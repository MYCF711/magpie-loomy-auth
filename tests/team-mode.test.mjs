import { test } from "node:test"
import assert from "node:assert/strict"
import { createTeamModeController } from "../src/team-mode.mjs"
import { LoomyAuthPlugin } from "../index.mjs"

const credential = (uid = "example-user") => ({ session: `session-${uid}`, uid, accountId: "同名账号" })
const json = (data, code = "000000") => new Response(JSON.stringify({ code, data }), {
  headers: { "Content-Type": "application/json" },
})

function setup({ initialTeam = "team-example" } = {}) {
  let personal = false
  let currentTeam = initialTeam
  let failPost = false
  const saved = new Map()
  const calls = []
  const load = (key) => saved.get(key)
  const save = (key, value) => saved.set(key, structuredClone(value))
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ path, method: init.method, body: init.body, headers: init.headers })
    if (path === "/api/v1/user/identity") return json({ currentTeamId: currentTeam, teams: [] })
    assert.equal(path, "/api/v1/user/current-team")
    assert.equal(init.method, "POST")
    currentTeam = JSON.parse(init.body).teamId ?? ""
    if (failPost) throw new Error("network timeout after switch")
    return json({})
  }
  const make = () => createTeamModeController({ readOption: () => personal, load, save })
  return {
    make, fetcher, saved, calls,
    set personal(value) { personal = value },
    set failPost(value) { failPost = value },
    get currentTeam() { return currentTeam },
  }
}

test("开关默认关闭：保留客户端当前身份，不请求、不自动切换", async () => {
  const s = setup()
  assert.equal(await s.make().sync(credential(), s.fetcher), false)
  assert.equal(s.calls.length, 0)
  assert.equal(s.saved.size, 0)
  assert.equal(s.currentTeam, "team-example")
})

test("打开真切个人、关闭真恢复原团队；不重新登录，POST 后查服务端确认", async () => {
  const s = setup()
  const controller = s.make()
  s.personal = true
  assert.equal(await controller.sync(credential(), s.fetcher), true)
  assert.equal(s.currentTeam, "")
  assert.deepEqual(s.calls.map(c => c.method), ["GET", "POST", "GET"])
  assert.equal(s.calls[1].body, "{}")
  assert.equal([...s.saved.values()][0].restoreTeamId, "team-example")
  s.personal = false
  assert.equal(await controller.sync(credential(), s.fetcher), true)
  assert.equal(s.currentTeam, "team-example")
  assert.deepEqual(JSON.parse(s.calls[4].body), { teamId: "team-example" })
  assert.equal([...s.saved.values()][0].personal, false)
})

test("后续目录刷新不重发切换 POST；插件重启后仍能恢复之前团队", async () => {
  const s = setup()
  s.personal = true
  await s.make().sync(credential(), s.fetcher)
  const calls = s.calls.length
  assert.equal(await s.make().sync(credential(), s.fetcher), false)
  assert.equal(s.calls.length, calls)
  s.personal = false
  await s.make().sync(credential(), s.fetcher)
  assert.equal(s.currentTeam, "team-example")
})

test("原本在个人模式：开关来回不擅自选一个团队", async () => {
  const s = setup({ initialTeam: "" })
  const controller = s.make()
  s.personal = true
  await controller.sync(credential(), s.fetcher)
  s.personal = false
  await controller.sync(credential(), s.fetcher)
  assert.equal(s.currentTeam, "")
  assert.equal(s.calls.some(c => c.method === "POST"), false)
})

test("POST 已生效但响应断开：重试不能丢原团队，关闭后仍能恢复", async () => {
  const s = setup()
  const controller = s.make()
  s.personal = true
  s.failPost = true
  await assert.rejects(controller.sync(credential(), s.fetcher), /切换积分身份/)
  assert.equal(s.currentTeam, "")
  assert.equal([...s.saved.values()][0].restoreTeamId, "team-example")
  s.failPost = false
  await controller.sync(credential(), s.fetcher)
  s.personal = false
  await controller.sync(credential(), s.fetcher)
  assert.equal(s.currentTeam, "team-example")
})

test("恢复失败保留原目标，不把失败标记为已恢复", async () => {
  const s = setup()
  const controller = s.make()
  s.personal = true
  await controller.sync(credential(), s.fetcher)
  s.personal = false
  s.failPost = true
  await assert.rejects(controller.sync(credential(), s.fetcher))
  assert.equal([...s.saved.values()][0].restoreTeamId, "team-example")
  assert.equal([...s.saved.values()][0].personal, true)
  s.failPost = false
  await controller.sync(credential(), s.fetcher)
  assert.equal([...s.saved.values()][0].personal, false)
})

test("保存恢复目标失败时不修改服务端身份", async () => {
  const s = setup()
  const controller = createTeamModeController({ readOption: () => true, load: () => null, save: () => { throw new Error("disk full") } })
  await assert.rejects(controller.sync(credential(), s.fetcher), /disk full/)
  assert.equal(s.calls.some(c => c.method === "POST"), false)
  assert.equal(s.currentTeam, "team-example")
})

test("服务端没有切成功就报错，不返回成功", async () => {
  const saved = new Map()
  const controller = createTeamModeController({ readOption: () => true, load: k => saved.get(k), save: (k, v) => saved.set(k, v) })
  const fetcher = async (url) => json(String(url).endsWith("identity") ? { currentTeamId: "team-example" } : {})
  await assert.rejects(controller.sync(credential(), fetcher), /未生效/)
  assert.equal([...saved.values()][0].applied, false)
})

test("同 UID 重登 / 改名仍使用同一恢复状态，不保存 session 明文", async () => {
  const s = setup()
  s.personal = true
  await s.make().sync(credential(), s.fetcher)
  s.personal = false
  await s.make().sync({ ...credential(), session: "new-login-session", accountId: "改名账号" }, s.fetcher)
  assert.equal(s.currentTeam, "team-example")
  assert.equal(s.saved.size, 1)
  assert.doesNotMatch(JSON.stringify([...s.saved]), /session-|new-login-session|改名账号|同名账号/)
})

test("同名但不同 UID 的账号隔离；缺 UID 时用登录态指纹隔离", async () => {
  const s = setup()
  s.personal = true
  const controller = s.make()
  await controller.sync(credential("first-user"), s.fetcher)
  await controller.sync(credential("second-user"), s.fetcher)
  await controller.sync({ ...credential("third"), uid: "" }, s.fetcher)
  await controller.sync({ ...credential("fourth"), uid: "" }, s.fetcher)
  assert.equal(s.saved.size, 4)
})

test("同账号并发目录刷新只切换一次", async () => {
  const s = setup()
  s.personal = true
  const controller = s.make()
  await Promise.all([controller.sync(credential(), s.fetcher), controller.sync(credential(), s.fetcher)])
  assert.equal(s.calls.filter(c => c.method === "POST").length, 1)
})

test("快速开后关：上一轮完成后重读选项，最终恢复团队", async () => {
  const s = setup()
  const controller = s.make()
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started
  const entered = new Promise(resolve => { started = resolve })
  let first = true
  const fetcher = async (url, init) => {
    if (first) {
      first = false
      started()
      await gate
    }
    return s.fetcher(url, init)
  }
  s.personal = true
  const on = controller.sync(credential(), fetcher)
  await entered
  s.personal = false
  const off = controller.sync(credential(), fetcher)
  release()
  await Promise.all([on, off])
  assert.equal(s.currentTeam, "team-example")
  assert.equal(s.calls.filter(c => c.method === "POST").length, 2)
})

test("开关符合宿主布尔选项契约并置顶，不新增登录方式", async () => {
  const plugin = await LoomyAuthPlugin({})
  const option = plugin.auth.options.find(o => o.key === "personal_mode")
  assert.ok(option)
  assert.equal(option.default, false)
  assert.equal(option.placement, "top")
  assert.ok(option.labels.en)
  assert.ok(option.descriptions.en)
  assert.equal(plugin.auth.methods.length, 3)
})
