# 赞助名单 KV + R2 实施计划

依据：`../specs/2026-10-28-sponsor-config.md`，用户已批准创建资源、上传头像与本地改造。首轮未部署；用户随后于 2026-10-28 批准提交、推送后部署网站 Worker。

1. 创建 `heybox-daily-config` KV 和 `heybox-daily-assets` R2，上传已有裁切头像并保存初始 JSON，读回比对内容和图片字节。记录 namespace ID 到 `apps/web/wrangler.jsonc`。外部写入仅限这些资源，不修改生产 Worker。
2. 新增 `apps/web/src/server/sponsors.ts` 和 `apps/web/src/lib/sponsors.ts`；在 `apps/web/test/sponsors.test.ts` 先验证名单字段、顺序、空值与损坏数据、私有 bucket 访问限制、GET/HEAD、缓存命中与故障。仅公开 sponsor 图片，不提供写接口。
3. 修改 `apps/web/src/server/env.ts`、`apps/web/src/worker.ts` 和 `apps/web/src/routes/sponsor.tsx`，接入公开读取与图片路由，保留站点安全响应头与既有缓存策略。图片改由 R2 提供，已有静态头像移动到非 public 的初始化资源目录，避免静态资源掩盖 R2 接入错误。
4. 在 `docs/hosting.md` 写明 KV JSON 格式、R2 上传、路径关系、更新延迟和本地 seed 命令。生产与 staging binding 隔离；本地 seed 只操作本地存储。
5. 使用 Node 24 运行新增测试与 web 既有测试、`tsc --noEmit`、`vp fmt --check`、`vp lint`。运行 `vp build`（只生成本地产物，不部署）。通过本地服务验证真实 Worker 路由和浏览器桌面/手机显示，再检查 Git diff 与资源读回结果。

pnpm 启动器在此环境存在已知错误，可直接调用已安装 node_modules 工具。测试、lint 不带自动修复；格式化仅限本次修改文件。基线失败需区分既有问题，禁止无关修复。撤回本次代码和 binding 即可回滚；资源删除不属于本次操作。

## 首轮执行结果（部署授权前）

- 已创建 KV `heybox-daily-config`，ID `05d04cf561004bd9b5b6084deb9dedf4`；`sponsors` 已写入并从远端读回。
- 用户在开通时另行确认了 R2 条款和超额按量收费；已激活 R2，创建私有 Standard bucket `heybox-daily-assets`。
- 已上传 `sponsors/h-y.jpg`，下载读回的 SHA-256 与本地裁切头像一致：`c10e1974f08ea59f75bf241e7284edb646a1271040240d2cfce72c9d05d50e2a`。
- 新增 6 项测试，总计 86 项 Web 测试通过；类型、lint、格式检查通过。`vp build` 成功，出现 `vite:css-post` 未生成 sourcemap 的非阻断警告。
- 本地 Worker 已验证 KV JSON、R2 图片字节、GET/HEAD、缓存与安全头、404/405；桌面与手机页面显示正常；本地 KV 置空后名单隐藏且收款码保留，随后恢复初始数据。
- 仅创建存储资源并改造本地代码，未部署、未 commit、未 push。
