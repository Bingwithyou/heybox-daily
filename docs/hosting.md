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

只查看界面可以运行 `pnpm --filter @heybox/web dev`，打开 `http://localhost:3000/`、`/about`、`/help`、`/privacy`、`/login` 或 `/sponsor`。默认入口 `/` 在未登录时进入 `/login`，已登录时进入 `/tasks`；访客直接访问 `/tasks` 也会进入登录页。公开介绍位于 `/about`。需要调试真实 API 时，复制 `apps/web/.dev.vars.example` 为 `.dev.vars`，填入本地密钥，运行 `pnpm --filter @heybox/web db:local`，并配置可用的执行端。未配置时 API 会明确返回服务未就绪。

公开页的标题、canonical、分享元数据和介绍页结构化数据由 `apps/web/src/lib/seo.ts` 管理，Worker 提供 `/robots.txt` 和 `/sitemap.xml`。自部署网站到其他域名时，除了修改 `SITE_URL` 和路由，也需更新该文件的 `siteUrl`，避免搜索结果指向原站。sitemap 仅列出公开页面；登录、个人任务和接口不收录，访问控制仍由原有认证实现。发布后需核对实际域名的 robots 和 HTML，确认 CDN 的托管 robots 或爬虫规则没有覆盖应用配置。

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

设备令牌 SDK 明确失败时立即结束该次初始化，不再统一等待 20 秒。`request_token` 阶段保留数值型 `sdkCode`、`httpStatus`、`upstreamCode` 和 `requestDurationMs`（仅在可取得时）；`sdkCode` 的 `-1`、`-2`、`-3` 分别表示 SDK 报告的连接错误、HTTP 错误和业务拒绝，`-4` 或未知错误归入 `sdk_error`。无响应仍由 `wait_token` 的 20 秒超时兜底，不自动重试；请求体、响应正文、令牌、Cookie 和 URL 查询参数不写入诊断。

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

首次登录会排队补跑当天任务。登录、恢复自动任务和手动重试入队后，网站会通过现有 Tunnel 通知 runner 立即领取；重复通知只唤醒同一调度循环，不会突破并发上限。只有存在执行名额时才领取，沿用原有账号租约与版本校验。定时触发器每小时第 1 分钟补查，北京时间 00:01 起将启用且尚无当天记录的账号加入队列，同一账号每天只有一条记录。执行前检查小黑盒真实状态，已完成的任务会跳过。

任务页右上角在排队时显示“等待执行”，实际运行时显示绿色呼吸圆点与“执行中”，结束后恢复下次执行时间。沿用现有轮询，活动任务约每 5 秒更新；用户设置减少动画时圆点静止。

登录完成、恢复和补跑的通知在任务入库后通过 Worker `waitUntil` 执行，不阻塞接口返回；通知仍保留 2 秒超时，失败后由既有的兜底领取机制处理。

runner 启动后立即检查，队列空闲时每 30 分钟兜底检查一次。有通知会提前唤醒；已知的重试时间和未释放租约会缩短等待，不必等满 30 分钟。通知失败不影响已入库的任务，新任务最多等下一次兜底检查。网站或 runner 离线时不能保证这个延迟上限，恢复后会继续检查；服务错误采用最长 30 分钟的退避。

多个运行任务各自重试结果回传，不共享等待回调；回传结束后才释放执行名额。停止 runner 时停止后续领取，等待已经领取的任务及回传结束，沿用 Compose 的 5 分钟退出宽限期。若停止时已有领取请求发出，该请求返回的任务也会执行并回传。

空闲领取使用现有索引查询待执行任务，没有工作时不执行恢复和领取的 UPDATE。过期限流、会话和旧任务每天北京时间 00:01 清理一次。稳定空闲时，每天约 48 次领取、24 次定时调用，约 75 条 SQL；不包含实际任务、失败重试和用户访问，SQL 条数也不等于 D1 计费行数。

升级时先更新 runner 再发布网站。领取响应仍为原来的任务或 `null`，空响应通过 `Retry-After` 告知下一次检查时间；新 runner 遇到旧网站未提供该响应头时仍每 10 秒检查，旧 runner 也能读取新网站返回的任务。本次无需数据库迁移。

短暂失败最多自动尝试 3 次，并延迟重试。登录失效会暂停，不会自动发送短信。重新登录会更新凭据版本；旧进程停止或租约到期前，新任务等待，不会接受旧凭据的任务结果。

暂停或删除会阻止后续步骤，已发送的请求不能撤回。退出登录会暂停当前账号任务并撤销该账号在当前浏览器的网站会话，保留登录态和记录，其他账号不受影响；删除托管数据会撤销该账号所有网站会话并删除登录态及记录。任务记录保留 30 天，手机号和验证码不写入数据库，限流键经过 HMAC 处理。

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
