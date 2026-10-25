// 宿主契约 + 挂载测试（离线，全部注入桩 fetch，不消费额度）
//
// 验的是 magpie 真正要求的东西：
//   ① 入口只导出插件工厂（它会把**每个函数导出**都当工厂调用）
//   ② 九项钩子齐全
//   ③ config() 未登录也要有模型（否则卡片显示 "0 models"）
//   ④ authorize() 立刻返回（死等会和 magpie 双向死锁）
//   ⑤ loader() 给出 baseURL/apiKey/fetch
//   ⑥ usage() 的窗口形状符合契约（used 是数字、aside 是布尔、amount/limit 只在真有时给）
//   ⑦ 拿不到读数时**不许**把额度报成 0

import { test } from "node:test"
import assert from "node:assert/strict"

import * as entry from "../index.mjs"
import { _internal } from "../index.mjs"

const { LoomyAuthPlugin } = entry
const { pure, staticModels, readUsage, publicUsage } = _internal

/** 每个用例一个独立 session —— 额度缓存就是这么键控的，复用会串号。 */
let seq = 0
const freshCred = (extra = {}) => ({
  session: `S-test-${++seq}`,
  accountId: "测试号",
  uid: "u1",
  phone: "",
  ...extra,
})

/** 桩 fetch：按 URL 回不同的罐头响应，并记录请求次数。 */
function stubFetch(routes) {
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" })
    for (const [match, reply] of routes) {
      if (String(url).includes(match)) return reply()
    }
    return json({ code: "000000", data: {} })
  }
  fetcher.calls = calls
  return fetcher
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

// ── ① 入口形状 ──────────────────────────────────────────────────────

test("入口只导出一个函数（插件工厂）—— magpie 会把每个函数导出都当工厂调用", () => {
  const functions = Object.entries(entry)
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k)
  assert.deepEqual(functions, ["LoomyAuthPlugin"])
})

test("_internal 里没有函数堆在顶层（helper 必须藏在数据对象或 src 模块里）", () => {
  // _internal 自身是对象，magpie 不会调它；只确认它不在函数导出里
  assert.equal(typeof _internal, "object")
})

// ── ② 九项钩子 ──────────────────────────────────────────────────────

test("九项钩子齐全", async () => {
  const plugin = await LoomyAuthPlugin({ client: {}, directory: undefined })
  assert.equal(typeof plugin.config, "function")
  assert.ok(plugin.auth && typeof plugin.auth === "object")
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.equal(typeof plugin.provider.models, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(plugin.provider.id, "loomy")
  assert.ok(plugin.auth.icon?.startsWith("data:image/"), "图标必须内嵌（外部 URL 在 git 源下不渲染）")
  assert.ok(Number.isFinite(plugin.auth.maxConcurrency))
})

test("三种登录方式都在，且 authorize() 立刻返回 —— 不许在里面等用户", async () => {
  const plugin = await LoomyAuthPlugin({ client: {} })
  assert.equal(plugin.auth.methods.length, 3)

  for (const method of plugin.auth.methods) {
    const t0 = Date.now()
    let flow
    try {
      flow = await method.authorize({})
    } catch (error) {
      // 桌面端没装时允许失败，但必须是「返回 failed」而不是抛出去
      assert.fail(`authorize 抛异常了：${error?.message}`)
    }
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 3000, `${method.label} 的 authorize 用了 ${elapsed}ms，太久（会和 magpie 死锁）`)
    assert.ok(flow && typeof flow === "object")
    if (flow.type === "failed") {
      assert.equal(typeof flow.error, "string")
      continue
    }
    assert.equal(typeof flow.callback, "function", `${method.label} 必须给 callback`)
    assert.equal(typeof flow.instructions, "string")
  }
})

// ── ③ config() ─────────────────────────────────────────────────────

test("config() 未登录也声明了模型（否则卡片显示 0 models）", async () => {
  const plugin = await LoomyAuthPlugin({ client: {} })
  const cfg = {}
  await plugin.config(cfg)
  const models = cfg.provider?.loomy?.models
  assert.ok(models && Object.keys(models).length >= 10, `模型太少：${Object.keys(models ?? {}).length}`)
  // 静态表里不许出现 image 型条目
  assert.equal("Hy-Image-3.5-preview" in models, false)
  assert.equal("doubao-seedream-5-lite" in models, false)
})

test("静态表里的上下文是实测值，不是占位（1M 档不许被「保守填小」）", async () => {
  const models = staticModels()
  assert.equal(models["DeepSeek-V4.1-Flash"].limit.context, 1_048_576)
  assert.equal(models["DeepSeek-V4.1-Flash"].limit.output, 384_000)
  assert.equal(models["Kimi-k2.6"].limit.context, 262_144)
  assert.ok(models.auto, "auto 也要在（上游有时不下发它）")
})

// ── ④ loader ───────────────────────────────────────────────────────

test("loader() 给 baseURL / apiKey / fetch", async () => {
  const plugin = await LoomyAuthPlugin({ client: {} })
  const session = { type: "oauth", access: "S-loader" }
  const out = await plugin.auth.loader(async () => session, { id: "loomy" })
  assert.equal(typeof out.fetch, "function")
  assert.equal(typeof out.baseURL, "string")
  assert.ok(out.baseURL.includes("loomyad.xunfei.cn"))
  assert.ok(out.apiKey, "apiKey 必须有（占位也行，真正鉴权头在 fetch 里换）")
})

// ── ⑤ usage() 的形状与语义 ──────────────────────────────────────────

test("usage()：上限已知 → 今日池真占比 + 永久池 aside", async () => {
  const fetcher = stubFetch([
    ["/points/balance", () => json({ code: "000000", data: { balance: 5500, dailyBalance: 4014, availableBalance: 9514 } })],
  ])
  const value = await readUsage(
    freshCred({ dailyQuota: 5000, dailyCycleDate: pure.beijingCycleDate(Date.now()) }),
    { fetcher },
  )
  const usage = publicUsage(value)

  assert.equal(usage.balance, "9514 积分")
  assert.equal(usage.windows.length, 2)
  const [today, permanent] = usage.windows

  assert.equal(today.name, "今日积分")
  assert.equal(today.used, 19.72)
  assert.equal(today.limit, 5000)
  assert.equal(today.amount, 986)
  assert.equal(today.unit, "积分")
  assert.equal(typeof today.resetsAt, "string")
  assert.equal("aside" in today, false, "今日池必须参与路由")

  assert.equal(permanent.aside, true, "永久池不许参与路由")
  assert.equal("_quota" in usage, false, "内部字段不许漏给 magpie")
})

test("usage()：号被蹬空 → 一条 used:100 的参与路由窗口（这是修好路由的关键）", async () => {
  const fetcher = stubFetch([
    ["/points/balance", () => json({ code: "000000", data: { balance: 0, dailyBalance: 0, availableBalance: 0 } })],
  ])
  const value = await readUsage(freshCred(), { fetcher })
  const usage = publicUsage(value)

  assert.equal(usage.balance, "0 积分")
  assert.equal(usage.windows.length, 1)
  assert.equal(usage.windows[0].used, 100)
  assert.equal("aside" in usage.windows[0], false, "aside 的死号不参与路由排序，会继续被选派")
})

test("usage()：读不到 balance 时报错，**不许**报成 0（0 和读不到是两件事）", async () => {
  const fetcher = stubFetch([["/points/balance", () => json({ code: "000000", data: {} })]])
  const usage = publicUsage(await readUsage(freshCred(), { fetcher }))
  assert.ok(usage.error, "必须给 error")
  assert.equal(usage.windows.length, 0)
  assert.notEqual(usage.balance, "0 积分")
})

test("usage()：上限从流水推导（凭据里没有时），且推导只要本业务日的 daily 扣分", async () => {
  const today = pure.beijingCycleDate(Date.now())
  const fetcher = stubFetch([
    ["/points/balance", () => json({ code: "000000", data: { balance: 5500, dailyBalance: 4014, availableBalance: 9514 } })],
    ["/points/records", () =>
      json({
        code: "000000",
        data: {
          balance: 5500,
          dailyBalance: 4014,
          availableBalance: 9514,
          total: 3,
          list: [
            { direction: "debit", consumeSource: "daily", dailyCycleDate: today, pointsActual: 986 },
            { direction: "debit", consumeSource: "daily", dailyCycleDate: "2026-01-01", pointsActual: 40000 },
            { direction: "debit", consumeSource: "permanent", dailyCycleDate: "", pointsActual: 12345 },
          ],
        },
      }),
    ],
  ])
  const usage = publicUsage(await readUsage(freshCred(), { fetcher }))
  assert.equal(usage.windows[0].limit, 5000, "quota = dailyBalance + 本日 daily 扣分 = 4014 + 986")
  assert.equal(usage.windows[0].used, 19.72)
})

test("usage()：上游 200 + 信封 100002 → signIn: expired（登录态要如实标记）", async () => {
  const fetcher = stubFetch([
    ["/points/balance", () => json({ code: "100002", desc: "登录已失效" })],
  ])
  const usage = publicUsage(await readUsage(freshCred(), { fetcher }))
  assert.equal(usage.signIn, "expired")
  assert.match(usage.error, /登录已失效|100002/)
})

// ── ⑥ chat.headers ─────────────────────────────────────────────────

test("chat.headers 只给本 provider 的请求加头", async () => {
  const plugin = await LoomyAuthPlugin({ client: {} })
  const out1 = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "loomy" }, sessionID: "sess-1" }, out1)
  assert.equal(out1.headers["x-loomy-session"], "sess-1")

  const out2 = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "sess-1" }, out2)
  assert.deepEqual(out2.headers, {})
})
