// Loomy · 模型目录（静态兜底表 + 实测拉取）
//
// ⚠ 静态表里的数字**全部来自一次实测**（`GET /api/v1/models`，2026-10-26），
//   不是照抄文档，也不是「看起来差不多」：
//
//   id                   context     output   efforts                        reason  vision  tools
//   spark-x2.6           1048576     131072   none|low|medium|high|xhigh     ✓       ✗       ✓
//   spark-x              1048576      65536   同上                            ✓       ✗       ✓
//   DeepSeek-V4.1-Flash  1048576     384000   同上                            ✓       ✓       ✓
//   MiniMax-M3           1048576     512000   同上                            ✓       ✓       ✓
//   Kimi-k2.6             262144      65536   同上                            ✓       ✓       ✓
//   qwen-3.8-max         1000000      65536   同上                            ✓       ✗       ✓
//   GLM-5.3-Flash        1048576     131072   同上                            ✓       ✓       ✓
//   qwen3.8-flash        1000000     131072   同上                            ✓       ✓       ✓
//   mimo-v2.5            1048576     131072   同上                            ✓       ✓       ✓
//   auto                       —          —   无 thinking_config              ✗       ✗       ✗
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

const { splitRateSuffix, modelShape, parseModels } = _pure

const API_URL = `${INTEGRATION_BASE}/api/v1`

/** 实测快照：[id, 展示名, context, output, 有无视觉, 有无工具]，efforts 统一为上游那 5 档 */
const SNAPSHOT = [
  ["spark-x2.6", "Spark-X2.6 正式版(限时免费)", 1_048_576, 131_072, false, true],
  ["spark-x", "Spark-X2.5（限时免费）", 1_048_576, 65_536, false, true],
  ["DeepSeek-V4.1-Flash", "DeepSeek V4.1 Flash", 1_048_576, 384_000, true, true],
  ["MiniMax-M3", "MiniMax M3", 1_048_576, 512_000, true, true],
  ["Kimi-k2.6", "Kimi k2.6", 262_144, 65_536, true, true],
  ["qwen-3.8-max", "Qwen 3.8 Max", 1_000_000, 65_536, false, true],
  ["GLM-5.3-Flash", "GLM 5.3 Flash", 1_048_576, 131_072, true, true],
  ["qwen3.8-flash", "qwen 3.8 flash", 1_000_000, 131_072, true, true],
  ["mimo-v2.5", "MiMo V2.5", 1_048_576, 131_072, true, true],
]

const EFFORTS = ["none", "low", "medium", "high", "xhigh"]

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
        rate: undefined,
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
