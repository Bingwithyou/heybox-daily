# 赞助名单配置（已批准）

## 目标与范围

赞助名单由 Cloudflare Workers KV 管理，头像由 R2 Standard 存储。不使用 Images 付费服务。创建资源、初始化 H*y 的名单记录、上传已有裁切头像并改造本地代码。首轮仅实现和验证；用户随后于 2026-10-28 批准提交、推送后部署网站 Worker。

## 数据与展示

- KV namespace：`heybox-daily-config`，binding：`SITE_CONFIG`，key：`sponsors`，不设置过期时间。
- 值为 JSON 数组，每项包含稳定 `id`、显示昵称 `name`、站内头像路径 `avatar`，按数组顺序显示。
- R2 bucket：`heybox-daily-assets`，binding：`SPONSOR_ASSETS`，对象位于 `sponsors/` 前缀。bucket 保持私有，由现有 Worker 的 `/sponsors/<文件名>` 提供只读访问及缓存。
- 页面保持已有布局，通过公开只读 `/api/sponsors` 读取名单；空配置或暂时读取失败时不显示名单，不影响收款码。错误写服务端日志，不回退到硬编码名单。
- 图片路径仅接受该站点的 sponsors 图片路径，避免将 bucket 其他对象公开。支持 GET/HEAD，图片缓存 1 小时；替换头像优先采用新文件名。
- KV 全球传播可能延迟约 60 秒或更久。前端不轮询，重新访问页面读取配置。

## 验收

真实 KV 和 R2 创建并读回验证；本地展示来自 KV 的 H*y 和 R2 头像；修改本地 KV 可更新名单，空配置或异常不影响赞助页面。相关测试、类型检查、格式、lint 和构建通过。生产 Worker 保持未部署。

## 风险与回滚

R2 若未激活或需要同意计费条款，先完成独立的代码与 KV 工作，等待用户完成必要开通。资源授权不包含购买 Images。预发布环境不连接生产 KV/R2；缺少 binding 时名单隐藏。回滚时仅撤回本次代码和 bindings，远端数据可保留，不主动删除资源。
