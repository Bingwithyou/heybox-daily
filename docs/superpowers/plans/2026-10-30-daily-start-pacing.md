# 实施计划

对应已批准设计：`docs/superpowers/specs/2026-10-30-daily-start-pacing.md`。

1. 在 `apps/web/test/daily-reliability.test.ts`、新增 `apps/web/test/start-pacing.test.ts`、`apps/executor/test/queue.test.ts` 增加随机范围、共享领取限制、重复消息、事务回滚、32 缓冲、延后消费的回归测试，先确认旧实现失败。
2. 新增 `apps/web/migrations/0006_daily_start_pacing.sql`，更新 `packages/hosting/src/retry.ts`、`packages/hosting/src/store.ts` 和 `apps/executor/src/queue.ts`。必要时调整既有测试中的模拟时钟，使测试继续验证其原业务语义。
3. 更新 `docs/hosting.md`。测试执行不访问真实上游；`node --test apps/web/test/*.test.ts apps/executor/test/*.test.ts`、两端 `tsc --noEmit`、Web lint/build、Executor `test/runtime.mjs`。构建产生 dist，formatter 仅对本次触及文件使用；失败先区分既有 baseline。
4. 部署前读取当前版本/内容与配置，保存待重试任务快照。通过现有 Cloudflare 连接应用新增 D1 迁移，部署 Executor 与 Web，不创建新远程资源。若 Wrangler 登录仍缺失，沿用已验证的连接 API 发布路径，校验本地产物与线上内容。
5. 执行一次 CAS 条件打散，保护任务状态、已用次数和历史；保存更新数、跳过数、最早/最晚时间和分布。回读线上版本、源码、队列/Cron及真实执行日志。不要为验证而人为新增真实账号操作。

发布包含用户明确授权的生产代码更新、D1 结构迁移及待重试任务时间调整；不提交或推送 Git。回滚原则见 spec。

## 执行状态

- 实现、D1 迁移及两个 Worker 的生产部署已完成。
- `node --test apps/web/test/*.test.ts apps/executor/test/*.test.ts`：155/155 通过。Web、Executor 的 `tsc --noEmit` 通过；Web build 通过；lint 无错误，有 6 条未修改代码的既有警告。构建保留已有 CSS source map 警告。
- Executor `node test/runtime.mjs` 通过，使用真实 workerd、D1、DO 和 Queue，本次验证没有请求真实上游。补充回归覆盖共享启动门槛、事务回滚、32 个缓冲、过早及重复投递、退避范围、跨日停止；同步修复了启动门槛延迟旧日任务清理的边界。
- 北京时间 04:57 部署：Executor `0e819967-4eb7-4f62-b1dd-acbff9882013`，Web `80d6ceac-03d8-4d40-a4bb-c60b467bba34`，均为 100%。部署后重新下载源码，主模块 SHA-256 分别为 `21fcd98bd456db1b51bb6e588ba73a7615eddddf4aebe7f9b5e91cb2758fc324`、`3e2f3aa4b51ff989bc5c096f2e3e105daf42269b7610aa5dd7f0a5a07f2e6282`。Web 保留现有静态资源及模块名；新构建的两个等价动态 import 引用映射回现有 chunk 名，其余 JS 差异仅为 hosting 逻辑。绑定、密钥、8 并发和两个 Cron 保持原配置。
- `0006_daily_start_pacing.sql` 已应用并登记。部署后连续 4 次分钟级调度日志均为 `ok`；首页、登录、关于页及抽查静态资源均返回正常内容。
- 05:20 补齐 `apps/web/src/server/schema.ts` 的 `dispatch_at`、`daily_scheduler` 模型和单行约束，并修正部署工具传输 source map 时的中文编码问题。Executor 主 JS 内容不变；Web 类型检查、117 项测试、build 和本文件 lint 通过。最终版本：Executor `cffa2016-a8f3-4660-a5ac-bad775ff175e`，Web `eadb7990-86fa-4f80-ac4d-a3b1c0a702c3`，均为 100%。Web 主 JS SHA-256 为 `8cbee39edb9192cff023812c38935d259213508c1202226338aafabafe0ebb97`；两端线上主 JS、source map mappings 和 sourcesContent 均与本地预期重新核对一致，页面健康检查通过。
- 04:59 对快照内的 701 个待重试任务执行一次 CAS 打散，均保留 attempts=4，结果和失败时间不变，未提前执行。原 702 个任务中有 1 个在快照前已完成，未纳入更新。计划时间分布为 05:10:49–07:11:43。任务历史前后 SHA-256 均为 `80a858499a5158f90c9fd7043dffce8a331a4243fa8661b4f8c7ea7dcca97da2`。本地 1,000 条更新及 6 个状态变化边界通过验证，重复执行同一快照不会再次随机改期。
- 回滚参考：部署前 Executor `57f9680e-05c6-4892-bffc-845b5cc66807`，Web `782b79d1-4a0a-4f5a-a666-a7e746af93e4`。回滚仅还原代码，不删除新表/字段，不还原已发生的尝试和历史。

## 用户追加的人工提前执行

用户随后要求不再等到 07:00，先手动执行剩余任务。这覆盖此前“本轮不得提前”的操作约束，保留不清零次数、8 并发、4 秒启动间隔及 32 个投递缓冲。05:05 先提前 20 个仍符合快照条件的任务，唤醒 Executor；根据本轮真实结果继续处理并登记结论。

- 05:07 提前剩余 681 个任务，继续由已部署的 Executor 调度执行。末尾 3 个任务在队列投递和回收之间停留，补充唤醒后正常开始；未绕过启动速率或次数限制。
- 06:03 最终核对：快照内 701 个任务全部结束，696 个完成、5 个登录失效；无待执行或运行中的任务。696 个完成任务均有 `sign`、`1`、`19`、`31` 四项 `finish` 回执。
- 本轮新增 701 次尝试，所有任务均从 4 次增加到 5 次；其中尝试记录为 694 次完成、2 次失败、5 次登录失效。2 次校验异常随后经只读上游查询确认四项已完成，仅按 CAS 同步任务最终状态，保留失败尝试和错误历史，没有再次执行。
- 原 2,804 条尝试记录的 SHA-256 仍为 `80a858499a5158f90c9fd7043dffce8a331a4243fa8661b4f8c7ea7dcca97da2`，与操作前完全一致。
- 依据执行时间记录核对，全局最短启动间隔为 4,011 ms，峰值同时执行数为 7，符合 4 秒启动间隔及最多 8 并发的约束。5 个登录失效账号需要重新登录，本轮没有清零次数或追加第 6 次尝试。

## 后续并发调整

用户要求将最大并发降至 6。已更新 `apps/executor/wrangler.jsonc` 和 `docs/hosting.md`，并通过 Queues API 将 `heybox-daily-tasks` 的现有消费者 `max_concurrency` 从 8 改为 6，回读确认生效。其余消费者参数保持一致，4 秒启动间隔不变；本地配置解析及 `git diff --check` 通过。此参数调整没有重新发布业务代码。用户随后授权提交并推送本次全部改动。
