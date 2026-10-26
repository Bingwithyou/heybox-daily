# 使用说明

## 首次准备

登录在服务器上完成，不需要 Android 手机、ADB 或手动复制 Cookie。第一次仍需准备签名资源：小黑盒 **1.3.398 / build 1142** 的 `base.apk` 和配套 **版本 14** 的 `shader-code.bin`，在有 Python 3 的电脑上执行：

```bash
python3 scripts/prepare-assets.py --apk /path/to/base.apk --shader /path/to/shader-code.bin
```

脚本会提取原生库并检查资源是否匹配。`shader-code.bin` 不在 APK 中，来自小黑盒 `/account/getui/fix` 接口返回的 `code` 字段，需要 Base64 解码为二进制文件。当前脚本还没有自动获取这份文件的功能。

将生成的 `private/assets` 复制到服务器的仓库目录，再登录：

```bash
mkdir -p state
chmod 700 private
docker compose build heybox login
docker compose run --rm login
```

按提示输入手机号和验证码，国内手机号默认使用 `+86`，其他号码需包含国家或地区区号。程序会在临时 Chromium 中通过官网获取设备令牌，短信登录后验证原生签到和任务接口，成功后生成 `private/config.json`。浏览器随后退出，日常任务镜像不包含浏览器。

验证码输错后可以在同一会话内重输，最多提交三次，直接回车可取消。程序不会自动重发短信。登录失败时原配置会保留；验证码过期、发送频率限制等情况会直接停止。

登录后的目录为：

```text
private/
├── config.json
└── assets/
    ├── app-metadata.apk
    ├── libnative-lib.so
    ├── libglesv3_1.so
    └── shader-code.bin
```

检查和运行：

```bash
docker compose run --rm heybox check
docker compose run --rm heybox run
```

登录过期时重新运行 `docker compose run --rm login`。不要把网页账号 Cookie 当成 APP 登录态；本项目通过 APP 短信登录接口获取原生凭据。

<details>
<summary>已有 Android 登录态的导入方式</summary>

旧导入脚本继续可用：在连接了 Android 手机的电脑上安装 Python 3 和 `adb`，手机先登录小黑盒并允许 USB 调试，再运行 `python3 scripts/import-android.py`。连接多台设备时加 `--serial 设备序列号`，生成的 `private/config.json` 可复制到服务器使用。手动配置格式见 [config.example.json](../config.example.json)。

</details>

## 定时运行与更新

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
docker compose build heybox login
docker compose run --rm heybox check
```

## 开发

业务代码使用 TypeScript 和 Node.js 24，通过 pnpm 管理依赖、编译和测试。原生签名使用 Java 17、Maven 和 Unidbg，登录使用 Playwright Core 和 Chromium。首次使用时安装项目固定的 pnpm 版本：

```bash
npm install --global pnpm@12.15.0
```

在仓库目录执行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
mvn -f signer/pom.xml package dependency:copy-dependencies -DincludeScope=runtime
pnpm check
```

`pnpm build` 将 `src/*.ts` 编译到 `dist/`，Docker 镜像在构建时完成编译。运行容器不需要在服务器额外安装 pnpm、Java 或浏览器。直接在本机调试登录时，使用 `node dist/cli.js login`，并通过 `CHROMIUM_PATH` 指定 Chromium 可执行文件。

MIT License。依赖与协议参考见 [NOTICE.md](../NOTICE.md)。APP 资源不随仓库发布。
