// 团队积分：共享余额和当前成员的每日限额是两项独立约束。
// 个人钱包即使有分，也不能当作当前团队的可用额度。

import { fetchTeamIdentity, fetchTeamBalances } from "./api.mjs"
import { _pure } from "./pure.mjs"

const { beijingCycleDate, beijingResetAt } = _pure

/** 缺字段不是 0；尤其不能把 null / 空串当成「团队已耗尽」。 */
function points(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function dailyTextWindow(display) {
  return { name: "团队每日额度", used: 0, aside: true, display, unit: "积分" }
}

/** 返回 null 才表示服务端当前处于个人模式；查询失败交给 usage 如实报错。 */
export async function readTeamUsage(credential, now, fetcher) {
  const identity = await fetchTeamIdentity(credential.session, fetcher)
  if (!identity) return null
  const data = await fetchTeamBalances(credential.session, fetcher)
  // 两次 GET 之间用户可能在客户端切了团队，不把另一团队的余额贴到旧名字上。
  if (data.teamId !== identity.id) throw new Error("团队已切换或读数不一致，请刷新积分")
  const balance = points(data.currentBalance)
  if (balance === undefined) throw new Error("团队积分读数异常（上游没有返回有效的 currentBalance）")
  if (typeof data.dailyLimitEnabled !== "boolean") throw new Error("团队每日额度读数异常（缺少 dailyLimitEnabled）")

  const limit = points(data.dailyLimitPoints)
  const consumed = points(data.dailyConsumedPoints)
  const remaining = points(data.dailyRemainingPoints)
  const currentCycle = data.dailyLimitTimezone === "Asia/Shanghai" && data.dailyLimitCycleDate === beijingCycleDate(now)
  const known = currentCycle && limit !== undefined && consumed !== undefined && remaining !== undefined
  const windows = []

  if (!data.dailyLimitEnabled) {
    windows.push(dailyTextWindow("未设置每日上限"))
  } else if (known) {
    windows.push({
      name: "团队每日额度",
      used: limit > 0 ? Math.min(100, Math.round((10000 * consumed) / limit) / 100) : 100,
      amount: consumed,
      limit,
      display: `${remaining} / ${limit} 积分`,
      unit: "积分",
      resetsAt: beijingResetAt(data.dailyLimitCycleDate, now),
    })
  } else {
    // 旧业务日 / 缺字段不能沿用，更不能写成 0 或满额。
    windows.push(dailyTextWindow("今日额度未知，请刷新"))
  }

  windows.push({
    name: "团队剩余积分",
    used: balance === 0 ? 100 : 0,
    // 共享池没有每日重置；正余额只展示，不用累计充值伪造占比。
    // 池已空时必须有参与路由的 spent 窗口；无每日上限时此窗口表达可用状态。
    ...(balance > 0 && data.dailyLimitEnabled ? { aside: true } : {}),
    display: balance === 0 ? "团队积分已耗尽" : `${balance} 积分（团队共享）`,
    unit: "积分",
  })

  return {
    ...(credential.accountId || credential.phone ? { user: credential.accountId || credential.phone } : {}),
    plan: identity.name ? `团队 · ${identity.name}` : "团队",
    balance: `${balance} 积分（团队共享）`,
    windows,
    signIn: "kept",
    // 内部字段供本地额度闸使用；不把团队每日上限写进个人签到凭据。
    _team: { balance, ...(data.dailyLimitEnabled && known ? { remaining } : {}) },
  }
}
