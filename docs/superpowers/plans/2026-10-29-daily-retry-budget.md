# 每日执行预算实施计划

关联 spec：`docs/superpowers/specs/2026-10-29-daily-retry-budget.md`。

1. `apps/web/test/daily-reliability.test.ts`、`store.test.ts`：先验证 12 次上限、退避各档、Retry-After、租约恢复、重复消息、登录与暂停恢复不清零、次日重新获得预算及跨日停止。
2. `packages/contracts/src/index.ts`、`packages/hosting/src/retry.ts`、`store.ts`：集中预算常量；同步领取、结束、恢复、重新排队约束；保留历史与并发控制。
3. `apps/web/src/lib/dashboard-loader.ts` 与任务页面：延后任务每分钟刷新；测试运行、未来、到期边界。
4. 运行 Web/Executor/Runner 相关现有测试、TypeScript 检查、Web lint/build、Executor workerd runtime；测试在本地隔离数据库与 mock upstream 运行，构建生成本地产物。已有 Windows 权限测试与 integration EBUSY 清理失败单独记录，不修无关问题。
5. 只读核对 CF 订阅、D1/Queue/Workers 用量和当前正式版本；核对官方配额，以正常、少量重试、全部持续失败估算，区分 SQL 调用与计费读写行数。
6. 按已授权部署 Executor 和 Web，核对正式版本、计划、并发、发布代码与站点健康，读取今日状态。只恢复仍有效且未耗尽预算的临时失败。

风险：持续上游故障会增加执行和历史记录；不保证外部服务一定当天成功。回滚可重新部署此前已记录的正式 Worker 版本；数据库结构不变，历史次数不清零，回滚后已超过 3 次的旧任务会停止。


## 执行结果

全部实施与正式部署已完成。新 Web 为 `ad3f2ac5-9eb1-47c9-b1a6-4530f6990cb5`，Executor 为 `8c20e8c7-3ed6-43b8-82b7-315243e719eb`，均 100%。代码、静态任务页产物、Cron、队列并发及当天完成状态已回读核对。没有符合恢复条件的有效账号失败任务，无需额外重新排队。

验证结果、D1 隔离测量、实际 CF analytics 与配额估算见 `docs/retry-capacity-2026-10-29.md`。现有 Windows integration 临时目录 EBUSY 清理失败保留，业务断言通过；未作无关修复。


## 后续上限调整

用户随后明确将上限改为每天 5 次（仍含首次）；未改变退避、跨日或累计计数规则。共享常量同步控制领取、结束、租约恢复、重新排队与页面提示。更新现有边界测试，先确认旧 12 次实现导致 5 项失败，再修改常量；完整 Web 111 项、Executor/Runner 107 项、类型检查和构建通过。

已发布 Web `0f11d25b-22e9-4dc8-84d5-b93e24af04a0`、Executor `6e375d01-c847-49cd-b3f8-e78ed181f858`，均 100%；正式代码及任务页静态资源与本地构建一致。每日调度、扫描频率与并发不变。没有正在排队或执行的旧高次数任务需要迁移。容量报告已按 5 次重算。
