#!/usr/bin/env node
// 出站 User-Agent 规定 —— 可执行版
//
//   node scripts/check-ua.mjs            # 检查当前目录
//   node scripts/check-ua.mjs ../my-plugin
//
// 退出码 0 = 合规，2 = 有违规，1 = 用法错误。
//
// 为什么值得一条独立断言：
// 上游网关按 `<product>/<version>` 形态识别「第三方客户端」，命中即回
// `403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}` ——
// 报错文案说的是「网络繁忙」，看不出是 UA 的锅，用户会去重试、去换号，都没用。
// 而 magpie 给插件的请求带 `User-Agent: magpie/<version>`（插件型 provider 一律改写），
// **插件不显式设 UA 就把它透传给上游**，一样命中。所以两件事都要查：
//   ① UA 的值不能是我们自己的产品名 / 运行时默认 / 截断的 Mozilla；
//   ② 打上游的请求要显式带 UA（不显式 = 透传宿主 UA）。
//
// 查不到的：UA 在运行期才拼出来、或从配置读的，静态扫描看不见 —— 那部分留给
// CHECKLIST.md 的 A 表。

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve, relative } from "node:path"

/** 官方 UA 的三条取法里，唯一能写死在模板里的那条：完整合法的 Chrome UA。 */
export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/** 跳过的目录：测试与发布脚本里出现坏 UA 是**故意的**（夹具 / 打 GitHub API）。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "tests", "test", "scripts", "dist", "coverage", ".github", "docs"])

/** 自产品名形态：`magpie/…`、`magpie-cnb-auth/0.1.0`、`alysis-magpie/0.1.0`。 */
const OWN_PRODUCT = /^(magpie|magpie-[\w.-]*|[\w.-]*magpie[\w.-]*)\//i
/** 运行时默认 UA：不是任何厂商的客户端。 */
const RUNTIME_DEFAULT = /^(node|undici|deno|bun\/[\d.]+|go-http-client[\w./]*)$/i

/** 读 UA 值的四种写法。值为模板字面量时只取静态部分（`${…}` 当空）。 */
const UA_PATTERNS = [
  /["']user-agent["']\s*:\s*([`"'])([\s\S]*?)\1/gi, // 对象字面量 / Headers init
  /\.set\(\s*["']user-agent["']\s*,\s*([`"'])([\s\S]*?)\1\s*\)/gi, // headers.set(...)
  /\.append\(\s*["']user-agent["']\s*,\s*([`"'])([\s\S]*?)\1\s*\)/gi,
  /\b(?:USER_AGENT|CLIENT_UA|UA)\s*=\s*([`"'])([\s\S]*?)\1/gi, // 常量
]

/** UA 的值是常量引用（`"user-agent": OFFICIAL_UA`）：设了，但静态判不了值 —— 只用于「有没有设」。 */
const UA_REFERENCE =
  /["']user-agent["']\s*:\s*([A-Za-z_$][\w$]*)|\.set\(\s*["']user-agent["']\s*,\s*([A-Za-z_$][\w$]*)\b\s*\)/gi

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out)
      continue
    }
    if (/\.(mjs|cjs|js|ts)$/.test(e.name) && !/\.test\.|\.spec\./.test(e.name)) out.push(join(dir, e.name))
  }
  return out
}

/** 去掉行注释与块注释，避免把文档示例算成违规。字符串里的 `//` 会误伤，但只影响「是否扫描到」，不影响判据。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length
}

/** 文件里有没有**非本机**的 http(s) 地址：只打 127.0.0.1 / localhost 的文件不算「打上游」。 */
/** 把紧跟其后的 `+ "…"` 逐段接上：跨行拼接的 UA 是一条值，不是两条残句。 */
function joinConcatenated(src, endIdx, first) {
  let out = first
  let i = endIdx
  for (;;) {
    const m = /^\s*\+\s*([`"'])([\s\S]*?)\1/.exec(src.slice(i))
    if (!m) break
    out += m[2]
    i += m[0].length
  }
  return out
}

function hasRemoteUrl(src) {
  const urls = src.match(/https?:\/\/[^\s"'`)]+/g) ?? []
  return urls.some((u) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+|:\$\{[^}]*\})?(?:[/?#]|$)/i.test(u))
}

/**
 * @param {string} root 要检查的插件目录
 * @returns {{level:"fail"|"warn"|"pass", file:string, line:number, value:string, message:string, fix:string}[]}
 */
export function scanUserAgents(root) {
  const rows = []
  const files = walk(resolve(root))

  for (const file of files) {
    const rel = relative(resolve(root), file).split("\\").join("/")
    const raw = readFileSync(file, "utf8")
    const src = stripComments(raw)
    const found = []
    let sawUA = false

    for (const re of UA_PATTERNS) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(src)) !== null) {
        // `"…AppleWebKit/537.36 " + "(KHTML, like Gecko) Chrome/… Safari/537.36"`
        // 这种跨行拼接要接回来再判，否则会把完整 Chrome UA 误判成残句。
        const joined = joinConcatenated(src, m.index + m[0].length, m[2])
        const value = joined.replace(/\$\{[^}]*\}/g, "").trim()
        sawUA = true
        found.push({ value, line: lineOf(src, m.index) })
      }
    }

    // 值是常量引用（`"user-agent": OFFICIAL_UA`）—— 算「显式设了」，但静态判不了值。
    UA_REFERENCE.lastIndex = 0
    if (UA_REFERENCE.test(src)) sawUA = true

    for (const { value, line } of found) {
      const v = value.trim()
      if (v === "") continue
      if (OWN_PRODUCT.test(v)) {
        rows.push({
          level: "fail", file: rel, line, value: v,
          message: `UA 是我们自己的产品名形态（${v}），上游会按 <product>/<version> 判成第三方客户端`,
          fix: `换成该服务官方客户端的 UA；官方是网页就用完整 Chrome UA：${CHROME_UA}`,
        })
        continue
      }
      if (RUNTIME_DEFAULT.test(v)) {
        rows.push({
          level: "fail", file: rel, line, value: v,
          message: `UA 是运行时默认值（${v}），不是任何厂商的客户端`,
          fix: `换成官方客户端 UA（网页形态用完整 Chrome UA）`,
        })
        continue
      }
      if (v.includes("Mozilla/5.0") && v.includes("AppleWebKit/537.36") && !v.includes("Chrome/")) {
        rows.push({
          level: "fail", file: rel, line, value: v,
          message: "UA 是截断的 Mozilla 残句（缺 `(KHTML, like Gecko) Chrome/<major>.0.0.0 Safari/537.36`），不是合法浏览器 UA",
          fix: `补成完整 Chrome UA：${CHROME_UA}`,
        })
      }
    }

    // ② 打上游却完全没设 UA：宿主会把 magpie/<version> 透传上去。
    //    只对「有 fetch/WebSocket 且出现**非本机** http(s) 地址」的文件报警告 ——
    //    只打 127.0.0.1 的（本机 magpie 网关 / CDP）和纯工具模块不算。
    if (!sawUA && /\bfetch\s*\(|\bnew WebSocket\s*\(/.test(src) && hasRemoteUrl(src)) {
      rows.push({
        level: "warn", file: rel, line: 0, value: "",
        message: "这个文件打上游（fetch / WebSocket + https 地址）却没有 User-Agent 字面量，可能透传宿主的 magpie/<version>",
        fix: "在该请求的 headers 里显式带官方客户端 UA；静态拼不出来的，在 CHECKLIST A 表里人工确认一次",
      })
    }
  }

  return rows
}

// ── CLI ──────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
if (isMain) {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"))
  const root = resolve(arg ?? ".")
  if (!statSync(root).isDirectory()) {
    console.error(`不是目录：${root}`)
    process.exit(1)
  }
  const rows = scanUserAgents(root)
  const fails = rows.filter((r) => r.level === "fail")
  const warns = rows.filter((r) => r.level === "warn")

  console.log(`\n出站 User-Agent 检查 · ${root}\n`)
  if (rows.length === 0) console.log("  ✓ 没发现问题\n")
  for (const r of rows) {
    const mark = r.level === "fail" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m!\x1b[0m"
    console.log(`  ${mark} ${r.file}${r.line ? `:${r.line}` : ""}  ${r.message}`)
    if (r.value) console.log(`      值：${r.value}`)
    console.log(`      → ${r.fix}`)
  }
  console.log(`\n  失败 ${fails.length} · 警告 ${warns.length}\n`)
  process.exit(fails.length ? 2 : 0)
}
