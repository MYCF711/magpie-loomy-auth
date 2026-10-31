// 发布到 npm 的包装器 —— 用 `npm run publish:npm`。
//
// package.json 的 name 是 ASCII slug（= npm 包名）；卡片标题在 magpie.name。
// 发布时不需要换 name；只有在 name 与 PUBLISH_AS 不一致的旧分支上才临时换，发完恢复。
//
// CI=true 时，npm 报「同版本已存在」（E409 / previously staged）按成功处理：
// 本地 release 已发过同一版，tag 触发的 workflow 不该因此变红。

import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const PUBLISH_AS = "magpie-plugin-loomy-auth"

const FILE = fileURLToPath(new URL("./package.json", import.meta.url))
const orig = fs.readFileSync(FILE, "utf8")
const pkg = JSON.parse(orig)

const renamed = pkg.name !== PUBLISH_AS
if (renamed) {
  pkg.name = PUBLISH_AS
  fs.writeFileSync(FILE, JSON.stringify(pkg, null, 2) + "\n")
}

try {
  const r = spawnSync(process.argv[2] || "npm publish --access public", {
    shell: true,
    encoding: "utf8",
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) {
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`
    if (process.env.CI === "true" && /E409|previously staged|EPUBLISHCONFLICT|cannot publish over/i.test(text)) {
      console.warn(`\n! npm 已有 ${PUBLISH_AS}@${pkg.version}，按已发布处理（CI）\n`)
      process.exitCode = 0
    } else {
      console.error(`\n✗ npm 发布失败：${PUBLISH_AS}@${pkg.version}\n`)
      process.exitCode = 1
    }
  }
} finally {
  if (renamed) {
    fs.writeFileSync(FILE, orig)
    console.log("name 已还原为 " + JSON.parse(orig).name)
  }
}
