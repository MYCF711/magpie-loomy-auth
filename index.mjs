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
import { claimDailyQuota, loginBySmsCode, fetchBalances, sendSmsCode, fetchOnboarding, claimAllTasks, fetchInviteCodes, bindInviteCode, fetchActivation } from "./src/api.mjs"
import { readDesktopSession, readAllLoomySessions, readAllLoomyAccounts } from "./src/desktop.mjs"
import { staticModels, liveModels } from "./src/models.mjs"
import { readUsage, publicUsage, quotaToRemember, clearUsageCache } from "./src/usage.mjs"
import { chatFetch } from "./src/chat.mjs"

const API_URL = `${INTEGRATION_BASE}/api/v1`

export const LoomyAuthPlugin = async ({ client } = {}) => {
  const log = (message, level = "info") => {
    try {
      client?.app?.log?.({ service: "loomy", level, message })
    } catch {
      // 没有日志通道就算了
    }
  }

  // 卡片标题与文案不在这里做 —— 那是 registry 条目的职责（registry-entry.json）。
  // 插件不写 magpie 自己的缓存目录：那份文件属于 magpie，插件只读不写。

  // 目录进程内缓存：session -> { at, models }
  const catalog = new Map()

  // 新手任务缓存：session -> { at, value }。10 分钟，足够跟上任务进度，
  // 又不至于让每次 usage 刷新都多打一个端点。
  const onboardingCache = new Map()
  const ONBOARDING_TTL_MS = 10 * 60_000

  const onboardingWindowFor = async (credential) => {
    const hit = onboardingCache.get(credential.session)
    if (hit && Date.now() - hit.at < ONBOARDING_TTL_MS) return hit.value
    let value = null
    try {
      const state = await fetchOnboarding(credential.session)
      value = _pure.onboardingWindow(state.tasks, state.total)
    } catch {
      // 拿不到就不画这一格 —— 不许因为一个加分项让整张卡片报错
      value = null
    }
    onboardingCache.set(credential.session, { at: Date.now(), value })
    return value
  }

  /**
   * 把 quota 写回凭据，让下次 usage 走「0 额外请求」的快路径。
   *
   * ⚠ magpie 的 `client.auth.set` 是**整体替换**（不是合并），
   *   所以必须带回原记录的其它字段；而 `keyFor(id)` 在账号作用域里
   *   会把 id 解析成**当前账号**的键，因此这里写的就是当前账号。
   */
  /**
   * 收集**本机其它已登录 Loomy 账号**的邀请码，供新账号首次登录时使用。
   *
   * 为什么需要读文件：`getAuth()` 只在**当前账号作用域**里可见（magpie 的
   * `inScope`），拿不到别的账号。而邀请码存在别的账号名下 —— 只能从
   * `plugin-auth.json` 里把 loomy / loomy#xxxx 这些条目全捞出来，逐个查。
   *
   * ⚠ 全失败就当没有（登录不能因为「找不到邀请码」而失败）。
   * ⚠ 结果按分钟缓存：登录是低频操作，但三个 provider id 会各扫一遍，
   *   没必要每次都打 N 个只读请求。
   */
  const inviteCodeCache = new Map() // session -> { at, codes }
  const INVITE_CACHE_TTL_MS = 60_000

  const collectInviteCandidates = async (excludeSession) => {
    const sessions = readAllLoomySessions(excludeSession)
    const out = []
    for (const session of sessions) {
      const hit = inviteCodeCache.get(session)
      if (hit && Date.now() - hit.at < INVITE_CACHE_TTL_MS) {
        out.push(...hit.codes)
        continue
      }
      try {
        const codes = await fetchInviteCodes(session)
        inviteCodeCache.set(session, { at: Date.now(), codes })
        out.push(...codes)
      } catch {
        // 这个号查不到就跳过，不影响其它号
      }
    }
    return out
  }

  /**
   * 给**本账号**挑一个可用的邀请码（供签到钩子调用）。
   *
   * 返回 `undefined` 表示不该兑换 —— 三种情况：
   *   1. 本号已经兑换过别人的码（`activated: true`）—— 每号只能一次，别白发请求
   *   2. 本机没有**别人**的码（只有自己）—— 不能自己邀请自己
   *   3. 挑不出还有余量的码
   *
   * ⚠ **被邀请者仍可以继续邀请别人**：实测 181 号兑换了 189 的码之后，
   *   它自己的 `FDW3CU` 仍是 `active` / `usedCount 0`。所以这里**不**因为
   *   「本号 activated」就把本号从候选里剔除 —— 它自己那份照常可用。
   *   反过来，**已邀请过我的那个码**要排除：不然 A 邀请 B、B 又邀请 A，
   *   平台侧可能视作互刷。
   */
  const pickInviteFor = async (session) => {
    // ① **判据只有一条：本号是否已经被邀请过。**
    //
    //    平台规则就这一条（客户端文案：「每个账号仅能兑换一次」「你已经兑换过积分啦」）。
    //    所以不需要知道「谁邀请了谁」—— 那信息接口根本不提供
    //    （`invitation-codes` 只回 `usedCount` 这个数量，不说是谁）。
    //    `appliedInvitationCode` 只用于日志，不参与判断。
    let applied
    try {
      const st = await fetchActivation(session)
      if (st.activated) return undefined
      applied = st.appliedInvitationCode
    } catch {
      // 读不到状态就别乱兑换 —— 宁可这一天不换
      return undefined
    }

    // ② 本号自己的码要从候选里排除（不能自己邀请自己）
    let selfCode
    try {
      const mine = await fetchInviteCodes(session)
      selfCode = mine[0]?.code
    } catch {
      selfCode = undefined
    }

    // ③ 从本机**别的账号**的码里挑一个还有余量的
    const candidates = await collectInviteCandidates(session)
    const picked = _pure.pickInviteCode(candidates, selfCode)
    if (!picked) return undefined
    if (applied && picked.code === applied) return undefined // 理论上不可达，防御性保留
    return picked.code
  }

  /**
   * 新账号登录后的收尾：把「已有账号的邀请码」带上去 + 记住当日上限。
   *
   * ⚠ 邀请码必须走 `first-login`（首次初始化）或 `points/activation`，
   *   而**每个账号只能兑换一次** —— 客户端文案：「您可以使用邀请码兑换一次积分」。
   *   所以这里先查一次 `activation`：已经用过的就不再动，避免白白发一次写请求。
   *
   * 邀请码从**其它已登录账号**里挑（`getAuth` 拿不到全局，所以由调用方传 candidates）。
   * 一个都找不到就静默跳过 —— 这是加分项，不该让登录失败。
   */
  /**
   * 登录后的收尾：**只初始化当天额度**，顺手记进凭据。
   *
   * ⚠ 邀请码**不在这里兑换**。它是「账号存在期间随时可做一次」的事，
   *   不是「注册那一刻必须做」的事 —— 放进每天一次的签到钩子，既覆盖新号
   *   第一次签到，也覆盖「老号后来才想用」，注册流程里不用塞输入框。
   *   见下面 `auth.checkin` 的第 ③ 步。
   */
  const settleNewAccount = async (session) => {
    const claim = await claimDailyQuota(session)
    return quotaPatch(claim)
  }

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
                // 登录后立刻初始化当天额度（官方客户端同款行为）并把上限记进凭据；
                // 顺便带上已有账号的邀请码（每个账号只能兑换一次，失败不影响登录）
                const patch = await settleNewAccount(session)
                return {
                  type: "success",
                  access: session,
                  refresh: "",
                  expires: Date.now() + SESSION_TTL_MS,
                  accountId: label,
                  ...(desktop.userid ? { uid: String(desktop.userid) } : {}),
                  ...(desktop.phone ? { phone: String(desktop.phone) } : {}),
                  ...patch,
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
                const patch = await settleNewAccount(session)
                return {
                  type: "success",
                  access: session,
                  refresh: "",
                  expires: Date.now() + SESSION_TTL_MS,
                  accountId: _pure.maskPhone(phone),
                  uid: userid,
                  phone,
                  ...patch,
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
            const patch = await settleNewAccount(session)
            return {
              type: "success",
              access: session,
              refresh: "",
              expires: Date.now() + SESSION_TTL_MS,
              accountId: note || `Loomy ${session.slice(-6)}`,
              ...patch,
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

        const usage = publicUsage(value)
        // 新手任务：一次性可领的 1 万分，只做 aside 展示（不参与路由）。
        // ⚠ 单独缓存 10 分钟 —— 它是另一个端点，而 usage 会被频繁刷新。
        const extra = await onboardingWindowFor(credential)
        if (extra) usage.windows = [...(usage.windows ?? []), extra]
        return usage
      },

      // ═══ ⑥ 签到 ═══════════════════════════════════════════════════
      /**
       * magpie 按**北京时间**每账号每天调一次，当天失败后还会再调。
       *
       * ⚠ outcome 必须是契约六个合法值之一 —— 这是市场插件正在犯的错
       *   （返回 `"success"`，magpie 归 `failed` 却保留 message，
       *    界面于是显示「签到失败 · 每日赠送积分已刷新」）。
       */
      /**
       * 签到钩子 = **每天把能领的都领一遍**。
       *
       * magpie 按北京时间每账号每天调一次，所以这里是「顺手做」的最佳位置：
       *
       *   ① 刷新每日额度（`first-login`，幂等）
       *   ② 领新手任务（`onboarding/tasks/complete`，幂等）
       *   ③ 兑换邀请码（`points/activation`，**每账号一次**）
       *
       * 三件事全部幂等，重复调用无害 —— 这是把它们放在每天签到里的前提。
       * ⚠ ②③ 失败都**不影响签到结果**：它们是一天里顺带做的事，
       *   不是签到的前置条件。
       */
      async checkin(getAuth, provider) {
        const auth = await getAuth()
        const credential = _pure.credentialOf(auth)
        if (!credential) return { outcome: "failed", message: "未登录" }

        // ① 每日额度
        const claim = await claimDailyQuota(credential.session)
        const result = _pure.checkinOutcome(claim)
        if (claim.ok) {
          // 签到是拿到 `dailyQuota` 的**权威时刻**：记进凭据并清缓存，
          // 让卡片立刻反映新的上限（而不是等 60 秒 TTL）
          await remember(provider?.id ?? PROVIDER, auth, quotaPatch(claim))
          clearUsageCache()
        }

        const extras = []

        // ② 新手任务
        try {
          const state = await fetchOnboarding(credential.session)
          const { claimed, failed } = await claimAllTasks(credential.session, state.tasks)
          onboardingCache.set(credential.session, { at: Date.now(), value: null })
          if (claimed.length > 0) {
            const gained = claimed.reduce((n, x) => n + x.points, 0)
            log(`新手任务领到 ${claimed.length} 项（+${gained} 分）${failed.length ? `，${failed.length} 项失败` : ""}`)
            extras.push(`新手任务 +${gained} 分`)
            clearUsageCache()
          }
        } catch (e) {
          log(`新手任务领取跳过：${e?.message ?? e}`, "warn")
        }

        // ③ 邀请码 —— **签到时才兑换，不在登录时**
        //
        // 为什么改到这里：邀请码的有效期是「帐号存在期间」，不是「注册那一刻」。
        // 放在签到里，既覆盖了「新号第一次签到」，也覆盖了「老号后来才决定用」，
        // 不用在注册流程里塞一个输入框。
        try {
          const picked = await pickInviteFor(credential.session)
          if (picked) {
            const r = await bindInviteCode(credential.session, picked)
            if (r.ok && !r.alreadyActivated) {
              log(`已兑换邀请码 ${picked}（邀请人 +${_pure.INVITE_REWARD_POINTS}，本号 +${_pure.INVITE_REWARD_POINTS}）`)
              extras.push(`邀请码 +${_pure.INVITE_REWARD_POINTS} 分`)
              clearUsageCache()
            } else if (r.ok && r.alreadyActivated) {
              log(`本号已兑换过邀请码（${picked}），跳过`)
            } else {
              log(`邀请码兑换失败（不影响签到）：${r.message}`, "warn")
            }
          }
        } catch (e) {
          log(`邀请码兑换跳过：${e?.message ?? e}`, "warn")
        }

        if (extras.length) result.message += ` · ${extras.join(" · ")}`
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
  fetchOnboarding,
  claimAllTasks,
  fetchInviteCodes,
  bindInviteCode,
  fetchActivation,
  readAllLoomyAccounts,
  pickInviteFor: (session) => pickInviteFor(session),
  collectInviteCandidates: (s) => collectInviteCandidates(s),
}
