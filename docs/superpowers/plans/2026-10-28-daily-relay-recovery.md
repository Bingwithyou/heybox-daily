# 每日任务转发实施计划

依据 `docs/superpowers/specs/2026-10-28-daily-relay-recovery.md`，在当前工作目录实施，保留已上线 D1 优化的未提交改动。

1. **转发接口与边界**
   - 修改 `apps/login-relay/src/worker.ts`，以 origin/path/method 允许每日任务所需接口；复用原有鉴权、请求体上限、头白名单和禁重定向行为。
   - 在 `apps/login-relay/test/worker.test.ts` 先验证新增路径被旧逻辑拒绝，再覆盖正确主机/方法、错误主机/方法、签名和上报表单保真、429/403 无重试。
   - 更新 `apps/login-relay/test/runtime.mjs`，使用真实 workerd 和模拟上游验证每日上报转发；不访问真实账号。
2. **Runner 接入**
   - 修改 `apps/runner/src/login-relay.ts`、`main.ts`、`worker.ts`、`process.ts`，实现每日传输开关、启动校验和脱敏 transport 日志。
   - 在 `apps/runner/test/login-relay.test.ts` 与 `process.test.ts` 覆盖开关、缺配置、每日任务通过 Worker 的真实 handler、失败不回退和暂停校验。
   - 更新 `apps/runner/.env.example`、`docs/login-relay.md` 说明配置及回滚。
3. **验证与发布**
   - 运行 `pnpm --filter @heybox/login-relay typecheck/test/test:runtime`、`pnpm --filter @heybox/runner typecheck/test` 和 `git diff --check`。类型检查只读；runtime 测试启动本地服务并产生临时缓存；镜像构建生成本地/远端构建产物。
   - 先发布现有转发 Worker，再构建 Runner 镜像，备份生产环境与 Compose，设置 `DAILY_TRANSPORT=worker`、`TASK_CONCURRENCY=1` 后更新容器。保留旧版本与镜像。
4. **真实补跑**
   - 重新查询当天仍启用、凭据有效、状态 failed 的账号；条件更新单个任务入队，沿用原结果和租约规则。
   - 唤醒既有队列，核验成功回写和四项真实完成状态后按小批次继续。每批检查失败分类及进展；403/429/明确限流停止后续入队。
   - 汇总完成、过期、失败、暂停和剩余状态；不把未核验任务写成完成。必要时跨日停止并重新评估当日范围。

2026-10-28 追加批准：连续验证 5 个账号成功后，用户批准将并发从 1 提高到 3。补跑每批最多 3 个，整批结果核实后再继续；出现失败则停止后续批次排查。

2026-10-28 再次批准：核对 CF 与 VPS 指标后，用户批准并发提高到 6，连续 5 批正常后自动提高到现有上限 8；保留整批核验和失败停止后续补跑。
