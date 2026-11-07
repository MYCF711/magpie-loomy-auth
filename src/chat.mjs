// Loomy · 请求接管（loader 的 fetch）
//
// 只做五件事，其余原样转发（上游本来就是 OpenAI 协议，不做协议转换）：
//
//   ① 换成 Loomy 的 token 双头（AI SDK 发的 Bearer 是占位值，必须覆盖）
//   ② 已知不吃 `image_url` 的模型（见 `prefersTagFormat`）：发送前就把
//      `image_url` data URI 改写成 `<image_base64>` 标记
//   ②' 图片格式兜底：模型名没命中判据、却仍因图片格式整条 400 时，
//      把同一个 body 改写成标记形态**本地重发一次**（见 `IMAGE_FORMAT_SAID` / `taggedBody`）
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
import { CHAT_TIMEOUT_MS, CLIENT_UA, ERROR_CODES } from "./constants.mjs"
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

  // ④ 已知耗尽：不发给上游，直接回一个明确的 429。
  //    `code` 只能取 ERROR-CODES.md §3 词表（R2）：耗尽在宿主眼里就是「限流 / 冷却」，
  //    取 `rate_limited`（429 · 可退避 · 换号有救）。自造 `insufficient_points` 属于
  //    词表外的码 —— 宿主不认识就既不退避也不换号，CI 也会直接判失败。
  if (usageValue && exhausted(usageValue)) {
    return jsonResponse(429, {
      error: {
        message: "Loomy 积分已耗尽（今日额度与永久积分均为 0），请签到或更换账号",
        type: "rate_limit_error",
        code: ERROR_CODES.rateLimited,
        status: 429,
      },
    })
  }

  let model = ""
  try {
    model = JSON.parse(bodyText)?.model ?? ""
  } catch {
    // 非 JSON body：原样透传
  }

  // ② 发送前预改写：已知不吃 `image_url` 的模型直接按标记形态发（省掉一次 400）
  let alreadyTagged = false
  if (model && prefersTagFormat(model) && bodyText) {
    const tagged = taggedBody(bodyText)
    if (tagged !== null) {
      bodyText = tagged
      alreadyTagged = true
    }
  }

  const incoming = new Headers(request ? request.headers : init?.headers)
  // `user-agent` 必须进跳过名单：magpie 递给插件的是它自己的 `magpie/<version>`，
  // 原样转发就是这个插件在替「第三方客户端」投标（上游网关按 `<product>/<version>` 认人，
  // 命中即 403 TM.00000001）。下面统一换成官方 Loomy 客户端的 UA。
  for (const key of ["authorization", "x-api-key", "token", "content-length", "host", "user-agent"]) incoming.delete(key)
  incoming.set("token", session)
  incoming.set("Authorization", `Bearer ${session}`)
  incoming.set("user-agent", CLIENT_UA)
  if (bodyText) incoming.set("Content-Type", "application/json")

  // 重发与首发必须用**完全相同**的 headers / method / signal —— 只换 body。
  // signal 在这里先定下来（不留在 fetch 参数里），否则重发会各自造一个新的超时。
  const method = init?.method ?? request?.method ?? "POST"
  const callerSignal = init?.signal ?? request?.signal ?? null
  const signal = callerSignal ?? AbortSignal.timeout(CHAT_TIMEOUT_MS)
  const target = request ? request.url : url
  const sendOnce = (body) =>
    fetch(target, { ...(init ?? {}), method, headers: incoming, body: body || undefined, signal })

  let response
  try {
    response = await sendOnce(bodyText)
  } catch (error) {
    // 只有**调用方**主动取消才往外抛；本插件自己的超时按上游失败处理（回 502）
    if (callerSignal?.aborted) throw error
    return jsonResponse(502, {
      error: { message: `Loomy 请求失败：${error?.message ?? error}`, type: "api_error" },
    })
  }

  // ②' 图片格式兜底（实测 2026-11-08）：网关的后端路由会漂移 —— 同一个 model 名
  //    不一定落同一个后端，而讯飞自研后端（iflytek-spark-loomy / alibaba-dashscope）
  //    对 `image_url` 一律整条 400。模型名没命中判据时，这里按**文案**认。
  //
  //    只在「400 + 命中文案 + 本次 body 里确实有 data URI 图片 + 尚未改写过」时重发，
  //    且**只重发一次**：重发还失败就把第二次的 Response 原样交回去（不再加工）。
  if (!alreadyTagged && (await isImageFormatRefusal(response))) {
    const retryBody = taggedBody(bodyText)
    if (retryBody !== null) {
      try {
        const retried = await sendOnce(retryBody)
        response = withImageRetryHeader(retried)
      } catch (error) {
        if (callerSignal?.aborted) throw error
        // 重发没拿到响应：把第一次的 400 交回去 —— 它才是上游的真实回答
      }
    }
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

  // ⑤ 上游用 400 说「内容太长了」，但**它并不总是真的超长**（实测 2026-10-30）：
  //    同一天里 838,400 token 的请求成功，373,924 token 的却被这样拒绝；
  //    同一时段还有 `429 模型服务当前繁忙` —— 这条 400 更像过载时的通用文案。
  //
  //    所以按**请求体大小**分流，而不是一律当长度问题：
  //      · 请求体远小于模型声明上限 ⇒ 不是长度问题 ⇒ 502（magpie 换号重试，几秒钟）
  //      · 请求体确实很大        ⇒ 真是长度问题 ⇒ 改写成 `tooLongRe` 认得的中文写法
  //        （magpie 据此让 agent 压缩上下文，而不是整轮失败）
  const tooLong = await rewriteTooLongRefusal(response, bodyText.length)
  if (tooLong) return tooLong

  return response
}

/** 上游把图片格式当成整条请求有误的两句文案（2026-11-08 实测，逐字抄自错误体） */
const IMAGE_FORMAT_SAID = /请求有误，请重试；若多次出现请更新应用版本|暂不支持该图片格式/

/**
 * 上游是不是因为图片投递形态整条拒了 —— 只认 **400 + 上面那两句文案**。
 *
 * ⚠ 用 `clone()` 读：不重发时原 Response 必须原样交回去（照 `rewriteTooLongRefusal` 的做法）。
 * ⚠ 先判状态码再读 body：只有 400 会读，2xx/SSE 连 clone 都不做。
 */
async function isImageFormatRefusal(response) {
  if (response?.status !== 400) return false
  let payload
  try {
    payload = await response.clone().json()
  } catch {
    return false // 不是 JSON 错误信封 ⇒ 跟我们无关
  }
  // ⚠ 必须是**上游错误信封**，且 `error.message` 以那句话开头。
  //   只做 `text.includes(文案)` 会误触发：用户把报错贴进对话、或把日志当图片喂回来时，
  //   body 里本来就含这串字（本机真实发生过 —— 本会话上下文里就有它的回声）。
  //   那时任何 400（哪怕与图片无关）都会让插件把同一个大请求再发一遍，白烧一次额度。
  const message = payload?.error?.message
  if (typeof payload?.error?.type !== "string" || typeof message !== "string") return false
  return IMAGE_FORMAT_REFUSAL_MESSAGE.test(message.trim())
}

/**
 * 上游错误信封里的**完整**文案（不是出现在任意位置的花絮）。
 *
 * 用 `^…` 锚定 `error.message` 的开头：`iflytek-spark-loomy` / `alibaba-dashscope`
 * 就是把这句话当 `message` 整句给出的（实测原文，见 docs/internals.md 的矩阵节）。
 */
const IMAGE_FORMAT_REFUSAL_MESSAGE = /^(请求有误，请重试|暂不支持该图片格式)/

/**
 * 把 body 改写成 `<image_base64>` 标记形态；
 * 没有 data URI 图片块时返回 `null`（用来判「本次请求到底带没带图」）。
 */
function taggedBody(bodyText) {
  if (!bodyText) return null
  try {
    const parsed = JSON.parse(bodyText)
    // 已经是标记形态 ⇒ 没有「第二次」可做。不拦这一条，body 里另有多张 data URI 图时
    // 会绕过 `alreadyTagged` 把同一个请求再发一遍（图片还是会重复计费）。
    if (hasImageBase64Tag(parsed)) return null
    const rewritten = rewriteImagesToTags(parsed)
    return rewritten === parsed ? null : JSON.stringify(rewritten)
  } catch {
    return null // 非 JSON body 谈不上图片块
  }
}

/** body 里是否已经有 `<image_base64>` 标记（说明上游要的形态已经就位） */
function hasImageBase64Tag(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (const message of messages) {
    const content = message?.content
    if (typeof content === "string") {
      if (content.includes(IMAGE_BASE64_OPEN)) return true
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.includes(IMAGE_BASE64_OPEN)) {
          return true
        }
      }
    }
  }
  return false
}

const IMAGE_BASE64_OPEN = "<image_base64>"

/** 重发后的响应打上排障头（只加头，body 仍是上游那条流，不解包） */
function withImageRetryHeader(response) {
  const headers = new Headers(response.headers)
  headers.set("x-loomy-image-retry", "1")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** 「内容太长」的几种中文说法 —— 上游只说了长度，没说「上下文」 */
const TOO_LONG_SAID = /内容太长(了)?|内容过长/

/**
 * 上游「其实是超限」时才说得出的通用文案（2026-11-08 实测）。
 *
 * `iflytek-spark-loomy` / `volces-ark` / `alibaba-dashscope` 把「上下文超上限」统一抛成
 * 这两句。⚠ 它们**只在请求体很大时**才算长度问题：请求体很小时多半是图片形态问题
 * （走上面的兜底重发）或瞬时错误（按 502 换号）—— 所以不在这里、也不重发，
 * 一律留给 `rewriteTooLongRefusal` 按请求体大小分流。
 */
const GENERIC_OVERFLOW_SAID = /请求有误，请重试|暂不支持该图片格式/

/** 换成 magpie `tooLongRe` 认得的中文写法（`上下文…超` 命中） */
const TOO_LONG_REWORDED = "上下文超出长度限制"

/**
 * 请求体小于这个字符数，就不可能是「超过模型上限」。
 *
 * 判据（2026-10-30 实测）：Loomy 的 DeepSeek-V4.1-Flash 声明 1,048,576 token，
 * 而 **838,400 token 的请求是成功的**；按 2~4 字符/token 折算约 200~330 万字符。
 * 取 200 万字符作界，落在它下面的一律当「上游瞬时错误」而不是长度问题。
 */
const NOT_TOO_LONG_MAX_CHARS = 2_000_000

/**
 * 这句错误体里「上游到底说了哪一句」—— 认不出就返回 `null`。
 *
 * 两种形态都接受，但**都必须在 `error.message` 上**（或整份 body 本身就是一个裸 message）：
 *   ① 上游错误信封 `{"error":{"message":"…"}}` → 只看 `error.message`，且要求锚定开头
 *   ② 纯文本错误体（无 JSON）→ 整份文本即 message，同样要求锚定开头
 *
 * 这样「用户把报错贴进对话」带来的回声（出现在消息正文中间）不会被误认成上游的话。
 */
function messagePattern(text) {
  const tooLong = /^(内容太长(了)?|内容过长)/
  let message = null
  try {
    const payload = JSON.parse(text)
    const candidate = payload?.error?.message
    // 有 error 信封但 message 不是字符串 ⇒ 不是「上游在说这句话」
    if (typeof candidate !== "string") return null
    message = candidate.trim()
  } catch {
    // 不是 JSON：整份当消息文本（上游偶尔直接回纯文本错误）
    message = text.trim()
  }
  // 锚定开头：回声出现在正文中间的不算
  if (tooLong.test(message)) return TOO_LONG_SAID
  if (IMAGE_FORMAT_REFUSAL_MESSAGE.test(message)) return GENERIC_OVERFLOW_SAID
  return null
}

/**
 * 处理「内容太长了」的 400/413/422：
 *   · 请求体不大 → 502（让 magpie 换号重试）
 *   · 请求体确实大 → 改写成 `tooLongRe` 认得的中文写法，状态码不变
 *
 * ⚠ 只读 400/413/422 的响应体（错误响应很小），其它状态码连 clone 都不做。
 * ⚠ 只换那一句文案；JSON 结构、其它字段、状态码保留。解析/读取失败一律原样返回。
 */
async function rewriteTooLongRefusal(response, requestChars = 0) {
  const status = response?.status
  if (status !== 400 && status !== 413 && status !== 422) return null
  let text
  try {
    // clone 之后再读：不改写时把原 Response 原样交回去
    text = await response.clone().text()
  } catch {
    return null
  }
  // ⚠ 只认**上游错误信封里的 message**，不认「整个 body 里出现过这串字」。
  //   用户把报错贴进对话时，body 里就带着这句话；拿 text 裸匹配会把
  //   一个与长度无关的 400 改写成「上下文超限」，让 agent 白压一次上下文。
  const said = messagePattern(text)
  if (said === null) return null

  // 请求体远小于上限 ⇒ 这不是长度问题，是上游的瞬时错误（过载时它就这么说）
  const momentary = requestChars > 0 && requestChars < NOT_TOO_LONG_MAX_CHARS
  const rewritten = momentary ? text : text.replace(said, TOO_LONG_REWORDED)
  const outStatus = momentary ? 502 : status
  const headers = new Headers(response.headers)
  // body 长度变了，原来的长度/编码头不再成立
  headers.delete("content-length")
  headers.delete("content-encoding")
  // 排障用：上游原本是几、我们判成了什么
  headers.set("x-loomy-vendor-status", String(status))
  if (momentary) headers.set("x-loomy-classified", "momentary")
  return new Response(rewritten, { status: outStatus, statusText: response.statusText, headers })
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export { businessCode, isAuthErrorCode, rewriteTooLongRefusal }
