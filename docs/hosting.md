# 网站开发与部署

网站提供小黑盒短信登录、每日自动签到和三项分享任务。用户可查看结果、暂停、补跑、重新登录或删除托管数据，赞助页使用仓库内的原图。

`apps/web` 使用 React 19、TanStack Start、Tailwind CSS 4、shadcn/ui base-nova、oRPC、Better Auth 和 Drizzle，运行在 Cloudflare Workers，数据保存在 D1。`apps/executor` 在独立 Worker 中执行每日任务、活动和登录挑战，网站通过 Service Binding 调用；VPS 只运行设备令牌服务及 cloudflared。工程使用 pnpm workspace 和 Vite+，原 runner 保留为回滚实现。

## 本地检查

需要 Node.js 24 和 pnpm 12.15.0。在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm --filter @heybox/runner typecheck
pnpm --filter @heybox/runner test
pnpm --filter @heybox/executor typecheck
pnpm --filter @heybox/executor test
pnpm --filter @heybox/executor test:runtime
pnpm --filter @heybox/web test
pnpm --filter @heybox/web build
pnpm --filter @heybox/web typecheck
pnpm --filter @heybox/web lint
pnpm --filter @heybox/web format:check
pnpm --filter @heybox/web test:integration
```

集成测试会临时启动本地 Worker、D1 和模拟执行端，验证登录、Cookie、任务领取、暂停和删除。它不发送短信、不访问真实小黑盒账号，也不创建远程资源；结束后清理临时数据库。

只查看界面可以运行 `pnpm --filter @heybox/web dev`，打开 `http://localhost:3000/`、`/about`、`/help`、`/privacy`、`/login` 或 `/sponsor`。默认入口 `/` 在未登录时进入 `/login`，已登录时进入 `/tasks`；访客直接访问 `/tasks` 也会进入登录页。公开介绍位于 `/about`。需要调试真实 API 时，复制 `apps/web/.dev.vars.example` 为 `.dev.vars`，填入本地密钥，运行 `pnpm --filter @heybox/web db:local`，并配置可用的执行端。未配置时 API 会明确返回服务未就绪。

### 赞助名单与头像

赞助页通过公开只读 `/api/sponsors` 读取 Workers KV，不依赖登录或 Runner 密钥。名单存放在 `heybox-daily-config` namespace（binding `SITE_CONFIG`）的 `sponsors` key，不设置到期时间。Cloudflare 控制台的 **存储和数据库 → Workers KV → heybox-daily-config** 可直接编辑值：

```json
[
  { "id": "h-y", "name": "H*y", "avatar": "/sponsors/h-y.jpg" }
]
```

`id` 保持唯一，`name` 是显示昵称，数组顺序即页面顺序。`avatar` 是站内路径，文件名只使用英文字母、数字、下划线或短横线，扩展名支持 `jpg`、`jpeg`、`png`、`webp`、`avif`。空数组隐藏感谢名单；缺少配置或配置格式错误也会隐藏，服务端记录读取/校验错误，不影响收款码。KV 的跨地域更新可能需要 60 秒或更久，修改后重新访问页面查看。

头像存放在 R2 Standard bucket `heybox-daily-assets`（binding `SPONSOR_ASSETS`）下的 `sponsors/` 目录，例如 `sponsors/h-y.jpg`。bucket 保持私有，不启用 `r2.dev` 或公开 bucket 域名；现有 Worker 只为 `/sponsors/<图片文件名>` 提供 GET/HEAD 读取，边缘及浏览器缓存 1 小时。替换头像建议使用新文件名，再更新 KV，避免旧缓存。无需 Cloudflare Images。

添加赞助人时，先在 **R2 → heybox-daily-assets → sponsors/** 上传已裁切的头像，再在 KV 数组中添加记录。只上传公开展示用的头像，不上传付款截图。后续名单和头像更新无需重新部署；首次接入仍需要部署代码和 bindings，本次资源初始化不等同于部署。

仓库的 `apps/web/seed/` 保存初始数据和裁切头像，页面不直接引用这些文件。以下命令从仓库根目录执行，仅初始化本地存储，用于预览：

```sh
pnpm --filter @heybox/web exec wrangler kv key put sponsors --binding SITE_CONFIG --path seed/sponsors.json --local
pnpm --filter @heybox/web exec wrangler r2 object put heybox-daily-assets/sponsors/h-y.jpg --file seed/sponsors/h-y.jpg --content-type image/jpeg --local
pnpm --filter @heybox/web dev
```

向远端上传需把 `--local` 改为 `--remote`，写名单会替换完整数组，必须先读取当前配置并保留其他记录。`staging` 环境默认未绑定生产 KV/R2，不展示名单；需要预发布数据时应单独创建并配置资源，不能复用生产 binding。回滚可撤回本次代码和 bindings，保留 KV/R2 数据即可。

公开页的标题、canonical、分享元数据和介绍页结构化数据由 `apps/web/src/lib/seo.ts` 管理，Worker 提供 `/robots.txt` 和 `/sitemap.xml`。自部署网站到其他域名时，除了修改 `SITE_URL` 和路由，也需更新该文件的 `siteUrl`，避免搜索结果指向原站。sitemap 仅列出公开页面；登录、个人任务和接口不收录，访问控制仍由原有认证实现。发布后需核对实际域名的 robots 和 HTML，确认 CDN 的托管 robots 或爬虫规则没有覆盖应用配置。

格式化只处理网站：`pnpm --filter @heybox/web exec vp fmt`。不需要改动原有 CLI 或 Python 辅助脚本。

### 发码耗时诊断

设备令牌服务默认保留一个只加载依赖和指纹生成器的空闲子进程。它不提前下载 SDK、不生成指纹或令牌；每次请求创建新的指纹和 DOM，子进程只使用一次。空闲、启动中及执行中的子进程合计最多 4 个；完成退出后再补充空闲进程，避免初始化抢占当前请求的 CPU。失败补充有 1 秒退避；30 秒请求上限包含最多两次生成尝试，断连取消和退出清理仍生效。认证的 `/health` 返回 `pool` 的总进程数、空闲数、就绪数和活跃数，不包含 PID 或凭据。

执行 Worker 默认同时初始化独立登录 DO 和请求 VPS 令牌，两项成功后才调用 DO 的 begin。预备调用不保存手机号或令牌、不设 alarm、不发短信；即使期间 DO 被回收，begin 也会重新加载并持久化状态后再发码。DO 准备失败不调用发码，短信发码失败不自动重发。`executor_login_preparation` 记录 `challenge_prepare`（DO 预备往返）、`login_prepare`（两项并行等待）和 `challenge_begin`（后续发码往返）；并行阶段不可简单相加。

可分别设置 token 服务环境变量 `TOKEN_PREWARM=false`、执行 Worker 变量 `LOGIN_PREPARE_PARALLEL=false` 关闭优化；前者重建 token 容器，后者重新部署 executor。无需数据库迁移。空闲预热约增加 165 MiB VPS 内存，每次发码增加一次 DO 请求；实际耗时及 DO 活跃时长以部署后的测量为准。

`POST /api/auth/heybox/send-code` 返回 `Server-Timing` 和随机的 `x-heybox-request-id`。网站的 `auth_sms_timing`、执行端的 `executor_login` / `executor_login_failed`、VPS 的 `device_token_finished` / `device_token_failed` 使用同一个 `requestId`，可按此关联单次请求。计时包括成功和失败路径；日志不记录手机号、IP、验证码、设备令牌、Cookie 或原始异常内容。

| 指标 | 范围 |
| --- | --- |
| `app` | 网站接收请求至准备响应，不含浏览器网络传输 |
| `auth_quota` | Better Auth 通用接口限流的数据库操作 |
| `web_accounts` | 账号绑定检查和已登录设备会话读取 |
| `sms_quota` | 四条短信限流规则的哈希和原子数据库操作 |
| `sms_cooldown` | 读取最终冷却时间 |
| `executor` | 网站调用执行端至读完响应 |
| `challenge_prepare` / `login_prepare` / `challenge_begin` | DO 初始化往返、DO 与令牌的并行等待、后续发码往返 |
| `challenge_total` | 登录状态对象的总处理时间 |
| `challenge_load` / `challenge_save` / `challenge_clear` | 短期登录状态的加载、保存和清理；多次操作累计 |
| `token_http` | 执行端请求 VPS 令牌服务至读完响应 |
| `token_service` / `token_queue` / `token_generate` | VPS 总处理时间、排队等待和独立进程生成令牌 |
| `token_sdk_download` / `token_initialize` / `token_sdk_execute` / `token_wait` | SDK 下载与校验、依赖和 DOM 初始化、脚本执行、等待令牌 |
| `token_dns` / `token_tcp` / `token_tls` / `token_upstream` | 取令牌连接的 DNS、TCP、TLS 各阶段及整个 SDK 请求；仅记录实际发生的阶段 |
| `sms_upstream` | 构造签名、请求小黑盒发码并解析业务响应 |

这些指标存在包含关系，不能全部相加：并行模式下 `executor` 包含 `login_prepare` 和 `challenge_begin`；`login_prepare` 包含重叠执行的 `challenge_prepare` 与 `token_http`，`challenge_begin` 包含 DO 的 `challenge_total` 及其中的 `sms_upstream`。串行回滚模式下 `challenge_total` 才包含 `token_http`。`token_http` 又包含 VPS 的处理时间。浏览器总耗时需结合 Network 的请求计时。旧版本服务不返回的指标会缺省，不会伪造为零。

四条短信规则以一次 SQLite 语句原子执行，减少正常发码的限流数据库往返（4 次变为 1 次）。保持规则顺序、额度、窗口和首次拒绝后停止扣减后续规则的语义，不改变验证码重试或冷却时间。无需数据库迁移。

2026-10-28 06:14（北京时间）发布核验：网站版本 `a0f64fd9-cd84-4350-af68-826c1f3bd7e7`、执行 Worker 版本 `1c2664ac-c7ba-48a7-ba5c-49fe904366fa` 均为 100% 部署；VPS 镜像为 `heybox-token:login-performance-20261028`。Linux 登录测试 13 项通过，线上 SDK 请求返回相同关联 ID 和完整令牌计时；无效手机号请求返回 400 并携带网站计时，未发送短信。执行端健康检查与真实账号只读任务核验通过。完整真实发码的提速幅度仍需用后续用户请求测量。

2026-10-28 06:54 发布预热和并行准备：执行 Worker 版本 `d13be542-7358-4528-a225-d716cce185e0`、网站版本 `68886cde-40ad-4a1d-b1a4-2afb7de5cf0f`，VPS 镜像 `heybox-token:login-preparation-20261028`。令牌服务部署前后各 3 次真实 SDK 请求均成功，生成耗时中位数由 1,679 ms 降至 909 ms；样本少且有上游波动，不代表完整短信登录的提速。请求后恢复为 1 个已就绪空闲子进程，没有复用令牌。

本次验证：Linux 根目录与 runner 共 169 项通过（原生资源校验补齐只读挂载后单独通过）；executor 19 项、网站 80 项单测通过；workerd 的并行准备、DO 重建、加密存储及队列验证通过。Windows 网站集成的业务断言全部通过，但临时目录清理仍有既有 `EBUSY`；根目录权限断言仅在 Linux 通过。网站全量格式检查仍有 49 个未改文件的基线差异，本次未批量格式化。回滚容器配置位于 VPS `/home/ubuntu/heybox-hosted/private/login-preparation-20261028/compose.before.yaml`，旧镜像与前述 Worker 版本保留。

当前 Vite+ 1.4.0 内置 Vite 8.3.5。pnpm 的 `peers check` 会将别名包版本 1.4.0 与插件要求的 Vite 版本比较，因此报告版本不满足；已按 Vite+ 文档配置 overrides，实际构建与本地生产页面验收通过。构建还有首屏包大小及 CSS sourcemap 提示，不影响本版运行。

## 生产资源

当前实例已于 2026-10-27 部署到 [heybox.cansiny.top](https://heybox.cansiny.top)。资源如下：

| 资源 | 用途 |
| --- | --- |
| Worker `heybox-daily` | 网站、用户 API、任务调度 |
| Worker `heybox-executor` | 内部执行服务，不开放 workers.dev 或公开路由 |
| D1 `heybox-daily` | 网站会话、加密登录态、任务记录 |
| Queues `heybox-daily-tasks` / `heybox-daily-dead` | 每日任务投递及死信处理 |
| Durable Objects `LoginChallenge` / `ActivityGate` | 加密的短期登录挑战、活动限额与账号互斥 |
| `heybox.cansiny.top` | 网站域名 |
| Tunnel `heybox-daily-runner` | Worker 到 VPS 的加密连接 |
| `heybox-token.cansiny.top` | 仅提供设备令牌及健康检查，要求独立服务令牌 |
| `heybox-runner.cansiny.top` | 保留的旧 runner 回滚地址 |
| VPS Compose 项目 | 令牌服务及 cloudflared；旧 runner 停止并移除运行配置中的账号密钥 |

Tunnel 从 VPS 主动连接 Cloudflare，容器之间使用项目独立网络，无需接管 VPS 的 80 或 443 端口。执行端仍要求服务令牌；浏览器不能直接调用。已有 HTTPS 反向代理也可以使用，`RUNNER_URL` 必须指向经过校验的 HTTPS 服务。

以下步骤会创建资源和发布服务，请在部署授权后执行。Cloudflare 账号需具备 Workers、D1、Tunnel 和对应域名 DNS 的管理权限。

仓库中的 `wrangler.jsonc` 已绑定当前实例。维护该实例时复用现有资源；自行部署时，将 `account_id`、D1 的 `database_id`、域名和服务地址替换为自己的配置。不要重复创建同名资源或沿用他人的资源 ID。

### Cloudflare 执行架构的部署与切换

生产使用 `EXECUTOR_ENABLED=true` 和 `DAILY_EXECUTOR=cloudflare`。前者控制新登录及活动路由，后者控制每日任务通知并禁用旧 `/internal/claim` 入口；执行 Worker 的 `DAILY_ENABLED=true` 控制投递和消费。这三个开关用于分阶段切换，不要只改其中一个就认为迁移完成。

1. 备份 D1、原 Worker 版本与 VPS 配置，应用 `0003_cloudflare_queue.sql`。它只新增投递字段及索引，不改凭据格式。已有安装不要重新生成 `CREDENTIAL_KEY`。
2. 创建 `heybox-daily-tasks` 和 `heybox-daily-dead`，先以 `DAILY_ENABLED=false` 部署 `apps/executor`。Wrangler 创建 SQLite Durable Object 类并配置队列。主队列每批 1 条、初始最大并发 8；调整 `max_concurrency` 后重新部署，依据排队时间、429 和失败率逐步评估，程序不会自行加压。
3. 将原 `CREDENTIAL_KEY` 和 `RUNNER_SERVICE_TOKEN` 配置为执行 Worker Secret；生成独立 `TOKEN_SERVICE_TOKEN`，只共享给执行 Worker 和 VPS 令牌服务。网站不持有凭据密钥。Secret 使用交互输入或受保护的 stdin，不放在源码或命令参数中。
4. 以 Dockerfile 的 `token-service` target 启动 `compose.token.yaml`，环境文件只包含 `TOKEN_SERVICE_TOKEN`、`HOST`、`PORT`。Tunnel 的 `heybox-token.cansiny.top` 指向 `http://token:8789`。令牌服务和 cloudflared 需要共享 Docker 网络；本实例令牌 Compose 加入已有的 `heybox-hosted_default` 外部网络，复用原 Tunnel 容器。
5. 部署带 `EXECUTOR` Service Binding 的网站，先保持旧路由。检查内部健康接口和只读任务状态，再将 `EXECUTOR_ENABLED` 设为 `true`。新挑战由 Worker 处理，旧挑战按签名 Cookie 记录的后端继续完成；切换至少 5 分钟后再停旧 runner。
6. 等旧 runner 的在途任务和结果回传结束，再启用执行 Worker 的 `DAILY_ENABLED` 及网站的 `DAILY_EXECUTOR=cloudflare`。检查队列、D1 结果与现有网站会话；不要重置已经完成的当天任务。最后将旧 runner 的密钥配置移入权限为 `600` 的受控回滚备份，移除旧容器，保留令牌服务和 Tunnel。

常用命令（新部署才创建队列，现有实例直接复用）：

```bash
pnpm --filter @heybox/executor exec wrangler queues create heybox-daily-tasks
pnpm --filter @heybox/executor exec wrangler queues create heybox-daily-dead
pnpm --filter @heybox/executor exec wrangler secret put CREDENTIAL_KEY
pnpm --filter @heybox/executor exec wrangler secret put RUNNER_SERVICE_TOKEN
pnpm --filter @heybox/executor exec wrangler secret put TOKEN_SERVICE_TOKEN
pnpm --filter @heybox/executor run deploy
pnpm --filter @heybox/web build
pnpm --filter @heybox/web run deploy
```

登录挑战各自使用一个 Durable Object，手机号、临时配置、必要时保存的验证码及票据哈希在加密后暂存，5 分钟过期并由 alarm 清理。不同挑战的验证码校验互不占用旧 runner 的全局 4 个名额；同一挑战不能并发提交。持久化记录表明上游操作被中断时，挑战失效并要求用户重新开始，不自动重发短信。VPS SDK 仍为 4 并发，另有最多 16 个、等待最长 15 秒的短队列，每个 SDK 子进程最长 30 秒；服务不接收手机号、验证码或账号凭据。

活动仍只由用户操作触发，保留明确的关注确认。全局最多 4 个活动请求，同一账号不能同时执行；90 秒操作截止时间短于 95 秒互斥租约。参与前重新读取上游状态，中断后再次操作也先核实已参与及关注状态。

执行日志仅记录操作类型、任务 ID、有限的结果分类和耗时；不记录手机号、验证码、票据、设备令牌或上游响应原文。`executor_task_finished` 的 `accepted=true` 表示 D1 接受该版本与租约的结果；请求返回 200 本身不代表任务完成。CPU 以 Cloudflare 观测值为准，不能把包含等待时间的 `durationMs` 当作 CPU 时间。

回滚顺序：先关闭 `DAILY_ENABLED`，等待在途任务结束；恢复受控备份中的旧 runner 与密钥配置；将网站每日路由改回 `legacy`。新登录改回旧 runner 后，仍需给已创建的 Worker 挑战保留 5 分钟完成窗口，期间保留 Service Binding。确认新挑战排空后再停执行 Worker。新增 D1 字段和索引可保留，不能通过恢复旧数据库快照回退新产生的用户数据。

### 旧 runner 部署（仅回滚及兼容维护）

以下 VPS 完整执行端说明用于保留旧部署能力；当前生产日常运行使用上面的 Cloudflare 架构。

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
- `TASK_CONCURRENCY`：日常任务并发数，默认 `8`，允许 `1`–`8`；设为 `1` 可恢复串行。修改后需要重启 runner。
- `RUNNER_EGRESS_IP`：可选，填入已核实的服务器公网出口 IPv4 或 IPv6；更换 NAT、代理或出口后同步更新。日志标记为配置值，程序不会自动探测；未配置或格式无效时记为 `unknown`。

另建 `private/tunnel.env`，内容为 `TUNNEL_TOKEN=你的连接令牌`。将两个文件权限设为 `600`，不要提交或打印到日志。

```bash
docker compose -p heybox-hosted -f compose.hosted.yaml --profile tunnel up -d --build
```

runner 只监听主机回环地址；cloudflared 不开放额外入站端口。登录操作合计最多四个并发，日常任务默认最多八个账号并行；一个账号执行并回传结果后立即补位，同一账号内部步骤仍顺序执行。两种并发上限独立，因此需要一起考虑资源峰值。登录和任务子进程有硬超时。APP 签名由 TypeScript 在进程内计算，设备令牌由 Node.js 和 jsdom 执行经摘要校验的官方 SDK 获取，不启动 Java、Android 模拟环境或 Chromium。浏览器指纹在每次新登录时生成一次并在初始化后释放，数据库继续只保存原有登录配置；后续任务沿用设备 ID 和令牌。

日常任务返回后记录 `runner_task_finished`，包含任务 ID、从启动子进程到退出的 `durationMs`、结果 `outcome` 及有限的失败分类 `category`；不包含排队等待时间。HTTP 429 和明确的请求频繁错误归为 `upstream_rate_limit`，其他 HTTP 错误、网络失败、人机验证分别记录。子进程超时或异常仍记录 `runner_operation_failed`，并带任务 ID 和耗时。日志不记录账号凭据或上游错误原文；公开错误提示不变。

可运行 `node apps/runner/bench/task-concurrency.ts` 对比 1 / 4 / 8 并发。使用 Node.js 24 和已构建的根目录 `dist`，每档运行八个合成账号，保留真实子进程、签名、上报加密及任务等待，只把网络替换为模拟响应。输出耗时、Node 进程合计峰值 RSS、CPU 时间和完成数；不会访问真实账号。测试需要 `ps`，本机结果不代表 VPS 或真实上游的容量。

登录的每个执行步骤记录一条结果日志：`runner_operation_completed` 或 `runner_operation_failed`。`outcome` 区分短信已发送（`sent`）、等待人机验证（`captcha`）、已登录（`authenticated`）和失败（`failed`）；`captcha` 不表示短信已发送。日志包含独立的 `operationId`、开始时间、耗时、是否携带人机验证凭据，以及 `phoneRef`、`deviceRef`、`egressIp` / `egressSource`。失败继续保留经过脱敏的上游原因和阶段。

设备令牌 SDK 明确失败时立即结束该次初始化。SDK 下载限时 5 秒；取令牌的 DNS、TCP 和 TLS 建连合计限时 3 秒，完整请求限时 5 秒，SDK 等待令牌由 8 秒超时兜底。`request_token` 阶段保留数值型 `sdkCode`、`httpStatus`、`upstreamCode` 和 `requestDurationMs`（仅在可取得时），以及白名单内的 `networkCode` 和 `networkPhase`；`sdkCode` 的 `-1`、`-2`、`-3` 分别表示 SDK 报告的连接错误、HTTP 错误和业务拒绝，`-4` 或未知错误归入 `sdk_error`。

VPS 进程池仅对令牌阶段的网络失败、HTTP 5xx 和等待令牌超时最多重试一次，第二次使用全新的子进程、指纹和 DOM；两次尝试共用原有 30 秒上限和取消信号。完整性校验失败、上游明确拒绝、脚本错误、取消和进程异常不自动重试。短信提交和验证码验证不自动重发。`device_token_attempt_failed` 与最终结果使用同一个 `requestId`，记录尝试序号、是否重试和经过筛选的诊断；分阶段耗时累计包含失败尝试，网络耗时包含在 `token_wait` 中，不能相加。请求体、响应正文、令牌、Cookie 和 URL 查询参数不写入诊断。

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

公共账号统计使用 5 分钟浏览器和边缘缓存，新增或删除账号后，统计数字可能最多延迟 5 分钟更新；后台标签页暂停刷新。任务页首次读取完整历史，后续轮询只读取当天状态，任务结束、跨日或切换账号时重新读取历史；同一页面不会重叠发送轮询。带 hash 的 `/assets/` 文件使用一年浏览器缓存，发布后通过文件名变化更新。赞助页使用与原图像素一致的无损 WebP，原 PNG 下载链接保留。

首次登录会排队补跑当天任务。登录、恢复自动任务和手动重试入库后，网站通过内部 Service Binding 通知执行 Worker 投递。Queues 消息只携带任务 ID 和投递标识，不携带凭据。消费时原子领取 D1 任务，继续核验账号租约、凭据版本及日期；重复消息不能重复领取。网站定时触发器每小时第 1 分钟补查，北京时间 00:01 起将启用且尚无当天记录的账号加入队列，同一账号每天只有一条记录。执行前检查小黑盒真实状态，已完成的任务会跳过。

任务页右上角在排队时显示“等待执行”，实际运行时显示绿色呼吸圆点与“执行中”，结束后恢复下次执行时间。沿用现有轮询，活动任务约每 5 秒更新；用户设置减少动画时圆点静止。

登录完成、恢复和补跑的通知在任务入库后通过 Worker `waitUntil` 执行，不阻塞接口返回；通知仍保留 2 秒超时，失败后由既有的兜底领取机制处理。

执行 Worker 每分钟恢复投递失败、到期重试及过期租约。投递先写入 60 秒保留标识，发送成功后登记；发送结果不确定时到期重投。已登记消息正常由 Queues 保留；若一小时仍未领取，恢复扫描更换投递标识并重投，覆盖死信投递也耗尽或消息丢失的情况。正在运行及已完成的任务不重投，旧投递标识不能再领取。消费者先持久化结果再确认消息，停用每日执行时仍记录收到的死信结果。通知丢失时通常由下一次分钟级扫描补投，Cloudflare 或上游故障期间不保证这一延迟。

每条任务有 4 分钟执行截止时间，网络请求和等待可取消。数据库结果写入短暂失败时先重试；仍失败则重试消息，租约过期后恢复业务任务。超过队列投递次数的消息进入死信队列，只能将匹配投递标识的排队任务标为失败，不能覆盖正在执行或已经完成的结果。

恢复与投递扫描使用状态、日期、可执行时间和投递索引，不扫描已完成历史。执行 Worker 的每分钟扫描每天约 1,440 次，另有网站调度和实际任务查询；SQL 条数不等于 D1 计费行数。过期限流、会话和旧任务每天北京时间 00:01 清理一次。

有任务排队时，先按当天的可执行时间和创建时间读取首个可领取任务；只有没有立即可执行的任务时才汇总重试和租约期限。跨日恢复使用两个日期范围查询，避免每领一个任务都遍历当天队列。`0002_queue_ready_index.sql` 将原有 `jobs_ready` 索引改为 `(status,date,available_at,created_at)`，不增加每次状态更新需要维护的队列索引数量。发布这项优化前先应用该迁移；它不修改账号或任务数据。回滚代码可保留新索引，若需要恢复旧索引则在维护窗口重建 `(status,available_at)`。

每日任务开始和成功结束时强制远程核验，中途每 30 秒至多核验一次，失败后的补充状态读取前也强制核验；每个步骤仍在本地检查日期。短任务通常只有两次远程核验。网站核验任务、租约、日期、凭据版本及有效性；仅在租约剩余不足 2 分钟时续期至 5 分钟后，续期 UPDATE 再次核验全部条件，防止读取后重新登录或删除仍被续期。暂停不撤销运行中的租约，旧版本结果仍不能覆盖新凭据状态。

升级时先应用上述索引迁移，再更新 runner 和发布网站。领取响应仍为原来的任务或 `null`，空响应通过 `Retry-After` 告知下一次检查时间；新 runner 遇到旧网站未提供该响应头时仍每 10 秒检查，旧 runner 也能读取新网站返回的任务。

短暂失败最多自动尝试 3 次，并延迟重试。登录失效会暂停，不会自动发送短信。重新登录会更新凭据版本；旧进程停止或租约到期前，新任务等待，不会接受旧凭据的任务结果。

暂停会取消排队任务，但已开始的任务继续完成并记录结果；暂停后失败的任务不自动重试。退出登录使用相同暂停规则，并撤销该账号在当前浏览器的网站会话，保留小黑盒登录态和记录，其他账号不受影响。重新登录或删除在下一次核验时阻止旧任务的后续步骤（检查间隔最多 30 秒，已发送的请求不能撤回）；最终写入始终核验当前版本及租约。删除托管数据会撤销该账号所有网站会话并删除登录态及记录。任务记录保留 30 天，手机号和验证码不写入网站 D1；登录挑战在独立 Durable Object 内加密暂存，5 分钟清理。限流键经过 HMAC 处理。

## 2026-10-28 迁移验收记录

北京时间 05:10 核验：网站版本 `ddeac031-5165-4f28-b6a2-fc5cef43d5d3` 和执行 Worker 版本 `0990576c-d777-4fb0-a5b1-30f543b8b8a7` 均为 100% 部署；每日队列最大并发为 8，两个 Worker 的 workers.dev 和预览地址均关闭。D1 已登记 `0003_cloudflare_queue.sql`。

生产旧 runner 已停止并移除；SDK 镜像为 `heybox-token:cloudflare-executor-20261028`，运行环境没有 `CREDENTIAL_KEY` 或 `RUNNER_SERVICE_TOKEN`。VPS 回滚备份位于 `/home/ubuntu/heybox-hosted/private/migration-20261028`，目录权限 `700`、密钥文件 `600`。当前生产账号密钥位于执行 Worker Secret；预发布演示环境保持独立。

验证包括真实 SDK 令牌生成、Worker 使用原密文读取已完成的四项任务、既有浏览器会话和活动列表，以及本地 workerd 的完整模拟任务、真实 D1/Queues、DO 重启恢复、过期清理、8 路独立登录和重复消息去重。执行端与存储的 50 项测试通过，Linux 容器登录测试 13 项通过。网站构建、类型检查、lint 和本次修改文件的格式检查通过；生产公开页面、访客跳转、robots、sitemap 和隐私说明验证通过。

本地完整单元测试最初为 240/241：唯一失败是 Windows 不支持 POSIX `0600` 的既有断言，已在 Linux 容器通过该登录测试。网站端到端业务断言全部通过，但 Windows 临时目录清理阶段出现 `EBUSY`；全库格式检查还有未修改文件的基线差异，本次仅格式化修改文件。

05:10 的实时数据为 620 个开启自动任务且凭据有效的账号，今天全部完成，完成记录的四项任务均已核验，没有排队或运行中的遗漏。本次没有重置已完成记录，也没有为验收发送真实短信或参与活动。切换后的整批每日执行及其 CPU 用量尚未发生，不能把模拟集成或少量生产读取当作整批运行证据。

## 预发布演示环境

预发布地址为 `https://preview.heybox.cansiny.top`。使用演示号码 `13900000009`、验证码 `123456` 登录，先点击“获取验证码”；不会发送短信。活动参与、关注和每日奖励均为模拟结果，不访问小黑盒。历史页中的演示记录也不代表真实收益。

网站使用独立 Worker `heybox-daily-staging`、D1 `heybox-daily-staging`、Tunnel `heybox-daily-staging-runner` 和服务密钥。VPS 目录为 `/home/ubuntu/heybox-staging`，Compose 项目名为 `heybox-staging`，不开放宿主端口。预发布关闭 Cron；登录、恢复或重试时才唤醒模拟执行。活动状态保存在模拟 Runner 内存中，重启后恢复初始演示状态。账号 `13900000008` 用于模拟失败路径。

使用 Node.js 24，正常安装依赖后从仓库根目录手动发布：

```bash
# 构建并核验预发布目标，不上传
node scripts/deploy-staging.mjs --build-only
# 构建、核验并发布预发布 Worker
node scripts/deploy-staging.mjs
```

脚本显式设置 `CLOUDFLARE_ENV=staging` 和 Vite staging 模式，临时使用空 `.dev.vars.staging`，避免把本地开发密钥写入构建产物；若该文件已存在会停止并保留原文件。发布前核验 Worker、域名、D1 ID、空 Cron 和变量白名单。Worker Secret 通过 Wrangler 单独配置，不写入源码。更新模拟 Runner 时，在上述 VPS 目录运行 `docker compose -p heybox-staging -f compose.staging.yaml up -d --build`；只向该目录同步源码和 `private/staging/runner.env`、`tunnel.env`。

预发布禁止搜索引擎收录。它适合界面与流程验收，不能用来证明真实短信、小黑盒接口或奖励到账正常。需要下线时停止 staging Compose 并移除 staging Worker 域名，保留 D1；不要使用正式环境资源名执行这些操作。

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
