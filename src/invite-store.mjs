// 邀请码本地库：**自己攒的码**，不读官方客户端。
//
// 背景：官方客户端时代，插件的「自动邀请」是靠扫本机其它 Loomy 登录态、现查它们的
// 邀请码来实现的。这一版不碰官方客户端的任何文件（见 docs/security.md），所以改成
// 「谁登录过、就把谁的邀请码记进插件自己的小库」——下次有新号登录时从这里挑。
//
// ⚠ 只存**邀请码**（半公开的兑换码 + 首尾各 4 位归属指纹），**绝不存 session**。
// ⚠ 目录不可写时静默降级为空库：自动邀请是锦上添花，不能挡住登录。

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { _pure } from "./pure.mjs"

const { INVITE_REWARD_POINTS } = _pure

const STORE_VERSION = 1
const MAX_ENTRIES = 200
const STORE_TTL_MS = 90 * 24 * 3600_000

/** 账号归属指纹：只用于「别自己邀请自己」，不可逆推 session。 */
export function ownerTag(session) {
  const value = String(session ?? "").trim()
  if (!value) return ""
  return createHash("sha256").update(value).digest("hex").slice(0, 12)
}

export function storePath() {
  const explicit = String(process.env.LOOMY_INVITE_STORE ?? "").trim()
  if (explicit) return explicit
  const base = process.platform === "win32"
    ? (process.env.APPDATA || join(homedir(), "AppData", "Roaming"))
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"))
  return join(base, "magpie-plugin-loomy-auth", "invites.json")
}

export function loadInviteStore(path = storePath(), now = Date.now()) {
  try {
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.entries)) return []
    return parsed.entries
      .filter((row) => row && typeof row.code === "string" && row.code)
      .filter((row) => !row.at || now - row.at < STORE_TTL_MS)
      .slice(0, MAX_ENTRIES)
  } catch {
    return [] // 损坏就重来，不抛
  }
}

/** 记住一组邀请码（同一个 code 只留一条，owner 取最新）。返回写入后的条目数。 */
export function rememberInviteCodes(codes, { owner = "", path = storePath(), now = Date.now() } = {}) {
  const incoming = (Array.isArray(codes) ? codes : [])
    .map((row) => (typeof row === "string" ? { code: row } : row))
    .map((row) => ({
      code: String(row?.code ?? "").trim(),
      // ⚠ 必须连 status / usedCount / maxUses 一起存：
      //   `pickInviteCode()` 会把 status 不是 ""/"active"、或已用满的码过滤掉。
      //   只存 code 的话，候选会被它全部滤空 —— 自动邀请看起来「开着但永远不生效」。
      status: typeof row?.status === "string" ? row.status : "",
      usedCount: Number.isFinite(row?.usedCount) ? row.usedCount : undefined,
      maxUses: Number.isFinite(row?.maxUses) ? row.maxUses : undefined,
    }))
    .filter((row) => row.code)
  if (!incoming.length) return loadInviteStore(path, now).length

  const byCode = new Map()
  for (const row of loadInviteStore(path, now)) byCode.set(row.code, row)
  for (const row of incoming) {
    const prev = byCode.get(row.code)
    byCode.set(row.code, {
      code: row.code,
      owner: owner || prev?.owner || "",
      status: row.status || prev?.status || "",
      ...(row.usedCount === undefined ? (prev?.usedCount === undefined ? {} : { usedCount: prev.usedCount }) : { usedCount: row.usedCount }),
      ...(row.maxUses === undefined ? (prev?.maxUses === undefined ? {} : { maxUses: prev.maxUses }) : { maxUses: row.maxUses }),
      at: now,
      reward: INVITE_REWARD_POINTS,
    })
  }
  const entries = [...byCode.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_ENTRIES)

  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: STORE_VERSION, entries }, null, 2), "utf8")
  } catch {
    // 目录不可写就只活在内存里（本次进程内仍能用）
  }
  return entries.length
}

/**
 * 兜底邀请码：码库为空（第一次装、或者从没登录过第二个号）时也要有候选。
 *
 * 取值原则：**只放当前 active 的码**。已用尽（`exhausted` / `usedCount === maxUses`）
 * 的码不要放进来 —— `pickInviteCode()` 会把它挑出来又白跑一次绑定请求。
 * 顺序即优先级：靠前的先被挑中。
 *
 * 换码：改这里，或直接用环境变量 `LOOMY_INVITE_CODE=CODE1,CODE2`（逗号分隔，覆盖本表）。
 */
export const FALLBACK_INVITE_CODES = Object.freeze(
  String(process.env.LOOMY_INVITE_CODE ?? "").trim()
    ? String(process.env.LOOMY_INVITE_CODE).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)
    : ["J2QC44", "V5Y8JE"],
)

/**
 * 候选邀请码：排除本号自己那份。
 *
 * @param {string} selfSession 当前账号的 session（只用来算归属指纹，不落盘）
 * @param {{ path?: string, now?: number }} [opts]
 * @returns {Array<{ code: string }>}
 */
export function inviteCandidates(selfSession, { path = storePath(), now = Date.now(), fallback = FALLBACK_INVITE_CODES } = {}) {
  const self = ownerTag(selfSession)
  const all = loadInviteStore(path, now)
  const stored = all.filter((row) => !row.owner || row.owner !== self)
  // 本号自己的码：既要排除，也不能在兜底那一步被加回来
  // （否则「自己邀请自己」的候选还在，只是靠 pickInviteFor 的第二道 selfCode 拦着）
  const selfCodes = new Set(all.filter((row) => row.owner && row.owner === self).map((row) => row.code))

  const out = stored.map((row) => ({
    code: row.code,
    status: typeof row.status === "string" ? row.status : "",
    usedCount: Number.isFinite(row.usedCount) ? row.usedCount : 0,
    maxUses: Number.isFinite(row.maxUses) ? row.maxUses : 0,
  }))

  // 兜底排在最后：自己攒到的码优先，兜底只在没有可用码时被挑中。
  // 同一个 code 已经在库里就以库里的状态为准（那份是最近一次查到的真实状态）。
  const known = new Set(out.map((row) => row.code))
  for (const code of fallback || []) {
    const value = String(code ?? "").trim().toUpperCase()
    if (!value || known.has(value) || selfCodes.has(value)) continue
    known.add(value)
    out.push({ code: value, status: "active", usedCount: 0, maxUses: 0 })
  }
  return out
}
