# magpie-plugin-loomy-auth

> magpie 供应商插件 · 讯飞 Loomy
> 仓库 `MYCF711/magpie-loomy-auth` · npm 包名 **`magpie-plugin-loomy-auth`**

Loomy（讯飞）做成 magpie 供应商插件：**桌面端登录态导入 / 短信 / 粘贴 session**
三种登录、实时模型目录与思考档位、工具调用与图片对话、每日额度刷新，
以及**按 magpie 的真实路由语义分池上报的积分**。

```
magpie-plugin-loomy-auth  on
  loomy (Loomy, 10 models)  signed in as 189****8051
```

---

## 这个插件修的是什么

市场现有的 Loomy 插件把积分卡片报错了。**这不是外观问题** ——
magpie 按每个非 `aside` 窗口的 `used` 给账号排序：

```js
// magpie 二进制里的原文
const group = (w) => w.used >= 98 ? "spent" : w.used >= 90 ? "low" : "fine"
// spent 的账号 "answers only when nothing else can"（排到最后）
// usage 归一化时 used: Math.max(0, num(w?.used)) —— 插件不给就是 0
```

而现有插件根本不上报 `used`，于是 `used` 全被当成 0，**被蹬空的号以「满额」
的姿态排在队首**。实测三天本机路由日志：

| 事实 | 数字 |
|---|---|
| 所在组被实际选中 | 256 / 2592 = **9.9%** |
| 其中命中余额为 0 的那个号 | **255 次** |
| 带失败迹象 | 11 次，含 `Loomy: 积分余额不足，请获取积分后再试` |

本插件的上报口径：

| | 上报方式 | 理由 |
|---|---|---|
| **今日池** | 参与路由：`used` / `amount` / `limit` / `resetsAt` 齐全 | 它有周期（北京日）、有上限，是唯一该决定「现在能不能用这个号」的窗口 |
| **永久池** | `aside: true`，只给 `display` | 它无周期、无上限。伪造 `total = 剩余` 就是把占比说谎 |
| **两池皆空** | 合成一条 `used: 100` 的**参与路由**窗口 | 让这个号沉底。不画窗口 = 它继续以 0% 排在最前面 |
| **上限未知** | `aside` + `used: 0`，显示「N 积分剩余（今日上限未知）」 | 宁可降级，也不谎报一个占比 |

顺带修掉同源的第二个缺陷：签到返回的 `outcome` 必须是契约六个合法值之一
（`claimed` / `done` / `ineligible` / `inactive` / `captcha` / `failed`）。
现有插件返回 `"success"` —— 不在表里，magpie 一律归 `failed` 却**保留它的
message**，于是界面出现「签到失败 · 每日赠送积分已刷新」这种自相矛盾的行。

---

## 安装

`magpie plugin add <tgz>` 不能用（它把 tgz 当 JS 模块 `import()`，报
`exports no OpenCode plugin function`）。按包名 + 本地 `file:` 依赖装：

```bash
# 1. 打包
npm pack --pack-destination ./dist

# 2. tgz 放进 magpie 的 dist/
cp dist/magpie-plugin-loomy-auth-0.1.1.tgz ~/.config/magpie/plugins/dist/

# 3. plugins.json 追加
#    { "spec": "magpie-plugin-loomy-auth" }
# 4. plugins/package.json 的 dependencies 追加
#    "magpie-plugin-loomy-auth": "./dist/magpie-plugin-loomy-auth-0.1.1.tgz"

# 5. 用 magpie 自带的 bun 装
cd ~/.config/magpie/plugins && ~/.cache/magpie/bun/1.4.4/magpie-bun.exe install

# 6. 重启 magpie（见下：实测不必需，但重启是确定路径）
```

### 装完要不要重启？

**实测（2026-10-26）：不必需。** 本地 tgz 装好、`plugins.json` 登记完成后，**运行中的
magpie 在约几分钟内自行用上了新插件** —— 路由日志里同一个空号的 `used` 从 `0`
变成 `100`（`2026-10-26T04:19:33`），期间没有重启（进程 PID 未变）。

⚠ 触发机制**未查明**：二进制里没有 `fsnotify`/`Watcher`/`reloadPlugins` 符号，
所以不是目录监听，疑似按 tick 复查配置。既然机制不明，**改完重启一次最稳** ——
重启不会丢登录态（`plugin-auth.json` 不动），实测重启后 `plugin list` 仍是
`loomy (Loomy, 10 models) signed in as 189****8051`。

已验证：`magpie plugin list` 能列出 `magpie-plugin-loomy-auth on / loomy (Loomy, 10 models)`。

### ⚠ npm 包名与仓库名不是同一个

| | 值 | 为什么 |
|---|---|---|
| 仓库名 | `magpie-loomy-auth` | GitHub 仓库，随便叫 |
| **npm 包名** | **`magpie-plugin-loomy-auth`** | 见下 |

**`magpie-loomy-auth` 这个包名在 npm 上已被他人占用**（0.3.2，维护者 `an0119`，
仓库 `lin2670/magpie-plugins`，也是 Loomy 插件）。magpie 的「有新版本」检查按
**包名**去 npm 查，与仓库属主无关 —— 所以撞名会让界面提示一个**别人的**新版，
点「更新」就把别人的包装进来顶掉本插件（本机实测触发过：`waiting: [{package:
"magpie-loomy-auth", version: "0.1.0", latest: "0.3.2"}]`）。

⇒ 加 `-plugin-` 段避开，同时保留 `magpie` 前缀（便于按前缀搜索）。

⚠ 本地用 `file:` tgz 安装时包名只是标识，改名代价只有一次重装；
但**插件内 `REGISTRY_ENTRY.package` 必须与 package.json 的 `name` 一字不差**，
否则自注册条目对不上市场卡片。


⚠ **别和其它声明 `loomy` 的插件同时装** —— 两个插件抢同一个 provider id，
`auths().get(provider)` 谁赢是未定义的。装本插件前先摘掉 `magpie-plugin-loomy`。

**凭据形状与旧插件兼容**（`{type:"oauth", access, refresh, expires, accountId, uid, phone}`），
所以已有登录态直接复用，**不用重新登录**。

---

## 登录方式

| 方式 | 说明 |
|---|---|
| **桌面端登录态导入** | 自动读本机 Loomy 客户端的 Local Storage（leveldb 明文，键 `loomy-auth-session`），无需短信 |
| **手机号 + 短信验证码** | 中国大陆 11 位手机号 → 6 位验证码 |
| **粘贴 session** | 手动粘贴客户端登录态，可带备注名 |

Loomy **没有续期接口**（会话固定 14 天），所以本插件**不伪造 `refresh_token`** ——
`auth.refresh` 恒返回 `undefined`。伪造的后果比过期更糟：magpie 会以为能自动续，
把账号标记成「可恢复」，用户永远等不到「请重新登录」。

---

## 模型

10 个 chat 模型（上游还下发 3 条 `type:"image"`，**按类型过滤掉** —— 它们不是
对话模型，列出来就是让用户选中一个必然失败的东西）。

| id | context | output | 视觉 | 倍率 |
|---|---|---|---|---|
| `DeepSeek-V4.1-Flash` | 1,048,576 | 384,000 | ✓ | x2.0 |
| `spark-x2.6` | 1,048,576 | 131,072 | ✗ | x0.0 |
| `spark-x` | 1,048,576 | 65,536 | ✗ | x0.0 |
| `MiniMax-M3` | 1,048,576 | 512,000 | ✓ | x4.0 |
| `Kimi-k2.6` | 262,144 | 65,536 | ✓ | x6.5 |
| `qwen-3.8-max` | 1,000,000 | 65,536 | ✗ | x12.0 |
| `GLM-5.3-Flash` | 1,048,576 | 131,072 | ✓ | x0.8 |
| `qwen3.8-flash` | 1,000,000 | 131,072 | ✓ | x0.8 |
| `mimo-v2.5` | 1,048,576 | 131,072 | ✓ | x3.3 |
| `auto` | — | — | ✗ | — |

以上全部取自一次实测（`GET /api/v1/models`），**不是文档抄的**。
`context` 原样上报：magpie 把它转给 agent 决定何时压缩对话，而**路由组按
组内最大值算窗口** —— 一个填小的成员会把整组拉低。

思考档位来自上游 `reasoning_efforts`：`none|low|medium|high|xhigh`，默认 `low`。
`auto` 上游没有 thinking_config，因此不声明 reasoning。

---

## 协议要点（本插件依赖的实测事实）

| 事实 | 影响 |
|---|---|
| `dailyQuota` / `dailyConsumed` / `dailyCycleDate` **只在** `POST /points/first-login`（写端点，幂等） | 上限只能签到/登录时拿到并记进凭据；**不许硬编码 5000**（活动会变） |
| `/api/v1/points/balance` 只回 3 个数字（实测 61~233ms） | 热路径用它，是三家现有插件都没用的最小端点 |
| `/api/v1/points/records` 每条 debit 带 `consumeSource` + `dailyCycleDate` | 上限的**降级推导**：`quota ≈ dailyBalance + Σ(本业务日 daily 扣分)`。两号实测吻合：0/0 → used 100%；有余额 → 3.96% |
| 业务日按东八区，重置在次日 00:05 | `resetsAt` 用它；跨日旧上限**作废** |
| 部分错误是 **HTTP 200 + 信封 `{code:"100002"}`** | 「状态码 ok」不等于成功，一律判业务码；失效时打 `X-Magpie-Sign-In: expired` |
| deepseek 系模型只认 `<image_base64>` 标记 | `image_url` data URI 会被上游当截断的 base64 文本读，所以只对 deepseek 系改写 |
| `POST /points/first-login` 幂等，判据是 `alreadyProcessed` | 「今天已领」必须是 `done` 而不是 `claimed` |

### 一次 `usage()` 的请求数

| 情形 | 请求数 |
|---|---|
| 凭据里有当天 `dailyQuota`（签到/登录写过） | **1**（只读 balance） |
| 凭据里没有当天上限 | 2（balance + 流水，翻页上限 6 页） |
| 之后每一轮 | 回到 **1**（推导出来的上限会写回凭据） |

写回走 `client.auth.set({path:{id}})`；它在账号作用域里把 id 解析成**当前账号**的键，
所以多账号互不串（实测两号各自写回自己的 `dailyQuota`）。

---

## 测试

```bash
npm test                  # 42 条，全离线、零额度
node tests/live.mjs       # 真实账号 + 真实上游（只读 + 幂等签到，不消费额度）
```

单测锁死四组语义（**反向验证过**：把 `windowsOf` 改回市场插件的写法，其中
4 条会变红；把签到 outcome 改回 `"success"`，2 条会变红）：

1. 两池皆 0 → 一条 `used:100` 的**参与路由**窗口（不许 aside、不许消失）
2. 永久池恒 `aside` 且不给 `amount`/`limit`
3. 上限未知 → `aside` + `used:0`，绝不谎报成满额
4. 上限已知 → 真实占比 + 完整字段；跨日旧上限作废

`tests/live.mjs` 在真账号上的当前输出（2026-10-26）：

```
=== loomy  18970098051
    balance=8979 积分  used=30.42%  limit=5000  永久池 aside
    checkin → {"outcome":"done","message":"今日额度已刷新（3479/5000 积分）"}
=== loomy#0zloqw  18170800632
    balance=0 积分  used=100  ← 参与路由，会让这个号沉底
    checkin → {"outcome":"done",...}
✅ 全部通过
```

---

## 已知取舍

- **不做二维码 / 微信登录**：上游把微信登录放在一个需要本地起页面的流程里，
  而桌面端导入 + 短信已经覆盖同一批账号；少一条链路少一份维护面。
- **不做「锁定永久积分」开关**：本插件把永久池恒标 `aside`（不参与路由），
  于是 magpie 只在其它号都不可用时才用它 —— 这已经是「优先别烧永久积分」的语义，
  不需要再加一个开关。
- **不做多账号并发选号**：magpie 自己管这个（`signInKey` → 账号作用域）。
  插件只负责把一个账号的真实读数报准 —— 报准了，选号自然对。

---

## 许可

MIT
