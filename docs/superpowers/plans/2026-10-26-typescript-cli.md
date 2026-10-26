# 实施计划

依据：`../specs/2026-10-26-typescript-cli.md`。仅执行用户已确认的 TypeScript + pnpm 迁移，不添加网页。

1. **建立构建配置**
   - 修改 `package.json`，新增 `tsconfig.json`、`pnpm-lock.yaml`，移除 npm 锁文件；更新 `.gitignore`、`.dockerignore`。
   - 固定 TypeScript、pnpm 和 Node.js 24 类型版本；严格类型检查，ESM 输出到 `dist/`。
   - `pnpm install` 会下载依赖并生成锁文件；不修改全局 Node.js 或包管理器配置。
2. **迁移业务代码**
   - 将 `src/` 下的签名、上报、配置、原生桥接、请求、任务和 CLI 文件迁移为 TypeScript，补齐配置、响应、任务及注入依赖的类型。
   - 保留现有行为和外部数据合同；`test/*.test.js` 只改为导入编译后的模块，继续验证实际运行代码。
   - 执行 `pnpm typecheck`、`pnpm build`、`pnpm test`，要求原有 15 项测试全部通过。
3. **同步 Docker、CI 和文档**
   - Docker 增加业务代码构建阶段，最终镜像执行 `dist/cli.js`，不携带开发依赖或私有文件。
   - CI 使用固定 pnpm 版本、冻结锁文件安装、类型检查与回归测试；更新 `NOTICE.md` 和使用说明中的路径、命令。
   - 构建命令会生成本地镜像并联网下载构建依赖。用已有 Colima Linux 环境验证 `check` 与当天已完成任务的 `run`，不部署 VPS。
4. **交付检查**
   - 检查 diff、私有文件忽略规则、文档链接及命令一致性；保留用户此前的 README 与赞助调整。
   - 报告本地验证及未执行的提交、推送、部署。登录替代方案及 APK 依赖结论与实现状态分开说明。

主要风险是编译输出路径导致 CLI、测试或 Docker 入口失效，以及类型补充误改接口数据。通过编译后测试和 Linux 真实只读检查验证；若失败先修复本次引入的问题。回滚按 spec 限定范围逐文件恢复，不重置其他改动。

## 验收记录

2026-10-26 已完成上述迁移。TypeScript 7.0.2、pnpm 12.15.0、Node.js 24.22.1 下严格类型检查和 15 项测试通过；Linux ARM64 镜像完成冻结锁文件安装、编译、构建及同样的 15 项测试。真实账号 `check` 成功，`run` 跳过当天已完成的签到和三项分享任务，奖励增量为零。文档链接、diff 格式和私有目录忽略规则已检查。未提交、推送或部署；新的 CI 配置尚未在 GitHub 运行。
