# 正式登录的 Workers 转发

用户于 2026-10-27 批准独立 Worker 方案及测试通过后的上线。

## 目标与范围

将托管网站的短信登录请求从 VPS 直连改为 `Runner → heybox-login-relay Worker → 小黑盒`。复用现有签名、设备初始化、ChallengeStore 和浏览器人机验证。发码、验证码校验及登录后的账号读取使用转发；日常签到、分享任务和 CLI 保持当前路径。网站代码和数据库合同不变。

此前隔离实验已验证真实登录，以及模拟初始 CAPTCHA 状态后的真实腾讯弹窗、人工票据和登录续流程；尚未覆盖上游自然触发 CAPTCHA，也不能保证每个请求使用不同 IP 或消除限流。

## 接口与配置

- 新增 `apps/login-relay`，Worker 名称 `heybox-login-relay`，独立 `LOGIN_RELAY_TOKEN`，无数据库、Cron 或网站域名绑定。
- Runner 配置 `LOGIN_RELAY_URL`（HTTPS origin）与 `LOGIN_RELAY_TOKEN`；二者均未配置时沿用直连，配置不完整或无效时拒绝启动。启用后失败不自动回退直连，不自动重试。
- `POST /relay` 使用 Bearer token；JSON 包含原始签名 URL、method、白名单 headers、表单 body。仅允许 `api.xiaoheihe.cn` 上的发码、验证码登录、任务列表与签到状态只读接口及匹配的方法。
- 禁止任意主机、带凭据 URL、额外端口、重定向和任务写入接口。限制输入体积，服务密钥不会转发到上游。
- 保留上游 HTTP 状态和 JSON（包含 `show_captcha` / appid），不缓存，不记录 URL、手机号、验证码、票据、Cookie 或凭据。
- Runner 日志新增登录 transport 标识；Workers 模式下不再填写配置的 VPS egressIp，实际 Cloudflare 出口未知。

## 失败与兼容

网络超时、上游 HTTP 错误及人机验证继续进入现有错误/挑战处理。不会重发短信或切换设备。既有并发限制、5 分钟挑战有效期、3 次人工验证限制保持不变。转发配置关闭后旧直连行为可用。

## 验证与部署

离线覆盖鉴权、目标/方法白名单、超限 body、请求保真、上游 CAPTCHA、错误码、重定向、超时/取消、无重试、登录全流程与日志脱敏。通过 Node 测试、typecheck 和真实 workerd 本地转发检查。

部署独立 Worker 后，构建并验证 Runner 镜像，再更新生产 Runner 配置与容器；保留旧镜像及权限为 600 的环境备份。检查运行中的任务后再切换，说明重启会使内存中未完成的登录挑战失效。网站 Worker 不重新发布；不迁移 D1；不 commit/push。

最后使用已授权尾号 2976 验收网站真实登录与会话，核对 Runner 日志确实走 Workers；如出现 CAPTCHA 由用户完成。正常登录入队的既有自动任务行为不改变。回退关闭两个转发变量并重建 Runner 容器，或恢复旧镜像和环境备份；不回滚用户数据。

## 上线验收记录

2026-10-27 已发布独立转发 Worker，并于北京时间 16:33 切换正式 Runner。正式网站使用尾号 2976 自然触发上游 CAPTCHA；人工验证后发码成功，短信校验后进入任务页。三步日志均为 `transport=cloudflare_worker`，设备引用一致，实际出口 IP 保持未知。此次补齐了此前未覆盖的自然触发场景。

验收发现 CAPTCHA 后发码没有重新启动前端冷却，用户批准补充修复。普通发送及原倒计时到期后的 CAPTCHA 续发均已验证禁用按钮 60 秒，刷新保持剩余时间；该补丁发布为网站版本 `212da302-0bdc-4eb0-ba00-3c97dd358dcb`，线上登录资源与受测构建逐字节一致，现有网站会话和任务页读取正常。

独立转发版本：`977aaaf4-cb96-417e-8328-762a9c4d9520`；Runner 镜像：`sha256:f57586fc519b295f821392e8d567c4e396861e03e698772b5ba6eef580f33828`。旧镜像与环境配置已保留用于回退，临时凭据和本地测试服务已清理。本次未执行 Git commit/push。
