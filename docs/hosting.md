# 网站开发与部署

网站提供小黑盒短信登录、每日自动签到和三项分享任务。用户可查看结果、暂停、补跑、重新登录或删除托管数据，赞助页使用仓库内的原图。

`apps/web` 使用 React 19、TanStack Start、Tailwind CSS 4、shadcn/ui base-nova、oRPC、Better Auth 和 Drizzle，运行在 Cloudflare Workers，数据保存在 D1。`apps/runner` 运行在 Linux VPS，复用根目录 CLI 的登录和任务逻辑。工程使用 pnpm workspace 和 Vite+。

## 本地检查

需要 Node.js 24 和 pnpm 12.15.0。在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm --filter @heybox/runner typecheck
pnpm --filter @heybox/runner test
pnpm --filter @heybox/web test
pnpm --filter @heybox/web build
pnpm --filter @heybox/web typecheck
pnpm --filter @heybox/web lint
pnpm --filter @heybox/web format:check
pnpm --filter @heybox/web test:integration
```

集成测试会临时启动本地 Worker、D1 和模拟执行端，验证登录、Cookie、任务领取、暂停和删除。它不发送短信、不访问真实小黑盒账号，也不创建远程资源；结束后清理临时数据库。

只查看界面可以运行 `pnpm --filter @heybox/web dev`，打开 `http://localhost:3000/login` 或 `/sponsor`。需要调试真实 API 时，复制 `apps/web/.dev.vars.example` 为 `.dev.vars`，填入本地密钥，运行 `pnpm --filter @heybox/web db:local`，并配置可用的执行端。未配置时 API 会明确返回服务未就绪。

格式化只处理网站：`pnpm --filter @heybox/web exec vp fmt`。不需要改动原有 CLI 或 Python 辅助脚本。

当前 Vite+ 1.4.0 内置 Vite 8.3.5。pnpm 的 `peers check` 会将别名包版本 1.4.0 与插件要求的 Vite 版本比较，因此报告版本不满足；已按 Vite+ 文档配置 overrides，实际构建与本地生产页面验收通过。构建还有首屏包大小及 CSS sourcemap 提示，不影响本版运行。

## 生产资源

当前实例已于 2026-10-27 部署到 [heybox.cansiny.top](https://heybox.cansiny.top)。资源如下：

| 资源 | 用途 |
| --- | --- |
| Worker `heybox-daily` | 网站、用户 API、任务调度 |
| D1 `heybox-daily` | 网站会话、加密登录态、任务记录 |
| `heybox.cansiny.top` | 网站域名 |
| Tunnel `heybox-daily-runner` | Worker 到 VPS 的加密连接 |
| `heybox-runner.cansiny.top` | 执行端服务域名 |
| VPS 独立 Compose 项目 | runner 和 cloudflared 容器 |

Tunnel 从 VPS 主动连接 Cloudflare，容器之间使用项目独立网络，无需接管 VPS 的 80 或 443 端口。执行端仍要求服务令牌；浏览器不能直接调用。已有 HTTPS 反向代理也可以使用，`RUNNER_URL` 必须指向经过校验的 HTTPS 服务。

以下步骤会创建资源和发布服务，请在部署授权后执行。Cloudflare 账号需具备 Workers、D1、Tunnel 和对应域名 DNS 的管理权限。

仓库中的 `wrangler.jsonc` 已绑定当前实例。维护该实例时复用现有资源；自行部署时，将 `account_id`、D1 的 `database_id`、域名和服务地址替换为自己的配置。不要重复创建同名资源或沿用他人的资源 ID。

### 1. 准备 Cloudflare

```bash
pnpm --filter @heybox/web exec wrangler login
pnpm --filter @heybox/web exec wrangler d1 create heybox-daily
pnpm --filter @heybox/web exec wrangler tunnel create heybox-daily-runner
```

将新数据库的 ID 写入 `apps/web/wrangler.jsonc`，把 `vars` 改为：

```json
{
  "SITE_URL": "https://heybox.cansiny.top",
  "RUNNER_URL": "https://heybox-runner.cansiny.top"
}
```

在配置中添加网站的 Custom Domain：

```json
"routes": [{ "pattern": "heybox.cansiny.top", "custom_domain": true }]
```

在 Cloudflare Tunnel 中配置公开主机名 `heybox-runner.cansiny.top`，服务指向 `http://runner:8788`。为该主机名添加开启代理的 CNAME，目标为 `<Tunnel UUID>.cfargotunnel.com`；若控制台已自动创建，直接检查现有记录。保存其连接令牌，供下一步使用。这里的 `runner` 是同一 Compose 项目中的服务名。

### 2. 配置 VPS

使用独立目录保存本项目。保留原有 CLI 的 `private/config.json`；网站不读取这份单账号配置。

```bash
mkdir -p private
chmod 700 private
cp apps/runner/.env.example private/runner.env
```

填好 `private/runner.env`：

- `WEBSITE_URL`：网站 HTTPS 地址。
- `RUNNER_SERVICE_TOKEN`：用 `openssl rand -hex 32` 生成，与 Worker 的同名密钥一致。
- `CREDENTIAL_KEY`：用 `openssl rand -base64 32` 生成，只放在 VPS，用于 AES-256-GCM 加密。
- `RUNNER_EGRESS_IP`：可选，填入已核实的服务器公网出口 IPv4 或 IPv6；更换 NAT、代理或出口后同步更新。日志标记为配置值，程序不会自动探测；未配置或格式无效时记为 `unknown`。

另建 `private/tunnel.env`，内容为 `TUNNEL_TOKEN=你的连接令牌`。将两个文件权限设为 `600`，不要提交或打印到日志。

```bash
docker compose -p heybox-hosted -f compose.hosted.yaml --profile tunnel up -d --build
```

runner 只监听主机回环地址；cloudflared 不开放额外入站端口。登录操作合计最多四个并发，日常任务逐个执行，登录和任务子进程有硬超时。APP 签名由 TypeScript 在进程内计算，设备令牌由 Node.js 和 jsdom 执行经摘要校验的官方 SDK 获取，不启动 Java、Android 模拟环境或 Chromium。浏览器指纹在每次新登录时生成一次并在初始化后释放，数据库继续只保存原有登录配置；后续任务沿用设备 ID 和令牌。

登录的每个执行步骤记录一条结果日志：`runner_operation_completed` 或 `runner_operation_failed`。`outcome` 区分短信已发送（`sent`）、等待人机验证（`captcha`）、已登录（`authenticated`）和失败（`failed`）；`captcha` 不表示短信已发送。日志包含独立的 `operationId`、开始时间、耗时、是否携带人机验证凭据，以及 `phoneRef`、`deviceRef`、`egressIp` / `egressSource`。失败继续保留经过脱敏的上游原因和阶段。

手机号先规范为国际格式，再使用服务令牌做 HMAC；设备 ID 使用独立的 HMAC 前缀。日志不记录手机号、验证码、设备令牌、设备 ID、登录挑战或账号凭据原文。同一手机号的不同写法得到相同 `phoneRef`，同一登录设备的后续步骤得到相同 `deviceRef`；设备尚未生成时没有 `deviceRef`。更换服务令牌会改变这些关联标识，缺少有效令牌时不生成无密钥哈希。

排查上游限流时，在同一时间段和 `egressIp` 下比较不同 `phoneRef` 的结果：少数号码反复失败而其他号码能发送成功，更支持号码或账号相关限制；多个号码集中失败，更支持共享出口或服务级限制。这是相关性证据，上游未返回具体限流维度时不能直接定论；不同出口的对照还需实际存在对应流量。请求取消、设备初始化失败和等待人机验证不计为短信发送成功。

### 3. 发布网站

`BETTER_AUTH_SECRET` 单独用 `openssl rand -hex 32` 生成。通过交互输入设置密钥，避免把值写进命令行历史：

发布构建前移走本地 `.dev.vars`，确认 `dist/server/` 不带本地测试密钥；生产密钥使用 Wrangler Secret 保存。下面使用 `run deploy`，避免调用 pnpm 自带的 workspace `deploy` 命令。

```bash
pnpm --filter @heybox/web exec wrangler secret put BETTER_AUTH_SECRET
pnpm --filter @heybox/web exec wrangler secret put RUNNER_SERVICE_TOKEN
pnpm --filter @heybox/web exec wrangler d1 migrations apply heybox-daily --remote
pnpm --filter @heybox/web build
pnpm --filter @heybox/web run deploy
```

正式验收需检查 HTTPS、验证码登录、网站会话和一条真实账号任务。短信发送和真实账号登录需要账号持有者授权。仅有本地模拟测试或离线签名通过，不能视为线上登录成功。

小黑盒可能以 HTTP 200 返回 `show_captcha`，要求先完成人机验证。网站仅在这时显示“完成人机验证”，按需加载腾讯官方 2.0 组件 `TJCaptcha.js`。完成后沿用原手机号和设备继续发码或校验短信；取消不会自动重发，容灾票据不能当作通过。挑战保留 5 分钟，人工验证最多提交 3 次，重复票据和并发提交会被拒绝。腾讯域名/appid 配置或小黑盒 IP 规则仍可能拒绝请求，手机 APP 完成验证不保证解除本次网页请求的要求。

旧版 `TCaptcha.js` 依赖 iframe 模板，部分浏览器环境可能在该子页面加载阶段报 `1007`。2.0 使用 JS 引擎渲染，保留相同构造参数和票据合同；升级只替换官方 SDK 地址，不改变后端校验。参见[腾讯官方升级说明](https://cloud.tencent.com/document/product/1110/112026)。

网站会话与用于执行任务的小黑盒凭据分别有效。首页展示最近核验结果不代表刚刚查询了小黑盒；排查手机重登影响时，应分别检查网站会话及执行端的只读任务接口。

## 运行行为

首次登录会排队补跑当天任务。登录、恢复自动任务和手动重试入队后，网站会通过现有 Tunnel 通知 runner 立即领取；重复通知不会并发执行。定时触发器每小时第 1 分钟补查，北京时间 00:01 起将启用且尚无当天记录的账号加入队列，同一账号每天只有一条记录。执行前检查小黑盒真实状态，已完成的任务会跳过。

runner 启动后立即检查，队列空闲时每 30 分钟兜底检查一次。有通知会提前唤醒；已知的重试时间和未释放租约会缩短等待，不必等满 30 分钟。通知失败不影响已入库的任务，新任务最多等下一次兜底检查。网站或 runner 离线时不能保证这个延迟上限，恢复后会继续检查；服务错误采用最长 30 分钟的退避。

空闲领取使用现有索引查询待执行任务，没有工作时不执行恢复和领取的 UPDATE。过期限流、会话和旧任务每天北京时间 00:01 清理一次。稳定空闲时，每天约 48 次领取、24 次定时调用，约 75 条 SQL；不包含实际任务、失败重试和用户访问，SQL 条数也不等于 D1 计费行数。

升级时先更新 runner 再发布网站。领取响应仍为原来的任务或 `null`，空响应通过 `Retry-After` 告知下一次检查时间；新 runner 遇到旧网站未提供该响应头时仍每 10 秒检查，旧 runner 也能读取新网站返回的任务。本次无需数据库迁移。

短暂失败最多自动尝试 3 次，并延迟重试。登录失效会暂停，不会自动发送短信。重新登录会更新凭据版本；旧进程停止或租约到期前，新任务等待，不会接受旧凭据的任务结果。

暂停或删除会阻止后续步骤，已发送的请求不能撤回。退出登录会暂停当前账号任务并撤销该账号在当前浏览器的网站会话，保留登录态和记录，其他账号不受影响；删除托管数据会撤销该账号所有网站会话并删除登录态及记录。任务记录保留 30 天，手机号和验证码不写入数据库，限流键经过 HMAC 处理。

## 备份、更新与停止

更新前导出 D1 备份，备份文件也要按私人数据保护。`CREDENTIAL_KEY` 单独备份：只有数据库没有密钥无法恢复登录态。不要直接更换该密钥；本版没有批量重加密工具，更换主密钥需要先停止执行，并让用户重新登录。

```bash
# 导出到不纳入 Git 的目录
pnpm --filter @heybox/web exec wrangler d1 export heybox-daily --remote --output ../../private/heybox-backup.sql

# 停止执行端及连接
docker compose -p heybox-hosted -f compose.hosted.yaml --profile tunnel stop
```

停用网站时同时移除 Worker 的 Cron Trigger；需要下线时再移除网站域名路由。不会自动删除 D1。恢复旧版本前确认它兼容当前数据库；不要自动回滚或删除用户数据。

参考：[TanStack Start 的 Workers 部署](https://tanstack.com/start/latest/docs/framework/react/guide/hosting)、[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/)、[Wrangler Tunnel 命令](https://developers.cloudflare.com/workers/wrangler/commands/tunnel/)。
