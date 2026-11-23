# 内部实现与逆向证据

> 公开仓库。这里记录「为什么这么做」，每条结论都标了取证方式与日期，不写没有证据的推测。

## 0. 基线：逆向对象与版本

| 项 | 值 |
|---|---|
| 二进制 | `官方 Windows 客户端 0.9.39` |
| FileVersion / ProductVersion | `0.9.39` / `0.9.39.0` |
| 主进程包 | `E:\Loomy\resources\app.asar`（231,192,778 字节） |
| asar SHA-1 | `cdf5f9ec6c046a72989a0c8a05baf743897a18b7` |
| 与在线发布包比对 | `https://static-res.xfinfr.com/loomy/win/latest.yml` 的 `Loomy-Setup-0.9.39.exe`（sha512 `ltr1ybkss2yp/ixAc45vD+2zUu5mJozVQeyzzotvbf8TWcAIaPYLNTxGhEO5KCBqxp1REUUItVwLKYibFggWrQ==`，releaseDate `2026-10-10T02:40:08Z`）解包后的 `app.asar` —— **同一个文件** |
| 安装目录附带资源 | `resources/{node-runtime, opencode, opencode-home-template, opencode-runtime, playwright-mcp-runtime, python-archive, local-model-runtime, loomy-bundled-node, npm, uv, wecom, larksuite-cli, dingtalk-workspace-cli}` |

结论：截至 2026-11-23，官方**没有**发布比 0.9.39 更新的客户端；线上 `latest.yml` 的 sha512 与 10-10 那版逐字节一致。任何「Loomy 换了客户端」的说法都要先过这一关。

## 1. 两个网关

| 用途 | Base | 鉴权 |
|---|---|---|
| 模型目录 / 聊天 / 积分 / 团队 / 身份 | `https://loomyad.xunfei.cn`（`/api/v1/...`） | session：`Authorization: Bearer <session>` + `token: <session>` 双头 |
| 账号 / 短信登录 | `https://account.xfinfr.com` | HMAC-SHA1 签名（公开客户端常量，见 `src/constants.mjs`） |

聊天端点是 OpenAI 兼容的 `POST /api/v1/chat/completions`。**没有**什么「云端 agent 专用端点」：
`/api/v1/agent/chat`、`/api/v1/agents`、`/api/v1/agent/completions`、`/api/v1/user/info` 全部 404（2026-11-20 实测）。

## 2. 聊天请求的协议面（逐头复刻）

取证：`app.asar` → `electron/utils/request-headers.js`（`buildRequestHeaders` /
`buildLoomyChatRequestHeaders`）、`electron/utils/request-purpose.js`（17 个协议用途值）、
`electron/utils/app-version.js`（`withLoomyVersionHeader`）、
`electron/llm/llm-completion.js`（真正发请求那一段）。

| 头 | 取值 | 说明 |
|---|---|---|
| `Authorization` | `Bearer <session>` | — |
| `token` | `<session>` | `useSessionAuth` 为真时**额外**再给一条，不是二选一 |
| `Accept` / `Content-Type` | `application/json` | — |
| `traceparent` | `00-<32hex>-<16hex>-01` | **必带**。官方源码注释原文：「实测 Loomy iModel 缺 traceparent 时 chat/completions 会挂死直到超时」 |
| `ChatId` | `chat-<uuid>` | 会话标识，同一会话多轮相同 |
| `MsgId` / `TurnId` | `msg-<uuid>` | 消息标识；官方在可用时两者同值 |
| `InvokeOrigin` | `user` / `system` | 用户主动 `user`；后台子调用才 `system` |
| `X-Loomy-Request-Purpose` | `chat.message` 等 17 个值 | 服务端裁决层按用途判定 |
| `loomy-version` | 客户端版本，如 `0.9.39` | 取自 `app.getVersion()` |

实现：`src/tracing.mjs`（生成）+ `src/chat.mjs`（只对 `/chat/completions` 注入）。
`ChatId` 由 magpie 的 `sessionID` 经 sha256 推出 ⇒ 同一会话跨轮稳定。
本插件自造的 `x-loomy-session` **不发给上游**（官方没有这个头）。

### 官方依赖文件

「保留官方依赖」指的是**协议常量**，不是把客户端打进来：

- 账号签名用的 `VITE_XFYUN_ACCESS_KEY_ID/SECRET` 与 `VITE_XFYUN_APP_ID=GM3LOOMY`
  —— 来自 `resources/.env.prod`（该文件用 `LOOMYENC1:` + AES-256-GCM 混淆，
  口令内嵌在客户端里，那段代码自己写了「本质是混淆而非真正的密钥保密」）。
  这些是**随客户端公开分发的常量**，不是用户凭据；插件把它们放进 `src/constants.mjs`，
  并允许用环境变量覆盖（厂商旋转时自救）。
- `loomy-version` 与 UA 同理：UA 用客户端账号服务的 `Loomy|Desktop|Electron|macOS`。

不保留、也不依赖的东西：`opencode`/`node-runtime`/`python-archive` 等运行时，
`opencode-home-template` 里的 agent prompt（见下节）。

## 3. 系统提示词：官方那套在客户端本地，服务端不注入

- 官方客户端的「灵魂提示词」写在 `resources/opencode-home-template/opencode.json`
  的 `agent.<id>.prompt` 里，由客户端在本地拼进 opencode 会话 —— **第三方走
  `/chat/completions` 永远看不到它**。
- 2026-11-23 实测（`deepseek-v4-flash-1017`）：
  - 带自定义 system（`SENTINEL42`）→ 回复以 `SENTINEL42` 开头，**调用方提示词被尊重**；
  - 不带 system → 回「我是科大讯飞研发的讯飞星火认知大模型」= 裸模型自述，
    没有 Loomy 人设。

⇒ 「剥离官方系统提示词」在协议层**已经成立**。本插件的职责是**不把它加回去**：
`src/prompt.mjs` 只做一件事 —— 断言我们不注入、不改写调用方的 messages，
并对「把官方 soul prompt 原样搬进请求」的形态做剥离（防止用户从客户端抄了整段提示词塞进来）。

## 4. 「反代风控」到底有没有

用户侧的观察是「慢 + 不是真 DeepSeek」。2026-11-23 实测（本机 5 个账号）：

| 实验 | 结果 |
|---|---|
| 10 并发打 `deepseek-v4-flash-1017`（5 个账号轮转） | **10/10 都回 `served=deepseek-v4-flash-1017`**，3.9–16.1 秒，无降级 |
| 单发 `deepseek-v4-flash-1017` / `DeepSeek-V4.1-Flash` | 7/7 回请求名本身，3.0–15.5 秒 |
| 请求不存在的模型名 `definitely-not-a-model-12345` | **HTTP 200**，响应 `model=spark-x2.6` |
| 请求 `gpt-4o-mini` | HTTP 200，响应 `model=spark-x2.6` |
| 积分流水 `/api/v1/points/records` | `modelName` **恒为 `spark-x2.6-low`**，与请求的模型无关 |
| 交叉验证流水 | 同一 1346-token 输入：spark 扣 4 分、GLM/qwen/DeepSeek 各扣 1 分，`modelName` 却相同 |
| 问「你是谁」（DeepSeek / GLM / qwen / spark 四个） | 全部回「讯飞星火」 |
| `temperature: 0` 同模型连打两次 | 输出正文 sha 不同 ⇒ 无法用输出指纹判定后端 |

结论分两半，都要如实写：

1. **能干的部分**：网关确实有一条「认不出就兜底到 `spark-x2.6`」的路（不存在的模型名也 200），
   所以「选了 DeepSeek 拿到星火」在机制上可能发生。
2. **不能证的部分**：`modelName` 是通用桶名（不随请求模型变化，却随模型变价），
   **不能**当真实后端的判据；模型自述与输出指纹也都不可靠。本机 17 次 DeepSeek 请求
   没有一次被抓到「响应说 DeepSeek、实际是星火」。
3. 因此本插件**不**基于「风控」做特判（不做 UA 伪装、不做指纹伪造、不重放官方 token），
   只做协议对齐 + 容量错误的正确分类。任何「伪装成官方客户端」的加固都会引入新的失败面，
   属于「有代价」的改动，按仓库规则不做。

历史上那批「很慢」的实测归因（2026-11-18 / 11-20）：`503 no_provider_error`
（`metadata.provider_name: venus`）+ `openresty 504` + 首字 12–150 秒，同时段换模型对照
即可区分，是上游容量，不是鉴权、不是请求形状。

## 5. 不依赖官方客户端怎么登录

只需要一个 **session 字符串**，两条纯网络路径：

1. 短信：`account.xfinfr.com` 发码/校验 → 拿 session（HMAC-SHA1 签名，常量见上）。
2. 粘贴：用户自己从任何地方拿到的 session 直接粘贴。

本仓库**不读**本机任何其他应用的文件（`src/desktop.mjs` 已删除），
这也是安全加固的一部分：插件进程不碰用户磁盘上的第三方凭据。

## 6. 性能基线

2026-11-23 15:5x，本机直连与经 magpie 网关：

| 路径 | 延迟 |
|---|---|
| 直连 `deepseek-v4-flash-1017`（短请求） | 3.0–15.5 秒 |
| 经 magpie `loomy/deepseek-v4-flash-1017` | 2.2–3.4 秒 |
| 经 magpie `group/deepseek-v4.1-flash-1017` | 3.0 秒 |

插件的热路径开销只有两次缓存查询（额度 60s / 目录 10min），不发额外请求。

## 7. 自动邀请：从「扫本机」改成「自己攒」

官方客户端时代，插件的自动邀请靠 `readAllLoomySessions()` 扫本机其它登录态、现查它们的邀请码。
这一版删掉了那条路径（不读第三方应用文件），改成 `src/invite-store.mjs`：

| 项 | 取值 |
|---|---|
| 存什么 | `{ version, entries: [{ code, owner, at }] }`；`owner` 是 session 的 sha256 前 12 位 |
| 不存什么 | **session 本身**、手机号、任何凭据 |
| 位置 | `%APPDATA%\magpie-plugin-loomy-auth\invites.json`（非 Windows 为 `~/.config/...`），`LOOMY_INVITE_STORE` 可覆盖 |
| 写入时机 | 每次登录 / 选码时查到自己的码就记一条（按 code 去重，最多 200 条，90 天过期） |
| 读取时机 | `collectInviteCandidates()`：排除 `owner` 等于自己的那条（不能自己邀请自己） |
| 失败策略 | 读不到 / 写不进 / 文件损坏 ⇒ 当空库，登录流程不受影响 |
| 兜底 | `FALLBACK_INVITE_CODES`（默认 J2QC44 / V5Y8JE，即当前两个 `active` 码）；空库时补在后面，自攒码优先；同码以库里状态为准；`LOOMY_INVITE_CODE` 可整组覆盖 |
| 为什么只放 active | `pickInviteCode()` 只看 `status` 与 `usedCount/maxUses`；把 `exhausted` 的码放进来会被挑中，然后绑定失败白跑一次请求（实测 `E4DPT6` / `FDW3CU` / `AJCH2R` 三个都已是 exhausted） |
| 兜底的寿命 | **每张码只能用 1~2 次**（实测 `maxUses` 分布 2/1/2/1/1），用完变 `exhausted` 就废了。所以兜底码是「第一次装时有得用」，不是长期方案 —— 用尽后要换表（或设 `LOOMY_INVITE_CODE`） |

判据：`node --test tests/invite-store.test.mjs`（去重、排除自己、损坏降级、过期、指纹稳定）。

## 8. Loomy 客户端的内核是 opencode（2026-11-23 抓包确证）

不是推测：用客户端自带的 `resources/opencode/win32-x64/opencode.exe`（`--version` = **1.14.22**）
配 `resources/opencode-home-template/opencode.json` 里的 provider，把 baseURL 指到本机抓包口，
抓到它真实发出的请求：

```
POST /v1/chat/completions
user-agent: opencode/1.14.22 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13
authorization: Bearer <session> · token: <session>
x-session-affinity: ses_<opencode 会话 id>
accept: */* · connection: keep-alive
（没有 traceparent / ChatId / MsgId / InvokeOrigin / loomy-version）
body: {"model":"deepseek-v4-flash-1017","max_tokens":32000,"messages":[{"role":"system",
       "content":"You are opencode, an interactive CLI tool that helps users with software engineering tasks. ..."}]}
```

结论：

1. **客户端 = opencode 套壳**：模板 provider 是 `@ai-sdk/openai-compatible` + `useSessionAuth`，
   agent 叫 `loomy`，`agent.loomy.prompt` 就是那段 2376 字的「灵魂提示词」——它由**客户端本地注入**，
   第三方走 `/api/v1/chat/completions` 永远拿不到（这也是 `src/prompt.mjs` 只需要防「用户自己抄进去」）。
2. **两条聊天路径，头不一样**：
   - Electron 直连（`llm-completion.js`）：带 traceparent/ChatId/MsgId/TurnId/InvokeOrigin/Purpose/loomy-version。
   - opencode 路径：**不带**上面任何一个，但带 `x-session-affinity`，UA 是 opencode 组合串。
   本插件把两套合并：追踪头全给（历史实测缺 traceparent 会挂死），并补上 affinity。
3. **速度口径**：同一条 1017 请求在 magpie 日志里是 **318 token/秒**、`completion=426`，
   而首字用了 19 秒。144 次实测里首字 5~52 秒不等，**即使缓存命中 99% 也一样慢** ⇒
   慢在上游排队，不在 prefill、不在我们的请求形状。
4. 上游会回 `429 模型服务当前繁忙，请稍候`（同账号并发 2/3 实测未复现，属上游瞬时拥塞）。
