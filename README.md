# 讯飞 Loomy · 原生供应商

把讯飞 Loomy 的模型接进 magpie 的**原生 API Key 体验**：纯网络登录、逐头复刻官方聊天请求、
不依赖官方客户端、不注入官方系统提示词。

> npm 与 GitHub 两条安装路径都可用。
> 不要把这里的内容贴到公开仓库/公开文档里。

## 它和公开版有什么区别

| | 公开版 `magpie-loomy-auth` | 本仓库 `magpie-plugin-loomy-auth` |
|---|---|---|
| 登录 | 三种：读本机客户端 / 短信 / 粘贴 | 两种：**短信 / 粘贴**（不读本机任何文件） |
| 官方客户端 | 可从中导入登录态 | **完全不依赖**，装了也不用 |
| 系统提示词 | 不注入（但与官方共存时可能被客户端注入） | **不注入**，且会把误抄进来的官方 soul prompt 剥掉 |
| 安全 | 基础 | 凭据脱敏、上游白名单、redirect 拒绝、隐私扫描（见 `docs/security.md`） |
| 请求头 | 官方 7 个追踪头 | 同左，逐头一致 |

## 安装

```bash
magpie plugin add magpie-plugin-loomy-auth          # npm
magpie plugin add github:MYCF711/magpie-loomy-auth  # 或直接跟 git
magpie plugin list            # 应看到 loomy (讯飞 Loomy (native))
```

## 登录

只走网络，两条路：

1. **手机号 + 短信验证码**（推荐）：在 magpie 账号页选这条，输入手机号，收到验证码填入。
2. **粘贴 session**：已经有 session 的话直接粘。

拿到的 session 就是凭据，等价于「原生 API Key」。

## 模型

目录来自 `GET /api/v1/models`（进程内缓存 10 分钟），**实时过滤**：

- `deepseek-v4-flash-1017`（DeepSeek V4.1 Flash 1017，x2.0）
- `GLM-5.3-Flash`（x0.8）
- `qwen3.8-flash`（x0.8）
- `spark-x2.6`（x2.5，已不再免费）
- `auto`（自动）

裸名 `DeepSeek-V4.1-Flash` 不进目录：它不保证固定快照，选了可能落到旧版本。

## 提示词

- 本插件**不加**任何 system / developer 消息，不改写调用方的 messages。
- 官方客户端的「灵魂提示词」是客户端本地注入的，服务端不注入 —— 实测带自定义 system 的请求，
  回复会被尊重（`SENTINEL42` 用例）。
- 如果你把客户端那整段 soul prompt 抄进了请求，插件会在发送前剥掉（`src/prompt.mjs`），
  避免模型变成「Loomy 办公助手」口吻。

## 自动邀请

老版本靠扫本机其它 Loomy 登录态来「自动邀请」；这一版**不读官方客户端**，改成插件自己的码库：

- 每次登录顺手把自己的邀请码记进本地库（Windows：`%APPDATA%\magpie-plugin-loomy-auth\invites.json`，
  其它平台：`~/.config/magpie-plugin-loomy-auth/invites.json`，可用 `LOOMY_INVITE_STORE` 覆盖路径）；
- 新账号登录时，从库里挑一个**不属于自己**、且本号还没兑换过的码自动兑换，双方各 +5000；
- 库里只有邀请码和归属指纹（session 的 sha256 前 12 位），**没有 session**；
- 库文件损坏或目录不可写时静默跳过，登录不受影响；
- **兜底码**：库为空时（第一次装）用 `src/invite-store.mjs` 里的 `FALLBACK_INVITE_CODES`，
  可用环境变量 `LOOMY_INVITE_CODE=CODE1,CODE2` 整组覆盖。兜底排在自己攒的码之后，
  只放当前 `active` 的码（用尽的不放，否则会挑出来白跑一次）。

## 额度

今日池 / 永久池 / 团队池按 magpie 的路由语义上报（见 `docs/internals.md`）。
插件在聊天前用缓存的额度读数做本地闸，耗尽直接 429，不去撞上游报错。

## 故障排查

| 现象 | 看这里 |
|---|---|
| `503 no_provider_error`（`metadata.provider_name=venus`） | 上游可调度实例为 0，换模型或等一会；不是鉴权问题 |
| `openresty 504` | 上游网关超时，宿主会换号重试 |
| 首字几十秒 | 上游容量；同时段换模型对照可确认 |
| `100002` / `401` | session 过期，重新登录 |

## 安全

见 [docs/security.md](./docs/security.md)。一句话：凭据只进不回、只连两个官方域、不碰本机其它应用的数据。

## 协议与逆向证据

见 [docs/internals.md](./docs/internals.md)：基线版本、asar 哈希、请求头表、系统提示词结论、
「反代风控」的实测边界、性能基线。