# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与发布流程见 [magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold) 的 [UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md)。

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
