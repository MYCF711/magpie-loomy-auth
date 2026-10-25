// Loomy · 额度读取（本插件唯一要写对的地方）
//
// ════════════════════════════════════════════════════════════════════
// 一次 usage() 做什么
// ════════════════════════════════════════════════════════════════════
//
//   1. 只读一次 `/api/v1/points/balance`（3 个字段，实测 61~233ms）
//   2. 上限（dailyQuota）按优先序取：
//        a. 凭据里记的（登录/签到时拿到）—— **0 额外请求**
//        b. 流水推导：dailyBalance + Σ(本业务日 consumeSource=daily 扣分)
//           —— 只在 a 过期或缺失时发，且翻页上限 6 页
//        c. 都没有 → 「上限未知」，画 aside，**不谎报占比**
//   3. 组成 windows（见 pure.windowsOf）
//
// ⚠ 为什么不能每次都用流水推导：`records` 带 `list`，耗尽的号一天上百条，
//   每次界面重绘都翻 6 页是浪费 —— 而 quota 一天只变一次（签到时）。
// ⚠ 为什么不能在 usage 里调 `first-login`：它是**写**端点。magpie 会频繁刷
//   这个卡片，在只读路径上调写端点 == 「打开面板就签到」。
//
// ════════════════════════════════════════════════════════════════════
// 缓存
// ════════════════════════════════════════════════════════════════════
//
// 按 session 键控，成功/失败分别存：失败短 TTL（5s）让用户重试立刻生效，
// 不能把一次网络抖动缓存 60 秒、让界面 60 秒都显示「查询失败」。

import { _pure } from "./pure.mjs"
import { USAGE_CACHE_TTL_MS, USAGE_FAIL_TTL_MS, USAGE_LEAD_POINTS } from "./constants.mjs"
import { fetchBalances, fetchDailyLedger } from "./api.mjs"

const { beijingCycleDate, balanceLine, windowsOf } = _pure

const cache = new Map() // session -> { at, value }

/**
 * 读一个账号的额度，返回 magpie 的 usage 结果。
 *
 * @param credential credentialOf() 的结果
 * @param now epoch 毫秒（注入以便测试）
 */
export async function readUsage(credential, { now = Date.now(), fetcher = fetch } = {}) {
  const key = credential.session
  const hit = cache.get(key)
  if (hit && now - hit.at < (hit.value?.error ? USAGE_FAIL_TTL_MS : USAGE_CACHE_TTL_MS)) {
    return hit.value
  }

  let value
  try {
    value = await compute(credential, now, fetcher)
  } catch (error) {
    value = {
      error: String(error?.message ?? error).slice(0, 300),
      windows: [],
      ...(error?.signIn === "expired" ? { signIn: "expired" } : {}),
    }
  }
  cache.set(key, { at: now, value })
  return value
}

async function compute(credential, now, fetcher) {
  const pools = await fetchBalances(credential.session, fetcher)
  if (!pools) {
    return { error: "积分读数异常（上游没有返回 balance）", windows: [], signIn: "kept" }
  }

  const cycleDate = beijingCycleDate(now)
  const remembered = { value: credential.dailyQuota, cycleDate: credential.dailyCycleDate }
  const covered = _pure.quotaCoversCycle(credential.dailyCycleDate, now)

  let derived
  if (!covered || !(credential.dailyQuota > 0)) {
    // 凭据里没有当天上限 → 用流水推一次（这是**降级路径**，不是主路径）
    try {
      const ledger = await fetchDailyLedger(credential.session, cycleDate, fetcher)
      if (!ledger.partial && (ledger.today || pools.daily > 0)) {
        const value = pools.daily + ledger.consumed
        if (value > 0) {
          derived = { value, cycleDate, consumed: ledger.consumed, source: "derived" }
        }
      }
    } catch {
      // 推导失败不算错：退回「上限未知」，绝不因此把额度说成 0
      derived = undefined
    }
  }

  const quota = _pure.mergeQuotaReadings(remembered, derived, now)
  const windows = windowsOf(pools, quota, now)

  return {
    ...(credential.accountId || credential.phone
      ? { user: credential.accountId || credential.phone }
      : {}),
    balance: balanceLine(pools.total),
    windows,
    signIn: "kept",
    // 内部字段，交给 index.mjs 决定要不要写回凭据
    _quota: quota,
  }
}

/**
 * usage 结果 → 是否值得把 quota 写回凭据。
 *
 * 只在**推导出当天上限**且凭据里还没有/已过期时写 —— 这样下一次 usage
 * 走 a 路径、0 额外请求。（签到路径拿到的实测值优先，会覆盖它。）
 */
export function quotaToRemember(value, credential, now = Date.now()) {
  const quota = value?._quota
  if (!quota?.known || !(quota.value > 0)) return undefined
  if (!quota.cycleDate) return undefined
  if (!_pure.quotaCoversCycle(quota.cycleDate, now)) return undefined
  const same = credential.dailyQuota === quota.value && credential.dailyCycleDate === quota.cycleDate
  return same ? undefined : { dailyQuota: quota.value, dailyCycleDate: quota.cycleDate }
}

/** 去掉内部字段，交给 magpie 的对象必须是纯净的 usage 形状。 */
export function publicUsage(value) {
  if (!value) return { error: "查询失败", windows: [] }
  const { _quota, ...rest } = value
  return rest
}

/**
 * 热路径闸：这个账号现在还能发请求吗？
 *
 * 只在**缓存里已有读数**且两池皆空时才拦（`USAGE_LEAD_POINTS` 的提前量见常量注释）。
 * 缓存为空时**放行** —— 宁可让上游回一次「积分余额不足」，也不要因为
 * 本地没读到数就把一个好好的号挡住。
 */
export function exhausted(value) {
  if (!value || value.error) return false
  const windows = Array.isArray(value.windows) ? value.windows : []
  if (!windows.length) return false
  const total = Number(String(value.balance ?? "").replace(/[^\d.-]/g, ""))
  return Number.isFinite(total) && total <= USAGE_LEAD_POINTS
}

export function clearUsageCache() {
  cache.clear()
}
