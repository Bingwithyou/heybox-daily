# 实施计划：减少空闲 CF 和 D1 请求

按已批准的 `../specs/2026-10-27-idle-scheduling.md` 在当前 checkout 实现、验证，随后推送、发布新版并部署验收。

1. **固化行为测试。** 新增 `apps/runner/test/queue.test.ts`，覆盖空闲等待、即时唤醒、忙碌通知、串行执行、重试提示、服务故障和退出。扩展 `apps/runner/test/process.test.ts` 检查通知接口的认证。扩展 `apps/web/test/store.test.ts` 检查空闲读写、重试/租约提示、小时补查和每日清理。先观察新测试失败。
2. **实现通知和可唤醒任务循环。** 新增 `apps/runner/src/queue.ts`，调整 `main.ts` 和 `server.ts`；保留实际任务执行和结果回写逻辑。新增 `apps/web/src/server/notify.ts`，在 `auth.ts` 和 `rpc.ts` 的入队成功后短超时通知；通知失败只影响时效，不丢任务。
3. **降低 D1 空闲操作。** 调整 `store.ts` 的领取预查、下一次检查提示和调度返回值；`api.ts` 在空响应中添加 `Retry-After`，正文不变。已有任务、未到期租约、失败重试和跨日继续按原约束处理。增加查询计数和查询计划证据，不修改数据库结构。
4. **调整定时任务。** `apps/web/src/worker.ts` 调用小时补查并按需通知，单独调用每日清理；`wrangler.jsonc` 改为每小时第 1 分钟。更新 `docs/hosting.md` 说明正常唤醒、30 分钟兜底及故障恢复边界。
5. **验证和修复。** 运行 runner、web 测试及类型检查，网页 lint / format check / build，现有本地 D1 集成测试，并扩展 mock runner 验证登录/重试/恢复通知。构建 runner Docker 镜像并离线运行相关测试。检查 diff 和 Git 状态。验证命令的构建只生成本地产物；集成测试只创建临时本地 D1，不访问正式数据库或小黑盒接口。

验证命令使用 Node 24，当前机器以 `PATH=/Users/bytedance/.nvm/versions/node/v24.22.1/bin:$PATH npx --yes pnpm@12.15.0 ...` 调用，绕过已有 pnpm wrapper 问题：

- `--filter @heybox/runner test` / `typecheck`
- `--filter @heybox/web test` / `typecheck` / `lint` / `format:check` / `build` / `test:integration`
- `docker build --target runner -t heybox-daily-runner:idle-scheduling .`
- 使用 `--network none` 的 runner 镜像测试，以及 `git diff --check`。

通过条件：通知不增加执行并发或绕过租约，空闲稳定每天约 48 次领取和 24 次定时调用，已知重试按原延迟执行，空闲领取无需 UPDATE，清理每天一次；现有多账号和登录回归全部通过。新故障在范围内修复，已有无关失败只记录。

风险是通知丢失造成延迟或等待边界遗漏信号；通过版本计数、持久化任务先于通知、30 分钟兜底和定时补查控制。部署先 runner 后 Worker；回滚恢复旧源码/Cron，无数据库迁移。

6. **发布和线上验收。** 用户已授权推送、发布新版和部署。版本更新至 `0.2.1`，CI 通过后保留旧镜像和 D1 备份，更新 runner，再发布 Worker。读回线上 Cron 和空队列等待提示，观察真实通知是否立即触发领取、空闲时是否停止 10 秒轮询，并检查网站和运行状态。
