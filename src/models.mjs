// Loomy · 模型目录（静态兜底表 + 实测拉取）
//
// ⚠ 静态表里的数字**全部来自实测**（`GET /api/v1/models`，2026-10-26；
//   DeepSeek dated 条目复核于 2026-11-15），不是照抄文档，也不是「看起来差不多」：
//
//   id                      context  output   efforts                      reason   vision   tools
//   spark-x2.6              1048576  131072   none|low|medium|high|xhigh   ✓        ✗        ✓
//   spark-x                 1048576   65536   同上                         ✓        ✗        ✓
//   deepseek-v4-flash-1017  1048576  384000   同上                         ✓        ✓        ✓
//   MiniMax-M3              1048576  512000   同上                         ✓        ✓        ✓
//   Kimi-k2.6                262144   65536   同上                         ✓        ✓        ✓
//   qwen-3.8-max            1000000   65536   同上                         ✓        ✗        ✓
//   GLM-5.3-Flash           1048576  131072   同上                         ✓        ✓        ✓
//   qwen3.8-flash           1000000  131072   同上                         ✓        ✓        ✓
//   mimo-v2.5               1048576  131072   同上                         ✓        ✓        ✓
//   auto                          —       —   无 thinking_config           ✗        ✗        ✗
//
// ⚠ DeepSeek 的 id 是 **dated** 的 `deepseek-v4-flash-1017`，不是裸名。
//   2026-11-15 实测 `GET /api/v1/models` 同时下发两条 DeepSeek 对话条目（其余字段一致）：
//
//   id                       name                            created
//   DeepSeek-V4.1-Flash      DeepSeek V4.1 Flash(x2.0)       2026-09-14T09:49:05Z   ← 裸名/未固定 ID
//   deepseek-v4-flash-1017   DeepSeek V4.1 Flash 1017(x2.0)  2026-10-20T09:19:19Z   ← dated 固定版
//
//   两条的 context/output/视觉/工具/倍率完全一样（1,048,576 / 384,000 / ✓ / ✓ / x2.0），
//   差异在于 ID 是否带快照日期。**选 dated 的原因**：裸名不含快照日期，上游可以重新
//   指向其它快照，不适合用来承诺固定版本；dated ID 明确请求 1017，而本插件把 `api.id`
//   原样出站、不改写 `body.model`，因此静态与实时目录都只提供这一条 DeepSeek。
//
//   ⇒ **未固定裸名可能落到旧快照，不作为选项**：静态表只留 dated，
//   `liveModels` 遍历实时目录时显式跳过裸名（实时目录仍在同时下发它，不挡掉菜单里
//   就会多出一个会漂移的选项）。`parseModels` 保持通用解析，不在此层过滤 ——
//   历史单测直接喂裸名行，仍按原样解析。
//
// ⚠ `context` 必须原样上报，不要「保守填小」：magpie 把它转给 agent 决定何时
//   压缩对话，而**路由组按组内最大算窗口** —— 一个填小的成员会把整组拉低。
//   本工作区踩过这个坑：插件声明 131072 而卡片里填 1M，同一模型两条路径报两个值。
//
// ⚠ 上游还下发 3 条 `type:"image"`（Hy-Image-3.5-preview / doubao-seedream-5-lite /
//   qwen-image-3.0-pro）。它们**不是对话模型**，列出来就是让用户选中一个必然
//   失败的东西 —— `parseModels` 按 `type === "chat"` 过滤掉了。
//
// 倍率从展示名尾部 `(x2.0)` / `（x0.8）` 拆出，作为 `rate` 上报。

import { _pure } from "./pure.mjs"
import { PROVIDER_NAME, NPM, INTEGRATION_BASE } from "./constants.mjs"
import { fetchModels } from "./api.mjs"

const { splitRateSuffix, isFreeModel, modelShape, parseModels } = _pure

const API_URL = `${INTEGRATION_BASE}/api/v1`

/**
 * 上游 DeepSeek 的**裸名（未固定 ID）**：不固定快照，同一个 id 随时可能被上游指到
 * 其它 dated 快照。**未固定裸名可能落到旧快照，不作为选项** ——
 * 静态表只收录 dated（见 `DEEPSEEK_DATED_ID`），`liveModels` 遍历实时目录时跳过它。
 */
const DEEPSEEK_ALIAS_ID = "DeepSeek-V4.1-Flash"

/**
 * 要固定给用户的 DeepSeek 选项：上游的 dated id，快照写在名字里。
 * 除 id/展示名外与裸名条目完全一致（1M 上下文 / 384,000 输出 / 视觉 / 工具 / x2.0）。
 */
const DEEPSEEK_DATED_ID = "deepseek-v4-flash-1017"

/** 实测快照：[id, 展示名, context, output, 有无视觉, 有无工具]，efforts 统一为上游那 5 档 */
const SNAPSHOT = [
  ["spark-x2.6", "Spark-X2.6 正式版(限时免费)", 1_048_576, 131_072, false, true],
  ["spark-x", "Spark-X2.5（限时免费）", 1_048_576, 65_536, false, true],
  [DEEPSEEK_DATED_ID, "DeepSeek V4.1 Flash 1017", 1_048_576, 384_000, true, true],
  ["MiniMax-M3", "MiniMax M3", 1_048_576, 512_000, true, true],
  ["Kimi-k2.6", "Kimi k2.6", 262_144, 65_536, true, true],
  ["qwen-3.8-max", "Qwen 3.8 Max", 1_000_000, 65_536, false, true],
  ["GLM-5.3-Flash", "GLM 5.3 Flash", 1_048_576, 131_072, true, true],
  ["qwen3.8-flash", "qwen 3.8 flash", 1_000_000, 131_072, true, true],
  ["mimo-v2.5", "MiMo V2.5", 1_048_576, 131_072, true, true],
]

const EFFORTS = ["none", "low", "medium", "high", "xhigh"]

/**
 * 实测倍率（取自上游展示名尾部，2026-10-26）。
 *
 * ⚠ 这个表**只用于静态兜底**；活目录走 `parseModels`，倍率从上游直接解析。
 * 两个「限时免费」的 Spark 是 `x0.0` —— 也就是不扣积分，必须能被
 * `isFreeModel` 判成免费，否则它们会被当成收费模型、拿不到 Free first 的优先派发。
 */
const RATE_HINT = {
  "spark-x2.6": "(x0.0)",
  "spark-x": "(x0.0)",
  [DEEPSEEK_DATED_ID]: "(x2.0)",
  "MiniMax-M3": "(x4.0)",
  "Kimi-k2.6": "(x6.5)",
  "qwen-3.8-max": "(x12.0)",
  "GLM-5.3-Flash": "(x0.8)",
  "qwen3.8-flash": "(x0.8)",
  "mimo-v2.5": "(x3.3)",
}

/** 静态兜底表：未登录 / 目录拉取失败时用。**必须有内容**，否则卡片显示 "0 models"。 */
export function staticModels() {
  const out = {}
  for (const [id, name, context, output, vision, toolCall] of SNAPSHOT) {
    out[id] = modelShape(
      {
        id,
        name,
        context,
        output,
        reasoning: true,
        toolCall,
        images: vision,
        video: false,
        efforts: EFFORTS,
        defaultEffort: "low",
        // 上游把倍率写在展示名尾部，静态表里补回来 —— `free` 的判据要用它
        // （`x0.0` = 不扣分 = 免费；`auto` 没有倍率，因此不是免费）
        rate: splitRateSuffix(RATE_HINT[id] ?? "")[1],
        free: isFreeModel(name, splitRateSuffix(RATE_HINT[id] ?? "")[1]),
      },
      { api: { url: API_URL, npm: NPM } },
    )
  }
  // `auto` 上游没有 thinking_config（不声明 reasoning），上下文也不下发 —— 按 0 报，
  // 让 magpie 用组内默认；不猜一个数出来。
  out.auto = modelShape(
    { id: "auto", name: "自动 · 均衡", context: undefined, output: undefined, reasoning: false, toolCall: false, images: false, video: false, efforts: [] },
    { api: { url: API_URL, npm: NPM } },
  )
  return out
}

/**
 * 每账号拉一次真实目录；任何失败都**原样退回**传入的 provider.models
 * （不要标 `magpie.fellBack`：局部成功时标了 magpie 会整份丢弃）。
 */
export async function liveModels(session, fallback, fetcher = fetch) {
  const rows = await fetchModels(session, fetcher)
  if (!rows.length) return fallback
  const out = {}
  for (const row of rows) {
    // 实时目录仍在同时下发裸名 `DeepSeek-V4.1-Flash`。**未固定裸名可能落到旧快照，
    // 不作为选项** —— 只留 dated（它自己会作为一行被收进来），别让菜单里多出一个会漂移的 id。
    if (row.id === DEEPSEEK_ALIAS_ID) continue
    const base = fallback[row.id]
    out[row.id] = modelShape(row, {
      api: { url: API_URL, npm: NPM },
      ...(base ? { limit: base.limit, capabilities: base.capabilities } : {}),
    })
  }
  // 目录里没有的静态条目补回（例如 `auto` 有时不下发），保证菜单稳定
  for (const [id, shape] of Object.entries(fallback)) if (!out[id]) out[id] = shape
  return out
}

export { parseModels, splitRateSuffix }
export const CATALOG_URL = API_URL
export const PROVIDER_LABEL = PROVIDER_NAME
