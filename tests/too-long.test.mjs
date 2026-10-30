// 「内容太长了」的文案改写 —— 锁住 magpie `tooLongRe` 认不认得。
//
// 上游说的是「内容太长了，请精简输入或开启新对话」，一个「上下文」都没有；
// magpie 的 `tooLongRe`（internal/gateway/gateway.go:7484）中文只认
//   `上下文(长度)?(超|过长)`  与  `超(过|出)(了)?(模型)?(的)?(最大)?上下文`
// 于是 `overflowed()` 为假：不换号、不 rest，把 400 直接摔给客户端。
//
// 这组用例锁两件事：① 该改的被改对了（且 magpie 真能认出来）；② 不该改的一个字都不动。

import test from "node:test"
import assert from "node:assert/strict"

import { rewriteTooLongRefusal } from "../src/chat.mjs"

/** magpie `tooLongRe` 里那两条中文写法（逐字抄自 gateway.go，改这里等于改契约） */
const MAGPIE_TOO_LONG_ZH = /上下文(长度)?(超|过长)|超(过|出)(了)?(模型)?(的)?(最大)?上下文/

/** Loomy 的真实报错文案（请求日志 2026-10-30 实测） */
const VENDOR_TEXT = "内容太长了，请精简输入或开启新对话"

const jsonResponse = (status, payload, headers = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

test("上游说「内容太长了」时，改写成 magpie 认得的中文写法", async () => {
  const res = jsonResponse(400, { error: { message: VENDOR_TEXT, type: "invalid_request_error" } })
  const out = await rewriteTooLongRefusal(res)
  assert.ok(out, "应当改写，而不是原样返回")
  assert.equal(out.status, 400, "状态码保持不变")
  const body = await out.json()
  assert.equal(body.error.type, "invalid_request_error", "其余字段原样")
  assert.match(body.error.message, MAGPIE_TOO_LONG_ZH, "改写后 magpie 的 tooLongRe 必须命中")
  assert.doesNotMatch(body.error.message, /内容太长/, "原来那句应当被换掉")
})

test("413 与 422 同样改写（magpie 的 overflowed 认这三个状态码）", async () => {
  for (const status of [413, 422]) {
    const out = await rewriteTooLongRefusal(
      jsonResponse(status, { error: { message: VENDOR_TEXT } }),
    )
    assert.ok(out, `${status} 应当改写`)
    assert.equal(out.status, status)
    assert.match(await out.text(), MAGPIE_TOO_LONG_ZH)
  }
})

test("不是长度问题的 400 原样返回（同一个对象，不复制）", async () => {
  const res = jsonResponse(400, { error: { message: "invalid api key", type: "invalid_request_error" } })
  const out = await rewriteTooLongRefusal(res)
  assert.equal(out, null, "不该改写时返回 null，由调用方把原 Response 交回去")
})

test("非 400/413/422 原样返回，连 body 都不碰", async () => {
  // ⚠ Node 会在 Response 构造后异步调度第一次 pull，`pulled` 的绝对值不可控，
  //   所以这里不数次数 —— 断言的是「返回 null」+「原 Response 仍可读」，
  //   而「不读 2xx」由代码结构保证：状态码先判，非三码直接 return。
  const body = new ReadableStream({
    pull(c) {
      c.enqueue(new TextEncoder().encode("data: {}\n\n"))
      c.close()
    },
  })
  const res = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  const out = await rewriteTooLongRefusal(res)
  assert.equal(out, null)
  assert.equal(await res.text(), "data: {}\n\n", "原 Response 必须没被读干")
})

test("读完 clone 之后，原 Response 的 body 仍然完整可用", async () => {
  const res = jsonResponse(400, { error: { message: VENDOR_TEXT } })
  await rewriteTooLongRefusal(res)
  const still = await res.json()
  assert.equal(still.error.message, VENDOR_TEXT, "原对象必须没被读干")
})

test("改写时删掉 content-length（body 长度变了），并留下排障头", async () => {
  const res = jsonResponse(400, { error: { message: VENDOR_TEXT } }, { "content-length": "128" })
  const out = await rewriteTooLongRefusal(res)
  assert.equal(out.headers.get("content-length"), null)
  assert.equal(out.headers.get("x-loomy-vendor-status"), "400")
})

test("文案在其它位置（纯文本错误）也能改，且非 JSON 不破坏结构", async () => {
  const res = new Response(`上游返回：${VENDOR_TEXT}`, {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
  const out = await rewriteTooLongRefusal(res)
  assert.ok(out)
  const text = await out.text()
  assert.match(text, MAGPIE_TOO_LONG_ZH)
  assert.match(text, /^上游返回：/, "前缀原样保留")
})

test("只说「内容过长」的变体同样命中", async () => {
  const out = await rewriteTooLongRefusal(jsonResponse(400, { error: { message: "内容过长" } }))
  assert.ok(out)
  assert.match(await out.text(), MAGPIE_TOO_LONG_ZH)
})
// ── 分流：请求体大小决定这是「真超长」还是「上游瞬时错误」 ──────────────────
//
// 判据（2026-10-30 实测）：同一天里 838,400 token 的请求成功、373,924 token 的
// 被说「内容太长」，同时段还有 429「模型服务当前繁忙」。所以请求体远小于声明
// 上限时，这条 400 不是长度问题 —— 应当换号重试，而不是让 agent 白白压缩上下文。

test("请求体远小于上限时判为瞬时错误 → 502（换号），文案不改", async () => {
  const res = jsonResponse(400, { error: { message: VENDOR_TEXT } })
  const out = await rewriteTooLongRefusal(res, 150_000)
  assert.ok(out, "仍要拦下来，不能原样交给客户端")
  assert.equal(out.status, 502, "换号重试，而不是让 agent 压缩")
  assert.equal(out.headers.get("x-loomy-classified"), "momentary")
  assert.match(await out.text(), /内容太长/, "瞬时错误保留上游原话，便于排障")
})

test("请求体接近上限时才当长度问题 → 保持 400 并改写成 tooLongRe 认得的样子", async () => {
  const res = jsonResponse(400, { error: { message: VENDOR_TEXT } })
  const out = await rewriteTooLongRefusal(res, 3_000_000)
  assert.ok(out)
  assert.equal(out.status, 400, "真长度问题不改状态码")
  assert.equal(out.headers.get("x-loomy-classified"), null)
  assert.match(await out.text(), MAGPIE_TOO_LONG_ZH)
})

test("边界：恰好 200 万字符仍按「真长度问题」处理", async () => {
  const out = await rewriteTooLongRefusal(jsonResponse(400, { error: { message: VENDOR_TEXT } }), 2_000_000)
  assert.equal(out.status, 400)
  assert.match(await out.text(), MAGPIE_TOO_LONG_ZH)
})
