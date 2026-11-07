// 图片投递形态 —— 锁住「已知不吃 `image_url` 的模型走 `<image_base64>` 标记」+ 兜底重发。
//
// 实测（2026-11-08，同一张合法 1×1 PNG，8 个对话模型 × 两种形态，矩阵见 docs/internals.md）：
//   `image_url` data URI 只在**讯飞自研后端**上整条 400
//     iflytek-spark-loomy → 请求有误，请重试；若多次出现请更新应用版本
//     alibaba-dashscope   → 暂不支持该图片格式，请更换图片后再试
//   而 `<image_base64>` 文本标记在**全部 8 个模型**上都 200。
//
// 这组用例锁三件事：① 判据覆盖实测清单（GLM / mimo 保留原生视觉）；
// ② 兜底重发真的**只**发一次，且第二次 body 是标记形态；
// ③ 不该重发的（没图 / 非 400 / 已改写）一次都不多发。

import test from "node:test"
import assert from "node:assert/strict"

import { _internal } from "../index.mjs"
import { chatFetch } from "../src/chat.mjs"

const { prefersTagFormat } = _internal.pure

/** 合法的 1×1 PNG（实测用的就是这张） */
const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const imageBody = (model) =>
  JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "这是什么" },
          { type: "image_url", image_url: { url: PNG_DATA_URI } },
        ],
      },
    ],
  })

const textBody = (model) =>
  JSON.stringify({ model, messages: [{ role: "user", content: "纯文本，没有图片" }] })

/** 讯飞自研后端的两种真实错误体（逐字抄自实测响应） */
const SPARK_REFUSAL = JSON.stringify({
  error: {
    message: "请求有误，请重试；若多次出现请更新应用版本",
    type: "invalid_request_error",
    param: null,
    code: 400,
    metadata: { provider_name: "iflytek-spark-loomy" },
  },
})

const DASHSCOPE_REFUSAL = JSON.stringify({
  error: {
    message: "暂不支持该图片格式，请更换图片后再试",
    type: "invalid_request_error",
    param: null,
    code: 400,
    metadata: { provider_name: "alibaba-dashscope" },
  },
})

const jsonReply = (status, text) => () =>
  new Response(text, { status, headers: { "content-type": "application/json" } })

const sseReply = () => () =>
  new Response('data: {"choices":[]}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } })

/**
 * 替换全局 fetch（`chatFetch` 用的是全局 fetch），记录每次的 url / method / headers / body。
 * `t.after` 负责恢复 —— 每个用例都从干净状态开始，且绝不碰真上游。
 */
function stubFetch(t, replies) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: init?.body,
    })
    if (calls.length > replies.length) {
      throw new Error(`fetch 被调用了 ${calls.length} 次，mock 只准备了 ${replies.length} 条响应`)
    }
    return replies[calls.length - 1]()
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

const chat = (body) =>
  chatFetch({
    input: "https://loomyad.xunfei.cn/api/v1/chat/completions",
    init: { method: "POST", body },
    credential: null,
    session: "S-image-format",
    usageValue: undefined,
  })

// ── ① 预改写判据 ────────────────────────────────────────────────────

test("实测只认标记的模型 → true（含 group/ 前缀与大小写差异）", () => {
  for (const model of [
    "MiniMax-M3",
    "Kimi-k2.6",
    "spark-x2.6",
    "qwen3.8-flash",
    "group/qwen-3.8-max",
    "auto",
  ]) {
    assert.equal(prefersTagFormat(model), true, `${model} 应当预改写`)
  }
})

test("实测接受 image_url 的 GLM / mimo 保持原生视觉（false）", () => {
  assert.equal(prefersTagFormat("GLM-5.3-Flash"), false)
  assert.equal(prefersTagFormat("mimo-v2.5"), false)
  assert.equal(prefersTagFormat(""), false)
  assert.equal(prefersTagFormat(null), false)
})

test("命中判据的模型在发送前就改写成标记形态（不打上游、不靠 400）", async (t) => {
  const calls = stubFetch(t, [sseReply()])
  const res = await chat(imageBody("MiniMax-M3"))

  assert.equal(calls.length, 1, "预改写成立就不该有第一次 400")
  assert.match(calls[0].body, /<image_base64>/, "第一次请求体就应当是标记形态")
  assert.equal(calls[0].body.includes("image_url"), false, "不许再把 image_url 投出去")
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("x-loomy-image-retry"), null, "没重发就不许打重发头")
})

// ── ② 兜底重发 ──────────────────────────────────────────────────────

test("GLM 没命中判据却因图片格式 400 → 改写成标记本地重发一次，返回重发结果", async (t) => {
  const calls = stubFetch(t, [jsonReply(400, SPARK_REFUSAL), sseReply()])
  const res = await chat(imageBody("GLM-5.3-Flash"))

  assert.equal(calls.length, 2, "恰好两次：首发 + 一次重发")
  const first = calls[0]
  const second = calls[1]

  assert.equal(first.body.includes('"type":"image_url"'), true, "首发是原生形态（GLM 实测能吃）")
  assert.match(second.body, /<image_base64>/, "重发必须是标记形态")
  assert.equal(second.body.includes("image_url"), false, "重发体里不许再有 image_url")

  // 重发与首发同 headers / method / signal（signal 没法直接比，比其余三项）
  assert.equal(second.method, first.method)
  assert.equal(second.url, first.url)
  assert.equal(second.headers.get("authorization"), "Bearer S-image-format")
  assert.equal(second.headers.get("authorization"), first.headers.get("authorization"))
  assert.equal(second.headers.get("token"), first.headers.get("token"))

  assert.equal(res.status, 200, "返回的是重发的结果")
  assert.equal(res.headers.get("x-loomy-image-retry"), "1", "排障头要留在重发的响应上")
})

test("dashscope 那句「暂不支持该图片格式」同样触发重发", async (t) => {
  const calls = stubFetch(t, [jsonReply(400, DASHSCOPE_REFUSAL), sseReply()])
  const res = await chat(imageBody("qwen-3.8-max").replace("qwen-3.8-max", "glm-4.6"))

  assert.equal(calls.length, 2)
  assert.match(calls[1].body, /<image_base64>/)
  assert.equal(res.status, 200)
})

// ── ③ 不该重发的一次都不多发 ─────────────────────────────────────────

test("400 但 body 里没有图片 → 不重发，原 400 原样交回", async (t) => {
  const calls = stubFetch(t, [jsonReply(400, SPARK_REFUSAL)])
  const res = await chat(textBody("GLM-5.3-Flash"))

  assert.equal(calls.length, 1, "没图就没什么可改写的")
  // 请求体很小（几百字符）⇒ 归「瞬时错误」→ 502 让 magpie 换号重试
  // （`rewriteTooLongRefusal` 既有分流：小于 200 万字符一律不当长度问题）
  assert.equal(res.status, 502, "小请求上的这句话是瞬时错误，不是超限")
  assert.equal(await res.text(), SPARK_REFUSAL, "原样返回：一个字段都不许动")
  assert.equal(res.headers.get("x-loomy-classified"), "momentary")
})

test("重发也 400 → 恰好两次，不再循环", async (t) => {
  const calls = stubFetch(t, [jsonReply(400, SPARK_REFUSAL), jsonReply(400, SPARK_REFUSAL)])
  const res = await chat(imageBody("GLM-5.3-Flash"))

  assert.equal(calls.length, 2, "只重发一次，第三次绝不许出现")
  // 第二次的响应是原样的；但请求体很小 ⇒ 走出既有的 momentary 分流（502），
  // 这不是「改写」，是 0.1.19 起就有的规则：小请求上的这句话是瞬时错误。
  assert.equal(res.status, 502, "第二次的响应原样交回（未被「改写」，只被归类）")
  assert.equal(await res.text(), SPARK_REFUSAL, "文案一个字都不许动")
})

test("非 400（500）带图片 → 不重发", async (t) => {
  const calls = stubFetch(t, [jsonReply(500, '{"error":{"message":"boom"}}')])
  const res = await chat(imageBody("GLM-5.3-Flash"))

  assert.equal(calls.length, 1)
  assert.equal(res.status, 500)
})

test("已经改写过（预改写路径）再 400 → 不重发，避免同一 body 发两遍", async (t) => {
  const calls = stubFetch(t, [jsonReply(400, SPARK_REFUSAL)])
  const res = await chat(imageBody("MiniMax-M3"))

  assert.equal(calls.length, 1, "标记形态已经是重发后的样子，没有第二次可做")
  assert.match(calls[0].body, /<image_base64>/)
  assert.equal(res.status, 502, "小请求 → momentary 分流")
  assert.equal(await res.text(), SPARK_REFUSAL, "文案一个字都不许动")
})
// ── ③ 超大请求上的通用 400 必须进 too-long 通道 ──────────────────────────
//
// 2026-11-08 02:50:52 那次事故的形状：出站 18.17 MB、上游回这条通用 400。
// 它其实就是「超了 1,048,576」—— 所以请求体 > 200 万字符时，文案要改写成
// magpie `tooLongRe` 认得的样子，让 agent 压缩上下文，而不是整轮失败。

/** magpie `tooLongRe` 里那两条中文写法（逐字抄自 gateway.go） */
const MAGPIE_TOO_LONG_ZH = /上下文(长度)?(超|过长)|超(过|出)(了)?(模型)?(的)?(最大)?上下文/

test("请求体 > 200 万字符时，`请求有误` 被改写成 tooLongRe 认得的样子（事故形状）", async (t) => {
  stubFetch(t, [jsonReply(400, SPARK_REFUSAL)])
  const big = JSON.stringify({
    model: "MiniMax-M3", // 走预改写路径，避免兜底重发干扰
    messages: [{ role: "user", content: "x".repeat(2_100_000) }],
  })
  const res = await chatFetch({
    input: "https://loomyad.xunfei.cn/api/v1/chat/completions",
    init: { method: "POST", body: big },
    credential: null,
    session: "s",
    usageValue: undefined,
  })

  const text = await res.text()
  assert.match(text, MAGPIE_TOO_LONG_ZH, "改写后 magpie 必须能认出来")
  assert.doesNotMatch(text, /请求有误，请重试/, "原来那句被换掉")
  assert.equal(res.headers.get("x-loomy-vendor-status"), "400", "上游原本是几，留痕")
})

test("请求体很小的时候同一句 400 仍是瞬时错误（502 换号，文案不动）", async (t) => {
  stubFetch(t, [jsonReply(400, SPARK_REFUSAL)])
  const res = await chat(textBody("GLM-5.3-Flash"))

  assert.equal(res.status, 502)
  assert.equal(await res.text(), SPARK_REFUSAL)
  assert.equal(res.headers.get("x-loomy-classified"), "momentary")
})

// ── ④ 误触发防护：用户文本里含有这句话，不等于上游在说这句话 ──────────────
//
// 真实场景：用户把报错截图/日志贴进对话，body 里就带了「请求有误，请重试」这串字
// （本机真实发生过）。若判据是 `text.includes(文案)`，之后任何 400 都会触发重发，
// 把同一个大请求再发一遍 —— 白烧一次额度。判据必须是「上游错误信封 + message 开头命中」。

test("响应体里出现这句话但不在 error.message 开头 → 不重发", async (t) => {
  const echo = JSON.stringify({ error: { message: "invalid request: 用户提到 请求有误，请重试 这串字", type: "invalid_request_error" } })
  const calls = stubFetch(t, [jsonReply(400, echo)])
  const res = await chat(imageBody("GLM-5.3-Flash"))

  assert.equal(calls.length, 1, "只是文本里含这串字，不是上游在说这句 —— 不许重发")
  assert.equal(res.status, 400)
})

test("400 但不是错误信封（纯文本）→ 不重发", async (t) => {
  const calls = stubFetch(t, [jsonReply(400, '上游返回：请求有误，请重试；若多次出现请更新应用版本')])
  const res = await chat(imageBody("GLM-5.3-Flash"))

  assert.equal(calls.length, 1, "没有 error 信封就当它不是图片格式拒绝")
  assert.equal(res.status, 400)
})

test("body 里已经含 <image_base64> 标记 → 视为形态已就位，不重发", async (t) => {
  const calls = stubFetch(t, [jsonReply(400, SPARK_REFUSAL)])
  const body = JSON.stringify({
    model: "GLM-5.3-Flash",
    messages: [
      { role: "user", content: `看这两张\n<image_base64>AAAA</image_base64>\n<image_base64>BBBB</image_base64>` },
      { role: "user", content: [{ type: "image_url", image_url: { url: PNG_DATA_URI } }] },
    ],
  })
  const res = await chatFetch({
    input: "https://loomyad.xunfei.cn/api/v1/chat/completions",
    init: { method: "POST", body },
    credential: null,
    session: "s",
    usageValue: undefined,
  })

  assert.equal(calls.length, 1, "已经是标记形态，没有第二次可做 —— 别把大请求再发一遍")
  assert.equal(res.status, 502, "小请求 → momentary 分流")
})
