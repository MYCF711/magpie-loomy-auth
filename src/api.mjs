// Loomy · 网络层
//
// 两条通道（实测 2026-10-26）：
//   业务/积分/目录  INTEGRATION_BASE   鉴权 = token 双头（session 即 token）
//   账号/短信       XFYUN_ACCOUNT_BASE 鉴权 = HMAC-SHA1 签名（客户端公开常量）
//
// 延迟实测（同账号各 3 次）：/points/balance 61~233ms，/points/records 50~78ms。
// ⇒ 热路径只用一次请求；quota 从凭据里取，不为它多发一次。

import { _pure } from "./pure.mjs"
import { secrets, traceId } from "./crypto.mjs"
import {
  APP_ID,
  AUTH_ERROR_CODES,
  CLIENT_DEVICE_ID,
  CLIENT_MODEL_ID,
  CLIENT_UA,
  CLIENT_VERSION,
  INTEGRATION_BASE,
  LEDGER_MAX_PAGES,
  LEDGER_PAGE_SIZE,
  REQUEST_TIMEOUT_MS,
  XFYUN_ACCOUNT_BASE,
} from "./constants.mjs"

const {
  businessCode,
  dailyConsumedByCycle,
  ensureSuccess,
  isAuthErrorCode,
  looksLikeInsufficientPoints,
  normalizeCode,
  normalizePhone,
  parseModels,
  signedHeaders,
} = _pure

// ════════════════════════════════════════════════════════════════════
// 集成网关（token 双头）
// ════════════════════════════════════════════════════════════════════

function integrationHeaders(session) {
  // 实测：两个头都要，只给 Authorization 上游回鉴权失败
  return { token: session, Authorization: `Bearer ${session}` }
}

/**
 * 一次业务请求。
 *
 * ⚠ 上游有部分错误是 **HTTP 200 + 信封 `{code:"100002"}`**，
 *   所以「状态码 ok」不等于「成功」—— 一律交给 ensureSuccess 判业务码。
 */
export async function tokenRequest(method, pathAndQuery, session, body, what, fetcher = fetch) {
  const headers = { ...integrationHeaders(assertSession(session)), Accept: "application/json" }
  let payload
  if (body !== undefined) headers["Content-Type"] = "application/json"
  if (body !== undefined) payload = JSON.stringify(body)

  let res
  try {
    res = await fetcher(`${INTEGRATION_BASE}${pathAndQuery}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw httpError(502, `${what}失败：${error?.message ?? error}`)
  }

  const json = await readJson(res)
  if (!res.ok) {
    const message = json === null ? "" : businessMessage(json)
    if (json !== null && isAuthErrorCode(businessCode(json))) throw signInExpired(message || `${what}：登录已失效`)
    throw httpError(res.status, `${what}返回 HTTP ${res.status}${message ? `：${message}` : ""}`)
  }
  if (json === null) throw httpError(502, `${what}失败：响应不是 JSON`)
  ensureSuccess(json, what)
  return unwrap(json)
}

/** 信封形状在两版接口里出现过两种：`data` 与 `data.data`。都认。 */
function unwrap(json) {
  return json?.data?.data ?? json?.data ?? {}
}

function businessMessage(json) {
  const t = json?.desc ?? json?.message ?? json?.msg
  return typeof t === "string" ? t.trim() : ""
}

function assertSession(session) {
  const s = typeof session === "string" ? session.trim() : ""
  if (!s) throw signInExpired("Loomy 账号缺少 session，请重新登录")
  return s
}

function signInExpired(message) {
  return Object.assign(new Error(message), { signIn: "expired", status: 401 })
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

async function readJson(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

// ════════════════════════════════════════════════════════════════════
// 余额与额度
// ════════════════════════════════════════════════════════════════════

/**
 * 只读余额（**首选端点**）。
 *
 * `/api/v1/points/balance` 实测只回三个数字，载荷最小 —— 市场现有三家都在用
 * 带 `list` 的 `/points/records`，白拉一页流水。
 *
 * 注意它**不回 dailyQuota**（实测），所以占比还得靠凭据里的 quota 或流水推导。
 */
export async function fetchBalances(session, fetcher = fetch) {
  const data = await tokenRequest("GET", "/api/v1/points/balance", session, undefined, "积分查询", fetcher)
  const permanent = readNum(data.balance)
  // balance 是核心字段：读不到说明形状变了，**不编造成 0**
  if (permanent === undefined) return null
  const daily = readNum(data.dailyBalance) ?? 0
  const total = readNum(data.availableBalance) ?? permanent + daily
  return { permanent, daily, total }
}

/**
 * 从流水推今天的 daily 消耗（降级路径，只在凭据里没有当天 quota 时用）。
 *
 * 翻页而非取一页：耗尽的号可能一天就烧掉几十上百条，只看第一页会把
 * 消耗**算少**，于是把已空的号误报成「还剩很多」—— 那是往反方向错。
 * 上限 LEDGER_MAX_PAGES 页；翻不满就如实标 partial 并放弃推导（宁缺毋谎）。
 */
export async function fetchDailyLedger(session, cycleDate, fetcher = fetch) {
  let rows = []
  let total = 0
  let complete = false
  for (let page = 1; page <= LEDGER_MAX_PAGES; page++) {
    const data = await tokenRequest(
      "GET",
      `/api/v1/points/records?pageNo=${page}&pageSize=${LEDGER_PAGE_SIZE}&recordType=all`,
      session,
      undefined,
      "积分流水查询",
      fetcher,
    )
    const list = Array.isArray(data?.list) ? data.list : []
    rows = rows.concat(list)
    total = readNum(data?.total) ?? rows.length
    if (rows.length >= total || list.length === 0) {
      complete = true
      break
    }
  }
  if (!complete) return { partial: true, consumed: 0, latestCycle: undefined }

  const consumed = dailyConsumedByCycle(rows, cycleDate)
  // 本业务日一条 daily 都没有：可能今天还没用过（消耗 0），也可能厂商改了字段。
  // 用「流水里出现过的最新业务日」区分这两件事。
  const cycles = new Set()
  for (const r of rows) {
    if (r?.consumeSource === "daily" && typeof r.dailyCycleDate === "string" && r.dailyCycleDate.trim()) {
      cycles.add(r.dailyCycleDate.trim())
    }
  }
  const latestCycle = cycles.size ? [...cycles].sort().at(-1) : undefined
  return { partial: false, consumed, latestCycle, today: latestCycle === cycleDate }
}

// ════════════════════════════════════════════════════════════════════
// 签到（写端点，幂等）
// ════════════════════════════════════════════════════════════════════

/**
 * 触发每日额度刷新。
 *
 * ⚠ `dailyQuota` / `dailyConsumed` / `dailyCycleDate` **只有这个响应里有**，
 *   而它是写端点 —— 所以「打开面板」绝不能调它（会悄悄签到），
 *   只有 magpie 的 checkin 钩子与登录成功后的那一次可以。
 * ⚠ 幂等判据是 `alreadyProcessed`，重复调用同样回 HTTP 200。
 */
export async function claimDailyQuota(session, fetcher = fetch) {
  try {
    const data = await tokenRequest("POST", "/api/v1/points/first-login", session, {}, "每日签到", fetcher)
    return {
      ok: true,
      alreadyProcessed: data?.alreadyProcessed === true,
      dailyQuota: readNum(data?.dailyQuota),
      dailyBalance: readNum(data?.dailyBalance),
      dailyConsumed: readNum(data?.dailyConsumed),
      dailyCycleDate: typeof data?.dailyCycleDate === "string" ? data.dailyCycleDate.trim() : undefined,
    }
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error).slice(0, 300) }
  }
}

// ════════════════════════════════════════════════════════════════════
// 模型目录
// ════════════════════════════════════════════════════════════════════

export async function fetchModels(session, fetcher = fetch) {
  const json = await rawGet(`${INTEGRATION_BASE}/api/v1/models`, integrationHeaders(assertSession(session)), fetcher)
  if (json === null || !json.ok) throw httpError(502, `模型目录查询失败${json?.message ? `：${json.message}` : ""}`)
  const models = parseModels(json.body)
  if (!models.length) throw httpError(502, "Loomy 模型目录为空或格式不认识")
  return models
}

function readNum(value) {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value)
  return Number.isFinite(n) ? n : undefined
}

function readNum2(value, fallback) {
  const n = readNum(value)
  return n === undefined ? fallback : n
}

// ════════════════════════════════════════════════════════════════════
// 账号接口（签名 POST）
// ════════════════════════════════════════════════════════════════════

function clientBase() {
  return {
    appid: APP_ID,
    modelid: CLIENT_MODEL_ID,
    version: CLIENT_VERSION,
    devid: CLIENT_DEVICE_ID,
    ua: CLIENT_UA,
    traceid: traceId(),
  }
}

export async function signedPost(path, param, what, fetcher = fetch) {
  const body = JSON.stringify({ base: clientBase(), param })
  const headers = {
    ...signedHeaders("POST", path, body, secrets),
    "Content-Type": "application/json",
  }
  let res
  try {
    res = await fetcher(`${XFYUN_ACCOUNT_BASE}${path}`, { method: "POST", headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    throw httpError(502, `${what}失败：${error?.message ?? error}`)
  }
  const json = await readJson(res)
  if (!res.ok) throw httpError(res.status, `${what}返回 HTTP ${res.status}`)
  ensureSuccess(json ?? {}, what)
  return json ?? {}
}

/** 发送短信验证码。回 msgid 供 checkCode 用。 */
export async function sendSmsCode(phone, fetcher = fetch) {
  const payload = await signedPost("/login/phone/sendMsgCode", { ccode: "86", phone: normalizePhone(phone), expire: 300 }, "发送验证码", fetcher)
  const msgid = pickMsgid(payload)
  if (!msgid) throw httpError(502, "验证码已发出但上游没有返回 msgid")
  return msgid
}

/** 验证码换 session。Loomy **没有续期接口**，这个 session 就是 14 天的全部。 */
export async function loginBySmsCode(phone, code, msgid, fetcher = fetch) {
  const payload = await signedPost(
    "/login/phone/checkCode",
    { ccode: "86", phone: normalizePhone(phone), mcode: normalizeCode(code), msgid, expire: 14 * 24 * 3600 },
    "登录",
    fetcher,
  )
  const data = payload?.data ?? {}
  const session = typeof data.session === "string" ? data.session.trim() : ""
  const userid = typeof data.userid === "string" ? data.userid.trim() : ""
  if (!session) throw httpError(502, "登录成功但上游没有返回 session")
  return { session, userid }
}

function pickMsgid(payload) {
  for (const v of [payload?.data?.msgid, payload?.data?.msgId, payload?.data?.data?.msgid, payload?.data?.data?.msgId]) {
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

async function rawGet(url, headers, fetcher) {
  try {
    const res = await fetcher(url, { method: "GET", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const body = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, body }
  } catch {
    return null
  }
}

export { looksLikeInsufficientPoints, AUTH_ERROR_CODES, readNum2 as readNumOr }

// ════════════════════════════════════════════════════════════════════
// 新手任务（onboarding）
// ════════════════════════════════════════════════════════════════════

/**
 * 读新手任务状态（**只读**）。
 *
 * `GET /api/v1/onboarding/tasks` 实测回 `{tasks:{key:bool}, earned, total}`。
 * ⚠ 不要在 usage 的热路径上调它（另一个端点 + 会频繁刷新）。
 */
export async function fetchOnboarding(session, fetcher = fetch) {
  const data = await tokenRequest("GET", "/api/v1/onboarding/tasks", session, undefined, "新手任务查询", fetcher)
  return {
    tasks: _pure.normalizeTasks(data?.tasks),
    earned: readNum(data?.earned) ?? _pure.earnedPoints(_pure.normalizeTasks(data?.tasks)),
    total: readNum(data?.total),
  }
}

/**
 * 领取一个任务（**幂等写**）。
 *
 * 判据是响应体的 `alreadyCompleted`（重复领取同样回 200）。
 * 返回 `{ ok, alreadyCompleted, balance }`，不抛错 —— 批量领取不该因一项失败中断。
 */
export async function completeTask(session, key, fetcher = fetch) {
  try {
    const data = await tokenRequest(
      "POST",
      "/api/v1/onboarding/tasks/complete",
      session,
      { key },
      "新手任务领取",
      fetcher,
    )
    return {
      ok: true,
      alreadyCompleted: data?.alreadyCompleted === true,
      balance: readNum(data?.balance),
    }
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error).slice(0, 200) }
  }
}

/**
 * 一次性领完所有未完成的任务。
 *
 * ⚠ 按**分值从高到低**领：万一中途失败，领到的是大的那几项。
 * ⚠ 每项之间不并发：上游对同一账号的并发不友好（对话通道实测会 403），
 *   串行虽然慢一点，但不会把号打成风控。
 */
export async function claimAllTasks(session, tasks, fetcher = fetch) {
  const pending = _pure.pendingTasks(tasks ?? {})
  const claimed = []
  const failed = []
  for (const item of pending) {
    const r = await completeTask(session, item.key, fetcher)
    if (r.ok) claimed.push({ ...item, alreadyCompleted: r.alreadyCompleted })
    else failed.push({ ...item, message: r.message })
  }
  return { claimed, failed }
}
