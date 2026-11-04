// 错误码与状态码 —— 锁住 ERROR-CODES.md §3 词表与 §4 的 R2 / R8。
//
// 为什么要有这一组：宿主只认两样东西 —— HTTP status（换号 / 退避 / 标账号）
// 和 `code`（按词分支）。两者错一个，用户看到的现象都是「重试也没用」，
// 而 CI 的「供应商插件规定」会把它们判死：
//
//   R2  自造的词表外 code（历史上的 `insufficient_points`）
//   R8  超时落到 502 —— 502 表示「上游给了明确的错误体」，宿主读到它
//       既不退避也不换号，把一个「重试就好了」的错误直接摔给用户
//
// 这组用例就是 R2 / R8 / R9（词表里的 code 至少有一条断言）的落地。

import test from "node:test"
import assert from "node:assert/strict"

import { chatFetch } from "../src/chat.mjs"
import { tokenRequest } from "../src/api.mjs"
import { ERROR_CODES } from "../src/constants.mjs"

/** ERROR-CODES.md §3 的冻结词表（逐字抄自规范，改这里等于改契约；加码要升 v2） */
const VOCAB = new Set([
  "sign_in_required",
  "session_expired",
  "audit_blocked",
  "invalid_request",
  "model_not_found",
  "concurrency_conflict",
  "rate_limited",
  "upstream_unavailable",
  "upstream_timeout",
  "upstream_error",
  "internal_error",
  "not_implemented",
])

const chatRequest = (usageValue) =>
  chatFetch({
    input: "https://loomyad.xunfei.cn/v1/chat/completions",
    init: { method: "POST", body: JSON.stringify({ model: "x" }) },
    credential: null,
    session: "session-under-test",
    usageValue,
  })

/** 两池皆 0 的读数 —— `exhausted()` 判 true 的那种 */
const SPENT = { windows: [{}], balance: 0 }

// ── R2：code 必须来自词表 ──────────────────────────────────────────────

test("插件用到的每个 code 都在 ERROR-CODES §3 词表内", () => {
  for (const [name, code] of Object.entries(ERROR_CODES)) {
    assert.ok(VOCAB.has(code), `ERROR_CODES.${name} = "${code}" 不在词表里`)
  }
})

test("本地额度闸回 429 时，code 是词表内的 rate_limited（不是自造的 insufficient_points）", async () => {
  const res = await chatRequest(SPENT)
  const body = await res.json()

  assert.equal(res.status, 429, "限流 / 冷却对宿主就是 429：可退避、换号有救")
  assert.equal(body.error.code, "rate_limited")
  assert.ok(VOCAB.has(body.error.code))
  assert.equal(body.error.status, 429, "错误体也要带 status（§1 三件套）")
  assert.match(body.error.message, /耗尽/, "message 要说清是人能懂的哪种 429")
})

// ── R8：超时类不许落 502 ───────────────────────────────────────────────

test("上游 20 秒没响应 → 504 / upstream_timeout（不许落 502）", async () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  })
  const boom = async () => {
    throw timeout
  }

  await assert.rejects(
    () => tokenRequest("GET", "/api/v1/points/balance", "session-under-test", undefined, "查询余额", boom),
    (error) => {
      assert.equal(error.status, 504, "超时要让宿主退避/换号，不是当业务错误")
      assert.equal(error.code, "upstream_timeout")
      assert.match(error.message, /查询余额超时/, "要说是哪个请求超时（R7）")
      assert.match(error.message, /aborted due to timeout/, "上游原文必须保留（R7）")
      return true
    },
  )
})

test("连不上上游（不是超时）→ 503 / upstream_unavailable（不许落 502）", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" })
  const boom = async () => {
    throw refused
  }

  await assert.rejects(
    () => tokenRequest("GET", "/api/v1/points/balance", "session-under-test", undefined, "查询余额", boom),
    (error) => {
      assert.equal(error.status, 503, "「暂时不可用」同样不许落 502")
      assert.equal(error.code, "upstream_unavailable")
      assert.match(error.message, /ECONNREFUSED/)
      return true
    },
  )
})

test("上游真的回了状态码时照抄，不被连接层的分类改写", async () => {
  const reply = async () => new Response(JSON.stringify({ code: "000000", data: {} }), { status: 500 })

  await assert.rejects(
    () => tokenRequest("GET", "/api/v1/points/balance", "session-under-test", undefined, "查询余额", reply),
    (error) => {
      assert.equal(error.status, 500, "上游自己给的状态码才是真相")
      return true
    },
  )
})
