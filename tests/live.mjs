// 实况验证：真实账号 + 真实上游（不进 `npm test`，手动跑）
//
//   node tests/live.mjs
//
// 只调只读端点 + 幂等的签到端点（`first-login`），不发送任何对话请求 = 不消费额度。
// 假 client 用来捕获 magpie 的 auth.set 写回，验证「记进凭据」这条路径真的通。

import fs from "node:fs"
import assert from "node:assert/strict"

import { LoomyAuthPlugin, _internal } from "../index.mjs"

const { pure, publicUsage, readUsage } = _internal

const AUTH_FILE = process.env.LOOMY_AUTH_FILE || "C:/Users/Administrator/.config/magpie/plugin-auth.json"

const LEGAL = ["claimed", "done", "ineligible", "inactive", "captcha", "failed"]

const auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"))
const keys = Object.keys(auth).filter((k) => k === "loomy" || k.startsWith("loomy#"))
if (!keys.length) {
  console.log("⚠ 没有找到 loomy 账号，跳过")
  process.exit(0)
}

const written = []
const client = {
  auth: {
    set: async (opts) => {
      written.push({ id: opts?.path?.id, body: opts?.body })
      return { data: true }
    },
  },
  app: { log: () => {} },
}

const plugin = await LoomyAuthPlugin({ client, directory: undefined })
let failures = 0
const check = (name, pass, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`)
  if (!pass) failures++
}

for (const key of keys) {
  const raw = auth[key]
  const cred = pure.credentialOf(raw)
  console.log(`\n=== ${key}  ${raw.phone ?? "?"}`)

  // ① usage（只读）
  const usage = publicUsage(await readUsage(cred))
  console.log(`    balance=${usage.balance}  windows=${JSON.stringify(usage.windows)}`)
  check("usage 无 error", !usage.error, usage.error ? `→ ${usage.error}` : "")
  if (!usage.error) {
    const windows = usage.windows ?? []
    const today = windows.find((w) => w.name === "今日积分")
    check("有今日池窗口", !!today)
    if (today) {
      check("used 是 0~100 的数", Number.isFinite(today.used) && today.used >= 0 && today.used <= 100, `used=${today.used}`)
      const empty = String(usage.balance).startsWith("0 ")
      if (empty) {
        check("号已蹬空 → used:100 且参与路由", today.used === 100 && !today.aside, JSON.stringify(today))
      } else {
        check("上限已知时带 limit 且参与路由", Number.isFinite(today.limit) || today.aside === true, JSON.stringify(today))
      }
    }
    const permanent = windows.find((w) => w.name === "永久积分")
    if (permanent) {
      check("永久池是 aside 且不伪造总量", permanent.aside === true && permanent.limit === undefined)
    }
  }

  // ② 宿主的 usage 钩子 + quota 写回（真网络，假 client）
  const written0 = written.length
  const out = await plugin.auth.usage(async () => raw, { id: "loomy" })
  check("usage 钩子返回了窗口", Array.isArray(out.windows) && out.windows.length > 0)
  check("钩子输出里没有内部字段", !("_quota" in out))
  const patch = written.length > written0 ? written.at(-1) : undefined
  if (patch) {
    check("quota 写回凭据且带回原字段", patch.body?.access === raw.access && Number.isFinite(patch.body?.dailyQuota), JSON.stringify({ id: patch.id, dailyQuota: patch.body?.dailyQuota, dailyCycleDate: patch.body?.dailyCycleDate }))
  } else {
    console.log("   （本轮无需写回：凭据里的 quota 已是当前的）")
  }

  // ③ 签到（幂等写端点，不消费额度）
  const claim = await plugin.auth.checkin(async () => raw, { id: "loomy" })
  console.log(`    checkin → ${JSON.stringify(claim)}`)
  check("outcome 是契约合法值", LEGAL.includes(claim.outcome), `outcome=${claim.outcome}`)
  check("outcome 不是 claimed/done 以外的东西", ["claimed", "done", "failed"].includes(claim.outcome))

  // ④ 模型目录（只读）
  const models = await plugin.provider.models({ models: {} }, { auth: raw })
  const ids = Object.keys(models)
  check("目录里有 chat 模型", ids.length >= 10, `${ids.length} 个`)
  check("没有 image 型条目混进来", !ids.includes("Hy-Image-3.5-preview") && !ids.includes("doubao-seedream-5-lite"))
  const ds = models["DeepSeek-V4.1-Flash"]
  if (ds) check("DeepSeek 上下文是实测 1M 档", ds.limit.context === 1_048_576, String(ds.limit.context))
}

console.log(`\n${failures ? `❌ ${failures} 项不通过` : "✅ 全部通过"}`)
process.exit(failures ? 1 : 0)
