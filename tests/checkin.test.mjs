// 签到 outcome、凭据形状、请求改写 —— 都是市场现装插件实际做错的点。

import { test } from "node:test"
import assert from "node:assert/strict"

import { _internal } from "../index.mjs"

const { pure, quotaPatch } = _internal
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
