# 每日任务与历史记录实施计划

依据：`docs/superpowers/specs/2026-10-27-daily-history-ui.md`（已批准）。使用当前 checkout，保留并行活动功能、登录和设备令牌相关改动。

1. 核心结果与测试
   - 文件：`src/types.ts`、`src/tasks.ts`、`test/tasks.test.ts`。
   - 添加执行/跳过采集、可选盒电余额与差值。验证全部跳过、部分执行、签到执行、失败前部分执行、缺失/无效盒电及真实前后余额差。
   - 先补充有意义的失败用例，再实现。`node node_modules/typescript/bin/tsc -p tsconfig.json` 写入忽略的 dist；`node --test test/tasks.test.ts` 使用模拟接口、不访问真实账号。
2. Runner、合同与持久化
   - 文件：`packages/contracts/src/index.ts`、`apps/runner/src/worker.ts`、`apps/web/src/server/store.ts`、相关测试。
   - 向后兼容的可选字段贯通；重试保留已执行标记、正确累计盒电并保持未知信息。旧任务仍可读取。
   - 验证新旧结果解析、失败/重试边界、账号隔离；运行 runner/web 单元测试和类型检查。
3. 历史 API 与界面
   - 文件：`apps/web/src/server/rpc.ts`、`apps/web/src/routes/history.tsx`、`apps/web/src/routes/tasks.tsx`、`apps/web/src/components/layout.tsx`、`apps/web/src/components/account-menu.tsx`、`apps/web/src/server/page-access.ts`。
   - 添加独立历史读取接口、登录访问控制、桌面及移动入口；记录包含任务类型、今天、倒序且最多 15 条。
   - 复用奖励汇总及状态展示 helper；任务页仅查询今日数据，移除内嵌历史和计数，缩小图标，保留现有错误/重试/过期处理与 Activities。
   - 文件：`apps/web/src/components/rewards.tsx`、`apps/web/src/lib/task-status.ts`、`apps/web/public/rewards/*.png`、`NOTICE.md`。
4. 验证与本地交付
   - 相关测试、各包 typecheck；网站 build 生成 dist 与路由树。检查构建不携带 `.dev.vars` 本地秘密；不部署。
   - 使用现有本地模拟账号更新今天结果（含跳过、盒电），补充少量旧记录验证未知字段。
   - 浏览器核实任务/历史导航、跳过状态、三项小图标、空状态、未登录访问及窄屏布局；保留本地预览和截图。
   - `git diff --check`；不执行 commit / push / 远端写入。

回滚：仅撤销本计划涉及的变更块及新文件；保留先前「历史包含今天」需求与用户并行工作。无数据库迁移或远端状态需要回退。

## 验证结果

- 核心、Runner、Web 单元测试分别通过 101、44、62 项；本地集成测试通过，覆盖历史接口登录保护、账号隔离及收益/跳过字段持久化。
- 核心构建与测试类型检查、Runner/Web 类型检查、Web lint、相关文件格式检查及 Web build 通过；构建产物未包含本地 `.dev.vars` 秘密。
- 使用模拟账号核实桌面任务页、历史页、今天记录、跳过状态、旧记录未知盒电及手机菜单导航。390px 下任务页正常换行，历史表格独立横向滚动；修复隐藏奖励文字造成的页面溢出后，页面宽度与视口均为 390px。
- 本地预览：`http://localhost:3001/tasks` 和 `/history`。独立主机名避免其他 `127.0.0.1` 预览共用登录 Cookie；数据为本地模拟记录。
- `git diff --check` 通过。未 commit、push 或部署。
