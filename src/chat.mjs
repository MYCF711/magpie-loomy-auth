// Loomy · 请求接管（loader 的 fetch）
//
// 只做四件事，其余原样转发（上游本来就是 OpenAI 协议，不做协议转换）：
//
//   ① 换成 Loomy 的 token 双头（AI SDK 发的 Bearer 是占位值，必须覆盖）
//   ② deepseek 系模型：把 `image_url` data URI 改写成 `<image_base64>` 标记
//   ③ HTTP 200 + 信封 `{code:"100002"}` 的失效响应 → 打上
//      `X-Magpie-Sign-In: expired`（magpie 据此标记账号）
//   ④ 本地额度闸：**已知**两池皆空时直接回 429，不白撞上游
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

  return response
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export { businessCode, isAuthErrorCode }
