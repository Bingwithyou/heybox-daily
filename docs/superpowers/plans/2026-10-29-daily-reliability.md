# 实施计划

对应已批准设计：`docs/superpowers/specs/2026-10-29-daily-reliability.md`。

1. 补回归：`test/client.test.ts`、`apps/executor/test/`、`apps/web/test/store.test.ts` 及新增可靠性测试，验证结构化错误、脱敏、5/20 与 15/30 分钟退避、Retry-After、三次上限、结果证据与尝试历史。先验证失败再实现。
2. 核心和契约：`src/client.ts`、`src/tasks.ts`、`packages/contracts/src/index.ts`、执行器 daily tracing helper 和 `apps/executor/src/operations.ts`。保持登录与活动的既有错误兼容性。
3. 数据库与状态：新增 `apps/web/migrations/0005_daily_attempts.sql`（实现前核对编号），同步 Drizzle schema；`packages/hosting/src/store.ts` 记录每次领取/完成/租约失效，原子核验版本、日期、状态，分类计算 available_at。只增加结构，不重置历史任务。
4. 时间与 UI：修改 Web Wrangler Cron 为每小时第 30 分钟，Store 的每日门槛和 contracts nextRunAt 为 00:30，清理时刻、测试、帮助/关于/hosting 文档同步。任务页面仅在等待重试时显示原因和时间。
5. 验证：核心 build/typecheck/tests，runner 与 executor typecheck/tests/runtime，Web test/build/typecheck/lint/本次文件 format check/integration。构建会写本地产物，集成验证使用隔离本地 D1 与模拟上游，不用真实账号压测。记录原有全量格式与 Windows 清理基线问题，不修改无关文件。
6. 部署：先读正式版本/配置与线上源码差异，保留线上已有修复；备份部署元数据与 schema。应用新增迁移，部署 executor 和 Web，核对 Cron、Queue 上限、鉴权入口和公开说明，验证生产只读结果。Cron 传播可能需最多 15 分钟，用应用层 00:30 门槛阻止旧 00:01 触发提前建任务。

风险：延长退避会增加有故障账号的完成时间；单次成功不证明未来零故障。回滚代码保留新增尝试表与历史记录，不回滚用户数据；确认旧配置不会重新提前启动，必要时保持 00:30 的兼容版本。外部迁移和生产部署已获授权；未授权 commit/push/worktree，不执行。

## 实施与发布验收（2026-10-29 06:10，北京时间）

- 已按批准设计修改每日主流程：00:30 门槛、最多 3 次执行、分类退避和随机延迟、跨日停止、四项实态确认、逐次尝试记录及异常时的预计重试时间。数据库领取/记录和结果/记录使用事务，重复投递不计次，暂停后不再登记后续重试。
- 新迁移 `0005_daily_attempts.sql` 已应用正式 D1，新增尝试表及查询索引；`jobs_lease` 避免按租约查询回退为全表读取。租约丢失记录为结果未知，保存实际耗时并按超时退避。未重置或重跑历史任务。
- 发布前发现正式执行器比当前 Git HEAD 多出原生请求头对齐、请求定时器清理、失败响应 body 释放和签到诊断。本次将这些已上线行为同步回本地源文件及对应测试并保留，包含 `src/sign-diagnostics.ts`，没有将其他会话尚未上线的密码登录功能带入发布。
- 最终 Web 版本：`b49077ce-24f9-41b2-9977-fe3423ebff97`，执行器版本：`00fac4a4-8e33-4172-998e-3170a1ecc7ea`，均为 100%。本轮开始前分别为 `91507ad8-49cb-4cee-b6dc-2f5e027e7e47`、`671bee4d-1398-4bba-a09f-d4cde3891f43`。
- Cloudflare API 确认 Web Cron 为 `30 * * * *`，执行器扫描仍为每分钟；每日任务由北京时间 00:30 门槛控制。Queue 实际配置仍为 `max_concurrency=8`、`batch_size=1`，消息运输重试次数与最多 3 次业务执行相互独立。
- 发布包回读核对：Web 的 45 个代码模块与 43 个 sourcemap（忽略部署系统规范化的 source 路径）一致；执行器 32 个项目来源文件一致。帮助页和关于页均返回 200 且显示 00:30；匿名会话查询 200，未授权唤醒入口 401。Python 默认请求头被边缘拒绝，浏览器请求头访问正常，未改动站点访问规则。
- 第一版上线后的执行器定时扫描真实返回 `ok`、异常数 0。发布后自然触发的 1 个真实账号任务已结束，尝试记录落库，四个不同项目全部为 `finish`；截至 06:10 没有在途任务。未人为发起真实账号压测或重跑；上述完成状态不代表奖励必然入账。
- 下一次每日批次为 **2026-10-30 00:30（北京时间）**，尚未发生；不能将当前核验写成已验证明日整批完成率。

### 验证结果

- Web 全量 **108/108**；执行器全量 **37/37**；Runner 全量 **70/70**。相关末轮 Store/重试/暂停/事务回归 **52/52**，错误分类、脱敏、请求兼容性回归通过。
- 核心库全量 **116/117**；唯一剩余失败为未修改的 `test/login.test.ts:98` 在 Windows 上要求 POSIX `0600`，实际 mode 为 `0666`。未改变登录文件存储代码或扩大修复范围。
- 核心 build/typecheck、Web 与执行器及 Runner typecheck、Web build/lint、12 个本次涉及的 Web 文件 format check 和 `git diff --check` 通过。
- 最终真实 `workerd` 回归通过：隔离 D1、DO、队列、四项状态确认、重复消息、登录/活动兼容；72 次模拟上游请求，真实上游请求 0。
- Web 集成的全部业务检查通过，但退出清理临时目录时仍报已有 Windows `EBUSY`，命令整体非零退出。原有全量格式问题未纳入修改；构建的既有 CSS sourcemap 警告未阻止产物生成。
- 生产核验和部署前源包存于本机临时目录 `heybox-daily-reliability-20261029`，最终核验为 `final-verification.json`。Git 未 commit、push、创建 worktree 或 PR。

回滚保留新增表、索引和尝试数据；不可恢复旧 D1 快照覆盖新用户状态。若回退本轮前的 Web 版本，需同时保留 00:30 的门槛和 Cron，避免重新启用 00:01。正式版本的旧签到诊断和原生请求行为必须继续保留。
