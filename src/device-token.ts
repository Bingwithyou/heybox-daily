import { existsSync } from 'node:fs';
import type { Browser, BrowserType } from 'playwright-core';

export class DeviceTokenError extends Error {
  readonly stage: string;
  constructor(stage: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.stage = stage;
  }
}
interface DeviceTokenOptions { executablePath?: string; launch?: BrowserType['launch'] }
export async function getDeviceToken(options: DeviceTokenOptions = {}): Promise<string> {
  const executablePath = options.executablePath || process.env.CHROMIUM_PATH || '/usr/bin/chromium';
  if (!existsSync(executablePath)) throw new DeviceTokenError('executable', '登录需要 Chromium，请使用 docker compose run --rm login');
  let browser: Browser | undefined;
  let stage = 'launch';
  try {
    const { chromium } = await import('playwright-core');
    browser = await (options.launch || chromium.launch.bind(chromium))({ executablePath, headless: true });
    stage = 'context';
    const context = await browser.newContext();
    stage = 'page';
    const page = await context.newPage();
    stage = 'navigate';
    await page.goto('https://www.xiaoheihe.cn/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    stage = 'wait_token';
    await page.waitForFunction(() => {
      const token = (globalThis as unknown as { X_XHH_TOKENID?: string }).X_XHH_TOKENID;
      return typeof token === 'string' && /^B[A-Za-z0-9+/=_-]{88}$/.test(token);
    }, {}, { timeout: 45000 });
    stage = 'read_token';
    return await page.evaluate(() => (globalThis as unknown as { X_XHH_TOKENID: string }).X_XHH_TOKENID);
  } catch (cause) {
    throw new DeviceTokenError(stage, '未能从官网获取设备令牌，请检查服务器网络后重试', cause);
  } finally { await browser?.close().catch(() => {}); }
}
