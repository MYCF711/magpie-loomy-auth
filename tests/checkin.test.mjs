// 签到 outcome、凭据形状、请求改写 —— 都是市场现装插件实际做错的点。

import { test } from "node:test"
import assert from "node:assert/strict"

import { _internal } from "../index.mjs"

const { pure, quotaPatch, staticModels } = _internal
const { checkinOutcome, credentialOf, maskPhone, rewriteImagesToTags, prefersTagFormat, parseModels, splitRateSuffix } = pure

const LEGAL = ["claimed", "done", "ineligible", "inactive", "captcha", "failed"]

// ── 签到 outcome ────────────────────────────────────────────────────

test("幂等（alreadyProcessed）必须是 done，不是 claimed —— 否则用户以为每天都真的加额度", () => {
  const r = checkinOutcome({ ok: true, alreadyProcessed: true, dailyQuota: 5000, dailyBalance: 4802 })
  assert.equal(r.outcome, "done")
  assert.match(r.message, /4802/)
})

test("首次处理是 claimed，且 credit 由 quota - consumed 推（不编造）", () => {
  const r = checkinOutcome({ ok: true, alreadyProcessed: false, dailyQuota: 5000, dailyConsumed: 198, dailyBalance: 4802 })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 4802)
})

test("上游没给 quota/consumed 时不编数字，credit 退到余额", () => {
  const r = checkinOutcome({ ok: true, alreadyProcessed: false, dailyBalance: 777 })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 777)
})

test("失败是 failed（带原因），不会伪装成成功", () => {
  const r = checkinOutcome({ ok: false, message: "每日签到：登录已失效" })
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /登录已失效/)
})

test("所有返回的 outcome 都必须是契约合法值 —— 这里就是 sucooer 那个 \"success\" 翻车的地方", () => {
  const cases = [
    { ok: true, alreadyProcessed: true, dailyQuota: 5000 },
    { ok: true, alreadyProcessed: false, dailyQuota: 5000, dailyConsumed: 10 },
    { ok: true, alreadyProcessed: false },
    { ok: false, message: "x" },
  ]
  for (const c of cases) {
    const r = checkinOutcome(c)
    assert.ok(LEGAL.includes(r.outcome), `outcome "${r.outcome}" 不在契约合法值里，magpie 会归 failed`)
  }
})

// ── quota 写回凭据 ─────────────────────────────────────────────────

test("签到拿到上限才写回凭据；拿不到不写（不编造 dailyQuota）", () => {
  assert.deepEqual(quotaPatch({ ok: true, dailyQuota: 5000, dailyCycleDate: "2026-10-26" }), {
    dailyQuota: 5000,
    dailyCycleDate: "2026-10-26",
  })
  assert.deepEqual(quotaPatch({ ok: true, dailyQuota: undefined }), {})
  assert.deepEqual(quotaPatch({ ok: true, dailyQuota: 0 }), {})
  assert.deepEqual(quotaPatch({ ok: false }), {})
})

// ── 凭据形状（sucooer 只认第一种，于是收到映射就变成「未登录」）──────

test("四种凭据形态都要认", () => {
  const flat = { type: "oauth", access: "S1", accountId: "181****0632" }
  assert.equal(credentialOf(flat)?.session, "S1")
  assert.equal(credentialOf({ type: "oauth", access: "S2" })?.session, "S2")
  assert.equal(credentialOf({ loomy: { access: "S3" } })?.session, "S3")
  assert.equal(credentialOf({ loomy: { access: "S4" }, "loomy#ab12cd": { access: "S5" } })?.session, "S4")
  assert.equal(credentialOf("S6")?.session, "S6")
  assert.equal(credentialOf(null), null)
  assert.equal(credentialOf({}), null)
})

test("凭据里的 quota 与业务日要读出来（写回后的下一轮靠它省请求）", () => {
  const c = credentialOf({ access: "S", dailyQuota: 5000, dailyCycleDate: "2026-10-26" })
  assert.equal(c.dailyQuota, 5000)
  assert.equal(c.dailyCycleDate, "2026-10-26")
})

test("手机号掩码与规范化", () => {
  assert.equal(maskPhone("18170800632"), "181****0632")
  assert.equal(maskPhone("123"), "123")
})

// ── 图片适配（deepseek 系只认标记）──────────────────────────────────

test("只有 deepseek 系走 <image_base64> 标记", () => {
  assert.equal(prefersTagFormat("DeepSeek-V4.1-Flash"), true)
  assert.equal(prefersTagFormat("GLM-5.3-Flash"), false)
  assert.equal(prefersTagFormat("auto"), false)
})

test("图片块并入相邻 text 块，且只动 deepseek 会用到的那种 body 形状", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] }
  const out = rewriteImagesToTags(body)
  assert.equal(out.messages[0].content.length, 1)
  assert.match(out.messages[0].content[0].text, /^看图\n<image_base64>AAAA<\/image_base64>$/)
  assert.equal(body.messages[0].content.length, 2, "不许改动原对象")
})

test("没有图片时原样返回（同一个引用，避免无谓复制）", () => {
  const body = { messages: [{ role: "user", content: "纯文本" }] }
  assert.equal(rewriteImagesToTags(body), body)
})

// ── 模型目录 ────────────────────────────────────────────────────────

test("只保留 type=chat —— image 型列出来就是让用户选中一个必然失败的东西", () => {
  const rows = parseModels({
    data: [
      { id: "DeepSeek-V4.1-Flash", type: "chat", name: "DeepSeek V4.1 Flash(x2.0)", context_length: 1048576, max_output_tokens: 384000, reasoning_efforts: ["none", "high"], capabilities: { reasoning: true, function_calling: true, vision: true } },
      { id: "Hy-Image-3.5-preview", type: "image", name: "Hy image 3.5 preview", context_length: 100000 },
    ],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, "DeepSeek-V4.1-Flash")
  assert.equal(rows[0].context, 1048576)
  assert.equal(rows[0].images, true)
  assert.equal(rows[0].rate, "x2.0")
})

test("倍率从展示名尾部拆出，中英文括号都认", () => {
  assert.deepEqual(splitRateSuffix("DeepSeek V4.1 Flash(x2.0)"), ["DeepSeek V4.1 Flash", "x2.0"])
  assert.deepEqual(splitRateSuffix("MiniMax M3 （x4.0）"), ["MiniMax M3", "x4.0"])
  assert.deepEqual(splitRateSuffix("Spark-X2.5（限时免费）(x0.0)"), ["Spark-X2.5（限时免费）", "x0.0"])
  assert.deepEqual(splitRateSuffix("自动 · 均衡"), ["自动 · 均衡", undefined])
})

// ── free 字段（决定 magpie 的 Free first 路由档）─────────────────────

test("上游写明「限时免费」或倍率 x0.0 的模型才 free=true", () => {
  const { isFreeModel } = pure
  // 两个 Spark：上游展示名既写了「限时免费」，倍率也是 x0.0
  assert.equal(isFreeModel("Spark-X2.6 正式版(限时免费)(x0.0)", "x0.0"), true)
  assert.equal(isFreeModel("Spark-X2.5（限时免费）(x0.0)", "x0.0"), true)
  // 只看倍率也成立
  assert.equal(isFreeModel("Some Model(x0.0)", "x0.0"), true)
  assert.equal(isFreeModel("Some Model", "x0.00"), true)
  // 收费模型
  assert.equal(isFreeModel("DeepSeek V4.1 Flash(x2.0)", "x2.0"), false)
  assert.equal(isFreeModel("GLM 5.3 Flash(x0.8)", "x0.8"), false)
})

test("⚠ 不能只看 rate=0 —— 「套餐内不按次计费」不是免费（qoder 的 ultimate/dfmodel 就是这种）", () => {
  const { isFreeModel } = pure
  assert.equal(isFreeModel("Ultimate", undefined), false)
  assert.equal(isFreeModel("DeepSeek-Flash", undefined), false)
  // 唯一的例外是倍率文本明确写了 0
  assert.equal(isFreeModel("Spark-X2.5", "x0.0"), true)
})

test("Loomy 的 auto 不是免费（它会落到别的模型上花积分）", () => {
  const { isFreeModel } = pure
  assert.equal(isFreeModel("自动 · 均衡", undefined), false)
})

test("parseModels 把 free 从上游展示名解析出来", () => {
  const rows = parseModels({
    data: [
      { id: "spark-x2.6", type: "chat", name: "Spark-X2.6 正式版(限时免费)(x0.0)", context_length: 1048576 },
      { id: "DeepSeek-V4.1-Flash", type: "chat", name: "DeepSeek V4.1 Flash(x2.0)", context_length: 1048576 },
      { id: "auto", type: "chat", name: "自动 · 均衡" },
    ],
  })
  const by = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.equal(by["spark-x2.6"].free, true)
  assert.equal(by["DeepSeek-V4.1-Flash"].free, false)
  assert.equal(by["auto"].free, false)
})

test("静态表里两个 Spark 必须是 free=true（缓存/未登录时也要对）", () => {
  const m = staticModels()
  assert.equal(m["spark-x2.6"].free, true)
  assert.equal(m["spark-x"].free, true)
  assert.equal(m.auto.free, false)
  for (const id of ["DeepSeek-V4.1-Flash", "MiniMax-M3", "Kimi-k2.6", "qwen-3.8-max", "GLM-5.3-Flash", "qwen3.8-flash", "mimo-v2.5"]) {
    assert.equal(m[id].free, false, `${id} 不该是 free`)
  }
})

// ── 新手任务（onboarding）───────────────────────────────────────────

test("新手任务总池 10000，未完成的分值可累加", () => {
  const { onboardingPoints, earnedPoints, normalizeTasks } = pure
  const total = Object.values(onboardingPoints()).reduce((a, b) => a + b, 0)
  assert.equal(total, 10000, "上游标称 1 万分")

  const tasks = normalizeTasks({ first_message: true })
  assert.equal(earnedPoints(tasks), 500)
})

test("未知 key 被丢掉、缺失的补 false（上游加任务时不会炸）", () => {
  const tasks = pure.normalizeTasks({ first_message: true, some_new_task: true })
  assert.equal(tasks.some_new_task, undefined)
  assert.equal(tasks.share_soul, false)
  assert.equal(tasks.first_message, true)
})

test("待办按分值从高到低排（先领大的）", () => {
  const pending = pure.pendingTasks(pure.normalizeTasks({ first_message: true }))
  assert.equal(pending[0].key, "share_soul")   // 2000
  assert.equal(pending[0].points, 2000)
  assert.ok(pending.length === 7, "8 项里完成 1 项 → 剩 7")
  assert.ok(!pending.some((x) => x.key === "first_message"), "已完成的不能再出现在待办里")
})

test("新手任务窗口是 aside（一次性额度不该驱动路由）", () => {
  const w = pure.onboardingWindow(pure.normalizeTasks({ first_message: true }), 10000)
  assert.ok(w)
  assert.equal(w.name, "新手任务")
  assert.equal(w.aside, true, "一次性奖励不参与路由打分")
  assert.equal("limit" in w, false, "不给 limit，避免被当成池子算占比")
  assert.match(w.display, /9500/, "还剩 10000-500=9500")
  assert.match(w.display, /7 项/)
})

test("任务全领完就不画这一格（不是画一个 0）", () => {
  const all = Object.fromEntries(Object.keys(pure.onboardingPoints()).map((k) => [k, true]))
  assert.equal(pure.onboardingWindow(pure.normalizeTasks(all), 10000), null)
})
