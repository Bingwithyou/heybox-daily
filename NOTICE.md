# 来源与许可

- `src/signature.ts` 中的 Web 签名算法改写自 [XiaHouSheng/heybox-core](https://github.com/XiaHouSheng/heybox-core/blob/2fd1bbed98c4f82a99d432048e6d2f25bfaeb0a9/src/encoder_cli/process_origin.js)，保留 [MIT 许可](third-party/heybox-core-LICENSE)。
- 原生签名使用 [Unidbg 0.9.9](https://github.com/zhkl0228/unidbg)，按 Apache-2.0 授权，通过 Maven 下载。JNI 适配器按照 APP 1.3.398 的调用约定实现。
- 登录容器使用 Apache-2.0 授权的 [Playwright](https://github.com/microsoft/playwright) 和 Debian 提供的 Chromium。设备令牌由小黑盒官网正常加载的 SDK 生成，SDK 源码不随本仓库发布。
- `signer/src/main/java/net/fornwall/jelf/ElfParser.java` 来自 Unidbg 内的 [JElf](https://github.com/fornwall/jelf)，保留 [MIT 许可](third-party/jelf-LICENSE)。此处修正了 `byteSwap(long)` 的 64 位截断问题。
- 协议调查参考了 [yowiv08/heybox](https://github.com/yowiv08/heybox/tree/15f7fb8bffd2f6d58b1e38755002939fc919b055) 和 [zhong08/heybox-checkin](https://github.com/zhong08/heybox-checkin/tree/b7cc58df7c4bd1527ad25a333985ea2a59c792e4)。未打包这两个项目的框架或账号数据。

`third-party/heybox-assets/` 保存从小黑盒 Android 1.3.398 / build 1142 提取的两份原生库、仅包含清单和公开签名证书的精简包，以及官方 `/account/getui/fix` 接口提供的 shader 14。版本和 SHA-256 见该目录的 `manifest.json`。这些文件供所有账号共用，不含登录凭据、设备标识或用户数据，也不包含完整 APK。

上述 APP 资源的权利属于其原权利人，不属于本项目的 MIT 授权范围。
