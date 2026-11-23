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
      default: !!account.current, placement: "top", immediate: true,
    }]
  }
  async function apply(credential, key, fetcher) {
    const previous = accounts.get(key)
    const data = await fetchTeamContext(credential.session, fetcher)
    const teams = joined(data), current = currentId(data)
    const target = teams.find(t => t.teamId === current)?.teamId
      ?? teams.find(t => t.teamId === previous?.target)?.teamId
      ?? teams[0]?.teamId
    accounts.set(key, { teams, current, target })
    let changed = !!previous && previous.current !== current
    if (!teams.length) return changed
    // 先读成员和当前身份再取宿主值：未设置时 default 就是服务端的身份。
    const desired = readOption() === true ? target : ""
    if (current === desired) return changed
    await setCurrentTeam(credential.session, desired, fetcher)
    const verified = await fetchTeamContext(credential.session, fetcher)
    if (currentId(verified) !== desired) throw new Error("积分账户切换未生效，请重试")
    accounts.set(key, { teams: joined(verified), current: desired, target })
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
