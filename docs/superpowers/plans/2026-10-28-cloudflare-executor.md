# Cloudflare 执行端迁移实施计划

对应已批准设计：`docs/superpowers/specs/2026-10-28-cloudflare-executor.md`。在当前 dirty worktree 执行，保留此前修复，不提交或推送。

1. **业务边界与 outbox（先测试）。** 在 `apps/web/test/store.test.ts` 验证按 ID/投递标识领取、重复投递、发送中断、延迟重试、凭据更换、租约过期及 DLQ 处理。新增 `apps/web/migrations/0003_cloudflare_queue.sql`，更新 `schema.ts`、`store.ts`。旧 `claim()` 保持可回滚使用，新增字段为兼容性扩展。通过 Node SQLite 测试验证原子状态变化与原有回归。
2. **Worker 核心业务。** 新增 `apps/executor/package.json`、`tsconfig.json`、`wrangler.jsonc` 和 `src/`。提取 `src/login-core.ts` 供 Node 与 Worker 共用；保留原 `src/login.ts` 导出兼容性。复用现有凭据加解密、签到分享和活动实现，增加有截止时间的传输与必要适配。新增队列消费、投递恢复、失败分类和受保护的健康/只读验证入口。
3. **临时状态与协调。** 新增 executor 的登录状态机、状态加密和 DO 适配；每挑战隔离，先持久化再调用上游，alarm 清理。活动全局限额和账号互斥使用短租约。Node 单元测试验证故障和重启；workerd 集成验证真实存储、alarm、请求交错及不同挑战超过 4 路的执行能力。
4. **设备令牌服务。** 在 `apps/runner/src/` 新增 token 服务入口、受限队列与独立 SDK 子进程；Docker 增加目标，新增对应 Compose 配置。用合成 SDK 验证认证、固定请求合同、4 并发、短队列上限、取消和超时，不触发真实短信。
5. **网站接入与兼容切换。** 更新 `env.ts`、`security.ts`、`notify.ts`、`api.ts`、`schedule.ts` 和 `wrangler.jsonc`，优先使用启用的内部绑定，未启用时保留旧 runner 路由。新登录挑战带内部路由识别 cookie，使切换期间旧挑战仍由旧服务完成；公开 API 不变。集成验证登录、活动、每日调度与原有页面/会话行为。
6. **项目检查。** 先检查命令副作用。根 `tsc` 构建会生成忽略的 `dist`，Vite 构建会生成 `apps/web/dist`；Node 单测、tsc noEmit、lint 和 format:check 不应写源文件。使用固定依赖执行根测试、runner 测试/类型检查、executor 单测/类型检查/workerd 集成、web 测试/构建/类型检查/lint/format:check/本地集成；修复本次问题，记录无关 baseline 失败。新增 app 安装仅更新必要 workspace lock 项。
7. **分阶段部署与验收。** 在授权的 Cloudflare 账号创建主队列/DLQ 和 DO namespace；备份并应用迁移，发布执行 Worker（先关闭每日消费），部署独立 SDK 服务，配置密钥和绑定。先验证线上连接与只读业务，再切网站登录/活动；让旧挑战自然排空，停止旧 runner 并等待在途任务结束，再启用 Queue 任务。核验队列/D1 状态、错误和 CPU；不重置已完成任务、不批量发送真实短信或参与活动。记录实际部署版本和回滚命令，更新 `docs/hosting.md`。

主要命令（以当前安装路径为准）：`node node_modules/typescript/bin/tsc -p tsconfig.json`，`node --test test/*.test.ts`，各 app 的 `tsc --noEmit`、`node --test test/*.test.ts`，`node apps/executor/test/runtime.mjs`，`node apps/web/test/run-integration.ts`，Vite+ build/lint/fmt --check。真实部署用 Wrangler/SSH，密钥只通过受限文件或 stdin 传递，不打印。

通过标准：原有凭据与会话无需整体重登，SDK 是唯一常驻 VPS 业务；每日任务重复投递不重复领取，未知结果先核验，初始并发 8；不同挑战可超过 4 路验证，同一挑战和同一账号活动不重入；异常有可观测原因且不泄密；正式流量按新架构运行且回滚材料完整。
