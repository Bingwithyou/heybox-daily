# heybox-daily

在 Linux 服务器上跑小黑盒每日签到和分享任务。用 Docker 部署，跑完就退出，定时执行交给 cron。

目前支持签到、分享帖子、分享游戏、分享游戏评价。运行前先查当天状态，完成的任务会跳过；执行后再查一次，确认任务已经结算。签名在本地生成，不依赖第三方签名服务。

## 部署

服务器需要 Docker 和 Docker Compose。

```bash
git clone https://github.com/Cansiny0320/heybox-daily.git
cd heybox-daily
```

把准备好的 `private` 目录复制到仓库根目录。里面需要这些文件：

```text
private/
├── config.json
└── assets/
    ├── app-metadata.apk
    ├── libnative-lib.so
    ├── libglesv3_1.so
    └── shader-code.bin
```

`config.json` 存放你自己的 APP 登录态，其他文件用于本地签名。这些文件不会提交到 Git，也不会打进镜像。已有完整 `private` 目录时，直接复制即可；第一次准备的方法见下文。

```bash
chmod 700 private
chmod 600 private/config.json
docker compose build
docker compose run --rm heybox check
docker compose run --rm heybox run
```

`check` 只检查登录、签名和当天任务状态。`run` 会执行未完成的任务；登录过期、接口异常或任务没有结算时，会打印原因并以非零状态退出。

## 定时执行

用 `crontab -e` 添加一行，路径换成你的实际目录。下面按**服务器本地时间**每天 09:15 执行，容器内的当天判断使用北京时间。

```cron
15 9 * * * cd /opt/heybox-daily && /usr/bin/docker compose run --rm -T heybox run >> state/cron.log 2>&1
```

添加前先 `mkdir -p state`，并用 `command -v docker` 确认 Docker 路径。容器用文件锁避免重复运行。查看最近的执行记录：

```bash
tail -n 50 state/cron.log
```

更新代码后重新构建即可：

```bash
git pull --ff-only
docker compose build
docker compose run --rm heybox check
```

## 第一次准备配置

在连接了 Android 手机的电脑上操作，需要 Python 3 和 `adb`。手机先登录小黑盒，并允许 USB 调试：

```bash
python3 scripts/import-android.py
```

连接多台设备时加 `--serial 设备序列号`。脚本读取 APP 当前登录态，保存到 `private/config.json`，不会把凭据打印出来。也可以参考 [config.example.json](config.example.json) 手动填写。网页 Cookie 不能替代这里的 APP 登录态。

签名资源需要自行准备小黑盒 **1.3.398 / build 1142** 的 `base.apk` 和配套 **版本 14** 的 `shader-code.bin`，再执行：

```bash
python3 scripts/prepare-assets.py --apk /path/to/base.apk --shader /path/to/shader-code.bin
```

脚本会提取原生库并检查资源是否匹配。`shader-code.bin` 是 APP 通过 `/app/client/bootstrap` 获取的动态资源，不在 APK 内；本项目暂未提供自动获取流程。没有这份配套资源，无法运行签到。

准备完成后，把整个 `private` 目录传到服务器。服务器运行时不需要连接手机；登录过期后，在手机重新登录、导入并替换 `config.json`。

## 当前限制

- 目前只验证了上述 APP 和签名资源版本，不能保证换版本后仍然可用。
- 已在 Linux ARM64 容器中构建并读取真实账号状态，重复运行会跳过当天已完成的任务。GitHub CI 负责 Linux AMD64 构建和离线测试。
- 三项分享任务已通过真实账号确认完成并增加奖励。签到请求已验证能识别当天已签到；尚未验证未签到日首次领取奖励。
- 分享任务通过 APP 的分享事件接口上报，不会实际往微信发送消息，也不会替你发帖或写评价。
- 只处理签到和这三项分享任务，不处理关注、发帖、充值等其他任务。

## 开发

业务代码使用 Node.js 24 内置模块；原生签名使用 Java 17、Maven 和 Unidbg。

```bash
npm test
mvn -f signer/pom.xml package dependency:copy-dependencies -DincludeScope=runtime
npm run check
```

MIT License。依赖与协议参考见 [NOTICE.md](NOTICE.md)。APP 资源不随仓库发布。
