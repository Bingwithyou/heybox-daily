# 实施计划：移除 Chromium

设计：[Node.js 设备令牌](../specs/2026-10-27-node-device-token.md)。沿用已授权的真实验证、Node.js 替换与随机指纹范围，不创建 worktree 或执行 Git 发布动作。

1. `test/device-token.test.ts`：先增加有效/待处理/异常令牌、下载/执行错误、超时、指纹生命周期的离线回归，确认旧实现不满足新接口。测试不发送短信或访问上游。
2. `src/device-token.ts`、`package.json`、`pnpm-lock.yaml`：实现动态加载的 jsdom 环境、每次登录一次的指纹、官方 SDK 来源校验、超时和资源释放。固定已实测的 jsdom 27.0.1、fingerprint-generator 2.1.89，删除 playwright-core。
3. `Dockerfile`、`NOTICE.md`、`docs/usage.md`、`docs/hosting.md`：移除浏览器层和环境变量，更新当前运行说明；历史设计记录保留。daily runtime 仍不需要登录依赖。
4. 运行 `pnpm test`、runner 的 typecheck/test，以及 CI 已要求的 web test/build/typecheck/lint/format:check/test:integration。构建会更新忽略的 dist；integration 只使用隔离 D1 与 mock runner。记录已有无关失败，不擅自修复。
5. 构建 runtime/login/runner 镜像，检查 help、离线签名/runner 测试和不含浏览器依赖；在候选 login/runner 中只获取官方令牌，复核真实 API 已接受的随机令牌与现有凭据兼容性。除非出现相关新失败，不重复发送真实短信。
6. 保留旧生产镜像后发布候选 runner，检查服务认证、进程资源及站点只读接口；回滚仅切换本次 runner 镜像，保留已有 web 和内存改动。新登录若使本账号旧凭据失效，先准备同账号新密文并取得对应写回授权，不改变托管开关或任务记录。

成功标准：真实完整登录已有成功证据，最终实现的令牌签发可用；所有相关检查通过，运行镜像不包含 Chromium/Playwright，现有账号/任务合同与数据量不增加。
