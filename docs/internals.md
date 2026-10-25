# 实现细节（给要改这份代码的人）

> 这是插件 README 的技术附录。**装机用户看 [README](../README.md) 就够了。**
>
> 这里放的是：协议事实、为什么这么上报、怎么验证、哪些地方故意不做。
> 每条都尽量带「实测判据」—— 不是推测。

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

### 新手任务：一次性可领的 1 万分

Loomy 还有第三笔额度 —— **新手任务奖励**，总计 10,000 分，可主动领取：

| key | 任务 | 分值 |
|---|---|---|
| `first_message` | 发送第一条消息 | 500 |
| `pick_skill` | 选择一个技能 | 1000 |
| `generate_ppt` | 生成第一份 PPT | 1500 |
| `set_schedule` | 设置定时任务 | 1000 |
| `install_skill` | 安装一个技能 | 1500 |
| `configure_remote` | 配置远程控制 | 1000 |
| `create_soul` | 创建第一个搭子 | 1500 |
| `share_soul` | 分享搭子给朋友 | 2000 |

端点：`GET /api/v1/onboarding/tasks`（只读）+ `POST /api/v1/onboarding/tasks/complete`
（幂等写，判据 `alreadyCompleted`）。实测两个账号都能读；流水里能看到
「新手任务-发送第一条消息 +500」的 credit 记录 —— **领取是真到账的**。

插件怎么用它：

- **卡片上是 `aside` 窗口**：「可领 9500 积分（7 项待完成）」。一次性奖励
  **不参与路由打分**（不给 `limit`、`aside: true`）—— 否则一个任务没做完的号
  会显得额度很足而被优先派活。
- **签到成功后自动领**：领取是幂等的，放在每天一次的签到里做，既不会漏也不会
  重复。按分值**从高到低**串行领（中途失败至少领到大的那几项），失败不影响
  签到结果。
- **单独缓存 10 分钟**：`onboarding/tasks` 是另一个端点，而 `usage` 会被频繁
  刷新 —— 不能每次都打。

> 实况：`181****0632` 余额 0，但还有 10,000 分新手任务可领。卡片会如实显示，
> 不会因为「余额 0」就把这个人判死刑。

### 邀请码：新账号自动用老账号的邀请资格

Loomy 的「分享有礼」——**邀请好友双方各得 5000 积分**（客户端常量 `nb = 5e3`；
⚠ 别和新手任务里 `share_soul` 的 2000 混，那是两笔不同的奖励）。

每个账号有**专属邀请码**（实测：`189****8051` → `E4DPT6`、`181****00632` → `FDW3CU`，
上限 1000 次、已用 0），并且**每个账号只能兑换一次**别人的码。

| 端点 | 用途 |
|---|---|
| `GET /api/v1/invitation-codes` | 查自己的码（只读） |
| `GET /api/v1/points/activation` | 本账号是否已用过别人的码（只读） |
| `POST /api/v1/points/activation` | 绑定别人的码（一次性写） |
| `POST /api/v1/points/first-login` | **也接受 `{inviteCode, deviceId}`** —— 首次初始化时捎上，不用事后再绑 |

**这个插件怎么做的**：新账号登录时，自动从**本机其它已登录的 Loomy 账号**里挑一个
邀请码带上去。

- 挑码规则：排除自己的、用完的（`usedCount >= maxUses`）、非 `active` 的；
  优先**用得最少**的（把额度摊开）；`maxUses <= 0` 视为不限次。
- 先查 `activation`：**已用过就跳过**，不白发一次写请求（每账号只能用一次）。
- 走 `first-login {inviteCode}`（首次初始化顺带绑定）；那条没成再退回
  `points/activation`。**绑定失败不影响登录** —— 这是加分项。
- 为什么能拿到别的账号的邀请码：`getAuth()` 只在当前账号作用域里可见
  （magpie 的 `inScope`），所以直接读 `~/.config/magpie/plugin-auth.json`，
  把 `loomy` / `loomy#xxxxxx` 全捞出来逐个查（只读、不打印 session）。

```
新账号登录 → 收集本机其它 Loomy 账号的邀请码 → 挑用得最少的
          → 查 activation（已用过就跳过）→ first-login {inviteCode}
          → 双方各 +5000
```

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
npm test                  # 57 条，全离线、零额度
node tests/live.mjs       # 真实账号 + 真实上游（只读 + 幂等签到，不消费额度）
```

单测锁死这几组语义（**都做过反向验证**：改回市场插件的写法，对应用例会变红）：

1. 两池皆 0 → 一条 `used:100` 的**参与路由**窗口（不许 aside、不许消失）—— 变异后 4 条红
2. 永久池恒 `aside` 且不给 `amount`/`limit`
3. 上限未知 → `aside` + `used:0`，绝不谎报成满额
4. 上限已知 → 真实占比 + 完整字段；跨日旧上限作废
5. 签到 outcome 必须是契约六值之一（`"success"` 会让 magpie 显示「签到失败 · 已刷新」）—— 变异后 2 条红
6. `free` 只由厂商声明决定（`rate === 0` 不等于免费）—— 变异后 1 条红
7. 新手任务按分值排序、`aside` 不参与路由、全领完不画
8. 邀请码：排除自己/用完/非 active，优先用得最少

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

## 从本地 tgz 安装（不走 npm 时）

`magpie plugin add <tgz>` **不能用** —— 它把 tgz 当 JS 模块 `import()`，报
`exports no OpenCode plugin function`。按包名 + 本地 `file:` 依赖装：

```bash
npm pack --pack-destination ./dist
cp dist/magpie-plugin-loomy-auth-*.tgz ~/.config/magpie/plugins/dist/
# plugins.json 追加           { "spec": "magpie-plugin-loomy-auth" }
# plugins/package.json 追加   "magpie-plugin-loomy-auth": "./dist/magpie-plugin-loomy-auth-*.tgz"
cd ~/.config/magpie/plugins && ~/.cache/magpie/bun/1.4.4/magpie-bun.exe install
```

⚠ **改了代码必须 bump `version` 再打包**：同一个版本号重打，bun 会命中缓存
（输出 `no changes`），装了个寂寞。

### 装完要不要重启

**实测（2026-10-26）：不必需。** 本地 tgz 装好、`plugins.json` 登记完成后，
运行中的 magpie 在约几分钟内自行用上了新插件 —— 路由日志里同一个空号的 `used`
从 `0` 变成 `100`（`2026-10-26T04:19:33`），进程 PID 未变。

⚠ 触发机制**未查明**：二进制里没有 `fsnotify`/`Watcher`/`reloadPlugins` 符号，
不是目录监听，疑似按 tick 复查配置。既然机制不明，**改完重启一次最稳**
（重启不丢登录态）。

### ⚠ npm 包名与仓库名不是同一个

| | 值 |
|---|---|
| 仓库名 | `magpie-loomy-auth` |
| npm 包名 | **`magpie-plugin-loomy-auth`** |

`magpie-loomy-auth` 这个包名**在 npm 上已被他人占用**（0.3.2，维护者 `an0119`）。
magpie 的「有新版本」检查按**包名**去 npm 查，与仓库属主无关 —— 撞名会让界面提示
一个**别人的**新版，点「更新」就把别人的包装进来顶掉本插件。加 `-plugin-` 段避开。

⚠ **插件内 `REGISTRY_ENTRY.package` 必须与 `package.json` 的 `name` 一字不差**，
否则自注册条目对不上市场卡片。

---

## 许可

MIT
