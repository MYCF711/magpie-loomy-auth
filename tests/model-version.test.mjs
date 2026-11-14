// Loomy · 固定 DeepSeek 1017 的离线回归测试
//
// 背景（2026-11-15 上游目录实测）：`GET /api/v1/models` **同时**下发两条
// DeepSeek chat 条目，它们是两个不同的上游 id，不是同一个模型的两个写法：
//
//   DeepSeek-V4.1-Flash      「DeepSeek V4.1 Flash(x2.0)」       created 2026-09-14  未固定裸名
//   deepseek-v4-flash-1017   「DeepSeek V4.1 Flash 1017(x2.0)」  created 2026-10-20  dated 1017
//
// 裸名不带快照日期，上游可以重新指向其它快照，因此不作为固定 1017 选项。
// magpie 侧的 `modelIDs` / `modelNames` / 路由组名也只是展示与统计别名，不是快照锁。
//
// ⇒ 固定版本只认 dated id：可选目录里 DeepSeek 只有 `deepseek-v4-flash-1017`，
//   裸名不许出现；活目录里上游仍在下发裸名，必须显式跳过，且**不许**被
//   static fallback 的「补回静态条目」逻辑重新加回菜单。
//
// 本文件是**全线离线**回归：`liveModels` 的 fetcher 全部注入桩，
// 不发任何真实请求、不读凭据、不消费额度。判据（旧实现必须红）：
//   node --test tests/model-version.test.mjs

import { test } from "node:test"
import assert from "node:assert/strict"

import { _internal } from "../index.mjs"

const { staticModels, liveModels } = _internal

/** 上游的固定日期 id —— 它自己就是出站 `model` 字符串，写死在名字里的快照。 */
const DATED = "deepseek-v4-flash-1017"
/** 上游的未固定裸名 —— **不作为选项**（同一 id 可能落到旧快照）。 */
const ALIAS = "DeepSeek-V4.1-Flash"

/** 两条 DeepSeek 条目的实测值相同（2026-11-15 上游目录）。 */
const CONTEXT = 1_048_576
const OUTPUT = 384_000

/**
 * 裸名不许以任何形态回到可选目录里。
 *
 * 三个位置都要查：表键、条目自身的 `id`、真正出站的 `api.id`
 * —— 只改展示名、把裸名留在 `api.id` 里是这类修法最典型的漏法。
 */
function assertNoAlias(models, where) {
  const keys = Object.keys(models)
  assert.equal(ALIAS in models, false, `${where} 里出现了裸名 ${ALIAS}：${keys.join(", ")}`)

  const reverted = Object.entries(models).filter(
    ([key, m]) => m?.id === ALIAS || m?.api?.id === ALIAS || key.toLowerCase() === ALIAS.toLowerCase(),
  )
  assert.deepEqual(
    reverted.map(([key]) => key),
    [],
    `${where} 有条目仍然把裸名 ${ALIAS} 当出站 model 上报（只改展示名不算修好）`,
  )
}

/** 从上游目录里摘出来的一行（字段与 `GET /api/v1/models` 实测响应同形）。 */
const upstreamRow = (id, name, extra = {}) => ({
  id,
  name,
  object: "model",
  owned_by: "loomy",
  type: "chat",
  protocol: "openai_chat",
  created: 1792487959,
  reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
  default_reasoning_effort: "low",
  context_length: CONTEXT,
  max_output_tokens: OUTPUT,
  capabilities: {
    reasoning: true,
    vision: true,
    function_calling: true,
    streaming: true,
    system_message: true,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
  },
  ...extra,
})

/** 上游仍在下发的裸名行（未固定裸名）。 */
const ALIAS_ROW = upstreamRow(ALIAS, "DeepSeek V4.1 Flash(x2.0)")
/** 上游的 dated 1017 行 —— 唯一该进的选项。 */
const DATED_ROW = upstreamRow(DATED, "DeepSeek V4.1 Flash 1017(x2.0)")

/**
 * 完全离线的 fetcher：只认模型目录端点，别的 URL 直接报错。
 *
 * 桩里不放任何真实上游地址，也不允许回落到全局 `fetch` ——
 * 这样「离线」不是口头承诺：一旦实现里多打了什么请求，用例当场红。
 */
function catalogFetcher(rows) {
  const calls = []
  const fetcher = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, method: init?.method ?? "GET" })
    assert.match(target, /\/api\/v1\/models$/, `离线 fetcher 只允许目录端点，实际请求了 ${target}`)
    return new Response(JSON.stringify({ code: "000000", data: rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
  fetcher.calls = calls
  return fetcher
}

// ── ① 静态兜底表（未登录 / 目录拉取失败时就是这张表）──────────────────

test("静态表：收录 dated 1017，且没有裸名（否则菜单里多一个会漂移的选项）", () => {
  const models = staticModels()
  assert.ok(models[DATED], `静态表缺 ${DATED}，现有：${Object.keys(models).join(", ")}`)
  assertNoAlias(models, "静态表")
})

test("静态表：dated 的出站 api.id 就是 dated —— 不许只改展示名、把裸名留在 api.id 里", () => {
  const m = staticModels()[DATED]
  assert.equal(m.id, DATED)
  assert.equal(m.api.id, DATED, "api.id 才是真正发给上游的 model 字符串，必须是 dated")
  assert.equal(m.status, "active")
  assert.ok(String(m.api.url).includes("loomyad.xunfei.cn"), `api.url 不对：${m.api.url}`)
})

test("静态表：dated 的展示名写清 1017，倍率已从名字里剥掉（走 rate 字段）", () => {
  const m = staticModels()[DATED]
  assert.match(m.name, /1017/, `展示名里没有 1017，用户看不出版本：${m.name}`)
  assert.match(m.name, /deepseek/i, `展示名不对：${m.name}`)
  assert.equal(/[（(]/.test(m.name), false, `展示名里还带着倍率文本（上游是「… 1017(x2.0)」）：${m.name}`)
})

test("静态表：dated 的上下文/输出/视觉/工具/倍率是实测值，不是猜的", () => {
  const m = staticModels()[DATED]
  assert.equal(m.limit.context, CONTEXT, "1M 档不许被「保守填小」（路由组按组内最大值算窗口）")
  assert.equal(m.limit.output, OUTPUT)
  assert.equal(m.capabilities.reasoning, true)
  assert.equal(m.capabilities.attachment, true, "上游 capabilities.vision = true")
  assert.equal(m.capabilities.input.image, true)
  assert.equal(m.capabilities.toolcall, true, "上游 capabilities.function_calling = true")
  assert.equal(m.rate, "x2.0", "倍率取自上游展示名尾部 (x2.0)")
  assert.equal(m.free, false, "x2.0 是收费档，不是 free")
  for (const effort of ["none", "low", "medium", "high", "xhigh"]) {
    assert.ok(effort in m.variants, `缺推理档位 ${effort}：${Object.keys(m.variants).join(", ")}`)
  }
})

test("静态表：改 DeepSeek 不许顺手动别的条目（回归护栏）", () => {
  const models = staticModels()
  const others = ["spark-x2.6", "spark-x", "MiniMax-M3", "Kimi-k2.6", "qwen-3.8-max", "GLM-5.3-Flash", "qwen3.8-flash", "mimo-v2.5", "auto"]
  for (const id of others) assert.ok(models[id], `静态表少了 ${id}`)
  assert.ok(Object.keys(models).length >= 10, `模型太少：${Object.keys(models).length}`)
  assert.equal(models["Kimi-k2.6"].limit.context, 262_144)
  assert.equal(models["spark-x2.6"].free, true, "x0.0 / 限时免费 必须仍是 free")
  assert.equal("Hy-Image-3.5-preview" in models, false, "image 型条目不许进对话目录")
})

// ── ② 活目录：上游同时下发裸名与 dated ───────────────────────────────

test("活目录：上游同时下发裸名与 dated 时，裸名被过滤、dated 保留且字段正确", async () => {
  const fetcher = catalogFetcher([
    ALIAS_ROW,
    DATED_ROW,
    upstreamRow("Kimi-k2.6", "Kimi k2.6(x6.5)", { context_length: 262_144, max_output_tokens: 65_536 }),
  ])
  const models = await liveModels("S-offline-both", staticModels(), fetcher)

  assertNoAlias(models, "活目录（上游同时下发裸名与 dated）")

  const m = models[DATED]
  assert.ok(m, `${DATED} 被漏掉了：${Object.keys(models).join(", ")}`)
  assert.equal(m.id, DATED)
  assert.equal(m.api.id, DATED, "出站 model 必须是 dated，不能回落成裸名")
  assert.equal(m.name, "DeepSeek V4.1 Flash 1017", "展示名要保留上游的 1017（倍率已剥到 rate）")
  assert.equal(m.limit.context, CONTEXT)
  assert.equal(m.limit.output, OUTPUT)
  assert.equal(m.capabilities.input.image, true)
  assert.equal(m.capabilities.toolcall, true)
  assert.equal(m.rate, "x2.0")
  assert.equal(m.free, false)

  // 同一次拉取里别的模型不受影响
  assert.equal(models["Kimi-k2.6"].limit.context, 262_144)
  // 真的只打了一次目录端点（离线 fetcher 会拒绝别的 URL）
  assert.equal(fetcher.calls.length, 1)
  assert.match(fetcher.calls[0].url, /\/api\/v1\/models$/)
})

test("活目录：上游只回 dated 时原样保留，且不会凭空生出裸名", async () => {
  const fetcher = catalogFetcher([DATED_ROW])
  const models = await liveModels("S-offline-dated", staticModels(), fetcher)
  assertNoAlias(models, "活目录（上游只回 dated）")
  assert.equal(models[DATED].api.id, DATED)
  assert.equal(models[DATED].limit.context, CONTEXT)
})

// ── ③ 活目录：上游只回裸名 —— 不许被 fallback「补回」 ────────────────

test("活目录：上游只回裸名时，也不许靠 fallback 把裸名补回菜单", async () => {
  const fetcher = catalogFetcher([
    ALIAS_ROW,
    upstreamRow("Kimi-k2.6", "Kimi k2.6(x6.5)", { context_length: 262_144, max_output_tokens: 65_536 }),
  ])
  const models = await liveModels("S-offline-alias-only", staticModels(), fetcher)

  // 核心判据：上游给的是裸名，过滤掉之后**不能**从静态兜底里又冒出来
  assertNoAlias(models, "活目录（上游只回裸名 + fallback 补条目）")

  // 补回静态条目的既有契约仍在：dated 应该被补进来（保证菜单稳定）
  assert.ok(models[DATED], `dated 应作为静态兜底被补回：${Object.keys(models).join(", ")}`)
  assert.equal(models[DATED].api.id, DATED)
  assert.equal(models[DATED].limit.context, CONTEXT)

  // 上游这一轮给的其它条目照常保留
  assert.equal(models["Kimi-k2.6"].limit.context, 262_144)
})
