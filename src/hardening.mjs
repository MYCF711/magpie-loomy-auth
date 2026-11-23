// 安全加固的公共件：凭据脱敏 + 上游白名单。
//
// 这两件事都在**热路径**上（每个错误消息、每个出站 URL），所以只做纯函数、
// 不做 IO、不缓存全局状态。

/** 官方上游主机白名单 —— 硬编码，不受环境变量影响。 */
export const ALLOWED_HOSTS = Object.freeze(["loomyad.xunfei.cn", "account.xfinfr.com"])

/** session 是 32 位十六进制串；签名密钥是 16/32 位字母数字。别的一律不猜。 */
const SECRET_PATTERNS = [
  /\b[0-9a-f]{32}\b/gi, // session / token
  /\b(?:csk|sk)[-_][A-Za-z0-9_-]{6,}\b/g, // 形如 csk_ / sk- 的 key
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // 任何落到文本里的 Bearer
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
]

/**
 * 把一段文本里的凭据换成 `***`。
 *
 * ⚠ 只在**要给别人看的字符串**上调用（错误消息、日志、响应头、诊断信息），
 *   不要拿它处理请求体 —— 那会把用户正常内容改坏。
 */
export function redact(text, extra = []) {
  if (typeof text !== "string" || !text) return text ?? ""
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "***")
  for (const secret of extra) {
    const value = String(secret ?? "").trim()
    if (value.length >= 8) out = out.split(value).join("***")
  }
  // 手机号：只留前 3 后 4
  out = out.replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, "$1****$2")
  return out
}

/** 造一个 `Error`，message 已脱敏，原文放 `cause`（不参与序列化）。 */
export function safeError(message, extra = []) {
  const error = new Error(redact(message, extra))
  return error
}

/**
 * 只允许打官方上游。
 *
 * 抛错而不是返回 false：调用方忘了判断就是安全漏洞，所以这里 fail-closed。
 */
export function assertUpstream(url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw safeError(`上游地址不合法：${String(url).slice(0, 80)}`)
  }
  if (parsed.protocol !== "https:") throw safeError(`上游必须是 https：${parsed.protocol}`)
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw safeError(`上游主机不在白名单：${parsed.hostname}`)
  }
  return parsed
}
