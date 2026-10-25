# NOTICE

本插件的实现参考了以下来源。按各自的许可要求在此声明。

## magpie 插件契约

- **yetone/magpie** — Copyright (c) 2026 yetone, MIT License
  - `src/pure.mjs` 里 `auth.usage` 的 windows 字段形状、`used` 的归一化行为、
    `aside` 的语义、签到 `outcome` 的合法值清单、`client.auth.set` 的整体替换
    （而非合并）语义，均取自 magpie 二进制内嵌的插件契约源码。
  - `free` 字段的判据取自其路由模式说明（"Free first"）：模型供应商是否
    **不消耗本订阅的额度或积分**。

## Loomy（讯飞）协议实现

- **sucooer / anyaer 的 `magpie-plugin-loomy`**（`github.com/sucooer/magpie-plugins`, MIT）
  - `src/crypto.mjs` + `src/pure.mjs` 的 `signedHeaders`：账号接口的 HMAC-SHA1
    待签串构造（9 段 `\n` 连接）、路径分段转义规则。
  - `src/desktop.mjs`：Loomy 桌面端登录态的 leveldb 读取方式（键名
    `loomy-auth-session`、追加写所以从后往前找）。

- **agent2api**（`loomy/sign.rs`, `loomy/images.rs`）
  - deepseek 系模型只认 `<image_base64>` 标记、不认 `image_url` data URI 的结论，
    以及把标记并入相邻 text 块的做法。

## 与上述实现的差异

本插件的额度上报口径与它们**不同**：市场现有实现不上报 `used`（或在拿不到上限时
上报 0），导致 magpie 把被蹬空的账号排在路由队首。本插件上报真实占比、把永久池
标为 `aside`、并在两池皆空时合成一条 `used: 100` 的参与路由窗口。
详见 README 的「这个插件修的是什么」。

## 本项目自身

Copyright (c) 2026 MYCF711, MIT License（见 `LICENSE`）。
