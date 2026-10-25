// Loomy（讯飞）· magpie 供应商插件
//
// ═══════════════════════════════════════════════════════════════════════
// 这个插件解决的问题
// ═══════════════════════════════════════════════════════════════════════
//
// 市场上现有的 Loomy 插件把积分卡片报错了，而**这不是外观问题**：
// magpie 按每个非 aside 窗口的 `used` 给账号排序，报错就让一个被蹬空的号
// 以 `used:0` 的姿态排在队伍最前面。实测三天路由日志：
//
//     组内被选中 256 / 2592 = 9.9%   其中 255 次命中余额为 0 的那个号
//     带失败迹象 11 次，含「Loomy: 积分余额不足，请获取积分后再试」
//
// 本插件把两池读数按 magpie 的真实语义上报：
//
//   今日池   —— **参与路由**，真实占比（used / amount / limit / resetsAt 齐全）
//   永久池   —— `aside`，只显示余额。它无周期、无上限，不该驱动路由
//   皆空时   —— 合成一条 `used: 100` 的参与路由窗口，让这个号**沉底**
//
// 另修一个同源的显示缺陷：签到返回的 outcome 必须是契约六个合法值之一
// （`claimed/done/ineligible/inactive/captcha/failed`）。现装插件返回
// `"success"` —— 不在表里，magpie 一律归 `failed` 却保留它的 message，
// 于是界面出现「签到失败 · 每日赠送积分已刷新」这种自相矛盾的行。
//
// ═══════════════════════════════════════════════════════════════════════
// 九项清单（一项不缺）
// ═══════════════════════════════════════════════════════════════════════
//
//   ① config(cfg)                      声明 provider + 静态模型表
//   ② auth.methods[].authorize()       三种登录（桌面端导入 / 短信 / 粘贴 session）
//   ③ auth.refresh                      Loomy 无续期接口 —— 显式返回 undefined
//   ④ auth.loader(getAuth, provider)    请求接管（token 双头 + 图片改写 + 额度闸）
//   ⑤ auth.usage(getAuth, provider)     两池窗口（本插件的核心）
//   ⑥ auth.checkin(getAuth, provider)   每日额度刷新（合法 outcome）
//   ⑦ provider.models(provider,{auth})  每账号真实目录（失败退回静态表）
//   ⑧ "chat.headers"(input, output)     会话保持
//   ⑨ accountId / uid / icon / maxConcurrency
//
// ═══════════════════════════════════════════════════════════════════════
// 三条铁律（踩过就知道）
// ═══════════════════════════════════════════════════════════════════════
//
// 1. `config.models` 必须有内容 —— 未登录也要有，否则卡片显示 "0 models"
// 2. `authorize()` 立刻返回 —— 真正等登录的是 `callback()`，否则和 magpie 死锁
// 3. 入口模块**只导出工厂** —— magpie 把每个函数导出都当插件工厂调用，
//    所以 helper 全在 `_pure` 这个非函数对象与各 src 模块里
//
// ═══════════════════════════════════════════════════════════════════════
// Loomy 协议要点（全部实测，2026-10-26）
// ═══════════════════════════════════════════════════════════════════════
//
//   session 有效期 14 天，**没有续期接口** —— 过期只能重登（本插件不伪造 refresh）
//   `POST /api/v1/points/first-login` 是每日额度刷新，幂等，判据是 `alreadyProcessed`
//   `dailyQuota` / `dailyConsumed` / `dailyCycleDate` **只在这个响应里**
//   `/api/v1/points/balance` 只回 3 个数，是读余额的最小端点
//   `/api/v1/points/records` 的每条 debit 带 `consumeSource` + `dailyCycleDate`
//   `/api/v1/models` 含 image 型条目，必须按 `type === "chat"` 过滤
//   deepseek 系模型只认 `<image_base64>` 标记，不认 `image_url` data URI
//   业务日按东八区；部分错误是 HTTP 200 + 信封 code

import { _pure } from "./src/pure.mjs"
import {
  CATALOG_TTL_MS,
  ICON,
  NPM,
  PROVIDER,
  PROVIDER_NAME,
  SESSION_TTL_MS,
  INTEGRATION_BASE,
} from "./src/constants.mjs"
import { claimDailyQuota, loginBySmsCode, fetchBalances, sendSmsCode } from "./src/api.mjs"
import { readDesktopSession } from "./src/desktop.mjs"
import { staticModels, liveModels } from "./src/models.mjs"
import { readUsage, publicUsage, quotaToRemember, clearUsageCache } from "./src/usage.mjs"
import { chatFetch } from "./src/chat.mjs"
import { startSelfRegister } from "./src/self-register.mjs"

const API_URL = `${INTEGRATION_BASE}/api/v1`

const REGISTRY_ENTRY = {
  package: "magpie-plugin-loomy-auth",
  name: PROVIDER_NAME,
  providers: [PROVIDER],
  community: true,
  summary: {
    en: "Loomy (iFlytek) coding subscription for magpie: desktop-session import / SMS / session sign-in, live model catalog with reasoning efforts, chat with tool calling and images, and the two credit pools (daily + permanent) reported as the host routes them — the daily pool counts, the permanent one is shown aside.",
    zh: "讯飞 Loomy 编程订阅：桌面端登录态导入 / 短信 / 粘贴 session 三种登录，实时模型目录与思考档位，工具调用与图片对话，以及分池上报的积分（今日池参与路由、永久池仅展示）—— 修掉「退化账号显示剩余 100%」这类占比缺陷。",
  },
}

export const LoomyAuthPlugin = async ({ client, directory } = {}) => {
  const log = (message, level = "info") => {
    try {
      client?.app?.log?.({ service: "loomy", level, message })
    } catch {
      // 没有日志通道就算了
    }
  }

  // 自注册：写一次就够（magpie 静默时不碰市场缓存，实测 3 分钟零变化）
  startSelfRegister(REGISTRY_ENTRY, { configDir: directory, log })

  // 目录进程内缓存：session -> { at, models }
  const catalog = new Map()

  /**
   * 把 quota 写回凭据，让下次 usage 走「0 额外请求」的快路径。
   *
   * ⚠ magpie 的 `client.auth.set` 是**整体替换**（不是合并），
   *   所以必须带回原记录的其它字段；而 `keyFor(id)` 在账号作用域里
   *   会把 id 解析成**当前账号**的键，因此这里写的就是当前账号。
   */
  const remember = async (provider, auth, patch) => {
    if (!patch) return
    const body = { ...(auth ?? {}), ...patch }
    try {
      await client?.auth?.set?.({ path: { id: provider }, body })
    } catch (e) {
      log(`额头上限写回失败（不影响功能，只是下次多一次推导）：${e?.message ?? e}`, "warn")
    }
  }

  return {
    // ═══ ① 声明 provider ═══════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      // ⚠ 用 ??= ：不要覆盖用户在 plugins.json 里配的
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: NPM,
        api: API_URL,
        // ⚠ 未登录时也必须有内容，否则 magpie 显示 "0 models"
        models: staticModels(),
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: 4,
      // Loomy 没有续期接口；这个值只影响 magpie 何时「尝试」续期，
      // 而 refresh 恒返回 undefined，所以不会真的去续。
      refreshLead: 60_000,

      // ═══ ② 登录 ═══════════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: "Loomy 桌面端登录态（自动读取本机客户端）",
          /**
           * ⚠ 立刻返回：真正的等待在 callback 里。这里只做一次同步读盘 + 校验。
           *   （读盘是毫秒级的，但校验要发一次请求 —— 也放在 callback 里做，
           *     免得 authorize 卡住导致 magpie 拿不到 url 而死锁。）
           */
          authorize: async () => {
            const desktop = readDesktopSession()
            if (!desktop) {
              return {
                type: "failed",
                error:
                  "没有读到本机 Loomy 桌面端的登录态：请先打开 Loomy 客户端并登录，或改用手机号 / 粘贴 session 的方式。",
              }
            }
            const session = String(desktop.session).trim()
            return {
              url: "",
              method: "auto",
              instructions: `将从本机 Loomy 客户端导入登录态（${
                desktop.maskedPhone || (desktop.phone ? _pure.maskPhone(String(desktop.phone)) : "Loomy")
              }）。`,
              callback: async () => {
                // 一次校验：目录能拉通才算这个 session 是活的
                try {
                  await liveModels(session, {})
                } catch (error) {
                  return {
                    type: "failed",
                    error: `桌面端登录态已失效（${error?.message ?? error}）：请在 Loomy 客户端重新登录后重试。`,
                  }
                }
                const label =
                  desktop.maskedPhone ||
                  (desktop.phone ? _pure.maskPhone(String(desktop.phone)) : `Loomy ${session.slice(-6)}`)
                // 登录后立刻初始化当天额度（官方客户端同款行为）并把上限记进凭据
                const claim = await claimDailyQuota(session)
                return {
                  type: "success",
                  access: session,
                  refresh: "",
                  expires: Date.now() + SESSION_TTL_MS,
                  accountId: label,
                  ...(desktop.userid ? { uid: String(desktop.userid) } : {}),
                  ...(desktop.phone ? { phone: String(desktop.phone) } : {}),
                  ...quotaPatch(claim),
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "手机号 + 短信验证码",
          prompts: [
            { type: "text", key: "phone", message: "手机号（中国大陆 11 位）", placeholder: "13800000000" },
          ],
          authorize: async (inputs) => {
            // ⚠ authorize 不许抛异常：抛出去 magpie 只会看到一次失败，
            //   用户拿不到「为什么」。所以校验收成返回值。
            let phone
            try {
              phone = _pure.normalizePhone(inputs?.phone)
            } catch (error) {
              return { type: "failed", error: String(error?.message ?? error) }
            }
            const msgid = await sendSmsCode(phone)
            log(`验证码已发送（尾号 ${phone.slice(-4)}）`)
            return {
              url: "",
              method: "code",
              instructions: `验证码已发送至 ${_pure.maskPhone(phone)}，输入 6 位数字完成登录。`,
              callback: async (code) => {
                const { session, userid } = await loginBySmsCode(phone, code, msgid)
                const claim = await claimDailyQuota(session)
                return {
                  type: "success",
                  access: session,
                  refresh: "",
                  expires: Date.now() + SESSION_TTL_MS,
                  accountId: _pure.maskPhone(phone),
                  uid: userid,
                  phone,
                  ...quotaPatch(claim),
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "粘贴 session（Loomy 客户端登录态）",
          prompts: [
            {
              type: "password",
              key: "session",
              message: "Loomy session（同时是模型网关的 token）",
              placeholder: "粘贴 session 字符串",
            },
            {
              type: "text",
              key: "note",
              message: "备注名（可选）",
              placeholder: "例如 138****0000",
              validate: () => undefined,
            },
          ],
          authorize: async (inputs) => {
            const session = String(inputs?.session ?? "").trim()
            if (!session) return { type: "failed", error: "请粘贴 session" }
            try {
              await liveModels(session, {})
            } catch {
              return { type: "failed", error: "session 无效或已过期（拉取模型目录失败）" }
            }
            const note = String(inputs?.note ?? "").trim()
            const claim = await claimDailyQuota(session)
            return {
              type: "success",
              access: session,
              refresh: "",
              expires: Date.now() + SESSION_TTL_MS,
              accountId: note || `Loomy ${session.slice(-6)}`,
              ...quotaPatch(claim),
            }
          },
        },
      ],

      // ═══ ③ 续期 ═══════════════════════════════════════════════════
      /**
       * Loomy **没有续期接口**（实测：无 refresh 端点，会话固定 14 天）。
       *
       * 所以这里显式返回 undefined —— **不伪造 refresh_token**。
       * 伪造的后果比过期更糟：magpie 会以为能自动续，于是把账号标记成
       * 「可恢复」，用户永远等不到「请重新登录」的提示。
       * 过期时由 usage / loader 打 `signIn: "expired"` 让它如实标记。
       */
      async refresh() {
        return undefined
      },

      // ═══ ④ 请求接管 ═══════════════════════════════════════════════
      async loader(getAuth, provider) {
        const auth = await getAuth()
        const credential = _pure.credentialOf(auth)
        if (!credential) return {}

        return {
          baseURL: API_URL,
          // AI SDK 会用它发 `Authorization: Bearer <apiKey>`，但我们在 fetch
          // 里把它删掉换成真的 token 双头，所以这里给个占位值即可。
          apiKey: "loomy-session",
          async fetch(input, init) {
            // ⚠ 每次重新读 auth —— 可能已被写回/标记
            const fresh = await getAuth()
            const current = _pure.credentialOf(fresh) ?? credential
            const usageValue = await readUsage(current).catch(() => undefined)
            return chatFetch({
              input,
              init,
              credential: current,
              session: current.session,
              usageValue,
            })
          },
        }
      },

      // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
      /**
       * 本插件的核心。语义与判据见 `src/pure.mjs` 的 `windowsOf` 注释表。
       *
       * 一句话：**今日池参与路由、永久池只展示、皆空时让这个号沉底。**
       */
      async usage(getAuth, provider) {
        const auth = await getAuth()
        const credential = _pure.credentialOf(auth)
        if (!credential) return { error: "未登录", windows: [] }

        const value = await readUsage(credential)

        // 把推导出来的当天上限记回凭据 → 下次 usage 零额外请求
        const patch = quotaToRemember(value, credential)
        if (patch) await remember(provider?.id ?? PROVIDER, auth, patch)

        return publicUsage(value)
      },

      // ═══ ⑥ 签到 ═══════════════════════════════════════════════════
      /**
       * magpie 按**北京时间**每账号每天调一次，当天失败后还会再调。
       *
       * ⚠ outcome 必须是契约六个合法值之一 —— 这是市场插件正在犯的错
       *   （返回 `"success"`，magpie 归 `failed` 却保留 message，
       *    界面于是显示「签到失败 · 每日赠送积分已刷新」）。
       */
      async checkin(getAuth, provider) {
        const auth = await getAuth()
        const credential = _pure.credentialOf(auth)
        if (!credential) return { outcome: "failed", message: "未登录" }

        const claim = await claimDailyQuota(credential.session)
        const result = _pure.checkinOutcome(claim)

        if (claim.ok) {
          // 签到是拿到 `dailyQuota` 的**权威时刻**：记进凭据并清缓存，
          // 让卡片立刻反映新的上限（而不是等 60 秒 TTL）
          await remember(provider?.id ?? PROVIDER, auth, quotaPatch(claim))
          clearUsageCache()
        }
        return result
      },
    },

    // ═══ ⑦ 每账号的模型目录 ═══════════════════════════════════════
    provider: {
      id: PROVIDER,
      name: PROVIDER_NAME,

      async models(provider, { auth } = {}) {
        const fallback = staticModels()
        const credential = _pure.credentialOf(auth)
        if (!credential) return fallback

        const hit = catalog.get(credential.session)
        if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.models

        try {
          const models = await liveModels(credential.session, fallback)
          catalog.set(credential.session, { at: Date.now(), models })
          return models
        } catch (error) {
          log(`目录拉取失败，回退静态表：${error?.message ?? error}`, "warn")
          // 登录被拒 → 标记账号（magpie 会提示重新登录）
          if (error?.signIn === "expired" || /401|403|登录|失效/.test(String(error?.message))) {
            throw Object.assign(new Error("Loomy 登录已失效，请重新登录"), { signIn: "expired" })
          }
          return fallback
        }
      },
    },

    // ═══ ⑧ 每请求加头 ═════════════════════════════════════════════
    /**
     * 同一会话多轮不变；上游没有 cache 头可用，但把会话 id 带上便于
     * 上游/日志关联（与 market 上其它 provider 的做法一致）。
     */
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER || !input?.sessionID) return
      output.headers["x-loomy-session"] = String(input.sessionID).slice(0, 128)
    },
  }
}

/** 从签到响应里挑出要写回凭据的上限字段（拿不到就不写，不编造）。 */
function quotaPatch(claim) {
  const value = Number(claim?.dailyQuota)
  if (!Number.isFinite(value) || value <= 0) return {}
  return {
    dailyQuota: value,
    ...(claim?.dailyCycleDate ? { dailyCycleDate: claim.dailyCycleDate } : {}),
  }
}

// 供测试引用（⚠ 入口文件不要导出函数，否则会被 magpie 当插件工厂调用）
export const _internal = {
  PROVIDER,
  API_URL,
  pure: _pure,
  staticModels,
  liveModels,
  readUsage,
  publicUsage,
  quotaToRemember,
  quotaPatch,
  readDesktopSession,
  claimDailyQuota,
  fetchBalances,
}
