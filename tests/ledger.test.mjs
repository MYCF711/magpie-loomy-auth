// 流水翻页与「今日消耗」推导 —— PR #13 的两条缺陷在这里锁死。
//
// 缺陷一：LEDGER_PAGE_SIZE 曾是 100，而实测上游 `pageSize=100` 返回的是一份
//         **不含当天记录**的旧快照（total 少掉当天的条数，首页直接跳到昨天），
//         于是推导永远看不到今天的扣分。
// 缺陷二：翻页只认「rows.length >= total 或空页」为收全。4387 条流水的账号
//         pageSize=50 要翻 88 页，而上限 6 页 —— 永远 partial，推导永远不发生。
//         流水按时间倒序返回，所以「本页出现早于本业务日的行」即证明今天的
//         扣分已收全；但**该页上的今日记录同样要算进去**，不能整页丢掉。
//
// ⚠ 全离线：fetcher 是桩，不打真实上游、不读凭据、不读环境变量。
// ⚠ 桩按 pageNo 返回固定页，不按 pageSize 切片 —— 真实上游的 pageSize=100
//   返回的是另一份快照，用「切片」模拟反而会掩盖缺陷一；这里只让 URL 断言管它。

import { test } from "node:test"
import assert from "node:assert/strict"

import { fetchDailyLedger } from "../src/api.mjs"

const TODAY = "2026-11-14"
const YESTERDAY = "2026-11-13"

// 与 constants.mjs 无关，直接写死契约值：拿常量做断言会让「常量写错了」这个
// 缺陷自己证明自己正确（旧实现 LEDGER_PAGE_SIZE=100 时断言照样绿）。
const URL_PAGE_SIZE = 50
const MAX_PAGES = 6
const RECORDS_ENDPOINT = "https://loomyad.xunfei.cn/api/v1/points/records"

const debit = (cycleDate, points, consumeSource = "daily") => ({
  direction: "debit",
  consumeSource,
  dailyCycleDate: cycleDate,
  pointsActual: points,
})

const credit = (points, cycleDate = TODAY) => ({
  direction: "credit",
  consumeSource: "",
  dailyCycleDate: cycleDate,
  pointsActual: points,
})

/**
 * 离线桩：第 N 次请求（pageNo=N）回 `pages[N-1]`；超出 pages 长度回空页。
 * `total` 是上游信封里的总条数 —— 故意可以远大于页面内容（长账本）。
 */
function ledger(pages, total) {
  const calls = []
  const fetcher = async (url) => {
    calls.push(String(url))
    const pageNo = Number(new URL(String(url)).searchParams.get("pageNo"))
    const list = pages[pageNo - 1] ?? []
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: "000000", data: { list, total } }),
    }
  }
  return { fetcher, calls }
}

// ── ① 长账本：翻到「上一业务日」的页就停，且该页的今日记录一条不漏 ──────

test("长账本：翻到含上一业务日的页就停，且该页的今日记录一条不漏", async () => {
  // pageSize=50 时 4387 条要 88 页 —— 旧实现永远走不完 6 页，永远 partial。
  const pages = [
    [debit(TODAY, 198), debit(TODAY, 2)],
    [debit(TODAY, 100)],
    [
      debit(TODAY, 5),
      debit(YESTERDAY, 5000), // 倒序流水里出现昨天 ⇒ 今天的分已收全
      debit(TODAY, 7),
      debit("", 4000, "permanent"),
      credit(5000),
    ],
    [debit(TODAY, 9999)], // 出现昨日之后的行都不该被请求
    [debit(TODAY, 9999)],
    [debit(TODAY, 9999)],
  ]
  const { fetcher, calls } = ledger(pages, 4387)

  const out = await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(out.partial, false, "4387 条的账号不许因为翻不满 88 页就永远 partial")
  assert.equal(calls.length, 3, "看到上一业务日就必须停，不许再翻")
  // 200 + 100 + (5 + 7)：停在昨日那一页时，该页的今日记录仍要全部算进去
  assert.equal(out.consumed, 312)
  assert.equal(out.latestCycle, TODAY)
  assert.equal(out.today, true)
})

// ── ② 超过 6 页都只有今日记录：保持 partial，不猜 ──────────────────────

test("超过 6 页都只有今日记录：保持 partial（宁缺毋谎）", async () => {
  const pages = Array.from({ length: 8 }, () => [debit(TODAY, 1)])
  const { fetcher, calls } = ledger(pages, 100_000)

  const out = await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(out.partial, true, "翻不满就必须如实标 partial")
  assert.equal(out.consumed, 0, "partial 时不许给一个看起来可用的消耗数")
  assert.equal(out.latestCycle, undefined)
  assert.equal("today" in out, false, "partial 时不许给 today 这种看起来确定的字段")
  assert.equal(calls.length, MAX_PAGES, "页数上限是 6，不许无限翻")
})

// ── ③ 空账 / 完整账 ─────────────────────────────────────────────────

test("空账：第一页就空 → complete，消耗 0，不声称今天有流水", async () => {
  const { fetcher, calls } = ledger([], 0)

  const out = await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(out.partial, false)
  assert.equal(out.consumed, 0)
  assert.equal(out.latestCycle, undefined)
  assert.equal(out.today, false, "空账不许声称今天有流水")
  assert.equal(calls.length, 1, "第一页就空，不该再翻")
})

test("完整账：行数翻满 total 就 complete，且只统计本业务日的 daily 扣分", async () => {
  const pages = [
    [debit(TODAY, 10), credit(5000), debit("", 4000, "permanent")],
    [debit(TODAY, 20), debit(TODAY, 5)],
  ]
  const { fetcher, calls } = ledger(pages, 5)

  const out = await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(out.partial, false)
  assert.equal(calls.length, 2, "第 2 页才翻满 total")
  assert.equal(out.consumed, 35, "credit 与永久池扣分都不算今日消耗")
  assert.equal(out.latestCycle, TODAY)
  assert.equal(out.today, true)
})

// ── ④ 请求形状：pageSize=50（缺陷一）────────────────────────────────

test("请求 URL 用 pageSize=50、recordType=all，pageNo 从 1 递增", async () => {
  const { fetcher, calls } = ledger([[debit(TODAY, 1)], [debit(TODAY, 2)]], 2)

  await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(calls.length, 2)
  for (const [i, url] of calls.entries()) {
    const u = new URL(url)
    assert.equal(`${u.origin}${u.pathname}`, RECORDS_ENDPOINT)
    // pageSize=100 实测回的是不含当天的旧快照 ⇒ 推导永远看不到今天的扣分
    assert.equal(u.searchParams.get("pageSize"), String(URL_PAGE_SIZE), `第 ${i + 1} 次请求的 pageSize 必须是 50`)
    assert.equal(u.searchParams.get("pageNo"), String(i + 1))
    assert.equal(u.searchParams.get("recordType"), "all")
  }
})

// ── ⑤ 缺 dailyCycleDate / 未来日期都不许触发提前停 ───────────────────

test("缺 dailyCycleDate 的行不算「上一业务日」，不触发提前停", async () => {
  // 没有日期 ≠ 早于本业务日：拿它当停止判据会在第一页就停，把今天的消耗算少。
  const pages = Array.from({ length: MAX_PAGES }, (_, i) => [
    { direction: "debit", consumeSource: "daily", pointsActual: 100 + i },
    { direction: "debit", consumeSource: "daily", dailyCycleDate: "   ", pointsActual: 7 },
    { direction: "debit", consumeSource: "permanent", pointsActual: 4000 },
  ])
  const { fetcher, calls } = ledger(pages, 1_000_000)

  const out = await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(calls.length, MAX_PAGES, "没有「早于本业务日」的行就必须把 6 页翻满")
  assert.equal(out.partial, true)
})

test("时钟偏差：行日期晚于本业务日时，也不当成「上一业务日」提前停", async () => {
  const pages = Array.from({ length: MAX_PAGES }, () => [debit("2026-11-15", 5)])
  const { fetcher, calls } = ledger(pages, 1_000_000)

  const out = await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(calls.length, MAX_PAGES, "只有严格早于本业务日的行才是停止判据")
  assert.equal(out.partial, true)
})

// ── ⑥ 同页今日 + 昨日：停在该页，但今日记录全部算进去 ────────────────

test("同页今日 + 昨日：停在这一页，但该页的今日记录仍然全算", async () => {
  const pages = [
    [debit(TODAY, 198), debit(YESTERDAY, 5000), debit(TODAY, 2), debit(YESTERDAY, 1)],
    [debit(TODAY, 1000)],
    [debit(TODAY, 1000)],
    [debit(TODAY, 1000)],
    [debit(TODAY, 1000)],
    [debit(TODAY, 1000)],
  ]
  const { fetcher, calls } = ledger(pages, 4387)

  const out = await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(calls.length, 1, "第一页就出现昨日，不该再翻")
  assert.equal(out.partial, false)
  assert.equal(out.consumed, 200, "同一页里的两条今日记录（198 + 2）都要算")
  assert.equal(out.today, true)
})

// ── ⑦ 上游信封异常：list 不是数组时不许崩，也不许编造 ─────────────────

test("上游 list 形状不对时按空页处理，不崩、不编造消耗", async () => {
  const calls = []
  const fetcher = async (url) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: "000000", data: { list: { unexpected: true }, total: 1 } }),
    }
  }

  const out = await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(out.partial, false)
  assert.equal(out.consumed, 0)
  assert.equal(out.today, false)
  assert.equal(calls.length, 1)
})

// ── ⑧ 反例 P1：6 页全为昨日 daily debit ⇒ 不许因旧日期 complete ─────────

test("反例 P1：6 页全为昨日 daily debit、total 很大 → 翻满 6 页后仍是 partial", async () => {
  // 「遇到旧日期」只有在**此前已经见过今日 daily 扣分**时，才证明今天的分收全。
  // 一份从头到尾没有今日记录的快照（pageSize=100 的旧快照就是这样）若被当成 complete，
  // consumed=0 会被拿去推上限 —— 「快照不含今天」被误读成「今天没花钱」。
  const pages = Array.from({ length: MAX_PAGES }, () => [debit(YESTERDAY, 100)])
  const { fetcher, calls } = ledger(pages, 4387)

  const out = await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(calls.length, MAX_PAGES, "全是旧日期时必须翻满 6 页，不能第一页就停")
  assert.equal(out.partial, true, "没见过今日记录就 complete，会把旧快照误判成「今天没花钱」")
  assert.equal(out.consumed, 0)
  assert.equal("today" in out, false)
})

// ── ⑨ 反例 P2a：首页只有旧日期 credit ⇒ 不得提前停 ─────────────────────

test("反例 P2a：首页只有旧日期 credit → 不得提前停，后续页今日 debit 全算且 today=true", async () => {
  // credit 不是今日消耗（direction 不是 debit、consumeSource 不是 daily），
  // 它的旧日期不能当「今天的分已收全」的证据。
  const pages = [
    [credit(5000, YESTERDAY)],
    [debit(TODAY, 100)],
    [debit(TODAY, 7)],
    [debit(YESTERDAY, 5000)],
    [debit(TODAY, 9999)],
    [debit(TODAY, 9999)],
  ]
  const { fetcher, calls } = ledger(pages, 4387)

  const out = await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(calls.length, 4, "第 1 页的 credit 不许触发停止；第 4 页的昨日 daily 才该停")
  assert.equal(out.partial, false)
  assert.equal(out.consumed, 107, "第 2、3 页的今日 daily 扣分（100 + 7）必须算进来")
  assert.equal(out.latestCycle, TODAY)
  assert.equal(out.today, true)
})

// ── ⑩ 反例 P2b：首页只有旧日期 permanent debit ⇒ 不得提前停 ────────────

test("反例 P2b：首页只有旧日期 permanent debit → 不得提前停，后续页今日 debit 全算且 today=true", async () => {
  // permanent 扣分不进今日池，它的旧日期同样不是「今天的分已收全」的证据。
  const pages = [
    [debit(YESTERDAY, 4000, "permanent")],
    [debit(TODAY, 100)],
    [debit(TODAY, 7)],
    [debit(YESTERDAY, 5000)],
    [debit(TODAY, 9999)],
    [debit(TODAY, 9999)],
  ]
  const { fetcher, calls } = ledger(pages, 4387)

  const out = await fetchDailyLedger("session-unused", TODAY, fetcher)

  assert.equal(calls.length, 4, "第 1 页的 permanent 不许触发停止；第 4 页的昨日 daily 才该停")
  assert.equal(out.partial, false)
  assert.equal(out.consumed, 107)
  assert.equal(out.latestCycle, TODAY)
  assert.equal(out.today, true)
})
