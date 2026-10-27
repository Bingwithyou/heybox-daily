# Workers 登录转发实施计划

对应已批准设计：`docs/superpowers/specs/2026-10-27-login-relay.md`。

1. **记录基线与补充行为测试**
   - 保留 `apps/web`、`docs/hosting.md` 已有改动，记录 Runner/核心测试基线。
   - 新增 `apps/login-relay/test/worker.test.ts`、`apps/runner/test/login-relay.test.ts`，扩展 `apps/runner/test/login-logging.test.ts`。
   - 先确认新测试因缺少实现失败；覆盖真实签名参数与票据保真、发码/校验 CAPTCHA 续流程、错误不重试、鉴权及 SSRF 边界、Workers 日志不误报 VPS IP。
2. **实现独立转发 Worker**
   - 新增 `apps/login-relay/{package.json,tsconfig.json,wrangler.jsonc,src/worker.ts}`，同步 `pnpm-lock.yaml`。
   - 严格鉴权及输入限制，固定上游 allowlist，手动拒绝重定向，保留状态和响应体。
3. **接入 Runner 登录**
   - 新增 `apps/runner/src/login-relay.ts`；修改 `login.ts`、`main.ts`、`login-logging.ts`、`.env.example`。
   - 注入现有 HeyboxClient；仅登录调用使用转发。环境配置配对校验、超时/取消与错误脱敏，不增加自动重试。
4. **验证及文档**
   - `pnpm test`（生成根 `dist`，全部为离线夹具）；Runner `typecheck` / `test`；relay `typecheck` / `test`。
   - 本地 Wrangler/workerd 启动产生本地缓存；验证未认证拒绝及 Worker 真实运行时支持，不调用真实短信。
   - 更新部署说明（新增 `docs/login-relay.md`，避免覆盖正在修改的 hosting 文档），记录安全配置、范围、故障和回退。
5. **部署与验收**
   - 发布独立 Worker，独立密钥只经 stdin/受限文件传递，不输出值；校验未授权访问被拒绝。
   - 将白名单内的源码/构建上下文上传至 VPS，构建候选镜像并先做隔离验证。
   - 读取生产当前镜像、队列/操作状态，保存旧镜像与环境备份，启用转发后替换 Runner，核对健康和脱敏日志。该步骤会重启 Runner；现有网页部署不变。
   - 尾号 2976 完成一次网站真实登录，确认会话和 Workers 路径。用户提供短信码/人工 CAPTCHA；不强制反复触发。
   - 清理临时含凭据文件，保留可回退的受限生产备份与已部署独立 Worker。

通过条件：相关离线检查通过，真实 Worker/Runner 联通，正式网站登录成功，日志路径正确，未发布其他页面改动。若候选镜像或正式登录失败，定位本次问题并修复；影响在线可用性时恢复旧 Runner 配置/镜像。无关基线失败只记录，不擅自修复。

## 已批准的验收补充

正式验收自然触发 CAPTCHA 并成功登录后，用户发现实际发码成功时按钮未重新禁用，已明确批准一并修复并发布。根因为首次请求的冷却在人工验证过程中到期，`complete-captcha` 返回 `sent/retryAfter: 60` 后页面没有重新应用冷却。

- 修改 `apps/web/src/lib/login-cooldown.ts` 与 `apps/web/src/routes/login.tsx`：统一处理 `sent` 响应中的冷却秒数，保留更长的已知限额；`retryAfter: 0` 的验证码校验失败不重启计时。
- 在 `apps/web/test/login-cooldown.test.ts` 覆盖普通发送、耗时超过原倒计时的人机验证续发、刷新持久化、长限额和不重发的校验失败。
- 通过网页测试、typecheck、build、lint/format，以及本地模拟浏览器的两条发码路径后，单独发布此次网站补丁。基于已上线的 Git 基线创建普通构建目录，仅覆盖本次修改，不创建 Git worktree、不 commit/push。
- 网站保留前一部署版本用于回退；Runner 和独立转发 Worker 不再重启。
