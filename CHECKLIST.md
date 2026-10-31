# CHECKLIST —— 两张表，两个交付门

> 给 `magpie-loomy-auth`。`scripts/check.mjs`（在脚手架仓库里）只查**能自动查的那部分**；
> 下面这些查不到，但漏了照样出事，而且通常**不报错**。
>
> 逐条勾，勾不上就是还没好。

---

## A 表 · 代码交付前

```
□ 1. usage 上报了 used（不是只画进度条）
      判据：被用空的号**不会**排到队首（magpie 归一化时 used 缺失 = 0 = 满额）
      出处：internals 这个插件修的是什么

□ 2. 今日池参与路由，永久池 aside
      判据：今日池有 used/amount/limit/resetsAt；永久池 aside: true 只给 display
      出处：同上

□ 3. 两池皆空时合成了 used:100 的参与路由窗口
      判据：空号沉底，不是以 0% 排第一
      出处：同上

□ 4. 上限未知时降级而不是谎报
      判据：aside + used: 0 + 文案「今日上限未知」
      出处：同上

□ 5. 签到 outcome 在契约六值里
      判据：claimed / done / ineligible / inactive / captcha / failed —— 没有 "success"
      出处：internals 同上

□ 6. 热路径用 /points/balance
      判据：额度读数不拖慢卡片（那个端点只回 3 个数字）
      出处：internals 协议要点

□ 7. first-login 的「今天已领」判据是 done
      判据：alreadyProcessed 时显示「今天已领」，不是「刚领到」
      出处：internals 协议要点

□ 8. token 刷新有节流
      判据：不是每次调用都打上游
      出处：internals 协议要点

□ 9. 只读当前账号作用域
      判据：getAuth() 拿不到别的账号（inScope 隔离）
      出处：internals 协议要点

□ 10. 没有写 magpie 的市场缓存
      判据：src 里搜不到 plugin-market.json
      出处：internals 从本地 tgz 安装

□ 11. registry-entry.json 的 package 与 **npm 包名**一字不差
      判据：package 是 magpie-plugin-loomy-auth；name 是市场显示名「讯飞 Loomy」
      出处：同上

□ 12. node tests/semantics.test.mjs 全绿
      判据：usage 与 outcome 的语义锁没被破坏

□ 13. node ../magpie-plugin-scaffold/scripts/check.mjs . 退出码 = 0
```

---

## B 表 · 发版前（七步，一步不能少）

> ⚠ **`git push` 只是第 4 步。**

```
□ 第 0 步 · 写 CHANGELOG（一条一行）
□ 第 1 步 · bump version
      判据：package.json 的 version 变了（同版本重打命中 bun 缓存）
□ 第 2 步 · npm pack --dry-run
      判据：清单里有 README.md / CHANGELOG.md / docs / AGENTS.md / CHECKLIST.md
□ 第 3 步 · 提交并推功能分支（不是 main）
□ 第 4 步 · PR 的 rules 全绿后合并（禁止直接推 main）
□ 第 5 步 · npm run publish:npm
      判据：返回 + magpie-plugin-loomy-auth@<版本>；package.json 的 name 保持 ASCII slug，显示名在 magpie.name
□ 第 6 步 · tag + Release
      命令：git tag v<version> && git push origin v<version>
      本仓库**有** .github/workflows/release.yml ⇒ 推 tag 后 workflow 自动建，不用手工 POST
      判据：约 1 分钟后 GET /releases/tags/v<version> 为 200
□ 第 7 步 · 四条验证
      ① npm view magpie-plugin-loomy-auth version
      ② 下载 dist.tarball 解包看内容（不只看版本号）
      ③ magpie plugin list
      ④ GET /releases/tags/v<version>  → 200 且 draft=false
```
