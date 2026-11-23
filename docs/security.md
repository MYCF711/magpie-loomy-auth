# 安全加固

这个插件的交付物要能被别人直接装上用，所以加固不是「顺手写两句」，而是有判据的清单。
每条都对应代码里的位置与可复跑的检查。

## 1. 凭据：只进不回

| 规则 | 位置 | 判据 |
|---|---|---|
| session / 签名密钥**永不**出现在日志、错误消息、响应头 | `src/hardening.mjs` 的 `redact()`，`chat.mjs`/`api.mjs` 的所有错误路径都过它 | `node --test tests/security.test.mjs` 里「错误消息不许带 session」用例 |
| 凭据只在 `getAuth()` 作用域内读，不跨账号 | `index.mjs` 每个钩子各取一次 `getAuth()` | 代码审查 + `getAuth` 无全局缓存 |
| 伪造 refresh_token 一律禁止 | `auth.refresh()` 恒 `undefined` | 过期就报 `signIn: "expired"`，不假装能续 |
| 凭据不落盘到插件目录 | 插件不写盘（除 magpie 自己的凭据库） | `grep -rn "writeFile" src/` 应为空 |

## 2. 网络：只连两个官方域

`src/hardening.mjs` 的 `assertUpstream(url)` 白名单：`loomyad.xunfei.cn`、
`account.xfinfr.com`。任何其它 host 直接抛错。

理由：插件会把 session 放进请求头，一旦上游地址可被配置注入（环境变量、模型名、
重定向），session 就会被送到第三方。因此：

- 白名单是**硬编码**，不受环境变量影响；
- 所有 `fetch` 都带 `redirect: "error"`，不吃 30x 带凭据跳转；
- 上游地址常量集中 `src/constants.mjs`，改它要过 code review。

## 3. 不碰本机其它应用的数据

- 不读 Loomy 客户端目录、不读浏览器 cookie、不读任何 `*.json` 凭据文件。
- `src/desktop.mjs` 已删除（原实现会读本机客户端登录态）。
- 判据：`grep -rn "AppData\|Roaming\|auth-session" src/ index.mjs` 应为空。

### 3.1 自动邀请的本地码库

`src/invite-store.mjs` 会写一个小 JSON：**只有邀请码 + 归属指纹**（session 的 sha256 前 12 位），
**没有 session**。指纹只用于「别自己邀请自己」，不可逆推凭据。
目录：`%APPDATA%\magpie-plugin-loomy-auth\invites.json`，可用 `LOOMY_INVITE_STORE` 覆盖。
判据：`grep -n "writeFileSync" src/` 只应出现在这个模块里。

## 4. 请求形状最小化

- 只发官方协议需要的头（见 `docs/internals.md` §2），**不**加任何自造识别头。
- 不做 UA 伪装以外的指纹伪造：不发假 `x-forwarded-*`、不改 TLS 参数、不复用官方 token。
- 出站请求的 `Referer`/`Origin` 一律不带（非浏览器上下文）。

## 5. 输入边界

| 面 | 限制 |
|---|---|
| body 透传 | 不解析、不改写调用方 messages（除 `src/prompt.mjs` 的官方 soul prompt 剥离），保持流式原样透传 |
| 图片 | 仅接受 `data:` URI 形态；不做远程 URL 抓取（避免 SSRF） |
| 错误体 | 只读取前 8 KiB 做分类，不整份缓存进内存 |
| 超时 | 常规请求 20s / 聊天 300s，都带 `AbortSignal` |

## 6. 仓库卫生

- `npm pack` 白名单只含运行必需文件（`files` 字段）。
- `scripts/privacy-scan.mjs` 必须 0 命中（手机号、token、密钥、绝对路径）。
- 不提交 `verification/` 这类本机证据目录。
- 不在 README 里贴真实账号、手机号、session 片段。

## 7. 已知边界（如实写）

- 本插件持有的是**用户自己的** Loomy session，等价于把该账号的调用能力搬进 magpie；
  session 泄漏 = 账号被他人使用。加固只保证「不主动泄漏」，不保证服务端日志侧不可见。
- 上游是否对「非官方客户端」做额外策略（限速/降级）**无法从客户端侧证明**，
  见 `docs/internals.md` §4；因此本插件不做对抗性伪装，只做协议对齐。