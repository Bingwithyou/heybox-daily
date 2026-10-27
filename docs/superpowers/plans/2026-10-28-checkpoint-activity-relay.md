# 实施计划

关联 spec：`docs/superpowers/specs/2026-10-28-checkpoint-activity-relay.md`。设计、实现、验证、部署均已获用户批准；不提交或推送 Git。

1. 在 `apps/runner/test/checkpoint.test.ts` 和 `apps/web/test/store.test.ts` 增加行为测试：30 秒节流、强制结束、失败重试检查、本地跨日、暂停完成和失败不重试、重新登录与删除保护。先确认目标测试失败。
2. 增加 `apps/runner/src/checkpoint.ts`，接入 `apps/runner/src/worker.ts`；修改 `apps/web/src/server/store.ts` 暂停、心跳与结束 SQL，并更新受影响的既有测试。
3. 在 `apps/login-relay/src/worker.ts` 加入六个活动接口，在 `apps/runner/src/login-relay.ts`、`main.ts`、`worker.ts` 接入活动转发。扩展 relay 单测及 Runner 子进程模拟测试，验证错误方法拒绝、签名保持、不直连、不自动参与。
4. 更新 `.env.example`、`docs/login-relay.md`、`docs/hosting.md` 的配置和暂停说明。运行 Runner、relay、web 单测和 typecheck，web integration 及构建；这些命令可能生成本地产物，测试外部小黑盒请求均模拟。
5. 等待本次 526 个候选账号补跑完成并核验真实最终状态。部署 Worker 白名单、web 和 Runner（8 并发），先备份当前运行版本与配置，等待活动任务自然完成再重启。线上只读活动列表、检查服务健康和 CF 计量，不发送关注/参与请求。
6. 回滚：恢复部署前 web/relay 版本及 Runner 镜像和环境文件；不回滚任务历史或凭据数据。恢复后仍保留已验证每日 Worker 出口。

验证命令使用现有 pnpm 运行时：`pnpm --filter @heybox/runner test/typecheck`、`pnpm --filter @heybox/login-relay test/typecheck`（以 package scripts 为准）、`pnpm --filter @heybox/web test/typecheck/test:integration/build`。部署不包含数据库结构变化。

## 完成记录

- 127 项相关单测通过，三个应用 typecheck、网站构建、relay workerd 验证通过。网站集成全部功能断言通过，命令在 Windows 临时目录清理阶段因 `EBUSY` 退出 1；未修改无关清理代码，手动删除也被工具策略拒绝。
- 补跑 526 个候选最终核验：513 个完成且四项状态全部确认，13 个登录失效。查询当时全站启用且凭据有效的 613 个账号全部完成，当天完成记录中没有缺失四项核验的记录。
- Relay 版本 `c521be30-6a1a-4a52-b65b-f45d51b2242e`；网站版本 `d648a0ef-d064-479a-a1a0-c68bcf858033`。
- Runner 镜像 `heybox-hosted-runner:activity-relay-20261028`，正式构建须显式指定 `docker build --target runner`。首次构建误选最终 preview 阶段，已重建修正；生产入口确认 `node apps/runner/src/main.ts`，重启计数 0。并发 8，daily/activity 均为 worker。
- 正式服务 `/activities` 只读列表返回 200，读取到 4 个活动；未发送关注或参与请求。上线前直接通过 relay 的 14 个只读上游请求也全部返回 200。
