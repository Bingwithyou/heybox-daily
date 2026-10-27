import { createHash } from 'node:crypto';
import { runInContext } from 'node:vm';
import type { DOMWindow, JSDOM } from 'jsdom';

const sdkUrl = 'https://static.portal101.cn/dist/web/v3.0.0/fp.min.js';
// Reviewed official SDK. Do not execute an upstream replacement in Node without review.
const sdkSha256 = '7de91adbb7666216d9a72ba1c8655003e393aa5235f6345e399425cd78469a78';
const tokenPattern = /^B[A-Za-z0-9+/=_-]{88}$/;
const publicConfig = {
  organization: '0yD85BjYvGFAvHaSQ1mc', appId: 'heybox_website',
  publicKey: 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCXj9exmI4nQjmT52iwr+yf7hAQ06bfSZHTAHUfRBYiagCf/whhd8es0R79wBigpiHLd28TKA8b8mGR8OiiI1hV+qfynCWihvp3mdj8MiiH6SU3lhro2hkfYzImZB0RmWr2zE4Xt1+A6Oyp6bf+W7JSxYUXHw3nNv7Td4jw4jEFKQIDAQAB',
  staticHost: 'static.portal101.cn', protocol: 'https', noNeedRetry: true,
};

export class DeviceTokenError extends Error {
  readonly stage: string;
  constructor(stage: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.stage = stage;
  }
}
interface DeviceTokenOptions { fetchImpl?: typeof fetch; loadSdk?: () => Promise<string>; timeoutMs?: number }
type SdkWindow = DOMWindow & { _smConf: typeof publicConfig; _smReadyFuncs: Array<() => void>; SMSdk: { getDeviceId?: () => unknown } };

async function downloadSdk(fetchImpl: typeof fetch) {
  const response = await fetchImpl(sdkUrl, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`设备令牌组件下载失败：HTTP ${response.status}`);
  const source = await response.text();
  if (createHash('sha256').update(source).digest('hex') !== sdkSha256) {
    throw new DeviceTokenError('sdk_integrity', '官网设备令牌组件已更新，需要更新程序后重试');
  }
  return source;
}

function applyProperties(target: object, values: object, keys: string[]) {
  const record = values as Record<string, unknown>;
  for (const key of keys) if (record[key] !== undefined) {
    Object.defineProperty(target, key, { configurable: true, get: () => record[key] });
  }
}

export async function getDeviceToken(options: DeviceTokenOptions = {}): Promise<string> {
  let dom: JSDOM | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let stage = 'download_sdk';
  try {
    const source = await (options.loadSdk || (() => downloadSdk(options.fetchImpl || fetch)))();
    stage = 'initialize';
    // Lazy imports keep the daily-task image independent of login dependencies.
    const [{ JSDOM, ResourceLoader, VirtualConsole }, { FingerprintGenerator }] = await Promise.all([
      import('jsdom'), import('fingerprint-generator'),
    ]);
    const { fingerprint } = new FingerprintGenerator().getFingerprint({
      browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['linux'], locales: ['zh-CN', 'zh'],
    });
    dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://www.xiaoheihe.cn/', runScripts: 'outside-only',
      resources: new ResourceLoader({ userAgent: fingerprint.navigator.userAgent }), virtualConsole: new VirtualConsole(),
    });
    const window = dom.window as SdkWindow;
    applyProperties(window.navigator, fingerprint.navigator, ['appCodeName', 'appName', 'appVersion', 'userAgent',
      'language', 'languages', 'platform', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'vendor', 'product', 'productSub']);
    applyProperties(window.screen, fingerprint.screen, ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth', 'availTop', 'availLeft']);
    applyProperties(window, fingerprint.screen, ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio']);
    window._smConf = { ...publicConfig };
    window.SMSdk = {};
    return await new Promise<string>((resolve, reject) => {
      const check = () => {
        try {
          const token = window.SMSdk.getDeviceId?.();
          if (typeof token === 'string' && tokenPattern.test(token)) resolve(token);
        } catch (error) { reject(error); }
      };
      window._smReadyFuncs = [check];
      window.addEventListener('error', event => { event.preventDefault(); reject(new Error(event.message)); });
      timer = setTimeout(() => reject(new Error('等待设备令牌超时')), options.timeoutMs ?? 20_000);
      poll = setInterval(check, 50);
      stage = 'execute_sdk';
      runInContext(source, dom!.getInternalVMContext(), { timeout: 2000, filename: 'heybox-device-sdk.js' });
      stage = 'wait_token';
      check();
    });
  } catch (cause) {
    if (cause instanceof DeviceTokenError) throw cause;
    throw new DeviceTokenError(stage, '未能从官网获取设备令牌，请检查服务器网络后重试', cause instanceof Error ? cause : new Error(String(cause)));
  } finally {
    clearTimeout(timer); clearInterval(poll);
    dom?.window.close();
  }
}
