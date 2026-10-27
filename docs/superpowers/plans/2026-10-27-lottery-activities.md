# 抽奖活动实施计划

对应 spec：`docs/superpowers/specs/2026-10-27-lottery-activities.md`。

## 1. 验证上游行为

- 在忽略的 `.research/automation-validation-20261027/` 保存一次性验证脚本和结果。
- 实时读取 9317 的前置条件与一加账号关注状态，仅在未关注时执行已授权关注；先确认任务完成再调用参与接口；然后按已验证的当前 App 分享事件完成分享并回查券数。
- 对写操作逐项记录尝试标记，不自动重复未知结果。禁止触碰其他活动的关注或参与。
- 验收：关注状态、joined、share_act.finished 和实际券数有可核对结果；失败则查明本次链路原因。

## 2. 核心活动模块与测试

- 新增 `src/activities.ts`、`test/activities.test.ts`。复用 `HeyboxClient`、现有上报加密和本地签名。
- 实现活动发现、当前账号资格归一化、只关注必要账号、参与、补分享、状态回查。未知条件阻止操作；已完成动作不重发。
- 先写覆盖意义明确的行为测试并观察失败，再实现：未拥有游戏不能操作；真实前置任务决定资格；重复步骤跳过；关注失败不报名；报名失败不分享；分享成功响应但任务未完成不能报成功。
- 验证命令 `pnpm test`（编译写入忽略的 dist，测试使用本地 fixture，不访问真实账号）。

## 3. 网站与 Runner 接入

- 修改 `packages/contracts/src/index.ts` 定义精简活动视图、列表/参与请求与结果。
- 新增 Runner 活动服务；调整 `apps/runner/src/server.ts`、`main.ts` 和必要执行入口，使用加密凭据、账号串行和有界执行。补充 `apps/runner/test/activities.test.ts`。
- 新增 `apps/web/src/server/activities.ts`，在 `store.ts` 提供仅服务端读取当前有效凭据的方法，`rpc.ts` 增加当前账号的列表/参与操作。复用服务认证及 expectedAccount，检查输出合同。
- 网站 `apps/web/src/routes/tasks.tsx` 内接入独立活动列表组件，必要时使用折叠区域按需读取；已拥有游戏可参与、未拥有禁用并说明、关注前置明确按钮语义，已参与显示券数和分享状态。账号切换时不沿用其他账号状态。
- 补充服务端和 Runner 测试，覆盖身份隔离、并发/重复点击、输入校验和无隐私泄漏。必要的服务异常只影响活动区域。

## 4. 验收

- `pnpm --filter @heybox/runner typecheck`、`pnpm --filter @heybox/runner test`。
- `pnpm --filter @heybox/web typecheck`、`pnpm --filter @heybox/web test`、项目相关 lint/格式检查。
- `pnpm --filter @heybox/web build`（生成本地构建产物，无部署）。使用本地 mock 数据浏览验证正常、受限、关注、已完成与失败交互，确认窄屏布局和重复点击行为。
- 最后检查 diff，保留已有的登录页面、device-token、diagnostics 和相关测试修改，不处理其无关问题。

## 回滚

移除本次活动入口、RPC/Runner 分支及新模块即可恢复原每日任务功能；不修改原定时任务和任务数据库合同。已发出的小黑盒关注或参与不可通过本地回滚撤销。本次无远端发布；不自动取消已授权关注。

## 执行结果（2026-10-27）

- 一加活动真实验证通过：Web 关注接口成功，回查已关注、已参与，完成分享后共 700 张抽奖券。服务端在前置条件满足后已经登记参与，因此没有重复发送 join 请求。原生关注请求被拒绝，未据此判断成功；最终采用已验证的 Web 调用。
- 正式模块只读复验：9317 为 700 张，9351 为 1200 张；9305 因未满足游戏条件被阻止。再次执行已完成的 9317，写请求次数为 0。
- 197 项单元测试通过；根模块、测试、Runner、Web 类型检查通过；Web lint、改动文件格式检查和构建通过。完整本地 D1 / Better Auth / oRPC / Runner 集成检查通过。
- 本地模拟账号的桌面与窄屏浏览验证通过：关注操作有处理中状态，未拥有游戏的按钮禁用，完成后券数更新。窄屏内容宽度与视口均为 375 px，无横向溢出，浏览器无 error 日志。测试服务与临时浏览器已关闭。
- 本机 pnpm 12 启动器出现 ENOEXEC，使用 Node.js 24 直接运行相同的 TypeScript、测试和 Vite+ 命令验证，未修改机器配置或依赖。
- 保留已有无关改动；没有 commit、push 或部署。
