# 登录准备优化实施计划

依据：`docs/superpowers/specs/2026-10-28-login-preparation.md`。在当前工作目录实现，不创建 worktree。用户已授权验证通过后部署并 push。

## 1. 一次性进程预热

- 文件：`src/device-token.ts`、`apps/runner/src/token-child.ts`、`apps/runner/src/token-main.ts`、新增 `apps/runner/src/token-pool.ts`。
- 提取延迟初始化入口，预热只创建依赖/生成器。实现一个空闲进程及最多 4 个总进程的生命周期管理，保留环境隔离、30 秒生成上限、输出格式校验；预热失败延迟补充，完成或取消后清理进程。
- 先补行为测试：预热不触网、不生成指纹；全新 DOM；单次使用；并发上限；取消/超时/崩溃/关闭；禁用预热。
- 验证：根目录 build/typecheck 和 device-token 测试；runner typecheck、完整测试。测试使用注入 SDK 或子进程 fixture，不访问真实小黑盒。

## 2. Worker/DO 并行准备

- 文件：`apps/executor/src/worker.ts`、`operations.ts`、`objects.ts`、`challenge.ts`、`env.ts`、新增登录编排 helper；`packages/contracts/src/login-timing.ts`。
- 提取令牌请求，执行 Worker 并行请求 DO 初始化与令牌；准备完成后只调用一次 begin。内部传递令牌，公共入口解析仍丢弃外部令牌字段。DO 保持持久化和验证码处理逻辑。
- 测试：并行启动、初始化失败取消令牌、令牌失败、取消/总超时、begin 失败不重放、内部令牌校验；沿用 DO 持久化、验证码、验证码重试、人机验证及过期测试。
- 验证：contracts、executor、runner、web 的相关类型检查；executor 完整单测及 `test:runtime`，增加 workerd 的 prepare 无存储/无上游、prepare 后重建、成功链路计时断言。

## 3. 部署和运行验证

- 更新 `compose.token.yaml`、executor Wrangler 变量与 `docs/hosting.md` 的开关和运维说明。
- build/typecheck 会生成忽略目录 dist；runtime 测试创建并清理临时本地 D1/DO，所有上游模拟；部署与真实令牌测试访问外部服务。
- 先运行针对性测试；再完成受影响包的必要检查以及 Linux 容器验证，记录已有 Windows 文件权限/清理和全量格式基线问题，不修改无关文件。
- 备份当前生产容器配置及 Worker 部署 ID；构建新 token 镜像，Linux 离线测试通过后仅替换 token 服务；发布 executor，并重新发布网站以接收公共 contracts 新增的计时字段（网站业务逻辑不变）。保留旧镜像和回滚路径。
- 验证真实令牌生成、预热状态、峰值进程上限和健康、生产版本/关闭公共入口、网站冒烟。没有账号持有人实时参与时，不声称已完成真实短信登录。

## 4. Git 交付

- 核查 diff、显式暂存本次文件、检查暂存内容、提交并推送当前授权分支到所有配置的 remote；当前仅 `origin`。
- 核对远端 SHA 和 CI；失败先区分既有基线与本次引入，修复本次问题。

## 风险与回滚

预热失控可能占满 VPS 内存，故总进程上限覆盖空闲/初始化/执行/退出阶段；补充进程有退避。请求取消不能撤回已发出的短信，因此发送前检查取消并坚持不自动重试。DO 在 prepare 与 begin 间仍可能被回收，begin 必须能够重新加载；初始化只是延迟优化，不承担状态正确性。异常时分别关闭开关或回滚前一镜像/Worker，不回滚数据库或用户数据。
