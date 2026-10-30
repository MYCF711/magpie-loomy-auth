// Loomy · 请求接管（loader 的 fetch）
//
// 只做五件事，其余原样转发（上游本来就是 OpenAI 协议，不做协议转换）：
//
//   ① 换成 Loomy 的 token 双头（AI SDK 发的 Bearer 是占位值，必须覆盖）
//   ② deepseek 系模型：把 `image_url` data URI 改写成 `<image_base64>` 标记
//   ③ HTTP 200 + 信封 `{code:"100002"}` 的失效响应 → 打上
//      `X-Magpie-Sign-In: expired`（magpie 据此标记账号）
//   ④ 本地额度闸：**已知**两池皆空时直接回 429，不白撞上游
//   ⑤ 「内容太长了」的 400/413/422 → 把文案换成 magpie `tooLongRe` 认得的中文写法，
//      否则整轮会话会以 400 失败（详见 `rewriteTooLongRefusal` 的注释）
//
// ⚠ SSE 一律原样透传：解析 clone 会把整条流缓冲住，用户看到的是「一直不出字」。
//   所以只有 `content-type: application/json` 才 clone 来判业务码。
//
// ⚠ 本地闸只拦「确定没额度」的号，且只在缓存里有读数时拦。判错的代价不对称：
//   漏拦 = 上游回一次错误（有明确文案）；错拦 = 一个好好的号发不出请求。

import { _pure } from "./pure.mjs"
import { CHAT_TIMEOUT_MS } from "./constants.mjs"
import { exhausted } from "./usage.mjs"

const { businessCode, isAuthErrorCode, prefersTagFormat, rewriteImagesToTags } = _pure

export async function chatFetch({ input, init, credential, session, usageValue }) {
  const request = input instanceof Request ? new Request(input, init) : null
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (request?.url ?? "")

  let bodyText = ""
  const rawBody = request ? request.body : init?.body
  if (rawBody != null) {
    bodyText = typeof rawBody === "string" ? rawBody : await new Response(rawBody).text()
  }

  // ④ 已知耗尽：不发给上游，直接回一个明确的 429
  if (usageValue && exhausted(usageValue)) {
    return jsonResponse(429, {
      error: {
        message: "Loomy 积分已耗尽（今日额度与永久积分均为 0），请签到或更换账号",
        type: "rate_limit_error",
        code: "insufficient_points",
      },
    })
  }

  let model = ""
  try {
    model = JSON.parse(bodyText)?.model ?? ""
  } catch {
    // 非 JSON body：原样透传
  }

  if (model && prefersTagFormat(model) && bodyText) {
    try {
      const parsed = JSON.parse(bodyText)
      const rewritten = rewriteImagesToTags(parsed)
      if (rewritten !== parsed) bodyText = JSON.stringify(rewritten)
    } catch {
      // body 不是 JSON 时保持原样
    }
  }

  const incoming = new Headers(request ? request.headers : init?.headers)
  for (const key of ["authorization", "x-api-key", "token", "content-length", "host"]) incoming.delete(key)
  incoming.set("token", session)
  incoming.set("Authorization", `Bearer ${session}`)
  if (bodyText) incoming.set("Content-Type", "application/json")

  let response
  try {
    response = await fetch(request ? request.url : url, {
      ...(init ?? {}),
      method: init?.method ?? request?.method ?? "POST",
      headers: incoming,
      body: bodyText || undefined,
      signal: init?.signal ?? request?.signal ?? AbortSignal.timeout(CHAT_TIMEOUT_MS),
    })
  } catch (error) {
    if (init?.signal?.aborted) throw error
    return jsonResponse(502, {
      error: { message: `Loomy 请求失败：${error?.message ?? error}`, type: "api_error" },
    })
  }

  // ③ 只有 JSON 响应才解析业务码；SSE 原样透传
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
  if (contentType.includes("application/json")) {
    const payload = await response.clone().json().catch(() => null)
    if (payload !== null && isAuthErrorCode(businessCode(payload))) {
      const headers = new Headers(response.headers)
      headers.set("X-Magpie-Sign-In", "expired")
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }
  }

  // ⑤ 上游用 400 说「内容太长了」，但文案里一个「上下文」都没有 ——
  //    magpie 的 `tooLongRe`（internal/gateway/gateway.go）中文只认
  //    `上下文(长度)?(超|过长)` 与 `超(过|出)(了)?(模型)?(的)?(最大)?上下文`，
  //    这条漏网 ⇒ `overflowed()` 为假 ⇒ 该 try 被当普通错误、账号被冻结、
  //    组里其它成员一次没被问，整轮会话直接失败（请求日志实测 2026-10-30）。
  //
  //    这里把文案换成它认得的说法，状态码与其余字段原样。
  const tooLong = await rewriteTooLongRefusal(response)
  if (tooLong) return tooLong

  return response
}

/** 「内容太长」的几种中文说法 —— 上游只说了长度，没说「上下文」 */
const TOO_LONG_SAID = /内容太长(了)?|内容过长/
/** 换成 magpie `tooLongRe` 认得的中文写法（`上下文…超` 命中） */
const TOO_LONG_REWORDED = "上下文超出长度限制"

/**
 * 把「内容太长了」的 400/413/422 改写成 magpie 认得的文案，其余原样。
 *
 * ⚠ 只读 400/413/422 的响应体（错误响应很小），其它状态码连 clone 都不做。
 * ⚠ 只换那一句文案；JSON 结构、其它字段、状态码全部保留。解析/读取失败一律原样返回。
 */
async function rewriteTooLongRefusal(response) {
  const status = response?.status
  if (status !== 400 && status !== 413 && status !== 422) return null
  let text
  try {
    // clone 之后再读：不改写时把原 Response 原样交回去
    text = await response.clone().text()
  } catch {
    return null
  }
  if (!TOO_LONG_SAID.test(text)) return null
  const rewritten = text.replace(TOO_LONG_SAID, TOO_LONG_REWORDED)
  if (rewritten === text) return null
  const headers = new Headers(response.headers)
  // body 长度变了，原来的长度/编码头不再成立
  headers.delete("content-length")
  headers.delete("content-encoding")
  // 排障用：上游原本是几（magpie 会把响应头透给客户端）
  headers.set("x-loomy-vendor-status", String(status))
  return new Response(rewritten, { status, statusText: response.statusText, headers })
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export { businessCode, isAuthErrorCode, rewriteTooLongRefusal }
