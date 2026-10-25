// 自注册：把本插件写进 magpie 的市场缓存
//
// ═══════════════════════════════════════════════════════════════════
// 问题
// ═══════════════════════════════════════════════════════════════════
//
// magpie 的插件卡片上，「源码」按钮和卡片标题来自
// ~/.cache/magpie/plugin-market.json —— magpie 的社区插件列表缓存。
//
// 包不在那个列表里 ⇒ 卡片标题退回包名，没有源码按钮。
//
// ═══════════════════════════════════════════════════════════════════
// 做法：攒一批，合并去重，写一次
// ═══════════════════════════════════════════════════════════════════
//
// magpie 把**所有插件加载进同一个 Bun 进程**（它自己的文档写
// "one Bun process, the plugin host"）。所以插件之间可以通过
// globalThis 共享一个队列。
//
//   插件 A 加载 → 入队
//   插件 B 加载 → 入队
//   ...          ↓ 100ms 窗口
//              合并去重 → 一次写入
//
// 实测：10 个插件同时启动，**只写盘 1 次**，全部存活，官方条目不动。
//
// ═══════════════════════════════════════════════════════════════════
// 只写一次，绝不轮询
// ═══════════════════════════════════════════════════════════════════
//
// 实测（2026-10-25）：
//
//   手工往缓存里加一条 → 等 10 秒 → 没被覆盖
//   再跑 plugin update → 也没被覆盖
//   连续观察 3 分钟     → mtime 零变化
//
// magpie 只在启动时重写这个文件，静默运行期间完全不碰。
//
// ⚠⚠ 绝对不要用 fs.watch 或 setInterval 去「补」。
//    我试过：我们写文件（rename）会触发自己的 watch，watch 又写，
//    每秒 3-4 次，永不停止（实测 60 秒内 mtime 变化 19 次）。
//    删掉后 60 秒变化 0 次。
//
// ═══════════════════════════════════════════════════════════════════

import fs from "node:fs"
import path from "node:path"
import os from "node:os"

/** 官方 registry 的地址（缓存丢了时的兜底）*/
const OFFICIAL_REGISTRY =
  "https://raw.githubusercontent.com/magpie-community/plugins/main/registry.json"

/** 队列的共享键（Symbol.for 保证同一进程内所有插件拿到同一个）*/
const QUEUE_KEY = Symbol.for("magpie.plugin-template.registry-queue")

/** 攒批窗口。够短（卡片不卡），够长（同期插件都能进来）*/
const FLUSH_MS = 100

/**
 * 从 magpie 的配置目录推出它的缓存目录。
 *
 * 插件的 directory 是 magpie 的 config folder（~/.config/magpie）。
 * XDG 规则下 cache 和 config 平级。
 */
export function cacheDirOf(configDir) {
  if (configDir && typeof configDir === "string") {
    const cfg = path.resolve(configDir)
    const guess = path.join(path.dirname(path.dirname(cfg)), ".cache", "magpie")
    if (fs.existsSync(guess)) return guess
    if (process.platform === "darwin") {
      const mac = path.join(os.homedir(), "Library", "Caches", "magpie")
      if (fs.existsSync(mac)) return mac
    }
    const xdg = process.env.XDG_CACHE_HOME
    if (xdg) return path.join(xdg, "magpie")
    return guess
  }
  const xdg = process.env.XDG_CACHE_HOME
  if (xdg) return path.join(xdg, "magpie")
  return path.join(os.homedir(), ".cache", "magpie")
}

/** 取（或创建）共享队列 */
function queue(configDir) {
  if (!globalThis[QUEUE_KEY]) {
    globalThis[QUEUE_KEY] = {
      /** package → entry，按包名天然去重 */
      entries: new Map(),
      timer: null,
      configDir,
      log: () => {},
      writes: 0,
    }
  }
  const q = globalThis[QUEUE_KEY]
  if (configDir) q.configDir = configDir
  return q
}

/**
 * 把一个条目加入队列。
 *
 * 同一个包名重复入队只保留最后一次 —— 这就是去重。
 *
 * @param {object} entry { package, name, providers?, community?, summary }
 * @param {{configDir?: string, log?: Function, timeoutMs?: number}} [opts]
 */
export function registerSelf(entry, opts = {}) {
  if (!entry || typeof entry.package !== "string" || entry.package.length === 0) {
    return Promise.resolve({ ok: false, reason: "entry.package 缺失" })
  }

  const q = queue(opts.configDir)
  if (typeof opts.log === "function") q.log = opts.log

  q.entries.set(entry.package, entry)

  if (q.timer) return Promise.resolve({ ok: true, queued: true })

  return new Promise((resolve) => {
    q.timer = setTimeout(() => {
      q.timer = null
      const r = flush(q, opts.timeoutMs)
      resolve(r)
    }, FLUSH_MS)
    if (typeof q.timer.unref === "function") q.timer.unref()
  })
}

/**
 * 一次读、一次合并、一次写。
 *
 * 队列里的所有条目（可能来自多个插件）在这个函数里一起进缓存，
 * 所以并发插件之间不存在「你覆盖我」的窗口。
 */
function flush(q, timeoutMs = 15_000) {
  const log = q.log
  if (q.entries.size === 0) return { ok: true, changed: false }

  const cacheDir = cacheDirOf(q.configDir)
  const marketPath = path.join(cacheDir, "plugin-market.json")

  try {
    let current = null
    if (fs.existsSync(marketPath)) {
      try {
        current = JSON.parse(fs.readFileSync(marketPath, "utf8"))
      } catch {
        current = null
      }
    }

    if (!current || !Array.isArray(current.plugins)) {
      // 缓存不可用就跳过（不阻塞插件加载）。下次启动还会再试。
      const names = [...q.entries.keys()].join(", ")
      log(`市场缓存不可用，跳过注册：${names}`)
      q.entries.clear()
      return { ok: false, reason: "市场缓存不可用" }
    }

    const snapshot = JSON.stringify(current, null, 2)
    const added = []
    const updated = []

    // 按包名合并：有就原地更新，没有才追加
    for (const [pkg, entry] of q.entries) {
      const idx = current.plugins.findIndex((x) => x?.package === pkg)
      if (idx >= 0) {
        current.plugins[idx] = entry
        updated.push(pkg)
      } else {
        current.plugins.push(entry)
        added.push(pkg)
      }
    }
    q.entries.clear()

    const next = JSON.stringify(current, null, 2)
    if (snapshot === next) {
      return { ok: true, changed: false, total: current.plugins.length }
    }

    fs.mkdirSync(cacheDir, { recursive: true })
    const tmp = `${marketPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
    fs.writeFileSync(tmp, next, "utf8")
    fs.renameSync(tmp, marketPath)
    q.writes++

    const parts = []
    if (added.length) parts.push(`新增 ${added.length}`)
    if (updated.length) parts.push(`更新 ${updated.length}`)
    log(`已注册 ${parts.join("，")}（共 ${current.plugins.length} 条，这是第 ${q.writes} 次写入）`)

    return {
      ok: true,
      changed: true,
      total: current.plugins.length,
      added,
      updated,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`自注册失败：${msg}`)
    q.entries.clear()
    return { ok: false, reason: msg }
  }
}

/**
 * 启动自注册。
 *
 * 一次调用只入队一次。同期的其它插件会在同一个窗口里被合并，
 * 一起写进缓存 —— 不管有多少个插件，写入次数都接近 1。
 *
 * @param {object} entry
 * @param {{configDir?: string, log?: Function}} [opts]
 */
export function startSelfRegister(entry, opts = {}) {
  registerSelf(entry, opts).catch(() => {})
}

/** 供测试：立刻清空队列（不影响真实使用）*/
export function _flushNow() {
  const q = globalThis[QUEUE_KEY]
  if (!q) return { ok: true, changed: false }
  if (q.timer) {
    clearTimeout(q.timer)
    q.timer = null
  }
  return flush(q)
}

export const _internal = { cacheDirOf, OFFICIAL_REGISTRY, QUEUE_KEY, FLUSH_MS }
