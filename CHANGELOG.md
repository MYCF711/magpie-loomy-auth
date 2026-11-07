# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与发布流程见 [magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold) 的 [UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md)。

## 0.1.26 — 2026-11-08

**带图请求不再整轮 400 失败**

- 实测 8 个对话模型 × 两种图片投递形态：`image_url` data URI 只要落到讯飞自研后端（spark / dashscope）就**整条 400**（`请求有误，请重试；若多次出现请更新应用版本` / `暂不支持该图片格式`），而 `<image_base64>` 文本标记在**全部 8 个模型**上都 200
- 预改写判据从「只有 deepseek 系」改为**只认实测吃不下的那一批**：minimax / qwen-3.8-max / qwen3.8-flash / kimi / spark- / auto（大小写不敏感，`group/` 前缀也算）；**deepseek 移出清单**（实测它接受 `image_url`，同图 `prompt_tokens` 219 对标记形态的 102，且把图文本化正是把 token 放大到撞爆上下文的原因），GLM 与 mimo 同样保留原生视觉
- **兜底**：模型名没命中判据、却仍因图片格式回 400 时，把同一个 body 转成标记形态**本地重发一次**（只一次，重发也失败就返回第二次的结果）；重发后的响应带排障头 `x-loomy-image-retry: 1`
- 重发判据**锚定上游错误信封的 `error.message` 开头**，并拒绝「body 里本来就含这句文案」（用户贴报错截图/日志时会出现这种回声）与「已经含 `<image_base64>`」两种情形 —— 否则一个无关的 400 就会把大请求重发一遍、白烧一次额度
- 超大请求上那条**通用** `请求有误，请重试` 400（请求体 > 200 万字符时）也接进 too-long 通道，改写成 magpie 认得的「上下文超出长度限制」，让 agent 压缩上下文而不是整轮失败
- 长对话里开了图片的那一轮不再因为后端漂移就整个失败，用户直接看到回答

## 0.1.25 — 2026-11-05

**图标换成 Loomy 官方 logo（插件卡片 + 供应商两处都换）**

- 来源：Loomy 官网 `https://loomy.xunfei.cn/` 的 `<link rel="icon" href="/icon.png" sizes="1024x1024">`，1024×1024 原图。
- 之前用的是讯飞开放平台的 `ex` 字标（`magpie.icon`）和客户端 `app.ico` 的 256 档（`src/icon.mjs`），两个都不是 Loomy 自己的形象。
- 按原图的薄荷绿 `#72E3AD` 把透明四角填成方形，加 28% 圆角（对齐 magpie `.pm-logo` 的 10/36），缩到 256（供应商）/ 128（卡片）。
- `index.mjs` 的 `auth.icon` 与 `package.json` 的 `magpie.icon` 现在指向同一张官方图。

## 0.1.24 — 2026-11-05

**图标提亮，深色主题下不再发黑**

讯飞官方 favicon 是 `(13,53,82)` 的深蓝，放在 magpie 深色主题的 `--pill` 灰底上几乎看不见（0.1.23 截图里只剩一个影子）。现在把深蓝提到 `#60a5fa`（同色相、提亮），裁掉透明边后等比撑满 96×96，其余不变。
## 0.1.23 — 2026-11-05

**卡片图标内嵌官方图；`magpie.summary` 补上（按语言的对象）**

- 图标原来是指向 `raw.githubusercontent.com` 的 URL，大陆网络下拉不到、卡片经常空着；
  现改官方 60×60 图等比放到 128×128 透明画布内嵌为 data URI（3.7 KB），不依赖网络。
- `magpie.summary` 新增 `{"zh": …, "en": …}`（151 B / 153 B，上限 300）。yetone/magpie#394
  的 `ownSummary` 读 `map[string]string`，之前没有这个字段，卡片上没有任何一句话。


## 0.1.22 — 2026-11-04

**出站 UA 全部换成官方客户端 UA（同步脚手架 0.3.10 的坑表第 38 条）**

- 上游网关按 `<product>/<version>` 形态识别「第三方客户端」，命中即回
  `403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}`；而 magpie 给插件宿主
  的 UA 固定是 `magpie/<version>`，插件不显式覆盖就原样透传，同样命中
- 本仓库所有打上游的出站点改为显式带**官方客户端** UA；不再出现 `<包名>/<版本号>`、
  `node`、`Bun/…` 或截断的 Mozilla
- 新增 `scripts/check-ua.mjs`（`npm run check:ua`，0 = 合规）、`AGENTS.md` 坑表第 17 条、
  `CHECKLIST.md` 的 UA 勾选项

**错误出口对齐 ERROR-CODES.md（CI「供应商插件规定」判的两条 R2 / R8）**

- 本地额度闸那记 429 的 `code` 从自造的 `insufficient_points` 改成词表里的
  `rate_limited`（429 · 可退避 · 换号有救），错误体补 `status: 429`。词表外的码宿主不认识，
  等于既不退避也不换号
- 请求**没拿到响应**时不再一律 502：20 秒超时 → `504 upstream_timeout`，断连/拒连/DNS →
  `503 upstream_unavailable`。502 表示「上游给了明确的错误体（业务错误）」，落在这里
  宿主会既不退避也不换号，把一个「重试就好」的错误直接摔给用户
- 词表收敛到 `src/constants.mjs` 的 `ERROR_CODES`，新增 `tests/error-codes.test.mjs`
  锁住 R2 / R8 / R9（76 条测试全过）

## 0.1.21 — 2026-10-31

- **显示名迁移到 `magpie.name`**：`package.json` 的 `name` 改回 ASCII slug `magpie-plugin-loomy-auth`（bun 依赖键，避免 `plugin update` 报 `unrecognised dependency format`）；卡片标题由 `magpie.name: "讯飞 Loomy"` 提供（magpie 0.1.2404 的 `magpie.name` 修复）
- provider 名保持 `讯飞 Loomy`；`registry-entry.json` 的 `name` 同步，`package` 仍是 npm 包名
## 0.1.20 — 2026-10-31

- **卡片显示名改为「讯飞 Loomy」**：按新约定写成 `<中文> <English>`，英文部分照厂商官方写法 `Loomy`；provider 的 `name` 同步改，市场条目的 `name` 也同步。官方站点（https://loomy.xunfei.cn/）的标题与 description 只写「Loomy」，中文部分是厂商名「讯飞」，没有独立中文产品名
- **npm 包名仍是 `magpie-plugin-loomy-auth`**：`publish:npm` 在发布瞬间注入，仓库里的 `name` 只负责显示

## 0.1.19 — 2026-10-30

- **「内容太长了」不再整轮失败**：上游回 `400 内容太长了，请精简输入或开启新对话`，而 magpie 的 `tooLongRe` 中文只认 `上下文(长度)?(超|过长)` 与 `超(过|出)…上下文` —— 一个「上下文」都没有，于是被当普通错误冻结账号、组里其它成员一次没被问、整轮会话直接失败。现在在 `chatFetch` 里把这句话改写成 `上下文超出长度限制`，其余字段与状态码原样，magpie 据此判定「该压缩上下文」而不是失败
- **`npm test` 在 Node 24 上跑不起来**：`node --test tests/` 会把目录当模块路径解析 ⇒ `MODULE_NOT_FOUND`。改成 `node --test tests/*.test.mjs`（68 条全过）

## 0.1.18 — 2026-10-28

- **修正文档里的错误说法**：AGENTS 与 CHECKLIST 都写着「本仓库没有 .github/workflows ⇒ Release 手工建」，实际本仓库**有** `release.yml` —— 推 tag 后 workflow 自动建 Release。上一版发布时 `release.mjs` 打出「交给 release.yml」才暴露出来

## 0.1.17 — 2026-10-28

- **AGENTS 新增「零、magpie 升级时：只看稳定版」** —— magpie 有「更新渠道：每个版本 / 稳定版」，用户默认跑稳定版。两渠道实测差 **400 多个版本**（每版本 0.1.1763 / 稳定版 0.1.1327），但插件相关的契约字段**一条不差** ⇒ 追每版本几乎全是白跑。判断依据只有一条：**稳定版版本号变了**才需要重新同步

## 0.1.16 — 2026-10-28

- **新增 `AGENTS.md`** —— 给 AI 执行者的入口：按「你在哪一步」给阅读顺序，外加本仓库 15 条会静默出错的坑（症状 → 判据 → 出处）。核心那条就是本插件存在的理由：`usage` 不上报 `used` 会让**被用空的号以「满额」排队首**
- **新增 `CHECKLIST.md`** —— A 表 13 项代码交付前（含 usage 三态、签到 outcome 六值、热路径端点、刷新节流），B 表发版前七步
- [README](./README.md) —— 顶部加指路三行；发布是七步，`git push` 只是第 4 步
- [CHANGELOG](./CHANGELOG.md) 与 `publish-npm.mjs` 里的脚手架链接从旧名 `magpie-plugin-template` 改为 `magpie-plugin-scaffold`
- `package.json` 的 `files` 补上这两份，否则 npm 包里没有它们

## 0.1.15 — 2026-10-27

- **插件不再写 magpie 自己的缓存** —— 删掉 `src/self-register.mjs` 与 index 里的调用：`~/.cache/magpie/plugin-market.json` 属于 magpie，每次加载都去改它等于把 registry 条目盖掉
- **卡片标题与文案改由 registry 条目承担** —— 提交到 `magpie-community/plugins` 的条目是唯一受支持的做法
- 其余行为（登录、模型、积分、签到）**一行未动**，凭据形状不变，不用重新登录

## 0.1.14 — 2026-10-26

首次留档。0.1.5–0.1.13 是同一天的连续迭代，没有分开记 —— 下面这些是这个插件**现在**
给用户的东西：

- **两种积分池分开上报** —— 今日池参与路由，永久池只显示不参与；空号不会再以「满额」的姿态排在队首
- **签到一次做完三件事** —— 刷新今日额度、领 10,000 新手任务积分、兑换邀请码，全部幂等
- **免费模型按厂商口径判定** —— 不靠「倍率是 0」猜
- **邀请码只判断「这个号是否已被邀请过」** —— 不做多余判断
- **256px 图标** —— 卡片上不再是糊的
- **README 重写** —— 开头给数字、功能一条一行、安装放最后、参考源逐条列出
- **新增 `CHANGELOG.md`**，并让推 tag 自动生成 GitHub Release
- **仓库里的 `name` 改成 `Loomy`** —— 卡片标题就是包名（`plugins/package.json` 的依赖键由包内 `name` 决定），改这里才永久生效：`add` / `update` 不会再把它重置回 `magpie-plugin-loomy-auth`
- **新增 `publish-npm.mjs`** —— npm 上的包名仍是 `magpie-plugin-loomy-auth`（registry 不接受含大写的新包名）；发布改用 `npm run publish:npm`，别再裸跑 `npm publish`

## 更早

未留档 —— `git log --oneline` 是唯一的记录。
