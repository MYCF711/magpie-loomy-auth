// 发布到 npm 的包装器 —— 用 `npm run publish:npm`。
//
// package.json 的 name 现在是 ASCII slug（magpie-plugin-loomy-auth），也就是 npm 包名；
// 卡片标题改用 magpie.name（讯飞 Loomy）。所以发布时不需要再临时换 name。
//
// 保留这个包装器是为了旧分支/旧文档仍走同一条命令；它只在 name 与 PUBLISH_AS
// 不一致时才临时换名，发布后无论成败都恢复。

import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

/** npm 上的包名。与仓库里的 name 相同是正常的。 */
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
  execSync(process.argv[2] || "npm publish --access public", { stdio: "inherit" })
} finally {
  if (renamed) {
    fs.writeFileSync(FILE, orig)
    console.log("name 已还原为 " + JSON.parse(orig).name)
  }
}
