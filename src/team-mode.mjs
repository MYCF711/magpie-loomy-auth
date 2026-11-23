// Magpie 的 provider 选项只支持布尔开关，改变后会重拉 models。
// 在该入口执行身份切换；usage 始终只读、显示服务端当前身份。
import { createHash, randomUUID } from "node:crypto"
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fetchTeamIdentity, setCurrentTeam } from "./api.mjs"

function accountKey(credential) {
  // uid 不变时重登仍能恢复；没有 uid 才退到凭据指纹，绝不用可重名的显示名。
  const identity = credential.uid ? `uid:${credential.uid}` : `session:${credential.session}`
  return createHash("sha256").update(identity).digest("hex").slice(0, 32)
}

function stateFile(key) {
  return join(homedir(), ".cache", "magpie", `loomy-team-mode__${key}.json`)
}

function readState(key) {
  try {
    const value = JSON.parse(readFileSync(stateFile(key), "utf8"))
    if (typeof value?.personal !== "boolean" || typeof value?.restoreTeamId !== "string") return null
    return { personal: value.personal, restoreTeamId: value.restoreTeamId, applied: value.applied === true }
  } catch {
    return null
  }
}

function writeState(key, state) {
  const file = stateFile(key)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  // 只存恢复所需团队 ID 和开关状态，不复制登录会话 / token。
  writeFileSync(tmp, JSON.stringify({ personal: state.personal, restoreTeamId: state.restoreTeamId, applied: state.applied }), { mode: 0o600 })
  renameSync(tmp, file)
}

export function createTeamModeController({ readOption, load = readState, save = writeState }) {
  const inFlight = new Map()

  async function apply(credential, key, fetcher) {
    const personal = readOption() === true // 每次使用时读，不能在工厂构造时缓存开关。
    let state = load(key)
    if (!personal && !state?.personal) return false // 默认跟随客户端，不擅自切掉它原来的身份。
    if (personal && state?.personal && state.applied) return false

    const current = await fetchTeamIdentity(credential.session, fetcher)
    if (personal && !state?.personal) {
      state = { personal: true, restoreTeamId: current?.id ?? "", applied: false }
      // 先记恢复目标；即使 POST 超时但服务端实际已切换，也不会丢掉原团队。
      save(key, state)
    }
    const target = personal ? "" : state.restoreTeamId
    if ((current?.id ?? "") !== target) {
      await setCurrentTeam(credential.session, target, fetcher)
      const verified = await fetchTeamIdentity(credential.session, fetcher)
      if ((verified?.id ?? "") !== target) throw new Error("积分身份切换未生效，请刷新后重试")
    }
    save(key, { personal, restoreTeamId: personal ? state.restoreTeamId : "", applied: true })
    return true
  }

  return {
    async sync(credential, fetcher = fetch) {
      const key = accountKey(credential)
      // 同账号串行；快速来回拨动会在上一轮完成后重新读取当前选项。
      const pending = (inFlight.get(key) ?? Promise.resolve()).catch(() => {}).then(() => apply(credential, key, fetcher))
      inFlight.set(key, pending)
      try {
        return await pending
      } finally {
        if (inFlight.get(key) === pending) inFlight.delete(key)
      }
    },
  }
}
