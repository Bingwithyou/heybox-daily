# 使用说明

## 首次准备

服务器只需安装 Docker 和 Docker Compose。签名资源已经随仓库提供，构建时会装入镜像，无需下载或准备 APK。登录在服务器上完成，不需要 Android 手机、ADB 或手动复制 Cookie。

```bash
mkdir -p private state
chmod 700 private
docker compose build heybox login
docker compose run --rm login
```

按提示输入手机号和验证码，国内手机号默认使用 `+86`，其他号码需包含国家或地区区号。程序会在临时 Chromium 中通过官网获取设备令牌，短信登录后验证原生签到和任务接口，成功后生成 `private/config.json`。浏览器随后退出，日常任务镜像不包含浏览器。

验证码输错后可以在同一会话内重输，最多提交三次，直接回车可取消。程序不会自动重发短信。登录失败时原配置会保留；验证码过期、发送频率限制等情况会直接停止。

登录后的目录为：

```text
private/
└── config.json
```

约 2 MB 的公共资源位于 `third-party/heybox-assets`，与账号配置分开。程序直接读取镜像内的资源，日常运行不会下载 APK。旧版本留下的 `private/assets` 不再是默认读取位置；升级不需要重新登录。

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

<details>
<summary>维护或自行替换签名资源</summary>

内置资源与 Android **1.3.398 / build 1142 / shader 14** 配套。`app-metadata.apk` 只保留 APK 的 `AndroidManifest.xml` 和公开签名证书 `META-INF/MAXJIA.RSA`；另外包含两份原生库和公共 shader。文件的 SHA-256 记录在同目录的 `manifest.json`。

维护者可用 Python 3 重新提取已有的配套资源：

```bash
python3 scripts/prepare-assets.py --apk /path/to/base.apk --shader /path/to/shader-code.bin --output private/assets
```

shader 来自官方 `/account/getui/fix` 接口返回的 `code` 字段，经 Base64 解码得到；无需账号登录。脚本校验库和 shader 的哈希，只输出所需的元数据与签名文件。可用 `docker compose run --rm -e HEYBOX_ASSETS=/app/private/assets heybox check` 验证自备资源。更新内置版本时需同步版本配置、资源清单和验证记录，不能直接替换为任意最新版。

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

`pnpm build` 将业务代码和类型声明生成到 `dist/`。`pnpm typecheck` 先构建业务代码，再检查测试的类型；`pnpm test` 完成这两步后，用 Node.js 24 运行 `test/*.test.ts`。测试仍调用编译后的业务代码。

Docker 镜像在构建时完成编译，服务器不需要额外安装 pnpm、Java 或浏览器。直接在本机调试登录时，使用 `node dist/cli.js login`，并通过 `CHROMIUM_PATH` 指定 Chromium 可执行文件。

CI 另在禁用网络、未挂载账号配置的容器中验证原生签名，确认镜像自带的资源完整可用。

项目代码采用 MIT License。第三方资源、依赖与协议参考见 [NOTICE.md](../NOTICE.md)。
