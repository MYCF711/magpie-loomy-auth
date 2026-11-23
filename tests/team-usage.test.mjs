// 全离线：验证团队共享池与成员每日限额，不能用个人钱包决定团队账号是否可用。
import { test } from "node:test"
import assert from "node:assert/strict"

import { LoomyAuthPlugin } from "../index.mjs"
import { readUsage, publicUsage, quotaToRemember, exhausted, clearUsageCache } from "../src/usage.mjs"
import { chatFetch } from "../src/chat.mjs"

const NOW = Date.parse("2026-11-23T10:00:00+08:00")
const TODAY = "2026-11-23"
const identity = { currentTeamId: "team-example", teams: [{ teamId: "team-example", name: "示例团队" }] }
const balance = {
  teamId: "team-example",
  currentBalance: 1234567,
  dailyLimitEnabled: true,
  dailyLimitPoints: 40000,
  dailyConsumedPoints: 3200,
  dailyRemainingPoints: 36800,
  dailyLimitCycleDate: TODAY,
  dailyLimitTimezone: "Asia/Shanghai",
}
let seq = 0
const credential = () => ({ session: `team-test-${++seq}`, accountId: "测试账号", dailyQuota: 5000, dailyCycleDate: TODAY })
const json = (data, code = "000000", status = 200) => new Response(JSON.stringify({ code, data }), {
  status, headers: { "Content-Type": "application/json" },
})

function stub(overrides = {}) {
  const calls = []
  const routes = {
    "/api/v1/user/identity": () => json(identity),
    "/api/v1/team-points/balance": () => json(balance),
    "/api/v1/points/balance": () => json({ balance: 0, dailyBalance: 0, availableBalance: 0 }),
    "/api/v1/points/records": () => json({ list: [], total: 0 }),
    ...overrides,
  }
  const fetcher = async (url, init) => {
    const path = new URL(String(url)).pathname
    calls.push({ path, init })
    assert.ok(routes[path], `不应调用 ${path}`)
    return routes[path]()
  }
  return { fetcher, calls }
}
const daily = (value) => value.windows.find((w) => w.name === "团队每日额度")
const shared = (value) => value.windows.find((w) => w.name === "团队剩余积分")

test("当前团队：只读官方身份和团队余额，展示共享余额与成员真实每日占比", async () => {
  const { fetcher, calls } = stub()
  const cred = credential()
  const value = await readUsage(cred, { now: NOW, fetcher })
  assert.equal(value.plan, "团队 · 示例团队")
  assert.equal(value.balance, "1234567 积分（团队共享）")
  assert.deepEqual(calls.map((c) => c.path), ["/api/v1/user/identity", "/api/v1/team-points/balance"])
  for (const { init } of calls) {
    assert.equal(init.method, "GET")
    assert.equal(init.body, undefined)
    assert.equal(init.headers.token, cred.session)
    assert.equal(init.headers.Authorization, `Bearer ${cred.session}`)
    assert.equal(init.headers["user-agent"], "Loomy|Desktop|Electron|macOS")
  }
  assert.deepEqual(daily(value), {
    name: "团队每日额度", used: 8, amount: 3200, limit: 40000,
    display: "36800 / 40000 积分", unit: "积分", resetsAt: "2026-11-23T16:05:00.000Z",
  })
  assert.equal(shared(value).aside, true)
  assert.equal(shared(value).limit, undefined, "不能把团队余额当成总量编造百分比")
  assert.equal(shared(value).resetsAt, undefined, "团队总池不能冒充每日重置")
  assert.equal(exhausted(value), false, "个人钱包为 0 不能挡住有团队额度的号")
  assert.equal(quotaToRemember(value, cred, NOW), undefined, "不能把团队 40000 写回个人签到的 5000")
  assert.equal(cred.dailyQuota, 5000)
  assert.equal("_team" in publicUsage(value), false)
  assert.equal("_quota" in publicUsage(value), false)
})

test("团队共享池为 0：每日额度仍显示真实剩余，但账号必须 spent 并被本地闸拦住", async () => {
  const { fetcher } = stub({ "/api/v1/team-points/balance": () => json({
    ...balance, currentBalance: 0, dailyConsumedPoints: 0, dailyRemainingPoints: 40000,
  }) })
  const value = await readUsage(credential(), { now: NOW, fetcher })
  assert.equal(daily(value).used, 0)
  assert.equal(daily(value).display, "40000 / 40000 积分")
  assert.equal(shared(value).used, 100)
  assert.notEqual(shared(value).aside, true)
  assert.equal(shared(value).resetsAt, undefined)
  assert.equal(exhausted(value), true)
  const res = await chatFetch({ input: "https://loomyad.xunfei.cn/api/v1/chat/completions", session: "unused", usageValue: value })
  const body = await res.json()
  assert.equal(res.status, 429)
  assert.equal(body.error.code, "rate_limited")
  assert.match(body.error.message, /团队/)
  assert.doesNotMatch(body.error.message, /永久积分/)
})

test("成员每日额度用完：团队还有余额也必须报 used:100 并拦截", async () => {
  const { fetcher } = stub({ "/api/v1/team-points/balance": () => json({
    ...balance, dailyConsumedPoints: 40000, dailyRemainingPoints: 0,
  }) })
  const value = await readUsage(credential(), { now: NOW, fetcher })
  assert.equal(daily(value).used, 100)
  assert.equal(shared(value).aside, true)
  assert.equal(exhausted(value), true)
})

test("每日限额为 0 是真实不可用，不是无限额度", async () => {
  const { fetcher } = stub({ "/api/v1/team-points/balance": () => json({
    ...balance, dailyLimitPoints: 0, dailyConsumedPoints: 0, dailyRemainingPoints: 0,
  }) })
  const value = await readUsage(credential(), { now: NOW, fetcher })
  assert.equal(daily(value).used, 100)
  assert.equal(daily(value).display, "0 / 0 积分")
  assert.equal(exhausted(value), true)
})

test("没有每日上限：不把空 dailyRemainingPoints 当耗尽，共享池提供可用状态", async () => {
  const { fetcher } = stub({ "/api/v1/team-points/balance": () => json({
    ...balance, dailyLimitEnabled: false, dailyLimitPoints: 0, dailyConsumedPoints: 0, dailyRemainingPoints: 0,
  }) })
  const value = await readUsage(credential(), { now: NOW, fetcher })
  assert.equal(daily(value).display, "未设置每日上限")
  assert.equal(daily(value).aside, true)
  assert.notEqual(shared(value).aside, true)
  assert.equal(shared(value).limit, undefined)
  assert.equal(shared(value).resetsAt, undefined)
  assert.equal(exhausted(value), false)
})

for (const missing of [undefined, null, "", false, -1, "not-a-number"]) {
  test(`无效团队余额 ${String(missing)}：报错，不伪造 0、不回退到个人钱包`, async () => {
    const { fetcher, calls } = stub({ "/api/v1/team-points/balance": () => json({ ...balance, currentBalance: missing }) })
    const value = await readUsage(credential(), { now: NOW, fetcher })
    assert.match(value.error, /currentBalance/)
    assert.equal(value.balance, undefined)
    assert.equal(value.windows.length, 0)
    assert.equal(exhausted(value), false, "未知读数不能触发本地额度闸")
    assert.equal(calls.length, 2)
  })
}

for (const field of ["dailyLimitPoints", "dailyConsumedPoints", "dailyRemainingPoints"]) {
  test(`每日额度缺 ${field}：降级未知，不拿个人签到上限补齐`, async () => {
    const { fetcher } = stub({ "/api/v1/team-points/balance": () => json({ ...balance, [field]: null }) })
    const value = await readUsage(credential(), { now: NOW, fetcher })
    assert.equal(value.error, undefined)
    assert.equal(daily(value).aside, true)
    assert.equal(daily(value).limit, undefined)
    assert.match(daily(value).display, /未知/)
    assert.equal(exhausted(value), false)
  })
}

test("旧业务日用尽的每日额度不能挡住新业务日，也不伪造重置倒计时", async () => {
  const { fetcher } = stub({ "/api/v1/team-points/balance": () => json({
    ...balance, dailyLimitCycleDate: "2026-11-22", dailyConsumedPoints: 40000, dailyRemainingPoints: 0,
  }) })
  const value = await readUsage(credential(), { now: NOW, fetcher })
  assert.match(daily(value).display, /未知/)
  assert.equal(daily(value).resetsAt, undefined)
  assert.equal(exhausted(value), false)
})

test("不认识的时区不猜每日周期", async () => {
  const { fetcher } = stub({ "/api/v1/team-points/balance": () => json({ ...balance, dailyLimitTimezone: "UTC" }) })
  const value = await readUsage(credential(), { now: NOW, fetcher })
  assert.equal(daily(value).limit, undefined)
  assert.equal(daily(value).resetsAt, undefined)
})

test("身份与余额不是同一团队时拒绝混用", async () => {
  const { fetcher } = stub({ "/api/v1/team-points/balance": () => json({ ...balance, teamId: "another-team" }) })
  const value = await readUsage(credential(), { now: NOW, fetcher })
  assert.match(value.error, /团队已切换/)
  assert.equal(value.balance, undefined)
})

test("数字字符串可读，内部用户切到个人模式时仍读个人钱包", async () => {
  const { fetcher, calls } = stub({
    "/api/v1/user/identity": () => json({ isInternal: true, currentTeamId: "", teams: identity.teams }),
    "/api/v1/points/balance": () => json({ balance: "1500", dailyBalance: "4000", availableBalance: "5500" }),
  })
  const value = await readUsage(credential(), { now: NOW, fetcher })
  assert.equal(value.balance, "5500 积分")
  assert.equal(value.plan, undefined)
  assert.equal(value.windows[0].name, "今日积分")
  assert.equal(calls.some((c) => c.path.includes("team-points")), false)
})

test("团队数字字符串按真实数值解析，不受个人签到上限影响", async () => {
  const { fetcher } = stub({ "/api/v1/team-points/balance": () => json({
    ...balance, currentBalance: "1234567", dailyLimitPoints: "40000",
    dailyConsumedPoints: "3200", dailyRemainingPoints: "36800",
  }) })
  const value = await readUsage(credential(), { now: NOW, fetcher })
  assert.equal(daily(value).limit, 40000)
  assert.equal(daily(value).amount, 3200)
  assert.equal(daily(value).used, 8)
  assert.equal(exhausted(value), false)
})

test("不同登录态的团队余额缓存互不串号", async () => {
  const first = stub()
  const second = stub({ "/api/v1/team-points/balance": () => json({ ...balance, currentBalance: 0 }) })
  const credA = credential()
  const credB = credential()
  assert.equal(exhausted(await readUsage(credA, { now: NOW, fetcher: first.fetcher })), false)
  assert.equal(exhausted(await readUsage(credB, { now: NOW, fetcher: second.fetcher })), true)
  assert.equal(exhausted(await readUsage(credA, { now: NOW + 1000, fetcher: first.fetcher })), false)
  assert.equal(first.calls.length, 2)
  assert.equal(second.calls.length, 2)
})

test("身份/团队余额查询的过期信封原样标记 expired，不掩盖成个人模式", async () => {
  for (const path of ["/api/v1/user/identity", "/api/v1/team-points/balance"]) {
    const { fetcher, calls } = stub({ [path]: () => json({}, "100002") })
    const value = await readUsage(credential(), { now: NOW, fetcher })
    assert.equal(value.signIn, "expired")
    assert.ok(value.error)
    assert.equal(calls.some((c) => c.path === "/api/v1/points/balance"), false)
  }
})

test("身份网络失败只缓存 5 秒，恢复后重新查团队，不静默显示个人余额", async () => {
  let failed = true
  const { fetcher, calls } = stub({ "/api/v1/user/identity": () => {
    if (failed) throw new Error("network unavailable")
    return json(identity)
  } })
  const cred = credential()
  assert.ok((await readUsage(cred, { now: NOW, fetcher })).error)
  failed = false
  assert.ok((await readUsage(cred, { now: NOW + 1000, fetcher })).error)
  const value = await readUsage(cred, { now: NOW + 5001, fetcher })
  assert.equal(value.error, undefined)
  assert.equal(value.plan, "团队 · 示例团队")
  assert.equal(calls.length, 3)
})

test("成功缓存有界，过期后跟随服务端切换为个人模式", async () => {
  let inTeam = true
  const { fetcher, calls } = stub({ "/api/v1/user/identity": () => json(inTeam ? identity : { currentTeamId: "" }) })
  const cred = credential()
  await readUsage(cred, { now: NOW, fetcher })
  inTeam = false
  assert.equal((await readUsage(cred, { now: NOW + 1000, fetcher })).plan, "团队 · 示例团队")
  assert.equal(calls.length, 2)
  const personal = await readUsage(cred, { now: NOW + 60001, fetcher })
  assert.equal(personal.plan, undefined)
  assert.equal(personal.balance, "0 积分")
})

test("跨北京时间零点不沿用 60 秒缓存里的昨日 spent", async () => {
  let cycle = TODAY
  const { fetcher, calls } = stub({ "/api/v1/team-points/balance": () => json({
    ...balance, dailyLimitCycleDate: cycle, dailyConsumedPoints: cycle === TODAY ? 40000 : 0,
    dailyRemainingPoints: cycle === TODAY ? 0 : 40000,
  }) })
  const cred = credential()
  const before = Date.parse("2026-11-23T23:59:59+08:00")
  assert.equal(exhausted(await readUsage(cred, { now: before, fetcher })), true)
  cycle = "2026-11-24"
  assert.equal(exhausted(await readUsage(cred, { now: before + 2000, fetcher })), false)
  assert.equal(calls.length, 4)
})

test("宿主 usage 不附加个人新手任务窗口，也不把内部团队字段外泄", async (t) => {
  clearUsageCache()
  const { fetcher, calls } = stub({ "/api/v1/team-points/balance": () => json({
    ...balance, dailyLimitCycleDate: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
  }) })
  t.mock.method(globalThis, "fetch", fetcher)
  const plugin = await LoomyAuthPlugin({ client: {} })
  const value = await plugin.auth.usage(async () => ({ type: "oauth", access: "hook-team-test", accountId: "测试账号" }), { id: "loomy" })
  assert.equal(value.plan, "团队 · 示例团队")
  assert.equal(value.windows.length, 2)
  assert.equal("_team" in value, false)
  assert.equal("_quota" in value, false)
  assert.equal(calls.length, 2)
})
