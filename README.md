<h1 align="center">Heybox Daily</h1>
<p align="center">在自己的服务器上，完成小黑盒每日签到和分享任务。</p>
<p align="center">
  <a href="https://github.com/Cansiny0320/heybox-daily/actions/workflows/ci.yml"><img src="https://github.com/Cansiny0320/heybox-daily/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>
<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/usage.md">使用说明</a> ·
  <a href="https://github.com/Cansiny0320/heybox-daily/issues">问题反馈</a>
</p>

Heybox Daily 用 Docker 在 Linux 服务器上运行，处理每日签到、分享帖子、分享游戏和分享游戏评价。完成的任务会跳过，执行后会重新查询状态，确认任务已经结算。

准备好配套签名资源后，可以直接在服务器上通过手机号和验证码登录，不需要连接 Android 手机或导出 Cookie。目前签名资源仍需手动准备，具体要求见 [首次准备](docs/usage.md#首次准备)。

## 能帮你做什么？

- **完成每日任务**：处理签到和三项分享任务，签名在本地生成。
- **短信登录**：服务器自动获取设备令牌，输入手机号和验证码即可保存登录态。
- **避免重复执行**：先看今天完成了哪些，再处理剩下的任务；重复运行也会跳过已完成项。
- **确认执行结果**：上报成功后继续查任务状态，没有结算就报错，不把请求成功当成任务完成。
- **按时运行**：跑完就退出，用服务器的 cron 每天调用一次即可。

## 快速开始

**1 · 拉取代码。** 服务器先安装 Docker 和 Docker Compose，再执行：

```bash
git clone https://github.com/Cansiny0320/heybox-daily.git
cd heybox-daily
```

**2 · 准备签名资源。** 按 [首次准备](docs/usage.md#首次准备) 把资源放到 `private/assets`。这些文件不会提交到 Git，也不会打进镜像。

**3 · 登录并运行。**

```bash
docker compose build heybox login
docker compose run --rm login
docker compose run --rm heybox check
docker compose run --rm heybox run
```

`login` 会提示输入手机号和验证码。浏览器只在登录时运行，`check` 查看当天状态，`run` 执行未完成的任务。定时运行和更新方法见 [使用说明](docs/usage.md)。

## 使用提示

- **注意 APP 版本**：当前只验证了 Android **1.3.398 / build 1142** 和版本 **14** 的签名资源，其他版本暂不支持。
- **手机只用来收验证码**：服务器独立运行，登录失效时重新执行 `docker compose run --rm login`。
- **分享不会给别人发消息**：通过 APP 的分享事件接口上报，不会实际往微信发送消息，也不会替你发帖或写评价。
- **留意执行失败**：登录过期、接口异常或任务未结算时，会打印原因并以非零状态退出，详细记录见服务器日志。

三项分享任务已通过真实账号确认完成并增加奖励。签到已验证能识别当天已签到，首次未签到日领取奖励仍待验证。Linux ARM64 VPS 已验证从空白登录态获取设备令牌、短信登录和任务读取；Linux AMD64 由 GitHub CI 检查构建和离线测试。

## 数据与隐私

登录信息和签名资源保存在你自己的 `private` 目录。登录时会访问小黑盒官网及其设备验证服务，日常任务请求小黑盒接口，不使用第三方签名服务。构建镜像时会下载依赖。

`config.json` 以 `600` 权限保存登录信息，请勿公开或分享给其他人。手机号和验证码不会保存；新登录通过接口校验后才替换配置，失败时保留原文件。升级代码会保留该目录，备份时也需要单独保留。

## 反馈

遇到问题或有建议，欢迎提交 [Issue](https://github.com/Cansiny0320/heybox-daily/issues)，附上服务器架构、APP 版本和脱敏后的报错。

## 许可证与致谢

项目代码使用 [MIT License](LICENSE)。依赖与协议参考见 [NOTICE.md](NOTICE.md)，APP 安装包及签名资源不随仓库发布。开发和测试命令见 [使用说明](docs/usage.md#开发)。

## 赞助

如果你喜欢这个项目，可以通过微信或支付宝支持后续开发。

![微信与支付宝赞助二维码](.github/sponsorship/sponsorship-cats.png)
