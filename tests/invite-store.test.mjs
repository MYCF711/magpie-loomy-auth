// 自动邀请的本地码库：不读官方客户端，只攒自己的码。
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { inviteCandidates, loadInviteStore, ownerTag, rememberInviteCodes } from "../src/invite-store.mjs"

const tmp = () => join(mkdtempSync(join(tmpdir(), "loomy-invite-")), "invites.json")
const A = "a".repeat(32)
const B = "b".repeat(32)

test("记住的码能被读回来，并按 code 去重", () => {
  const path = tmp()
  assert.equal(loadInviteStore(path).length, 0)
  rememberInviteCodes([{ code: "FDW3CU" }, { code: "AAA111" }], { owner: ownerTag(A), path })
  rememberInviteCodes([{ code: "FDW3CU" }, { code: "BBB222" }], { owner: ownerTag(B), path })
  const codes = loadInviteStore(path).map((r) => r.code).sort()
  assert.deepEqual(codes, ["AAA111", "BBB222", "FDW3CU"])
})

test("候选里排除本号自己的码（不能自己邀请自己）", () => {
  const path = tmp()
  rememberInviteCodes([{ code: "MINE01" }], { owner: ownerTag(A), path })
  rememberInviteCodes([{ code: "OTHER1" }], { owner: ownerTag(B), path })
  const mine = inviteCandidates(A, { path, fallback: [] }).map((r) => r.code)
  assert.deepEqual(mine, ["OTHER1"])
  const theirs = inviteCandidates(B, { path, fallback: [] }).map((r) => r.code)
  assert.deepEqual(theirs, ["MINE01"])
})

test("没有归属信息的旧条目仍可作候选（不因为缺 owner 就丢）", () => {
  const path = tmp()
  rememberInviteCodes([{ code: "NOOWNR" }], { path, fallback: [] })
  assert.deepEqual(inviteCandidates(A, { path, fallback: [] }).map((r) => r.code), ["NOOWNR"])
})

test("库文件损坏 / 不存在时静默降级为空，不抛", () => {
  const path = tmp()
  writeFileSync(path, "{not json", "utf8")
  assert.deepEqual(loadInviteStore(path), [])
  assert.deepEqual(inviteCandidates(A, { path, fallback: [] }), [])
  assert.deepEqual(loadInviteStore(join(tmpdir(), "definitely-missing.json")), [])
})

test("过期条目不再参与候选", () => {
  const path = tmp()
  const old = Date.now() - 120 * 24 * 3600_000
  rememberInviteCodes([{ code: "STALE1" }], { owner: ownerTag(B), path, now: old })
  assert.deepEqual(inviteCandidates(A, { path, fallback: [] }).map((r) => r.code), [])
})

test("归属指纹不可逆推：只由 session 决定且固定长度", () => {
  assert.equal(ownerTag(A), ownerTag(A))
  assert.notEqual(ownerTag(A), ownerTag(B))
  assert.match(ownerTag(A), /^[0-9a-f]{12}$/)
  assert.equal(ownerTag(""), "")
})

test("候选带 status / usedCount，pickInviteCode 才能真正挑出可用码", async () => {
  const { _pure } = await import("../src/pure.mjs")
  const path = tmp()
  rememberInviteCodes(
    [
      { code: "FULL01", status: "active", usedCount: 2, maxUses: 2 }, // 已用满
      { code: "DEAD01", status: "exhausted", usedCount: 0, maxUses: 5 }, // 状态不可用
      { code: "GOOD01", status: "active", usedCount: 0, maxUses: 5 }, // 唯一可用
    ],
    { owner: ownerTag(B), path },
  )
  const candidates = inviteCandidates(A, { path, fallback: [] })
  assert.equal(candidates.length, 3, "候选本身不裁，交给 pickInviteCode")
  const picked = _pure.pickInviteCode(candidates, undefined)
  assert.equal(picked?.code, "GOOD01")
})

test("只存 code 的旧条目按 status 空串处理，仍然可用", async () => {
  const { _pure } = await import("../src/pure.mjs")
  const path = tmp()
  rememberInviteCodes([{ code: "LEGACY" }], { owner: ownerTag(B), path })
  const picked = _pure.pickInviteCode(inviteCandidates(A, { path, fallback: [] }), undefined)
  assert.equal(picked?.code, "LEGACY", "status 缺省为空串时视为可用, 与 pickInviteCode 判据一致")
})

test("码库为空时用兜底码（第一次装也有候选）", () => {
  const path = tmp()
  const cands = inviteCandidates(A, { path })
  assert.ok(cands.length >= 1, "空库必须还有兜底候选")
  assert.deepEqual(cands.map((c) => c.status), cands.map(() => "active"))
  assert.equal(cands[0].maxUses, 0, "maxUses=0 表示不设上限，交给服务端裁决")
})

test("兜底排在自己攒的码后面（自己攒的优先）", () => {
  const path = tmp()
  rememberInviteCodes([{ code: "OWNCODE", status: "active", usedCount: 0, maxUses: 5 }], { owner: ownerTag(B), path })
  const codes = inviteCandidates(A, { path, fallback: ["FALL01"] }).map((c) => c.code)
  assert.equal(codes[0], "OWNCODE")
  assert.equal(codes.at(-1), "FALL01")
})

test("兜底码与库里同一个码时不重复，且以库里的真实状态为准", () => {
  const path = tmp()
  rememberInviteCodes([{ code: "FALL01", status: "exhausted", usedCount: 2, maxUses: 2 }], { owner: ownerTag(B), path })
  const cands = inviteCandidates(A, { path, fallback: ["FALL01"] })
  assert.equal(cands.filter((c) => c.code === "FALL01").length, 1)
  assert.equal(cands.find((c) => c.code === "FALL01").status, "exhausted")
})

test("兜底码可以用参数整组替换（环境变量 LOOMY_INVITE_CODE 走的就是这条）", () => {
  const path = tmp()
  const cands = inviteCandidates(A, { path, fallback: ["AAA111", "BBB222"] })
  assert.deepEqual(cands.map((c) => c.code), ["AAA111", "BBB222"])
  assert.deepEqual(inviteCandidates(A, { path, fallback: [] }), [], "显式传空 = 不要兜底")
})

test("兜底码不会把本号自己的码加回来（自己邀请自己）", () => {
  const path = tmp()
  rememberInviteCodes([{ code: "MINE01", status: "active", usedCount: 0, maxUses: 5 }], { owner: ownerTag(A), path })
  const cands = inviteCandidates(A, { path, fallback: ["MINE01", "OTHER1"] })
  assert.deepEqual(cands.map((c) => c.code), ["OTHER1"], "自己的码不能出现在候选里")
})
