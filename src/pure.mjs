// Loomy · 纯函数层（不碰网络、不碰文件，由 index.mjs 经 `_internal` 交给测试）
//
// ⚠ magpie 的宿主会把入口模块的**每一个函数导出**都当插件工厂调用
//   （`internal/plugin/host.js` 的 `servers()`）。所以 helper 一律待在这个
//   `_pure` 数据对象里，index.mjs 只导出「一个工厂 + `_internal`」。
//
// ════════════════════════════════════════════════════════════════════
// 三条实测结论，本文件的设计全由此而来（测于 2026-10-26）
// ════════════════════════════════════════════════════════════════════
//
// ① `dailyQuota` **不在任何只读端点上**。
//    实测 `/api/v1/points/records`、`/api/v1/points/balance`、`/api/v2/points/records`
//    都只回 `balance` / `dailyBalance` / `availableBalance`；
//    只有 `POST /api/v1/points/first-login`（写端点，幂等）带
//    `dailyQuota` / `dailyConsumed` / `dailyCycleDate`。
//    ⇒ 上限只能「签到/登录时拿到并记进凭据」，**不许硬编码 5000**（活动会变）。
//
// ② 但**今日消耗可以从流水读出来**（降级路径）。
//    V1 `/api/v1/points/records` 每条 debit 带 `consumeSource`（`daily`/`permanent`）
//    与 `dailyCycleDate`，于是
//      quota ≈ dailyBalance + Σ(本业务日 consumeSource=daily 的扣分)
//    两号实测：181\*\*\*\*0632（0/0）→ quota=5000、used=100%；
//              189\*\*\*\*8051 → quota=5000、used=3.96%。
//
// ③ 永久池**不该参与路由**。它无周期、无上限，所以 `aside: true` 且
//    **不给 `amount`/`limit`** —— 给了，magpie 就把它当一条真额度算占比，
//    而「永久池总量 = 剩余」这种假总量正是市场现有插件的缺陷来源。
//
// ════════════════════════════════════════════════════════════════════
// magpie 如何用这些窗口（从二进制里取证的原文，决定本文件所有取舍）
// ════════════════════════════════════════════════════════════════════
//
//   const group = (w) => w.used >= 98 ? "spent" : w.used >= 90 ? "low" : "fine"
//   quotaFill(w){ const used = Math.round(to100(w.used)); return quotaLeft ? 100-used : used }
//   quotaCount(w){ if (!(w.limit > 0)) return w.display || ""; … }
//   const counted = q.windows.filter((w) => !w.unlimited);          // 卡片主环
//   … else if (w.aside) s = t("{api} only  after the others")        // aside 排后面
//   smart 路由：spent 的账号 "answers only when nothing else can"    // 排最后
//   usage 归一：used: Math.max(0, num(w?.used))                       // 缺省即 0
//
// ⇒ **一个空号若不画任何参与路由的窗口，就会以 used:0 的姿态排在前面。**
//   这正是市场插件把蹬空的号顶到路由队首、白撞几百次的根因。

import { BEIJING_UTC_OFFSET_MS, PROVIDER } from "./constants.mjs"

export const _pure = {
  windowsOf,
  balanceLine,

  beijingCycleDate,
  beijingResetAt,
  quotaCoversCycle,
  parseCycle,

  dailyConsumedByCycle,
  mergeQuotaReadings,

  credentialOf,
  maskPhone,
  normalizePhone,
  normalizeCode,

  splitRateSuffix,
  isFreeModel,
  parseModels,
  modelShape,

  prefersTagFormat,
  rewriteImagesToTags,

  buildEscapedPath,
  signedHeaders,

  businessCode,
  upstreamMessage,
  isAuthErrorCode,
  ensureSuccess,
  looksLikeInsufficientPoints,
  checkinOutcome,
}

const round = (n) => Math.round(n * 100) / 100

/** 任意值读成有限数；非法回 fallback（**不编造 0** 的场景都显式传 undefined）。 */
function num(value, fallback) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : Number(value)
  return Number.isFinite(n) ? n : fallback
}

// ════════════════════════════════════════════════════════════════════
// ① 额度窗口 —— 本插件的核心
// ════════════════════════════════════════════════════════════════════

/**
 * @param pools  只读端点的余额读数 `{permanent, daily, total}`
 * @param quota  `{value?, consumed?, cycleDate?, known:boolean, source}`
 * @param now    epoch 毫秒
 *
 * 判据表（四条语义各有单测锁死）：
 *
 * | 情形 | 今日池 | 永久池 |
 * |---|---|---|
 * | 知道上限、有/无消耗 | `used = 100*consumed/quota`，带 amount/limit/resetsAt | `aside`，只 display |
 * | 上限未知但可从流水推 | 用推导值，正常占比 | 同上 |
 * | 上限未知也推不出 | `aside` + `used:0`，**绝不谎报成满额或假占比** | 同上 |
 * | **两池皆 0（号被蹬空）** | 合成一条 `used:100` 的**参与路由**窗口 | 不画（本来就没） |
 */
function windowsOf(pools, quota, now) {
  const permanent = Math.max(0, num(pools?.permanent, 0))
  const daily = Math.max(0, num(pools?.daily, 0))
  const total = num(pools?.total, permanent + daily)
  const windows = []

  // —— 蹬空的号：必须画一条参与路由的满额窗口，让它沉底 ——
  if (total <= 0) {
    windows.push({
      name: "今日积分",
      used: 100,
      display: "积分已耗尽",
      unit: "积分",
      ...(quota?.cycleDate ? { resetsAt: beijingResetAt(quota.cycleDate, now) } : {}),
    })
    return windows
  }

  const ceiling = num(quota?.value, undefined)
  if (quota?.known && ceiling !== undefined && ceiling > 0) {
    const consumed = num(quota?.consumed, undefined) ?? Math.max(0, ceiling - daily)
    const used = round(Math.max(0, Math.min(100, (100 * Math.max(0, consumed)) / ceiling)))
    windows.push({
      name: "今日积分",
      used,
      display: `${daily} / ${ceiling} 积分`,
      amount: Math.max(0, ceiling - daily),
      limit: ceiling,
      unit: "积分",
      resetsAt: beijingResetAt(quota.cycleDate, now),
    })
  } else {
    // 上限拿不到：说还剩多少，但**不声称占比**（画成 aside 即不参与路由打分）。
    windows.push({
      name: "今日积分",
      used: 0,
      aside: true,
      display: `${daily} 积分剩余（今日上限未知）`,
      unit: "积分",
      ...(quota?.cycleDate ? { resetsAt: beijingResetAt(quota.cycleDate, now) } : {}),
    })
  }

  if (permanent > 0) {
    windows.push({
      name: "永久积分",
      used: 0,
      aside: true,
      display: `${permanent} 积分`,
      unit: "积分",
    })
  }

  return windows
}

/** 卡片顶部的总余额行（厂商自己的数，不做二次加工）。 */
function balanceLine(total) {
  const n = num(total, 0)
  return `${Math.max(0, Math.round(n))} 积分`
}

// ════════════════════════════════════════════════════════════════════
// ② 业务日（东八区）
// ════════════════════════════════════════════════════════════════════

/** epoch 毫秒 → 东八区业务日 `YYYY-MM-DD`。 */
function beijingCycleDate(now) {
  return new Date(now + BEIJING_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

/** `YYYY-MM-DD` → 该日 00:00（东八区）的 epoch 毫秒；解析失败回 undefined。 */
function parseCycle(cycleDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(cycleDate ?? "").trim())
  if (!m) return undefined
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - BEIJING_UTC_OFFSET_MS
}

/**
 * 该业务日的重置时刻 = 次一北京日的 **00:05**（ISO 字符串）。
 *
 * 留 5 分钟：踩北京 0 点的那次请求不该记到厂商已经关闭的那一天上。
 * `cycleDate` 解析不出来时，退到「now 所在北京日的次日 00:05」。
 * 若算出来已经过去（缓存里的旧日期），再推一天，**不返回过去的时间**
 * —— magpie 拿 resetsAt 算倒计时，给旧值会显示成「已重置」。
 */
function beijingResetAt(cycleDate, now) {
  const parsed = parseCycle(cycleDate)
  const day = parsed !== undefined ? parsed : beijingMidnightOf(now)
  let reset = day + 86_400_000 + 5 * 60_000
  while (reset <= now) reset += 86_400_000
  return new Date(reset).toISOString()
}

function beijingMidnightOf(now) {
  const d = new Date(now + BEIJING_UTC_OFFSET_MS)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - BEIJING_UTC_OFFSET_MS
}

/**
 * 这条 quota 是否还描述**当前**这个北京日。
 *
 * ⚠ 旧上限不能跨日沿用：上限是厂商的（活动会调），而它是**昨天**签到时
 *   拿到的。沿用昨天的数会让今日占比算错，所以日期已过就当作没有，
 *   等今天的签到 —— 宁可降级成「上限未知」，也不要谎报一个错占比。
 * ⚠ 完全没有日期时**保守保留**：`dailyCycleDate` 是厂商字段，可能不下发，
 *   而「永远等不到上限」比「偶尔沿用一次」更接近缺陷。
 */
function quotaCoversCycle(cycleDate, now) {
  const parsed = parseCycle(cycleDate)
  if (parsed === undefined) return true
  return parsed + 86_400_000 + 5 * 60_000 > now + 60_000
}

// ════════════════════════════════════════════════════════════════════
// ③ 流水推导 + 读数合并
// ════════════════════════════════════════════════════════════════════

/** 本业务日从 daily 池扣掉的总分（V1 records 才有这两个维度）。 */
function dailyConsumedByCycle(list, cycleDate) {
  let sum = 0
  for (const row of Array.isArray(list) ? list : []) {
    if (row?.direction !== "debit") continue
    if (row?.consumeSource !== "daily") continue
    const rowCycle = typeof row?.dailyCycleDate === "string" ? row.dailyCycleDate.trim() : ""
    if (cycleDate !== undefined && rowCycle !== "" && rowCycle !== cycleDate) continue
    const n = num(row?.pointsActual, 0)
    if (n > 0) sum += n
  }
  return sum
}

/**
 * 把三个上限来源合成一条 quota。优先序：
 *   签到实测（凭据里记的）> 流水推导 > 未知
 *
 * 每条都过 `quotaCoversCycle`：跨日的旧值一律作废。
 */
function mergeQuotaReadings(remembered, derived, now) {
  const remValue = num(remembered?.value, undefined)
  if (
    remValue !== undefined &&
    remValue > 0 &&
    quotaCoversCycle(remembered?.cycleDate, now)
  ) {
    return {
      value: remValue,
      cycleDate: remembered?.cycleDate ?? undefined,
      consumed: num(derived?.consumed, undefined),
      known: true,
      source: "checkin",
    }
  }

  const derValue = num(derived?.value, undefined)
  if (derValue !== undefined && derValue > 0) {
    return {
      value: derValue,
      cycleDate: derived?.cycleDate ?? undefined,
      consumed: num(derived?.consumed, 0),
      known: true,
      source: "derived",
    }
  }

  return { value: undefined, cycleDate: undefined, consumed: undefined, known: false, source: "unknown" }
}

// ════════════════════════════════════════════════════════════════════
// ④ 凭据形状
// ════════════════════════════════════════════════════════════════════

/**
 * magpie 交来的 auth 有四种形态，全部要认（sucooer 只认第一种，
 * 于是收到 provider 映射就返回 null → 卡片永远「未登录」）：
 *
 *   A `{type:"oauth", access, refresh, expires, accountId, uid, phone, dailyQuota…}`
 *   B `{type:"oauth", access}`
 *   C provider 映射 `{"loomy":{…}, "loomy#xxxx":{…}}`
 *   D 裸 session 字符串
 */
function credentialOf(auth) {
  if (typeof auth === "string") {
    const session = auth.trim()
    return session ? { session, accountId: "", uid: "", phone: "" } : null
  }
  if (!auth || typeof auth !== "object") return null

  if (typeof auth.access === "string" && auth.access.trim()) return fromRecord(auth)

  const candidates = [auth[PROVIDER], ...Object.values(auth)].filter(
    (v) => v && typeof v === "object" && typeof v.access === "string" && v.access.trim(),
  )
  return candidates.length ? fromRecord(candidates[0]) : null
}

function fromRecord(rec) {
  return {
    session: String(rec.access).trim(),
    accountId: typeof rec.accountId === "string" ? rec.accountId : "",
    uid: typeof rec.uid === "string" ? rec.uid : "",
    phone: typeof rec.phone === "string" ? rec.phone : "",
    dailyQuota: num(rec.dailyQuota, undefined),
    dailyCycleDate: typeof rec.dailyCycleDate === "string" && rec.dailyCycleDate.trim()
      ? rec.dailyCycleDate.trim()
      : undefined,
    expires: num(rec.expires, undefined),
  }
}

function maskPhone(phone) {
  const chars = [...String(phone ?? "")]
  if (chars.length < 7) return String(phone ?? "")
  return `${chars.slice(0, 3).join("")}****${chars.slice(-4).join("")}`
}

function normalizePhone(raw) {
  const trimmed = String(raw ?? "").replace(/[\s-]/g, "").replace(/^\+86/, "")
  const digits = /^86\d{11}$/.test(trimmed) ? trimmed.slice(2) : trimmed
  if (!/^1[3-9]\d{9}$/.test(digits)) throw Object.assign(new Error("请填写 11 位中国大陆手机号"), { status: 400 })
  return digits
}

function normalizeCode(raw) {
  const trimmed = String(raw ?? "").trim()
  if (!/^\d{6}$/.test(trimmed)) throw Object.assign(new Error("请填写 6 位数字验证码"), { status: 400 })
  return trimmed
}

// ════════════════════════════════════════════════════════════════════
// ⑤ 模型目录
// ════════════════════════════════════════════════════════════════════

/** 从展示名尾部拆 `(x3.0)` / `（x0.8）` 形态的积分倍率，其余标签原样保留。 */
function splitRateSuffix(name) {
  const trimmed = String(name ?? "").trimEnd()
  const half = trimmed.endsWith(")")
  const full = trimmed.endsWith("）")
  if (!half && !full) return [trimmed, undefined]
  const open = trimmed.lastIndexOf(half ? "(" : "（")
  if (open < 0) return [trimmed, undefined]
  const inner = trimmed.slice(open + 1, trimmed.length - 1).trim()
  const digits = /^[xX]([\d.]+)$/.exec(inner)?.[1]
  if (!digits || !/\d/.test(digits)) return [trimmed, undefined]
  const body = trimmed.slice(0, open).trimEnd()
  return [body || trimmed, `x${digits}`]
}

/**
 * 这个模型**不花账号的积分**吗？—— magpie 的 `free` 字段。
 *
 * 为什么需要它：magpie 有 `"free"` 这个路由模式（界面叫 *Free first*），
 * 契约原文是「模型供应商不消耗本订阅的额度或积分」。命中它的模型会被
 * **优先派发**，所以标错等于把本该免费的请求算进收费档。
 *
 * ⚠ 判据**不能**只看 `rate === 0`：
 *   - 本机实测 `plugin-providers.json` 里 `rate === 0` 的条目 51 条，
 *     其中 `free: true` 只有 13 条 —— 其余是「套餐内不按次计费」，
 *     例如 qoder 的 `ultimate` / `dfmodel`，它们仍消耗套餐额度，不是免费。
 *   - Loomy 的 `auto`（自动·均衡）也没有倍率文本，但它会落到别的模型上
 *     去花积分，同样不是免费。
 *
 * Loomy 的判据只有两条，且都来自上游自己的文字：
 *   1. 展示名里明确写了「免费」（如 `Spark-X2.6 正式版(限时免费)(x0.0)`）
 *   2. 倍率文本是 `x0.0`（成本 0 倍，即不扣分）
 * 两者都是上游写在 `name` 里的声明，不是我们从别处推的。
 */
function isFreeModel(displayName, rate) {
  const name = String(displayName ?? "")
  if (/免费/.test(name)) return true
  return typeof rate === "string" && /^x0(\.0+)?$/i.test(rate.trim())
}

/**
 * 解析 `GET /api/v1/models`（实测 13 条 chat 模型）。
 *
 * ⚠ 只保留 `type === "chat"`：上游还下发 image 型条目，列出来就是
 *   让用户选中一个必然失败的「模型」。
 */
function parseModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  const out = []
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : ""
    if (!id) continue
    if (typeof row?.type === "string" && row.type !== "chat") continue

    const caps = row?.capabilities && typeof row.capabilities === "object" ? row.capabilities : undefined
    const [name, rate] = splitRateSuffix(typeof row?.name === "string" && row.name.trim() ? row.name : id)
    const efforts = Array.isArray(row?.reasoning_efforts)
      ? row.reasoning_efforts.filter((e) => typeof e === "string" && e.trim() !== "")
      : []

    out.push({
      id,
      name: name || id,
      context: positive(row?.context_length) ?? positive(row?.context_window) ?? positive(row?.max_input_tokens),
      output: positive(row?.max_output_tokens) ?? positive(row?.max_completion_tokens),
      reasoning: caps?.reasoning === true || efforts.length > 0,
      toolCall: caps?.function_calling !== false,
      images: caps?.vision === true || hasModality(caps?.input_modalities, "image"),
      video: hasModality(caps?.input_modalities, "video"),
      efforts,
      defaultEffort:
        typeof row?.default_reasoning_effort === "string" ? row.default_reasoning_effort : undefined,
      rate,
      free: isFreeModel(row?.name, rate),
    })
  }
  return out
}

function hasModality(list, want) {
  return Array.isArray(list) && list.some((v) => typeof v === "string" && v.toLowerCase() === want)
}

function positive(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 上游模型 → magpie 的模型条目。
 *
 * ⚠ `limit.context` 会被 magpie 转给 agent，决定它何时压缩对话；更要紧的是
 *   **路由组按组内最大值算窗口** —— 填小会把整组拉低（本工作区踩过：
 *   插件声明 131072 而卡片填 1M，同一个模型两条路径报两个值）。
 *   Loomy 的 chat 模型上游实测就是 1,048,576，**原样上报，不二次收缩**。
 */
function modelShape(m, base = {}) {
  const efforts = m.efforts ?? []
  const shape = {
    ...base,
    id: m.id,
    name: m.name || m.id,
    api: { id: m.id, url: base?.api?.url, npm: base?.api?.npm },
    status: "active",
    limit: {
      context: m.context ?? base?.limit?.context ?? 0,
      output: m.output ?? base?.limit?.output ?? 0,
    },
    capabilities: {
      temperature: true,
      reasoning: !!m.reasoning,
      attachment: !!m.images,
      toolcall: m.toolCall !== false,
      input: { text: true, image: !!m.images, audio: false, video: !!m.video, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    variants: m.reasoning
      ? Object.fromEntries((efforts.length ? efforts : ["low", "medium", "high"]).map((e) => [e, {}]))
      : {},
  }
  if (m.rate) shape.rate = m.rate
  // ⚠ free 只由模型自己的声明决定（见 isFreeModel 的判据），
  //   **不要**在这里按「有没有 rate」反推 —— 那样 `x0.0` 会被误判成收费。
  shape.free = m.free === true
  return shape
}

// ════════════════════════════════════════════════════════════════════
// ⑥ 图片格式适配
// ════════════════════════════════════════════════════════════════════

/**
 * deepseek 系模型只认 `<image_base64>` 标记；喂标准 `image_url` data URI
 * 会被上游当成截断的 base64 文本读（agent2api loomy/images.rs 的实测结论）。
 * 宁可不转，不能转错 —— 非 deepseek 一律不动。
 */
function prefersTagFormat(modelId) {
  return String(modelId ?? "").toLowerCase().includes("deepseek")
}

function tagOfBlock(block) {
  if (!block || block.type !== "image_url") return null
  const url = block?.image_url?.url
  if (typeof url !== "string" || !url.startsWith("data:")) return null
  const comma = url.indexOf(",")
  if (comma < 0) return null
  return `<image_base64>${url.slice(comma + 1)}</image_base64>`
}

/** 把 image 块并入相邻 text 块（上游实测认可的形态）。 */
function rewriteImagesToTags(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (!messages) return body
  const convertible = messages.some(
    (msg) => Array.isArray(msg?.content) && msg.content.some((b) => tagOfBlock(b) !== null),
  )
  if (!convertible) return body

  const next = JSON.parse(JSON.stringify(body))
  for (const message of next.messages) {
    if (!Array.isArray(message?.content)) continue
    const content = message.content
    for (let index = content.length - 1; index >= 0; index--) {
      const tag = tagOfBlock(content[index])
      if (tag === null) continue
      content.splice(index, 1)
      const previous = index > 0 ? content[index - 1] : null
      if (previous?.type === "text" && typeof previous.text === "string") {
        previous.text += `\n${tag}`
      } else if (content[index]?.type === "text" && typeof content[index].text === "string") {
        content[index].text = `${tag}\n${content[index].text}`
      } else {
        content.splice(index, 0, { type: "text", text: tag })
      }
    }
  }
  return next
}

// ════════════════════════════════════════════════════════════════════
// ⑦ 账号接口签名（HMAC-SHA1，复刻客户端 generateSignature）
// ════════════════════════════════════════════════════════════════════

/** 路径分段转义。当前账号接口只含字母与 `/`，仍实现完整规则以免将来静默出错。 */
function buildEscapedPath(p) {
  let clean = String(p ?? "")
  if (!clean.startsWith("/")) clean = `/${clean}`
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1)
  return clean
    .split("/")
    .map((segment) => {
      let out = ""
      for (const byte of new TextEncoder().encode(segment)) {
        const ch = String.fromCharCode(byte)
        out += /[A-Za-z0-9\-_.~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
      }
      return out
    })
    .join("/")
}

/**
 * 待签串 9 段 `\n` 连接：
 *   METHOD\n ESCAPED_PATH\n ""(query)\n CONTENT_MD5\n content-type\n
 *   DATE(UTC)\n NONCE\n ""(signed headers)\n ""(canonicalized headers)
 *
 * 加密原语由调用方注入（`crypto.mjs`），这样本文件保持纯函数、可离线测。
 */
function signedHeaders(method, path, bodyString, secrets) {
  const md5 = bodyString ? secrets.md5Base64(bodyString) : ""
  const date = secrets.utcnow()
  const nonce = secrets.uuid()
  const stringToSign = [
    String(method).toUpperCase(),
    buildEscapedPath(path),
    "",
    md5,
    "application/json",
    date,
    nonce,
    "",
    "",
  ].join("\n")
  const signature = secrets.hmacSha1Base64(secrets.accessKeySecret, stringToSign)
  const headers = {
    Authorization: `account ${secrets.accessKeyId}:${signature}`,
    Date: date,
    Nonce: nonce,
  }
  if (md5) headers["Content-MD5"] = md5
  return headers
}

// ════════════════════════════════════════════════════════════════════
// ⑧ 信封、错误归类、签到 outcome
// ════════════════════════════════════════════════════════════════════

function businessCode(payload) {
  return typeof payload?.code === "string" ? payload.code.trim() : ""
}

function upstreamMessage(payload) {
  const text = payload?.desc ?? payload?.message ?? payload?.msg
  return typeof text === "string" ? text.trim() : ""
}

function isAuthErrorCode(code) {
  return ["020002", "100002"].includes(code)
}

/** 业务码非 000000 时抛；登录态失效归 401 并带 `signIn:"expired"`（magpie 据此标记账号）。 */
function ensureSuccess(payload, what) {
  const code = businessCode(payload)
  if (code === "000000") return
  const message = upstreamMessage(payload)
  const detail = message ? `${what}：${message}` : `${what}失败（上游 code=${code || "无"}）`
  if (isAuthErrorCode(code)) throw Object.assign(new Error(detail), { signIn: "expired", status: 401 })
  throw Object.assign(new Error(detail), { status: 502 })
}

/**
 * 「积分余额不足」判据 —— 必须**窄**。
 *
 * 上游是 HTTP 400 + 中文文案，不是结构化额度错误；泛词（quota/balance/不足）
 * 会误伤模型正文里恰好讨论「余额」的内容。
 */
function looksLikeInsufficientPoints(text) {
  const t = String(text ?? "")
  return /积分余额不足|积分不足|余额不足，请获取积分|请获取积分后再试/.test(t)
}

/**
 * 把签到结果映射成 magpie 的 outcome。
 *
 * ⚠⚠ 这是市场插件正在犯的那个错：契约的合法值只有
 *   `claimed / done / ineligible / inactive / captcha / failed`
 *   （`magpie-plugin-contract-full.txt` 的 `checkinOutcomes`）。
 *   sucooer 成功时返回 `{outcome:"success"}` —— 不在表里，
 *   magpie 一律归为 `failed` 但**保留 message**，于是用户看到
 *   「签到失败 · 每日赠送积分已刷新」这种自相矛盾的行。
 *
 * 幂等判据是响应体的 `alreadyProcessed`（重复调用同样回 HTTP 200），
 * 所以「今天已领」必须是 `done` 而不是 `claimed` —— 后者会让用户
 * 以为每天都真的加了额度。
 */
function checkinOutcome(raw) {
  if (raw?.ok === false) {
    return { outcome: "failed", message: raw.message || "每日额度刷新失败" }
  }
  if (raw?.alreadyProcessed === true) {
    const quota = num(raw?.dailyQuota, undefined)
    const balance = num(raw?.dailyBalance, undefined)
    return {
      outcome: "done",
      message: quota === undefined
        ? "今日额度已刷新"
        : `今日额度已刷新（${balance ?? 0}/${quota} 积分）`,
    }
  }
  // 首次处理：本次新发放的额度 = quota - consumed（两个都缺时不编造）
  const quota = num(raw?.dailyQuota, undefined)
  const consumed = num(raw?.dailyConsumed, undefined)
  const balance = num(raw?.dailyBalance, undefined)
  const credit =
    quota !== undefined && consumed !== undefined
      ? Math.max(0, quota - consumed)
      : (balance ?? quota ?? 0)
  return {
    outcome: "claimed",
    credit,
    message: `每日赠送额度已刷新（+${credit} 积分）`,
  }
}
