// Loomy（讯飞）供应商插件 · 常量
//
// 两个网关（实测，2026-10-26）：
//   业务/积分/模型目录  https://loomyad.xunfei.cn   鉴权 = token 双头（session）
//   账号/短信登录        https://account.xfinfr.com  鉴权 = HMAC-SHA1 签名（公开客户端常量）

export { ICON } from "./icon.mjs"

export const PROVIDER = "loomy"
export const PROVIDER_NAME = "讯飞 Loomy"

export const INTEGRATION_BASE = trim(process.env.LOOMY_POINTS_BASE_URL) || "https://loomyad.xunfei.cn"
export const XFYUN_ACCOUNT_BASE =
  trim(process.env.LOOMY_ACCOUNT_BASE_URL) || "https://account.xfinfr.com"

export const NPM = "@ai-sdk/openai-compatible"

/** Loomy 无续期接口：会话固定 14 天（上游 expire=14d），到期只能重登。 */
export const SESSION_TTL_MS = 14 * 24 * 3600_000

/** 模型目录进程内缓存 */
export const CATALOG_TTL_MS = 10 * 60_000

/**
 * 额度进程内缓存（成功）。
 *
 * ⚠ 这个 TTL 同时也是**请求热路径上的额度闸**（chat 前读同一份缓存判耗尽），
 *   所以不能长：耗尽后最多再漏 60 秒的请求。
 * ⚠ 成功与失败分别存：失败短 TTL，否则一次网络抖动会让界面 60 秒都显示
 *   「查询失败」，用户重试也没用。
 */
export const USAGE_CACHE_TTL_MS = 60_000
export const USAGE_FAIL_TTL_MS = 5_000

/**
 * 耗尽闸的提前量：剩余额度低于这个值就**按已耗尽处理**。
 *
 * 为什么：每日池耗尽时上游的报错形态是 HTTP 400「积分余额不足」，
 * 会白烧一次请求还可能被 harness 归类重试；而本地余额读数最多旧 60 秒。
 * 留 1 分的提前量，宁可早停 1 分也不要撞上游报错。
 */
export const USAGE_LEAD_POINTS = 1

/**
 * 推导每日池上限时翻流水的上限（条/页）。
 * ⚠ 不能是 100：实测上游 `pageSize=100` 返回的是一份**不含当天记录**的旧快照
 *   （total 比 pageSize≤80 时少掉当天的条数，首页直接跳到昨天），
 *   于是推导永远看不到今天的扣分、`partial` 也永远为真。
 *   50 已实测能拿到当天记录。
 */
export const LEDGER_PAGE_SIZE = 50
export const LEDGER_MAX_PAGES = 6

export const SUCCESS_CODE = "000000"
/** 登录态失效的业务码（上游部分错误是 HTTP 200 + 信封 code）。 */
export const AUTH_ERROR_CODES = ["020002", "100002"]

/**
 * ERROR-CODES.md §3 词表里本插件真正用到的几个码。
 *
 * ⚠ `code` 是**机器读**的稳定标识，只能取词表内的值 —— 自造一个码等于没给：
 *   宿主按词表分支，词表外就是「不认识」，既不退避也不换号。CI 的「供应商插件规定」
 *   会静态判这一条（R2），历史上 `insufficient_points` 就是这么挂的。
 *
 * 只列用到的；加码要改 ERROR-CODES.md，不许各插件自己造词。
 */
export const ERROR_CODES = Object.freeze({
  /** 429 · 可退避 · 换号有救 —— 限流 / 账号冷却，本地额度闸也归这一桶 */
  rateLimited: "rate_limited",
  /** 503 · 可重试 —— 连不上上游（断连 / 拒连 / DNS），是上游那边出事，不是请求的问题 */
  upstreamUnavailable: "upstream_unavailable",
  /** 504 · 可重试 —— 等到超时 / 流被截断，宿主该退避或换号，不是「业务错误」 */
  upstreamTimeout: "upstream_timeout",
})

export const REQUEST_TIMEOUT_MS = 20_000
export const CHAT_TIMEOUT_MS = 300_000

/** 上游业务日按东八区计（实测 dailyCycleDate 与北京时间一致）。 */
export const BEIJING_UTC_OFFSET_MS = 8 * 3600_000

// ── 账号接口的公开客户端常量（随 Loomy 客户端分发，不是用户凭据）──
// 配了环境变量就用用户的（常量被厂商旋转时自救）。
export const SIGN_ACCESS_KEY_ID = trim(process.env.LOOMY_XFYUN_ACCESS_KEY_ID) || "2thryby66wxi53sk"
export const SIGN_ACCESS_KEY_SECRET =
  trim(process.env.LOOMY_XFYUN_ACCESS_KEY_SECRET) || "zsak6eadrbawz683wf5r3m2snrwj868r"
export const APP_ID = trim(process.env.LOOMY_XFYUN_APP_ID) || "GM3LOOMY"

export const CLIENT_MODEL_ID = "Web"
export const CLIENT_DEVICE_ID = "web"
/**
 * 官方 Loomy 桌面客户端的 UA —— **本插件唯一的 UA 常量**。
 * 三处出站都要用它：chat（loader 的 fetch）· 业务/积分网关 · 账号签名 API；
 * 与签名体 `base.ua` 是同一个值。
 * 禁止出现 `magpie/…` / `magpie-…/…` 形态：上游网关按 `<product>/<version>`
 * 认第三方客户端，命中即 403；不显式设置时 fetch 的默认 UA（`node`）同样不合规。
 */
export const CLIENT_UA = "Loomy|Desktop|Electron|macOS"
export const CLIENT_VERSION = "1.0.0"

function trim(v) {
  return typeof v === "string" ? v.trim().replace(/\/+$/, "") : ""
}
