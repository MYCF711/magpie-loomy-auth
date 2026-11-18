// 聊天请求的追踪头 —— 锁住「与官方客户端 0.9.39 的请求形状一致」。
//
// 取证：官方安装包 → app.asar → `electron/utils/request-headers.js`
// 的 `buildRequestHeaders()` 与 `electron/llm/llm-completion.js` 里真正发请求那一段。
// 官方源码注释原文：**「实测 Loomy iModel 缺 traceparent 时 chat/completions 会挂死
// 直到超时」** —— 所以这里锁的不是「好看」，是上游要的协议面。
//
// 本文件全离线：只注入桩 fetch，不发任何真实请求、不读凭据。

import test from "node:test"
import assert from "node:assert/strict"

import { chatFetch } from "../src/chat.mjs"
import { chatIdFor, chatTracingHeaders, isTraceparent, newTraceparent } from "../src/tracing.mjs"

const CHAT_URL = "https://loomyad.xunfei.cn/api/v1/chat/completions"

const body = JSON.stringify({
  model: "deepseek-v4-flash-1017",
  messages: [{ role: "user", content: "hi" }],
})

/** 记录每次出站请求的 headers / body（chatFetch 用的是全局 fetch）。 */
function stubFetch(t) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body })
    return new Response('data: {"choices":[]}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

const call = (headers = {}, bodyText = body, url = CHAT_URL) =>
  chatFetch({
    input: url,
    init: { method: "POST", body: bodyText, headers },
    credential: null,
    session: "S-tracing",
    usageValue: undefined,
  })

// ── ① 形态 ─────────────────────────────────────────────────────────

test("traceparent 是 W3C 形态：00-<32hex>-<16hex>-01", () => {
  for (let i = 0; i < 20; i += 1) {
    assert.equal(isTraceparent(newTraceparent()), true, `${newTraceparent()} 形态不对`)
  }
  // 反例：少一段、段长不对、flags 非 hex 都不算
  for (const bad of [
    "",
    "00-0000-0000-00-01",
    "00-0000000000000000000000000000000-0000000000000001-01",
    "00-00000000000000000000000000000001-0000000000000001-zz",
  ]) {
    assert.equal(isTraceparent(bad), false, `${bad} 不该被认成合法 traceparent`)
  }
})

test("chatIdFor：同一会话稳定，不同会话不同，且是 chat-<uuid> 形态", () => {
  const a = chatIdFor("sess-1")
  assert.equal(a, chatIdFor("sess-1"), "同一会话必须稳定（多轮请求同一个 ChatId）")
  assert.notEqual(a, chatIdFor("sess-2"))
  assert.match(a, /^chat-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  // 没有会话 id 时退回随机 uuid（形态仍合法）
  assert.match(chatIdFor(""), /^chat-[0-9a-f-]{36}$/)
})

test("chatTracingHeaders：七个头齐全，值是官方客户端的取值", () => {
  const h = chatTracingHeaders({ sessionId: "sess-1" })
  assert.equal(isTraceparent(h.traceparent), true)
  assert.match(h.ChatId, /^chat-/)
  assert.match(h.MsgId, /^msg-/)
  assert.equal(h.TurnId, h.MsgId, "官方在可用时 TurnId 与消息 id 同值")
  assert.equal(h["X-Loomy-Request-Purpose"], "chat.message", "用户主动聊天必须声明用途")
  assert.equal(h.InvokeOrigin, "user")
  assert.match(h["loomy-version"], /^\d+\.\d+\.\d+$/)
})

// ── ② 真的加到了出站请求上 ──────────────────────────────────────────

test("/chat/completions 出站请求带官方追踪头，且不再外发 x-loomy-session", async (t) => {
  const calls = stubFetch(t)
  await call({ "x-loomy-session": "sess-abc" })

  assert.equal(calls.length, 1)
  const h = calls[0].headers
  assert.equal(isTraceparent(h.get("traceparent")), true, "缺 traceparent 上游会挂死")
  assert.equal(h.get("ChatId"), chatIdFor("sess-abc"), "ChatId 应当由 magpie 会话 id 推出")
  assert.match(h.get("MsgId"), /^msg-/)
  assert.equal(h.get("TurnId"), h.get("MsgId"))
  assert.equal(h.get("InvokeOrigin"), "user")
  assert.equal(h.get("X-Loomy-Request-Purpose"), "chat.message")
  assert.match(h.get("loomy-version"), /^\d+\.\d+\.\d+$/)

  // 鉴权两条仍在（官方 useSessionAuth 分支就是两条都给）
  assert.equal(h.get("authorization"), "Bearer S-tracing")
  assert.equal(h.get("token"), "S-tracing")

  // 自造的会话头不许出网（官方客户端没有这个头）
  assert.equal(h.get("x-loomy-session"), null)
})

test("同一 magpie 会话的多次请求 ChatId 相同，跨会话不同", async (t) => {
  const calls = stubFetch(t)
  await call({ "x-loomy-session": "sess-A" })
  await call({ "x-loomy-session": "sess-A" })
  await call({ "x-loomy-session": "sess-B" })

  assert.equal(calls[0].headers.get("ChatId"), calls[1].headers.get("ChatId"))
  assert.notEqual(calls[0].headers.get("ChatId"), calls[2].headers.get("ChatId"))
  // 每条消息的 MsgId/ traceparent 各自独立
  assert.notEqual(calls[0].headers.get("MsgId"), calls[1].headers.get("MsgId"))
  assert.notEqual(calls[0].headers.get("traceparent"), calls[1].headers.get("traceparent"))
})

test("非 /chat/completions 的端点不加聊天追踪头（不生图/embedding 的协议面）", async (t) => {
  const calls = stubFetch(t)
  await call({}, body, "https://loomyad.xunfei.cn/api/v1/embeddings")
  const h = calls[0].headers
  assert.equal(h.get("traceparent"), null)
  assert.equal(h.get("ChatId"), null)
  assert.equal(h.get("X-Loomy-Request-Purpose"), null)
  // 鉴权那两条照旧
  assert.equal(h.get("authorization"), "Bearer S-tracing")
})

test("图片兜底重发复用同一条消息的 ChatId / MsgId", async (t) => {
  const original = globalThis.fetch
  const calls = []
  let n = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ headers: new Headers(init?.headers), body: init?.body })
    n += 1
    if (n === 1) {
      return new Response(
        JSON.stringify({ error: { message: "请求有误，请重试；若多次出现请更新应用版本", type: "invalid_request_error" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      )
    }
    return new Response('data: {"choices":[]}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } })
  }
  t.after(() => {
    globalThis.fetch = original
  })

  const PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  const imageBody = JSON.stringify({
    model: "GLM-5.3-Flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "这是什么" },
          { type: "image_url", image_url: { url: PNG } },
        ],
      },
    ],
  })

  await chatFetch({
    input: CHAT_URL,
    init: { method: "POST", body: imageBody, headers: { "x-loomy-session": "sess-img" } },
    credential: null,
    session: "S-tracing",
    usageValue: undefined,
  })

  assert.equal(calls.length, 2, "应当恰好重发一次")
  assert.equal(calls[1].headers.get("ChatId"), calls[0].headers.get("ChatId"), "同一条消息必须同一个 ChatId")
  assert.equal(calls[1].headers.get("MsgId"), calls[0].headers.get("MsgId"), "同一条消息必须同一个 MsgId")
  assert.equal(isTraceparent(calls[1].headers.get("traceparent")), true)
})
