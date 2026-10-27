# 登录请求转发

托管网站可以让 Runner 通过独立 Cloudflare Worker 访问小黑盒登录接口。签名、设备初始化和临时登录挑战仍在 Runner 执行；腾讯弹窗继续由浏览器展示。发码、验证码校验及登录后的任务列表读取走转发，日常签到/分享和 CLI 不受影响。

`apps/login-relay` 对应 Worker `heybox-login-relay`，只接受带独立服务密钥的 `POST /relay`。允许的目标固定为 `https://api.xiaoheihe.cn` 上的四个接口：

| 路径 | 方法 |
| --- | --- |
| `/account/get_login_code/` | POST |
| `/account/login_code/` | POST |
| `/task/list_v2/` | GET |
| `/task/sign_v4/get_sign_state` | GET（只读排查） |

转发保留签名参数、表单、Cookie 和上游响应，包括 `show_captcha`。服务密钥不发给小黑盒。禁止重定向，不缓存、不记录请求内容，输入最多 32 KiB。超时或失败不会自动重发短信，也不会自动转为 VPS 直连。

## 检查

```bash
pnpm --filter @heybox/login-relay typecheck
pnpm --filter @heybox/login-relay test
pnpm --filter @heybox/login-relay test:runtime
pnpm --filter @heybox/runner typecheck
pnpm --filter @heybox/runner test
```

`test:runtime` 使用当前 Wrangler 自带的 workerd，以本地模拟上游验证运行时兼容性，不访问小黑盒、不发送短信。

## 发布与启用

部署需有明确授权。先发布转发 Worker，再配置和更新 Runner；不需要重新发布网站或迁移 D1。自行部署时修改 `apps/login-relay/wrangler.jsonc` 的账号与 Worker 名称。

```bash
pnpm --filter @heybox/login-relay run deploy
pnpm --filter @heybox/login-relay exec wrangler secret put LOGIN_RELAY_TOKEN
```

使用独立的高熵密钥，例如 `openssl rand -hex 32`，不要复用能访问网站内部 API 的 `RUNNER_SERVICE_TOKEN`。生产密钥通过交互输入或受限的 stdin 传递，不作为命令行参数或写入源码。

在 VPS 的 `private/runner.env` 中设置配对变量，文件权限保持 `600`：

```dotenv
LOGIN_RELAY_URL=https://heybox-login-relay.<your-subdomain>.workers.dev
LOGIN_RELAY_TOKEN=<same independent secret>
```

URL 只包含 HTTPS origin，不带路径、查询或用户凭据。两项都未配置时使用旧直连路径；配置不完整会拒绝启动。更新前记录旧镜像并备份环境文件；确认当前任务已结束后重建 Runner。重启会使内存中的未完成登录挑战失效，用户需要重新获取验证码。

上线验收一次真实网站登录，检查会话和 Runner 的 `runner_operation_completed` 日志。Workers 模式记录 `transport=cloudflare_worker`、`egressSource=cloudflare_worker`，省略 `egressIp`；VPS 的 `RUNNER_EGRESS_IP` 不能代表 Cloudflare 实际出口。直连仍记录 `transport=direct`。

Worker 使用 Cloudflare 的网络出口，不保证每次请求、每个用户或同一挑战使用不同/固定 IP，也不保证消除上游限流。模拟 CAPTCHA 入口后的真实票据测试与上游自然触发验证是不同覆盖范围。

## 回退

同时清空或删除两个 `LOGIN_RELAY_*` 变量并重建 Runner，可恢复直连；也可恢复更新前的镜像和环境备份。无需回滚数据库、撤销网站会话或改动网页代码。应急回退后保留 Worker 以便排查，不自动删除远程资源。
