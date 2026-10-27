# AGENTS.md —— 给 AI 执行者的入口

> 人类请看 [README](./README.md)。这份只回答两件事：**你现在该读哪一份**、
> **忘了哪一条会静默出错**。
>
> 结构照搬 [magpie-plugin-scaffold](../magpie-plugin-scaffold/AGENTS.md)；
> 第二节是本仓库自己的坑，来自 `docs/internals.md` 的实测记录。

---

## 零、magpie 升级时：只看稳定版

**判断「要不要跟着 magpie 改这个插件」看稳定渠道，不看每版本渠道。**
magpie 设置里有「更新渠道：每个版本 / 稳定版」，用户默认跑后者，插件要跟的也是后者。

```bash
curl -s "https://usemagpie.ai/api/latest?channel=stable" | grep -o '"version":"[^"]*"'
```

实测（2026-10-28）：两档差 **400 多个版本**（每版本 0.1.1763 / 稳定版 0.1.1327），
但把两边内嵌契约都提取出来逐字段比对后 —— **插件相关的字段一条不差**。
多出来的段是 GUI 历史，不是插件契约。⇒ 追每版本几乎全是白跑。

**稳定版版本号变了**，才需要重提取契约（脚手架的 `extract-contract.py`）→
跑 `contract-diff.mjs` → 看差集里有没有「不写会关掉某个能力」的字段。
完整判据见脚手架的
[HOOKS.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/HOOKS.md) 顶部
与 [UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md) 第七节。

---

## 一、先定位你在哪一步

| 你在做什么 | 必读（按顺序） | 做完的判据 |
|---|---|---|
| **第一次碰这个仓库**（想知道它为什么存在） | [docs/internals.md](./docs/internals.md) 的「这个插件修的是什么」 | 能说清 `used` 不上报会怎样（空号排队首） |
| **改额度 / `usage` 上报** | internals 的「这个插件修的是什么」+ HOOKS 九 | 今日池参与路由、永久池 `aside`、两池皆空有 `used:100` |
| **改签到** | internals 的「协议要点」签到那几行 | `outcome` 在契约六个合法值里 |
| **改积分 / 邀请 / 激活** | internals 的「协议要点」「一个账号的永久积分上限」 | 数值与实测账对得上（双方各 5000、上限 25,000） |
| **改登录 / 刷新** | internals 的「登录方式」 | 刷新有节流，不是每次都打 |
| **代码写完，准备交付** | [CHECKLIST.md](./CHECKLIST.md) 的 **A 表** | A 表全勾 + check 脚本退出 0 |
| **要发版本** | [UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md)（七步） | CHECKLIST B 表全勾 + 四条验证 |

**最容易漏的是最后一行。** `git push` 只是七步里的第 4 步。

---

## 二、本仓库的坑

| # | 症状（出问题时你看到什么） | 判据 | 出处 |
|---|---|---|---|
| 1 | 额度条正常，但**被用空的号反而最先被派活** | `usage` 必须上报 `used`。magpie 归一化时 `Math.max(0, num(w?.used))` —— 不给就是 0 = 满额 = 排队首。这是本仓库存在的理由 | internals 这个插件修的是什么 |
| 2 | 账号被误判「花完了」/ 或永远不被判花完 | **今日池**参与路由（`used`/`amount`/`limit`/`resetsAt` 齐全）；**永久池**恒 `aside: true` 只给 display | internals 同上 |
| 3 | 两池都空的号仍然排在最前面 | 必须**合成一条 `used: 100` 的参与路由窗口**把它压到底；不画窗口 = 继续以 0% 排第一 | internals 同上 |
| 4 | 界面上额度占比是编的 | 今日上限未知时 → `aside` + `used: 0`，显示「N 积分剩余（今日上限未知）」。宁可降级也不谎报占比 | internals 同上 |
| 5 | 签到界面出现「签到失败 · 每日赠送积分已刷新」这种自相矛盾的行 | `outcome` 必须是契约六值之一（`claimed`/`done`/`ineligible`/`inactive`/`captcha`/`failed`）。返回 `"success"` 会被归为 failed **但保留 message** | internals 同上 |
| 6 | 额度读数慢、拖慢整张卡片 | 热路径用 `/api/v1/points/balance` —— 它只回 3 个数字，实测 61~233ms，是三家现有插件都没用的最小端点 | internals 协议要点 |
| 7 | 「今天已领」被显示成「刚领到」 | `POST /points/first-login` 幂等，判据是 `alreadyProcessed`；「今天已领」必须是 `done`，不是 `claimed` | internals 协议要点 |
| 8 | 频繁刷新把上游打烦 / 触发限流 | token 刷新要**节流**，不能每次都打 | internals 协议要点 |
| 9 | 邀请奖励的数字对不上 | 实测邀请双方**各得 5000**，不是 2000 | internals 协议要点 |
| 10 | 拿别的账号的凭据去请求，串号 | `getAuth()` 只在当前账号作用域（magpie 的 `inScope`）可见，拿不到别的账号 | internals 协议要点 |
| 11 | 以为能给「锁定永久积分」加个开关 | 不需要 —— 永久池恒 `aside`，magpie 只在其它号都不可用时才用它，已经是「优先别烧永久积分」 | internals 已知取舍 |
| 12 | `magpie plugin add xxx.tgz` 装不上 | 它把 tgz 当 JS 模块 `import()`；本地包走 `plugins.json` + `plugins/package.json` 登记 | internals 从本地 tgz 安装 |
| 13 | 改了代码重装，行为没变 | 同版本号重打包命中 bun 缓存 —— 必须 bump `version`；另外「装完要不要重启」实测**不必需**，但触发机制未查明 | internals 从本地 tgz 安装 |
| 14 | npm 上装到了别人的包 | 本仓库 **npm 包名 ≠ 仓库名**：npm 是 `magpie-plugin-loomy-auth`，仓库是 `magpie-loomy-auth`。加 `-plugin-` 段就是为了避开撞名 | internals 从本地 tgz 安装 |
| 15 | 卡片标题 / 源码按钮不对 | `registry-entry.json` 的 `package` 必须与 `package.json` 的 `name` **一字不差**；插件不写 magpie 的市场缓存 | internals 从本地 tgz 安装 |

---

## 三、命令

```bash
# 合规检查（脚手架里的脚本，指到本仓库）
node ../magpie-plugin-scaffold/scripts/check.mjs .

# 语义测试（usage / 签到 outcome 那几条规则在这儿锁着）
node tests/semantics.test.mjs

# 打包面预演
npm pack --dry-run

# 发布（包内 name 是 Loomy，npm 包名是 magpie-plugin-loomy-auth）
npm run publish:npm

# Release（本仓库没有 .github/workflows，手工建）
git tag v0.1.16 && git push origin v0.1.16
#   然后 POST /repos/MYCF711/magpie-loomy-auth/releases
```

---

## 四、两个交付门

**门 1 · 代码交付**

```
□ node ../magpie-plugin-scaffold/scripts/check.mjs . 退出码 = 0
□ node tests/semantics.test.mjs 全绿（usage 语义不能靠眼睛看）
□ CHECKLIST.md 的 A 表全勾
```

**门 2 · 发布**

```
□ CHECKLIST.md 的 B 表全勾（七步）
□ 四条验证：npm view magpie-plugin-loomy-auth version / tarball 内容 /
            magpie plugin list / Release 在
```

⚠ 没过门 2 不许说「已发布」。

---

## 五、文档地图

| 文件 | 管什么 | 什么时候读 |
|---|---|---|
| [README](./README.md) | 用户门面：功能、模型、签到、安装、常见问题 | 改用户可见行为时 |
| [docs/internals.md](./docs/internals.md) | 修的是什么、登录、协议要点、测试、已知取舍、永久积分上限 | 改代码前按章查 |
| [tests/semantics.test.mjs](./tests/semantics.test.mjs) | `usage` 与签到 `outcome` 的语义锁 | 改这两块必跑 |
| [CHANGELOG.md](./CHANGELOG.md) | 每版一节 | 写新版本时 |
| [CHECKLIST.md](./CHECKLIST.md) | 两张勾选表 | 两个交付门 |
| 脚手架 [AGENTS.md](../magpie-plugin-scaffold/AGENTS.md) | 通用坑与 check 能查什么 | 第一次接触这个插件族时 |

---

## 六、这份文件的维护规矩

1. 任何一次「不报错、要几小时才找到」的坑，收工前在第二节加一行（症状 → 判据 → 出处）。
2. 第二节只放一句话判据，论证留在 `docs/internals.md`。
3. 判据要能当场验证（命令、字段、界面现象）。
