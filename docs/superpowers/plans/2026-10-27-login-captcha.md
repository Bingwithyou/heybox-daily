# 登录人机验证实施计划

对应已批准 spec：`docs/superpowers/specs/2026-10-27-login-captcha.md`。

- [x] 扩展上游登录与合同。修改 `src/client.ts`、`src/login.ts`、`packages/contracts/src/index.ts`：保留严格校验的公开 appid，人工验证票据只进入原接口的 query，增加公开登录步骤判别结果。补充 `test/login.test.ts` 的 CAPTCHA 识别、参数、身份回读和无敏感错误测试。
- [x] 实现执行端阶段状态。修改 `apps/runner/src/{worker,main,challenges,server}.ts`，必要时增加小型内部类型模块。保留原 Config/手机号/binding，处理发码和验码两种 CAPTCHA 阶段；限制重复/并发/过期/次数，保留旧托管凭据。补充 `apps/runner/test/security.test.ts` 和过程边界测试。
- [x] 接入网站。修改 `apps/web/src/server/{auth,api}.ts`，统一登录成功会话创建；修改 `apps/web/src/routes/login.tsx` 和增加按需验证码 SDK helper。只在需要时显示验证操作，取消不自动发码，拒绝容灾结果，执行错误只显示安全文本。
- [x] 集成验证。扩展 `apps/web/test/mock-runner.ts`、`integration.ts`；覆盖跨浏览器、阶段错误、正确继续、重复 ticket、再次 CAPTCHA、验码 CAPTCHA、旧会话不受失败影响。用本地真实 Worker/D1 + 模拟上游完成协议验证，再用 Chrome 检查 UI 状态和移动端。
- [ ] 发布与真实验收。更新 `docs/hosting.md`，检查 diff/敏感信息，按已有授权 push 并确认 CI。构建 runner、部署 Worker，确认服务健康。需要时仅针对测试账号恢复一次本站发码测试额度，不修改其他用户额度或小黑盒限制。触发真实验证后等待操作前确认，完成发码、短信校验、身份回读、页面进入及耗时测量；同时区分网站会话和小黑盒凭据是否有效。

验证命令：`pnpm test`；`pnpm --filter @heybox/runner typecheck`、`test`；`pnpm --filter @heybox/web test`、`build`、`typecheck`、`lint`、`format:check`、`test:integration`。`build` 会生成 dist；格式修复只限本次 web 文件；集成测试启动隔离本地服务。Docker/发布是已授权外部操作，真实 SMS 仅用于用户账号，不在自动化测试中调用。

主要风险：官方域名/appid/IP 限制不可提前确认；验证码必须由合法挑战产生，不能通过伪造回调实现成功。取消、过期或重启可丢弃短期挑战，但不更换已有托管凭据。回滚 Worker 和 runner 到 `b44d912`，无需数据库回滚。
