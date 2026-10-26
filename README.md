<h1 align="center">Heybox Daily</h1>
<p align="center">开箱即用的小黑盒每日签到和每日任务脚本</p>
<p align="center">
  <a href="https://github.com/Cansiny0320/heybox-daily/actions/workflows/ci.yml"><img src="https://github.com/Cansiny0320/heybox-daily/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>
<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/usage.md">使用说明</a> ·
  <a href="https://github.com/Cansiny0320/heybox-daily/issues">问题反馈</a>
</p>

## 快速开始

服务器先装好 Docker 和 Docker Compose，然后拉取项目：

```bash
git clone https://github.com/Cansiny0320/heybox-daily.git
cd heybox-daily
```

构建镜像，按提示输入手机号和验证码：

```bash
docker compose build heybox login
docker compose run --rm login
```

登录后就可以查看和执行任务：

```bash
# 看今天的任务进度
docker compose run --rm heybox check

# 完成今天剩下的任务
docker compose run --rm heybox run
```

想每天自动运行，需要在服务器上加一个 cron 任务，配置方法和更新步骤见 [使用说明](docs/usage.md)。

## 在线托管网站

网站支持小黑盒短信登录、每日自动执行、查看任务、暂停、补跑和删除托管数据。前端与 API 使用 Cloudflare Workers + D1，VPS 负责登录和脚本执行。

开发、部署和数据备份见 [网站部署说明](docs/hosting.md)。CLI 的使用方式保持不变。

## 几点说明

- 服务器登录可能会让手机上的小黑盒退出登录。手机重新登录后，可以再跑一次 `check`，确认服务器是否还能用。
- 提示登录过期时，重新执行 `docker compose run --rm login`。
- 这里的分享任务不会真的给微信好友发消息，也不会替你发帖或写评价。

已在 Linux ARM64 VPS 上实测短信登录、签到和三项分享，奖励正常到账。AMD64 通过了 CI 构建和离线签名检查，还没做真实账号验证。

## 账号信息

登录信息存在服务器上的 `private/config.json`，不要提交到 Git，也不要发给别人。更新代码会保留这个文件，迁移服务器时记得单独备份 `private` 目录。

手机号和验证码不会保存，登录失败也不会覆盖原来的配置。程序会访问小黑盒及其设备验证服务，签名在本地完成。

## 反馈

有问题可以提 [Issue](https://github.com/Cansiny0320/heybox-daily/issues)，带上服务器架构和报错信息。发日志前先删掉账号、Cookie 等个人信息。

## 许可证与致谢

代码使用 [MIT License](LICENSE)。内置的 APP 资源不属于本项目的 MIT 授权范围，来源和依赖见 [NOTICE.md](NOTICE.md)。开发和测试方法见 [使用说明](docs/usage.md#开发)。

## 赞助

觉得好用的话，欢迎通过微信或支付宝支持一下。

![微信与支付宝赞助二维码](.github/sponsorship/sponsorship-cats.png)
