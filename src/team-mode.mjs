// 布尔值仅是宿主的存储形式；用户选择的是个人 / 团队。
import { createHash } from "node:crypto"
import { fetchTeamContext, setCurrentTeam } from "./api.mjs"

const currentId = (data) => typeof data?.currentTeamId === "string" ? data.currentTeamId.trim() : ""
const joined = (data) => Array.isArray(data?.teams)
  ? data.teams.filter(t => t?.status === "active" && typeof t.teamId === "string" && t.teamId.trim())
  : []

export function createTeamModeController({ readOption }) {
  const accounts = new Map(), inFlight = new Map()
  function options() {
    const account = [...accounts.values()].find(a => a.teams.length)
    if (!account) return []
    return [{
      key: "team_mode", label: "积分账户", offLabel: "个人", onLabel: "团队",
      labels: { en: "Credit account", "zh-TW": "積分帳戶", ja: "ポイントアカウント", de: "Guthabenkonto" },
      offLabels: { en: "Personal", "zh-TW": "個人", ja: "個人", de: "Persönlich" },
      onLabels: { en: "Team", "zh-TW": "團隊", ja: "チーム", de: "Team" },
      default: !!account.current, placement: "accounts", immediate: true,
    }]
  }
  async function apply(credential, key, fetcher) {
    const previous = accounts.get(key)
    const data = await fetchTeamContext(credential.session, fetcher)
    const teams = joined(data), current = currentId(data)
    const target = teams.find(t => t.teamId === current)?.teamId
      ?? teams.find(t => t.teamId === previous?.target)?.teamId
      ?? teams[0]?.teamId
    let changed = !!previous && previous.current !== current
    if (!teams.length) {
      accounts.set(key, { teams, current, target, optionOn: !!current })
      return changed
    }
    // ⚠ 第一次观察只记录、绝不下发切换。
    // 宿主是「先声明开关、再重拉模型」的顺序，而 `options()` 在第一次 sync 之前是空的：
    // 此刻向宿主读这个键，拿到的只会是「未声明 ⇒ 缺省 false」。
    // 拿它当用户意图，就会把本来在团队里的账号静默切到个人（实测调用序：
    // GET identity → POST current-team {} → GET identity）。
    // 首次只把「开关 = 服务端当前身份」记下来，和 `options()` 里 default 的定义保持一致；
    // 之后只有在宿主读数与上次记录不同（= 用户真的拨了开关）时才写服务端。
    const optionOn = previous ? readOption() === true : !!current
    if (!previous || previous.optionOn === optionOn) {
      accounts.set(key, { teams, current, target, optionOn })
      return changed
    }
    const desired = optionOn ? target : ""
    if (current === desired) {
      accounts.set(key, { teams, current, target, optionOn })
      return changed
    }
    await setCurrentTeam(credential.session, desired, fetcher)
    const verified = await fetchTeamContext(credential.session, fetcher)
    // 失败时不落 optionOn：宿主读数仍是新值，下一次 sync 会重试。
    if (currentId(verified) !== desired) throw new Error("积分账户切换未生效，请重试")
    accounts.set(key, { teams: joined(verified), current: desired, target, optionOn })
    return true
  }
  return {
    options,
    async sync(credential, fetcher = fetch) {
      const key = createHash("sha256").update(credential.uid || credential.session).digest("hex")
      const pending = (inFlight.get(key) ?? Promise.resolve()).catch(() => {}).then(() => apply(credential, key, fetcher))
      inFlight.set(key, pending)
      try { return await pending } finally {
        if (inFlight.get(key) === pending) inFlight.delete(key)
      }
    },
  }
}
