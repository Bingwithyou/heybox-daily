# 预发布环境实施计划

对应 spec：`docs/superpowers/specs/2026-10-27-staging-environment.md`。用户已批准实现、创建资源和预发布部署。

1. **模拟执行端**：新增 `apps/runner/src/preview.ts`、`preview-main.ts` 和对应测试，复用现有登录挑战、服务认证、加密、活动串行控制。仅允许演示账号；回调地址只允许预发布或本地；模拟任务执行覆盖完成、重复通知、失败响应，不调用真实上游。先以测试证明号码/回调隔离，再实现。
2. **环境配置和标识**：`apps/web/wrangler.jsonc` 增加 staging 环境并显式清空 Cron，独立 vars/D1/域名；`env.ts` 与 Worker 增加预发布不收录支持；新增环境标识 helper，登录页提示测试登录，页头标记预发布。修改 `Dockerfile` 增加模拟 Runner 入口，新增 `compose.staging.yaml`。现有正式行为保留。
3. **可重复发布**：新增 `scripts/deploy-staging.mjs`、文档和 package scripts；构建前隔离本地密钥，发布前断言目标 Worker/域名/D1/无 Cron/无明文密钥。实际创建独立 D1、Tunnel、DNS/Worker 域名、设置随机 Secret，在 VPS 独立目录部署模拟容器。远程密钥存入 private，禁止打印。
4. **验证与演示数据**：运行模拟 Runner 测试、相关网站测试、类型检查、构建与现有集成验证；上线后用模拟账号完成 HTTPS 登录、活动参与、每日任务与历史展示检查。向预发布 D1 写入明确测试历史。浏览器检查桌面与窄屏，保存截图和资源摘要。

验证命令使用本机 Node.js 24 直接运行 tsc、node --test、vp build、集成脚本，避开已知 pnpm 启动器 ENOEXEC。构建与集成测试写入本地产物；wrangler deploy、D1 远程 SQL、Tunnel/DNS API、VPS Compose 是本次已授权的外部写入。仅部署预发布。

## 回滚

停止独立 staging Compose 项目并停用 staging Worker 路由即可下线；保留独立 D1 便于重试。部署失败时记录已创建资源与下一步，不删除正式数据。源码回滚只移除上述新增环境和模拟入口，保留本轮与其他会话已有改动。删除云端资源另按用户授权执行。
