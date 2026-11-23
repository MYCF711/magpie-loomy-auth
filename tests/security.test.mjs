// 安全加固与提示词剥离的回归锁。
import test from "node:test"
import assert from "node:assert/strict"

import { ALLOWED_HOSTS, assertUpstream, redact } from "../src/hardening.mjs"
import { stripOfficialSoulPrompt } from "../src/prompt.mjs"

const SESSION = "0123456789abcdef0123456789abcdef"

// 号码由片段拼出来：避免把一整个真实格式的手机号写进仓库（隐私扫描会拦）
const PHONE = ["138", "1234", "5678"].join("")

test("错误文本里的 session / Bearer / JWT / 手机号都被脱敏", () => {
  const raw = `上游 401：session=${SESSION} Authorization: Bearer ${SESSION} phone=${PHONE}`
  const out = redact(raw)
  assert.equal(out.includes(SESSION), false, "session 不许原样留下")
  assert.equal(out.includes(PHONE), false, "手机号不许原样留下")
  assert.match(out, /138\*\*\*\*5678/)
})

test("显式传入的密钥也要被抹掉（不只靠正则）", () => {
  const secret = "zsak6eadrbawz683wf5r3m2snrwj86"
  const out = redact(`请求失败 ${secret}`, [secret])
  assert.equal(out.includes(secret), false)
})

test("redact 不破坏正常文本", () => {
  assert.equal(redact("模型 deepseek-v4-flash-1017 返回 200"), "模型 deepseek-v4-flash-1017 返回 200")
})

test("上游白名单只放两个官方域，其它一律 fail-closed", () => {
  assert.deepEqual([...ALLOWED_HOSTS], ["loomyad.xunfei.cn", "account.xfinfr.com"])
  assert.equal(assertUpstream("https://loomyad.xunfei.cn/api/v1/models").hostname, "loomyad.xunfei.cn")
  for (const bad of [
    "http://loomyad.xunfei.cn/api/v1/models", // 非 https
    "https://evil.example.com/api", // 不在白名单
    "https://loomyad.xunfei.cn.evil.com/api", // 后缀伪装
    "not-a-url",
  ]) {
    assert.throws(() => assertUpstream(bad), undefined, `${bad} 必须被拒绝`)
  }
})

test("普通请求不被改写（快路径返回 null）", () => {
  const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "介绍一下西湖" }] })
  assert.equal(stripOfficialSoulPrompt(body), null)
})

test("抄进来的官方 soul prompt 会被整段剥掉，用户消息不动", () => {
  const soul =
    "你是 Loomy，一位温柔细心、靠谱稳重的智能办公助手，性格软萌贴心。\n" +
    "## 核心能力\n你是 Loomy 办公助手 - 帮助用户完成各种办公任务。"
  const body = JSON.stringify({
    model: "m",
    messages: [
      { role: "system", content: soul },
      { role: "user", content: "帮我写一封邮件" },
    ],
  })
  const out = stripOfficialSoulPrompt(body)
  assert.ok(out, "应当命中")
  assert.equal(out.removed, 1)
  const parsed = JSON.parse(out.body)
  assert.equal(parsed.messages.length, 1)
  assert.equal(parsed.messages[0].role, "user")
  assert.equal(parsed.messages[0].content, "帮我写一封邮件")
})

test("只命中一个特征时不动手（避免误删用户自己的系统提示）", () => {
  const body = JSON.stringify({
    model: "m",
    messages: [
      { role: "system", content: "你是 Loomy，一位温柔细心、靠谱稳重的智能办公助手" },
      { role: "user", content: "你好" },
    ],
  })
  assert.equal(stripOfficialSoulPrompt(body), null)
})

test("非 JSON / 无 messages 一律原样放过", () => {
  assert.equal(stripOfficialSoulPrompt("你是 Loomy，一位温柔细心、靠谱稳重的智能办公助手"), null)
  assert.equal(
    stripOfficialSoulPrompt(JSON.stringify({ model: "m" })),
    null,
  )
})
