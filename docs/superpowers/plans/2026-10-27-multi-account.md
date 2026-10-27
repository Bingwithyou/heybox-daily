# 多账号与接入数量实施计划

依据已批准的 specs/2026-10-27-multi-account.md，在当前会话执行。

1. 数据与会话行为
   - 修改 apps/web/src/server/store.ts，新增计数并验证暂停取消未完成任务、租约失效及保留历史。
   - 新增 server/accounts.ts，复用 Better Auth multi-session 的签名 Cookie 保存机制，为页面提供脱敏账号列表、切换、退出和删除端点；过期 Cookie 清理，最多 5 个独立账号。
   - 修改 server/auth.ts、server/api.ts，接入会话端点白名单，重新登录目标绑定挑战；错误账号和超限在 enroll 前拒绝。
   - 修改 server/rpc.ts，写操作必须携带 expectedAccount 并与服务端会话核对。现有集成测试同步合同。
2. 页面交互
   - 修改 lib/client.ts、components/layout.tsx、routes/index.tsx、routes/login.tsx，支持共享账号状态、菜单切换/添加、退出确认、重新登录目标、旧响应丢弃及多标签页变化处理。
   - 修改 src/worker.ts，仅对成功的公开计数 GET 响应保留 5 分钟缓存，其余接口维持 no-store。全站页脚读取公开计数端点；获取失败不显示虚构数字。PC 顶部 GitHub 图标、手机页脚链接。
   - 更新 docs/usage.md、docs/hosting.md 中与退出行为有关的说明，保留既有改动。
3. 回归与验证
   - 优先新增 store.test.ts 和本地 integration 测试，再实现行为。验证计数去重/暂停/失效/删除，多会话切换/退出/删除、越权和旧页面操作，重新登录账号不符和上限。
   - pnpm --filter @heybox/web test、typecheck、lint、format:check；pnpm --filter @heybox/web build 会产生 dist；test:integration 使用隔离临时 D1 和模拟 runner，无真实短信。
   - 本地浏览器查看登录页、任务菜单、退出框，PC 和手机布局。验证完成后关闭本次临时服务器。

不 commit、push 或部署。若存在基线问题，先判定来源，不扩展修复范围。无持久表结构变化，回滚本次文件补丁即可；用户已有修改保留。

## 完成记录

- 本地实现完成，使用 Better Auth 的签名 Cookie 与 session adapter 保存多个独立会话；账号列表不向前端返回会话 token。没有新增依赖或数据库迁移。
- 38 项 web 单元测试通过；隔离 D1 + 模拟 runner 集成测试通过，包括旧会话兼容、五账号上限、同账号去重、签名伪造拒绝、重新登录账号不符、退出暂停与删除隔离、旧页面写操作拦截及计数口径。
- typecheck、lint、format:check、build、git diff --check 通过。构建保留工具链的 CSS sourcemap 警告，不影响构建完成。
- 使用本地模拟账号验证登录、添加、切换、退出确认与退出后仍可使用另一账号；390px 手机视口和 PC 视口均检查。重新登录显示绑定盒友 ID，登录前后页脚均展示数量；账号变更时立即刷新数量，常规每 5 分钟刷新。
- 验证使用本机 Node 24.22.1 与 Vite+ 配套 pnpm 12.15.0；未发送真实短信、未提交、未推送、未部署。临时 UI 服务器在验证后关闭。
