// Loomy 上游 `/chat/completions` 的追踪头 —— 逆向自**官方客户端 0.9.39**。
//
// 取证方式：官方安装包（`Loomy-Setup-0.9.39.exe`，2026-10-10）→ `resources/app.asar`
// → `electron/utils/request-headers.js` 的 `buildRequestHeaders()` /
// `buildLoomyChatRequestHeaders()`，以及 `electron/llm/llm-completion.js` 里真正发出
// 请求的那一段。**不是猜的，也不是照第三方文档抄的**：第三方文档少列了
// `TurnId` 与 `X-Loomy-Request-Purpose`，且把 ChatId/MsgId 的大小写写成了全小写。
//
// 官方客户端 0.9.39 的聊天请求头（`llm-completion.js`）：
//
//   Accept: application/json
//   Content-Type: application/json
//   Authorization: Bearer <session>
//   token: <session>                   ← useSessionAuth 为真时额外带这一条
//   traceparent: 00-<32hex>-<16hex>-01 ← **必带**；官方源码注释：
//                                        「实测 Loomy iModel 缺 traceparent 时
//                                          chat/completions 会挂死直到超时」
//   ChatId: chat-<uuid>                ← 会话标识，同一会话的多次请求相同
//   MsgId: msg-<uuid>                  ← 消息标识，同一条助手消息的请求/收尾复用
//   TurnId: msg-<uuid>                 ← 可选（官方在可用时带）
//   X-Loomy-Request-Purpose: chat.message  ← 服务端裁决层按用途判定，缺了它就没有用途声明
//   InvokeOrigin: user                 ← 用户主动调用；后台子调用才是 system
//   loomy-version: 0.9.39              ← 客户端版本（`withLoomyVersionHeader` 注入）
//
// ⚠ HTTP 头名大小写不敏感，但**值**有形态要求：`traceparent` 必须是
//   `00-<32hex>-<16hex>-<2hex>`，上游按 W3C Trace Context 解析。
//
// ⚠ 本插件此前只发 `token` + `Authorization` + 一个桌面客户端 UA，上面这些追踪头
//   一个都没有 —— 这是与官方客户端最实质的差异，也是 2026-11-18 那批
//   「请求挂住 / 首字 100 秒+ / 504 延迟未开始」最可疑的协议层原因。

import crypto from "node:crypto"

import { LOOMY_CHAT_VERSION } from "./constants.mjs"

/** `00-<32hex trace-id>-<16hex span-id>-<2hex flags>` */
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

/** W3C Trace Context：版本固定 `00`，flags `01` = sampled。 */
export function newTraceparent() {
  return `00-${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(8).toString("hex")}-01`
}

export function isTraceparent(value) {
  return TRACEPARENT_RE.test(String(value ?? "").trim())
}

/**
 * 由 magpie 的会话 id 推出稳定的 `chat-<uuid>`。
 *
 * 官方客户端这里用的是它自己的对话 id；magpie 没有同名字段，但 `chat.headers`
 * 钩子会把 magpie 的 `sessionID` 放进 `x-loomy-session`（见 index.mjs ⑧）。
 * 用它的 sha256 拼成 UUID 形态：**同一会话永远同一个 ChatId**，重启后也稳定。
 */
export function chatIdFor(sessionId) {
  const seed = String(sessionId ?? "").trim()
  if (!seed) return `chat-${crypto.randomUUID()}`
  const hex = crypto.createHash("sha256").update(seed).digest("hex")
  return `chat-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function newMsgId() {
  return `msg-${crypto.randomUUID()}`
}

/**
 * 一次聊天请求要补的追踪头。**不含鉴权头**（那两条由调用方按凭据设置）。
 *
 * @param {{ sessionId?: string, msgId?: string, purpose?: string, invokeOrigin?: string }} [input]
 * @returns {Record<string,string>}
 */
export function chatTracingHeaders(input = {}) {
  const msgId = String(input.msgId ?? "").trim() || newMsgId()
  const purpose = String(input.purpose ?? "").trim() || "chat.message"
  const invokeOrigin = String(input.invokeOrigin ?? "").trim() || "user"
  return {
    traceparent: newTraceparent(),
    ChatId: chatIdFor(input.sessionId),
    MsgId: msgId,
    TurnId: msgId,
    "X-Loomy-Request-Purpose": purpose,
    InvokeOrigin: invokeOrigin,
    "loomy-version": LOOMY_CHAT_VERSION,
  }
}
