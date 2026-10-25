// Loomy · 桌面端登录态导入
//
// Loomy 是 Electron 应用，登录态以**明文 JSON** 存在 Chromium 的 Local Storage
// （leveldb）里，键名 `loomy-auth-session`：
//   {"phone":…, "maskedPhone":…, "session":…, "userid":…, "loggedInAt":…}
// 无加密、无 DPAPI —— 实测（Loomy 0.9.39，Windows）`000003.log` 里可直接读出
// session，且该 session 能打通 `/api/v1/models` 与积分接口。
//
// ⚠ leveldb 的 log 是**追加写**的：同一个键可能有多份，新的在后。
//   所以从后往前找，拿到的才是当前登录态。
// ⚠ 只读取本机自己的客户端存储，不碰任何别的用户数据；读不到就返回 null，
//   由上层提示「请先打开 Loomy 客户端登录」而不是报错。

import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const DESKTOP_SESSION_KEY = "loomy-auth-session"

export function desktopStorageDirs() {
  const home = os.homedir()
  const dirs = []
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming")
    dirs.push(path.join(appData, "Loomy", "Local Storage", "leveldb"))
  } else if (process.platform === "darwin") {
    dirs.push(path.join(home, "Library", "Application Support", "Loomy", "Local Storage", "leveldb"))
  } else {
    const cfg = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
    dirs.push(path.join(cfg, "Loomy", "Local Storage", "leveldb"))
  }
  return dirs
}

/** 读本机 Loomy 桌面端登录态；没有返回 null。 */
export function readDesktopSession() {
  for (const dir of desktopStorageDirs()) {
    const value = readSessionFrom(dir)
    if (value) return value
  }
  return null
}

export function readSessionFrom(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const logs = entries
    .filter((e) => e.isFile() && e.name.endsWith(".log"))
    .map((e) => e.name)
    .sort()
    .reverse() // 新的在后 ⇒ 从后往前

  for (const name of logs) {
    let bytes
    try {
      bytes = readFileSync(path.join(dir, name))
    } catch {
      continue
    }
    const key = new TextEncoder().encode(DESKTOP_SESSION_KEY)
    let at = bytes.lastIndexOf(key)
    while (at >= 0) {
      const value = jsonAfter(bytes, at + key.length)
      if (value && typeof value.session === "string" && value.session.trim()) return value
      at = bytes.lastIndexOf(key, at - 1)
    }
  }
  return null
}

/**
 * 从字节串里取 key 之后那个完整的 JSON 对象（括号配对，跳过字符串里的括号）。
 * 容错：截断的写入解析失败就返回 null，由调用方继续往前找。
 */
export function jsonAfter(bytes, from) {
  const open = bytes.indexOf(0x7b, from) // "{"
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte === 0x22) {
      // 跳过字符串字面量，括号配对不受其内容干扰
      i++
      while (i < bytes.length && bytes[i] !== 0x22) {
        if (bytes[i] === 0x5c) i++ // 反斜杠转义
        i++
      }
      continue
    }
    if (byte === 0x7b) depth++
    else if (byte === 0x7d && --depth === 0) {
      try {
        return JSON.parse(bytes.subarray(open, i + 1).toString("utf8"))
      } catch {
        return null
      }
    }
  }
  return null
}

// ════════════════════════════════════════════════════════════════════
// 本机已有的 Loomy 账号（读 magpie 的凭据文件）
// ════════════════════════════════════════════════════════════════════
//
// 为什么要读文件：`getAuth()` 只在**当前账号作用域**里可见（magpie 的 inScope），
// 拿不到同一 provider 下的**其它**账号。而「用已有账号的邀请码邀请新账号」
// 这件事，恰恰需要知道别的账号是什么 —— 只能直接读 `plugin-auth.json`。
//
// ⚠ 只读、只取 `access`（session），不打印、不外传。
// ⚠ 只认 `loomy` 与 `loomy#xxxxxx` 两种键（magpie 的多账号命名）。
// ⚠ 读不到就当没有：登录流程不能因为读凭据失败而失败。

/** magpie 的凭据文件位置（与 `~/.config/magpie` 一致；DSH/MAGPIE 目录可用环境变量覆盖）。 */
export function authFilePath() {
  if (process.env.MAGPIE_AUTH_FILE) return process.env.MAGPIE_AUTH_FILE
  const home = os.homedir()
  const cfg = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
  return path.join(cfg, "magpie", "plugin-auth.json")
}

/**
 * 本机所有 Loomy 账号的 session（**排除** excludeSession）。
 *
 * 顺序稳定（`loomy` 在前，其余按名排序），方便「优先用主账号的邀请码」。
 */
export function readAllLoomySessions(excludeSession) {
  let raw
  try {
    raw = JSON.parse(readFileSync(authFilePath(), "utf8"))
  } catch {
    return []
  }
  if (!raw || typeof raw !== "object") return []

  const keys = Object.keys(raw)
    .filter((k) => k === "loomy" || k.startsWith("loomy#"))
    .sort((a, b) => (a === "loomy" ? -1 : b === "loomy" ? 1 : a.localeCompare(b)))

  const out = []
  for (const key of keys) {
    const rec = raw[key]
    const session = typeof rec?.access === "string" ? rec.access.trim() : ""
    if (!session) continue
    if (excludeSession && session === excludeSession) continue
    if (!out.includes(session)) out.push(session)
  }
  return out
}

/** 本机所有 Loomy 账号的 `{key, session, phone}`（供挑选邀请码时排除自己）。 */
export function readAllLoomyAccounts() {
  let raw
  try {
    raw = JSON.parse(readFileSync(authFilePath(), "utf8"))
  } catch {
    return []
  }
  if (!raw || typeof raw !== "object") return []
  return Object.keys(raw)
    .filter((k) => k === "loomy" || k.startsWith("loomy#"))
    .sort((a, b) => (a === "loomy" ? -1 : b === "loomy" ? 1 : a.localeCompare(b)))
    .map((key) => ({
      key,
      session: typeof raw[key]?.access === "string" ? raw[key].access.trim() : "",
      phone: typeof raw[key]?.phone === "string" ? raw[key].phone : "",
    }))
    .filter((x) => x.session)
}
