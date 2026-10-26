# Loomy for magpie

**每个账号 25,000 一次性永久积分 + 每天 5,000 积分**

讯飞 Loomy 的编程订阅接进 magpie。

```
永久积分   最多 25,000    一次性，用完不再有
今日积分   每天  5,000    每天重置
```

---

## 功能

- **一次性 25,000 永久积分** —— 注册、新手任务、邀请与被邀请，全部自动领取
- **每天 5,000 积分** —— 签到自动刷新，不用点
- **10 个模型** —— 上下文最大 1M，支持看图与工具调用
- **两种模型免费** —— `spark-x2.6` / `spark-x` 不扣积分
- **三种登录** —— 桌面端一键导入 / 手机号短信 / 粘贴 session
- **积分算得准** —— 空号就显示空，不会被优先派活
- **免重登** —— 从别的 Loomy 插件换过来，登录态直接用

---

## 模型

| 模型 | 上下文 | 看图 | 倍率 |
|---|---|---|---|
| `DeepSeek-V4.1-Flash` | 1M | ✓ | x2.0 |
| `MiniMax-M3` | 1M | ✓ | x4.0 |
| `GLM-5.3-Flash` | 1M | ✓ | x0.8 |
| `qwen3.8-flash` | 1M | ✓ | x0.8 |
| `mimo-v2.5` | 1M | ✓ | x3.3 |
| `qwen-3.8-max` | 1M | ✗ | x12.0 |
| `Kimi-k2.6` | 256K | ✓ | x6.5 |
| `spark-x2.6` | 1M | ✗ | 免费 |
| `spark-x` | 1M | ✗ | 免费 |
| `auto` | — | ✗ | 自动选 |

思考档位 `none / low / medium / high / xhigh`，默认 `low`。

---

## 签到

magpie 每天调一次，一次做完三件事：刷新今日额度、领新手任务、兑换邀请码。
全部幂等，失败不影响签到本身。

---

## 安装

在 magpie 的 **插件 → 发现** 搜 `Loomy`，点**安装**。

先卸掉别的 Loomy 插件 —— 会抢同一个供应商。

### 命令行

```bash
# 从 npm（推荐）
magpie plugin add magpie-plugin-loomy-auth

# 从仓库源码（拿最新代码，不走 npm）
magpie plugin add github:MYCF711/magpie-loomy-auth

# 本地 tgz（自己改了代码）
npm pack --pack-destination ./dist
cp dist/magpie-plugin-loomy-auth-*.tgz ~/.config/magpie/plugins/dist/
# plugins.json          追加 { "spec": "magpie-plugin-loomy-auth" }
# plugins/package.json  追加 "magpie-plugin-loomy-auth": "./dist/magpie-plugin-loomy-auth-*.tgz"
cd ~/.config/magpie/plugins && ~/.cache/magpie/bun/1.4.4/magpie-bun.exe install
```

⚠ **`magpie plugin add <tgz路径>` 用不了** —— 它把 tgz 当 JS 模块 `import()`，报
`exports no OpenCode plugin function`（实测 0.1.1254）。本地包必须走上头那套
`plugins.json` 登记 + `bun install`。

装完确认：

```bash
magpie plugin list
# magpie-plugin-loomy-auth  on
#   loomy (Loomy, 10 models)  signed in as 189****8051
```

⚠ 改了代码要 **bump `version` 再打包** —— 同一版本号重打，bun 会命中缓存（输出 `no changes`）。

---

## 常见问题

**积分 0，但 App 里还有？** 今日额度用光了，等北京时间 0 点重置。

**登录已失效？** 会话 14 天到期，重新登录一次。

**会花我的积分吗？** 不会，只读余额和领奖励。

**25,000 怎么来的？** 25,000 = 注册 5,000 + 新手任务 10,000 + 邀请 5,000 + 被邀 5,000。
后两笔需要本机有两个以上账号（互相邀请），平台允许。全是**一次性**，领完就没了；
日常用的是每天 5,000 的今日积分。

---

## 参考源

本插件的协议实现参考了这几处，按各自许可在此声明（完整版权声明见 [`NOTICE.md`](NOTICE.md)）：

| 来源 | 用在哪 |
|---|---|
| [yetone/magpie](https://github.com/yetone/magpie)（MIT） | 插件契约：`usage` 窗口字段、`used` 归一化、`aside` 语义、签到 outcome 清单、`free` 判据 |
| [sucooer/magpie-plugins](https://github.com/sucooer/magpie-plugins)（MIT） | 账号接口的 HMAC-SHA1 签名构造、桌面端登录态（leveldb）读取方式 |
| [agent2api](https://github.com/aimod-cc/agent2api) | deepseek 系模型只认 `<image_base64>` 标记、不认 `image_url` 的结论 |

---

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)

## 许可

MIT。
