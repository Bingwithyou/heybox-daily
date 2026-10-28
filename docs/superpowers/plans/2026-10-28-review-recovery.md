# 审查问题修复实施计划

依据 `../specs/2026-10-28-review-recovery.md`，在当前 checkout 执行，不创建 worktree、不提交或发布。

1. **共享实现归属**：新增 `packages/hosting`，迁移 Store、security 通用 helper、crypto、checkpoint 和 LoginStep；修改三个应用及其测试的 imports、workspace manifests、lockfile、Dockerfile。保持业务行为不变，通过现有类型检查和单元测试。
2. **队列暂停与未知结果**：修改共享 Store、Executor `queue.ts`、contracts、Web Rewards/task-status。先增加暂停交回失败、恢复重新投递、陈旧消息隔离、丢失结果后重试零收益的回归测试，再实现。验收：不执行的任务不因暂停失败；未知收益不会显示为零或全部跳过。
3. **实际短信发送限流**：新增兼容 D1 迁移及占用方法，修改 Executor 登录操作、LoginFailure 和 Web 错误透传。验证跨挑战/并发手机号、CAPTCHA 释放、成功冷却、未知失败、过期所有权和验证请求不扣次数。
4. **登录完成恢复**：修改挑战状态、DO 路由、Web auth/login 和幂等存储。新增加密成功结果、过期/绑定拒绝、D1 失败重试、稳定会话、确认清理、旧结果不能覆盖新凭据的测试。验证依然不重放上游验证或短信。
5. **活动读取隔离**：在 `d8ff4cc` 取消链路之上新增按账号协调的短缓存与合并读取；独立读容量、参与互斥、版本隔离及失效。测试命中、TTL、并发合并、取消独立、参与失败/成功失效和过期读取不得污染缓存。
6. **文档与验收**：维护 `docs/hosting.md` 的停机、恢复、迁移和新行为说明，检查实际 diff；记录所有通过/失败结果及限制。

## 验证命令与副作用

使用现有 Node 24、pnpm 12.15。`pnpm test` 会生成本地 `dist`；Web build 生成本地构建产物。依赖安装仅更新本地 workspace 链接和 lockfile，不添加第三方依赖。格式化仅处理本次修改的 Web 文件。

依次运行核心、Runner、Executor、Web 单元测试及类型检查，Executor `test:runtime`，Web build/lint/format:check/test:integration。集成测试使用临时 D1、Miniflare 和模拟上游，不发送真实短信或参与真实活动。共享包变更还需验证 Docker 目标可以包含所有依赖；如本机 Docker 不可用，记录该限制，不声称容器已验证。

所有检查围绕上述验收条件；无关 baseline 失败单独记录。原生 queue pause/resume 命令只写入文档，不执行。回滚遵循 spec，保留新增表，不进行破坏性清理。

## 本地验收结果

六项实现已完成，基线为 `d8ff4cc`。保留了实施前已有的停机文档修改。

- 核心测试 106 项通过；Runner、Executor、Web 全量单元测试 200 项通过。此后补充死信恢复和短信冷却透传两个边界，并分别通过存储/调度/队列 50 项、登录/冷却/安全 21 项相关回归。
- Web、Executor、Runner、Login Relay 类型检查通过；Login Relay 5 项单元测试通过。
- Web build、lint、format:check、test:integration 通过；Executor 与 Login Relay 的 workerd 集成验证通过。使用模拟上游，没有发送真实短信或参与真实活动。
- `git diff --check` 通过。Dockerfile 已包含共享包的 manifest 和源码；本机无可用 Docker，未执行镜像构建。
- pnpm 的本机入口无法直接启动，改用现有 pnpm 12.15 的 JavaScript 入口完成依赖安装和检查；没有升级依赖。离线安装因本机缺少元数据失败，随后常规安装成功。

本次没有 commit、push、生产迁移或部署。发布前仍须按 hosting 文档执行兼容迁移和部署顺序；Docker 构建属于尚未在本机验证的环节。

## 发布追加授权

用户在本地验收后明确要求 push、部署和线上验证。发布顺序：核对远端与现有版本，提交并推送本批修改，备份 D1，应用 `0004_login_recovery.sql`，部署 Executor，再构建部署 Web，最后检查线上页面、内部健康接口、只读任务状态及错误日志。

部署前发现确认登录接口未加入 API 路由白名单。将登录恢复回归改为经过实际 API 路由后，先复现 404，再补入白名单；原有恢复、会话幂等和确认清理断言继续覆盖完整链路。

容器发布检查同时补齐 `.dockerignore` 的共享包白名单，避免 Dockerfile 需要的文件被构建上下文排除；使用 VPS 上的 Docker 验证实际镜像构建。
