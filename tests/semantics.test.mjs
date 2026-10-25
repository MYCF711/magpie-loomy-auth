// 额度窗口语义 —— 本插件存在的理由，四条判据全部锁死。
//
// ⚠ 这些用例是**反向验证过的**：把 windowsOf 改回「两池各画一条、
//   total = remaining」的市场插件写法，其中至少 4 条会变红。

import { test } from "node:test"
import assert from "node:assert/strict"

import { _internal } from "../index.mjs"

const { pure } = _internal
const { windowsOf, beijingCycleDate, beijingResetAt, quotaCoversCycle, dailyConsumedByCycle, mergeQuotaReadings } = pure

const NOW = Date.parse("2026-10-26T03:00:00+08:00") // 北京 2026-10-26 03:00
const TODAY = "2026-10-26"

const byName = (windows, name) => windows.find((w) => w.name === name)

// ── ① 号被蹬空：必须参与路由并报 100% ────────────────────────────────

test("两池皆 0 时合成一条 used:100 的参与路由窗口（不许 aside、不许消失）", () => {
  const windows = windowsOf({ permanent: 0, daily: 0, total: 0 }, { known: false }, NOW)
  assert.equal(windows.length, 1)
  const w = windows[0]
  assert.equal(w.used, 100)
  // 关键：不能是 aside —— 是 aside 就不参与路由排序，死号会继续被选中
  assert.equal("aside" in w, false)
  assert.equal(w.name, "今日积分")
})

test("蹬空且上限已知时，也仍然报 100% 而不是算出 0%", () => {
  const windows = windowsOf(
    { permanent: 0, daily: 0, total: 0 },
    { value: 5000, consumed: 5000, cycleDate: TODAY, known: true },
    NOW,
  )
  assert.equal(windows[0].used, 100)
  assert.equal("aside" in windows[0], false)
})

// ── ② 永久池恒 aside：不许伪造总量 ──────────────────────────────────

test("永久池是 aside 且不给 amount/limit（伪造 total=remaining 就是把占比说谎）", () => {
  const windows = windowsOf(
    { permanent: 5500, daily: 4802, total: 10302 },
    { value: 5000, consumed: 198, cycleDate: TODAY, known: true },
    NOW,
  )
  const permanent = byName(windows, "永久积分")
  assert.ok(permanent, "永久池必须画出来（用户要看得到余额）")
  assert.equal(permanent.aside, true)
  assert.equal("amount" in permanent, false)
  assert.equal("limit" in permanent, false)
  assert.equal("resetsAt" in permanent, false, "永久池没有周期，不该有重置时间")
})

test("永久池只剩它自己时也不参与路由（used 恒 0 且 aside）", () => {
  const windows = windowsOf(
    { permanent: 3000, daily: 0, total: 3000 },
    { value: 5000, consumed: 5000, cycleDate: TODAY, known: true },
    NOW,
  )
  const permanent = byName(windows, "永久积分")
  assert.equal(permanent.aside, true)
  // 今日池虽空但整号还有额度：今日窗口报 100%，永久池 aside 兜底展示
  assert.equal(byName(windows, "今日积分").used, 100)
})

// ── ③ 上限未知：绝不谎报 ────────────────────────────────────────────

test("上限未知时不声称占比（aside + used:0），但要说清还剩多少", () => {
  const windows = windowsOf({ permanent: 0, daily: 4014, total: 4014 }, { known: false, source: "unknown" }, NOW)
  const today = byName(windows, "今日积分")
  assert.equal(today.aside, true)
  assert.equal(today.used, 0)
  assert.equal("limit" in today, false)
  assert.match(today.display, /4014/)
  assert.match(today.display, /上限未知/)
})

test("上限未知也**不许**说成「剩余 100%」那种满额（limit 缺席即不画满幅）", () => {
  const windows = windowsOf({ permanent: 0, daily: 4014, total: 4014 }, { known: false }, NOW)
  assert.equal(byName(windows, "今日积分").limit, undefined)
})

// ── ④ 上限已知：真实占比 ────────────────────────────────────────────

test("上限已知时给真实占比与完整的 amount/limit/resetsAt", () => {
  const windows = windowsOf(
    { permanent: 5500, daily: 4014, total: 9514 },
    { value: 5000, consumed: 986, cycleDate: TODAY, known: true },
    NOW,
  )
  const today = byName(windows, "今日积分")
  assert.equal(today.used, 19.72)
  assert.equal(today.limit, 5000)
  assert.equal(today.amount, 986)
  assert.equal(today.display, "4014 / 5000 积分")
  assert.equal(today.resetsAt, "2026-10-26T16:05:00.000Z") // 北京次日 00:05
  assert.equal("aside" in today, false)
})

test("used 被夹在 0~100（上游做成超额也不给 magpie 一个越界值）", () => {
  const over = windowsOf(
    { permanent: 0, daily: 0, total: 10 },
    { value: 1000, consumed: 1500, cycleDate: TODAY, known: true },
    NOW,
  )
  assert.equal(byName(over, "今日积分").used, 100)
})

// ── ⑤ 业务日与跨日作废 ──────────────────────────────────────────────

test("业务日按东八区算", () => {
  assert.equal(beijingCycleDate(Date.parse("2026-10-25T16:30:00Z")), "2026-10-26")
  assert.equal(beijingCycleDate(Date.parse("2026-10-25T15:30:00Z")), "2026-10-25")
})

test("重置时刻落在次一北京日 00:05，且永远不在过去", () => {
  const reset = Date.parse(beijingResetAt(TODAY, NOW))
  assert.ok(reset > NOW, "不能给 magpie 一个已经过去的 resetsAt（会显示成已重置）")
  assert.equal(new Date(reset).toISOString(), "2026-10-26T16:05:00.000Z")
})

test("跨日的旧上限必须作废", () => {
  assert.equal(quotaCoversCycle(TODAY, NOW), true)
  assert.equal(quotaCoversCycle("2026-10-25", NOW), false, "昨天的上限不能拿来算今天")
  assert.equal(quotaCoversCycle(undefined, NOW), true, "厂商可能不下发日期，保守保留")
})

test("跨日作废后走「上限未知」而不是沿用旧值", () => {
  const quota = mergeQuotaReadings({ value: 5000, cycleDate: "2026-10-25" }, undefined, NOW)
  assert.equal(quota.known, false)
})

// ── ⑥ 流水推导（降级路径）────────────────────────────────────────────

test("只统计本业务日、daily 来源的扣分", () => {
  const list = [
    { direction: "debit", consumeSource: "daily", dailyCycleDate: TODAY, pointsActual: 198 },
    { direction: "debit", consumeSource: "daily", dailyCycleDate: TODAY, pointsActual: 2 },
    { direction: "debit", consumeSource: "daily", dailyCycleDate: "2026-10-25", pointsActual: 5000 },
    { direction: "debit", consumeSource: "permanent", dailyCycleDate: "", pointsActual: 5000 },
    { direction: "credit", consumeSource: "", dailyCycleDate: TODAY, pointsActual: 5000 },
  ]
  assert.equal(dailyConsumedByCycle(list, TODAY), 200)
})

test("推导出的上限优先于「未知」，但让位于签到实测值", () => {
  const derived = { value: 5000, cycleDate: TODAY, consumed: 986 }
  const remembered = { value: 5000, cycleDate: TODAY }
  assert.equal(mergeQuotaReadings(undefined, derived, NOW).source, "derived")
  assert.equal(mergeQuotaReadings(remembered, derived, NOW).source, "checkin")
  assert.equal(mergeQuotaReadings(undefined, undefined, NOW).known, false)
})

test("推不出来时不许编一个 0 当上限", () => {
  const quota = mergeQuotaReadings(undefined, { value: 0, cycleDate: TODAY, consumed: 0 }, NOW)
  assert.equal(quota.known, false)
  assert.equal(quota.value, undefined)
})
