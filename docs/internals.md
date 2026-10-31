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
  loomy (讯飞 Loomy, 10 models)  signed in as 189****8051
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

### 邀请码：签到时自动兑换（不在注册时）

**实测结论（2026-10-26，真号跑的）**：邀请双方**各得 5000**，不是 2000。

```
操作：181****0632 兑换 189****8051 的码 E4DPT6（走 bindInviteCode → POST /points/activation）

189****8051  永久积分 14860 → 19860  (+5000)   流水：+5000 邀请好友奖励
181****0632  永久积分 10000 → 15000  (+5000)   流水：+5000 填写邀请码奖励
E4DPT6  usedCount 0 → 1                       181 activation false → true
```

| 端点 | 用途 |
|---|---|
| `GET /api/v1/invitation-codes` | 查自己的码（只读）。回 `{inviteCode, usedCount, maxUses, status}` |
| `GET /api/v1/points/activation` | 本号是否已兑换过；回 `{activated, appliedInvitationCode}` |
| `POST /api/v1/points/activation` | 绑定别人的码（**每账号一次**） |
| `POST /api/v1/points/first-login` | **也接受 `{inviteCode, deviceId}`** |

#### 为什么放在签到里，而不是登录时

邀请码的有效期是「账号存在期间」，不是「注册那一刻」。放签到里覆盖两种情形：
新号第一次签到、老号后来才想用。注册流程里不用塞输入框。

`auth.checkin` 现在一次做三件事（全部幂等，重复调用无害）：

```
① POST /points/first-login        刷新每日额度（拿 dailyQuota）
② GET|POST /onboarding/tasks*     领新手任务
③ GET /points/activation          确认没兑换过
   GET /invitation-codes (本机其它账号)  取候选
   POST /points/activation        兑换选中的码
```

②③ 失败都不影响签到结果 —— 它们是顺带做的事，不是前置条件。

#### 判据只有一条：本号是否已经被邀请过

平台规则：**每个账号仅能兑换一次**（客户端文案「你已经兑换过积分啦」）。
所以判断依据就是 `GET /points/activation` 的 `activated`，跟「谁邀请了谁」无关。

**为什么不需要知道对方是谁**：`GET /api/v1/invitation-codes` 只回
`{inviteCode, usedCount, maxUses, status}` —— 有数量、没有名单。
客户端里也没有「被邀请的好友」列表接口；探测 `/invitation-codes/invitees`、
`/invitation-records`、`/points/invitation-records` 全部 404。
既然拿不到，就不该假装能判断。

#### 平台**允许**互刷（实测，不是推测）

```
189 兑换 181 的 FDW3CU → +5000 填写邀请码奖励
181 兑换 189 的 E4DPT6 → +5000 填写邀请码奖励
两边各再收 +5000 邀请好友奖励
⇒ 各得 10000，服务端全程 200，没有任何拦截
```

**这是平台的规则漏洞，不是插件的责任。** 本插件只做两件合规的事：

1. 本号 `activated: true` 时不再兑换（平台规则）；
2. 把本号自己的码从候选里排除（不能自己邀请自己）。

⚠ 曾经加过一条「本号码被用过就不再兑换别人的码」的规则，**已移除** —— 它拦不住互刷
（先兑换的一方 `usedCount` 还是 0），却会误伤 A→B→C 这种正常长链里的 B。

#### 候选从哪来

`getAuth()` 只在当前账号作用域可见（magpie 的 `inScope`），拿不到别的账号。
所以直接读 `~/.config/magpie/plugin-auth.json`，把 `loomy` / `loomy#xxxxxx`
全捞出来逐个查（只读，session 不打印、不外发）。挑码规则：
排除自己的、用完的（`usedCount >= maxUses`）、非 `active` 的；优先 `usedCount` 最小的。

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

⚠ **提交给 registry 的条目里 `package` 必须与 `package.json` 的 `name` 一字不差**
（`magpie-plugin-loomy-auth`），否则市场卡片对不上这个包。

⚠ 插件**不写** magpie 的市场缓存（`~/.cache/magpie/plugin-market.json`）——
那份文件属于 magpie，插件每次加载都去 merge，等于把 registry 条目盖掉。
0.1.14 及更早曾用 `src/self-register.mjs` 这么干，0.1.15 删除。
卡片标题与文案的唯一载体是 registry 条目。

---

## 一个账号的永久积分上限：25,000（实测账）

| 来源 | 分值 | 一次性 |
|---|---|---|
| 注册奖励 | 5,000 | ✓ |
| 新手任务（8 项） | 10,000 | ✓ |
| 被邀请（填别人的码） | 5,000 | ✓ |
| 邀请别人（自己的码被用） | 5,000 | ✓ |
| **合计** | **25,000** | |

实测两号 `credit` 流水完全一致：`+25,000`（11 条）。校验方式：

```
credit(25,000) − debit(consumeSource=permanent) = balance
  189****8051: 25,000 − 140  = 24,860  ✅ 与接口 balance 一致
  181****0632: 25,000 − 5,000 = 20,000  ✅ 与接口 balance 一致
```

⚠ **每日池的消耗不算在内**（`consumeSource: "daily"`）—— 那部分不动永久积分。
第一次算的时候把它们一起减了，得到 19,830 / 10,000，对不上；按来源拆开才吻合。

⚠ 后两笔（邀请/被邀请）需要本机有两个以上账号。单账号只有 5,000 + 10,000 = 15,000。

⚠ **25,000 是一次性的**。日常用的是今日积分（每天 5,000，北京时间 0 点重置）。
两者别混。

⚠ 平台**允许互刷**（A 邀 B、B 再邀 A，双方各拿两笔共 10,000，服务端全程 200）。
这是平台的规则漏洞，插件不做启发式拦截 —— 详见上文「邀请码」一节。

---

## 许可

MIT
