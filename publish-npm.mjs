// 发布到 npm 的包装器 —— 用 `npm run publish:npm`，不要裸跑 `npm publish`。
//
// 为什么要有它：两个读者开的是**同一个** package.json。
//
//   bun（magpie 的 git 安装）读它 → 决定插件卡片上的标题（依赖键 = name）
//   npm publish              读它 → 决定包名
//
// npm 不允许**新**包名含大写（registry 会拒：name can no longer contain capital
// letters），而卡片标题想要供应商自己的写法。所以发布这一下把 name 换成 npm 上的
// 包名，发完立刻还原 —— 仓库里永远留着好看的那个名字。
//
// ⚠ 从此不要裸跑 `npm publish`：那会拿 "讯飞 Loomy" 去发，被 registry 拒绝。
// ⚠ 机制说明见 magpie-plugin-scaffold 的 UPDATING.md。

import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

/** npm 上的包名。与仓库里的 name 不同是**故意的** —— 已装的用户按这个名收更新。 */
const PUBLISH_AS = "magpie-plugin-loomy-auth"

const FILE = fileURLToPath(new URL("./package.json", import.meta.url))

const orig = fs.readFileSync(FILE, "utf8")
const pkg = JSON.parse(orig)

if (pkg.name === PUBLISH_AS) {
  console.error(`package.json 的 name 已经是 ${PUBLISH_AS} —— 没有可换的，停。`)
  process.exit(1)
}

pkg.name = PUBLISH_AS
fs.writeFileSync(FILE, JSON.stringify(pkg, null, 2) + "\n")

try {
  execSync(process.argv[2] || "npm publish", { stdio: "inherit" })
} finally {
  fs.writeFileSync(FILE, orig)
  console.log(`name 已还原为 ${JSON.parse(orig).name}`)
}
