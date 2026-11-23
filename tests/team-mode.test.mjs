import { test } from "node:test"
import assert from "node:assert/strict"
import { createTeamModeController } from "../src/team-mode.mjs"
import { LoomyAuthPlugin } from "../index.mjs"
const credential = (uid = "example-user") => ({ session: `session-${uid}`, uid })
const json = (data) => new Response(JSON.stringify({ code: "000000", data }))

function setup({ current = "team-example", teams = [{ teamId: "team-example", status: "active" }] } = {}) {
  let selected, failPost = false, ignorePost = false
  const calls = []
  const controller = createTeamModeController({ readOption: () => selected ?? controller.options()[0]?.default })
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ path, method: init.method, body: init.body })
    if (path.endsWith("/identity")) return json({ currentTeamId: current, teams })
    assert.equal(path, "/api/v1/user/current-team")
    if (!ignorePost) current = JSON.parse(init.body).teamId ?? ""
    if (failPost) throw new Error("response lost")
    return json({})
  }
  return { controller, fetcher, calls,
    set selected(v) { selected = v }, set current(v) { current = v }, get current() { return current },
    set failPost(v) { failPost = v }, set ignorePost(v) { ignorePost = v }, set teams(v) { teams = v },
  }
}

test("首次跟随服务端；两端是个人 / 团队并即时应用", async () => {
  const s = setup()
  assert.deepEqual(s.controller.options(), [])
  assert.equal(await s.controller.sync(credential(), s.fetcher), false)
  const o = s.controller.options()[0]
  assert.equal(o.key, "team_mode")
  assert.equal(o.default, true)
  assert.equal(o.offLabel, "个人")
  assert.equal(o.onLabel, "团队")
  assert.equal(o.immediate, true)
  assert.equal(o.placement, "accounts")
  assert.doesNotMatch(JSON.stringify(o), /临时|开启|关闭|temporar/i)
  assert.equal(s.calls.filter(c => c.method === "POST").length, 0)
})
test("首次 sync 绝不下发切换：宿主此时还没声明开关，读到的「关」不是用户意图", async () => {
  // 真实宿主的顺序是「先声明开关、再重拉模型」，而 options() 在首次 sync 前是空的 ——
  // 此刻读 team_mode 只会拿到「未声明 ⇒ 缺省 false」。若把它当用户意图，
  // 已经在团队里的账号会被静默切到个人（GET identity → POST current-team {} → GET identity）。
  let current = "team-example"
  const calls = []
  const controller = createTeamModeController({ readOption: () => false })
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ path, method: init.method, body: init.body })
    if (path.endsWith("/identity")) {
      return json({ currentTeamId: current, teams: [{ teamId: "team-example", status: "active" }] })
    }
    if (path.endsWith("/current-team")) {
      current = JSON.parse(init.body).teamId ?? ""
      return json({})
    }
    throw new Error(`unexpected path ${path}`)
  }
  assert.equal(await controller.sync(credential(), fetcher), false)
  assert.equal(calls.filter(c => c.method === "POST").length, 0, "首次同步不许改服务端身份")
  assert.equal(current, "team-example", "团队身份必须原样保留")
  assert.equal(controller.options()[0].default, true, "首次同步后开关默认值应等于服务端身份")
})

test("团队切个人再切团队，直接调用官方接口并查身份确认", async () => {
  const s = setup()
  await s.controller.sync(credential(), s.fetcher)
  s.selected = false
  assert.equal(await s.controller.sync(credential(), s.fetcher), true)
  assert.equal(s.current, "")
  assert.equal(s.calls.find(c => c.method === "POST").body, "{}")
  assert.equal(s.controller.options()[0].default, false)
  s.selected = true
  assert.equal(await s.controller.sync(credential(), s.fetcher), true)
  assert.equal(s.current, "team-example")
})
test("个人模式保留成员选项，不依赖切换前保存恢复文件", async () => {
  const s = setup({ current: "" })
  await s.controller.sync(credential(), s.fetcher)
  assert.equal(s.controller.options()[0].default, false)
  s.selected = true
  await s.controller.sync(credential(), s.fetcher)
  assert.equal(s.current, "team-example")
})
test("未加入团队或成员非 active 时隐藏，也不 POST", async () => {
  for (const teams of [[], [{ teamId: "pending", status: "pending" }], [{ teamId: "gone", status: "inactive" }]]) {
    const s = setup({ current: "", teams })
    s.selected = true
    await s.controller.sync(credential(), s.fetcher)
    assert.deepEqual(s.controller.options(), [])
    assert.equal(s.calls.filter(c => c.method === "POST").length, 0)
  }
})
test("退出团队隐藏设置，查询失败保留已知成员状态", async () => {
  const s = setup()
  await s.controller.sync(credential(), s.fetcher)
  await assert.rejects(s.controller.sync(credential(), async () => { throw new Error("offline") }))
  assert.equal(s.controller.options().length, 1)
  s.current = ""
  s.teams = []
  await s.controller.sync(credential(), s.fetcher)
  assert.deepEqual(s.controller.options(), [])
})
test("多个团队优先当前团队；切个人再切团队仍选同一个", async () => {
  const s = setup({ current: "second", teams: [{ teamId: "first", status: "active" }, { teamId: "second", status: "active" }] })
  s.selected = false
  await s.controller.sync(credential(), s.fetcher)
  s.selected = true
  await s.controller.sync(credential(), s.fetcher)
  assert.equal(s.current, "second")
})
test("服务端未切成功报错；响应断开后可重试", async () => {
  const s = setup()
  await s.controller.sync(credential(), s.fetcher) // 基线：首次 sync 只记录，不下发
  s.selected = false
  s.ignorePost = true
  await assert.rejects(s.controller.sync(credential(), s.fetcher), /未生效/)
  s.ignorePost = false
  s.failPost = true
  await assert.rejects(s.controller.sync(credential(), s.fetcher), /切换积分身份/)
  s.failPost = false
  await s.controller.sync(credential(), s.fetcher)
  assert.equal(s.current, "")
})
test("同账号并发刷新不重复切换；客户端自行切换会使额度缓存失效", async () => {
  const s = setup()
  s.selected = false
  await Promise.all([s.controller.sync(credential(), s.fetcher), s.controller.sync(credential(), s.fetcher)])
  assert.equal(s.calls.filter(c => c.method === "POST").length, 1)
  const external = setup()
  await external.controller.sync(credential(), external.fetcher)
  external.current = ""
  assert.equal(await external.controller.sync(credential(), external.fetcher), true)
})
test("多账号隔离团队目标", async () => {
  const s = setup()
  s.selected = false
  await s.controller.sync(credential("one"), s.fetcher) // 账号一基线（只记录）
  s.current = ""
  s.teams = [{ teamId: "other", status: "active" }]
  await s.controller.sync(credential("two"), s.fetcher) // 账号二基线：记住自己的目标 other
  s.selected = true
  await s.controller.sync(credential("two"), s.fetcher) // 只有账号二被拨到团队
  assert.equal(s.current, "other")
})
test("旧宿主隐藏设置，不新增登录方式", async () => {
  const p = await LoomyAuthPlugin({})
  assert.deepEqual(p.auth.options, [])
  assert.equal(p.auth.methods.length, 3)
})
