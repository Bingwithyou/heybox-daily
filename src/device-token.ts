import { existsSync } from 'node:fs';

export async function getDeviceToken(): Promise<string> {
  const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
  if (!existsSync(executablePath)) throw new Error('登录需要 Chromium，请使用 docker compose run --rm login');
  let browser: import('playwright-core').Browser | undefined;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://www.xiaoheihe.cn/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => {
      const token = (globalThis as unknown as { X_XHH_TOKENID?: string }).X_XHH_TOKENID;
      return typeof token === 'string' && /^B[A-Za-z0-9+/=_-]{88}$/.test(token);
    }, {}, { timeout: 45000 });
    return await page.evaluate(() => (globalThis as unknown as { X_XHH_TOKENID: string }).X_XHH_TOKENID);
  } catch {
    throw new Error('未能从官网获取设备令牌，请检查服务器网络后重试');
  } finally { await browser?.close(); }
}
