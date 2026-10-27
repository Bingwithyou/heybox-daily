import { HeyboxApiError } from './client.js';
import { saveConfig } from './config.js';
import { getDeviceToken } from './device-token.js';
import { createLoginConfig, normalizePhone, sendLoginCode, verifyLoginCode, type LoginDependencies } from './login-core.js';
import type { Config } from './types.js';
export { createLoginConfig, normalizePhone, encryptPhone, sendLoginCode, verifyLoginCode, type LoginDependencies } from './login-core.js';
interface LoginOptions extends LoginDependencies {
  ask(question: string): Promise<string>;
  log?(message: string): void;
  file?: string;
}

export async function prepareLogin(options: LoginDependencies = {}) {
  const config = createLoginConfig('');
  const token = await (options.getDeviceToken || getDeviceToken)();
  if (!/^B[A-Za-z0-9+/=_-]{88}$/.test(token)) throw new Error('官网返回的设备令牌格式异常');
  config.session.x_xhh_tokenid = token;
  return config;
}

export async function runSmsLogin(options: LoginOptions) {
  const log = options.log || console.log;
  log('正在获取设备令牌…');
  const config = await prepareLogin(options);
  const phone = normalizePhone(await options.ask('手机号（默认 +86）：'));
  await sendLoginCode(config, phone, options);
  log(`验证码已发送至尾号 ${phone.slice(-4)}`);
  let authenticated: Config | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = (await options.ask('验证码（回车取消）：')).trim();
    if (!code) throw new Error('已取消登录，原配置已保留');
    if (!/^\d{4,8}$/.test(code)) {
      if (attempt === 2) throw new Error('验证码应为 4 至 8 位数字');
      log('验证码应为 4 至 8 位数字，请重新输入');
      continue;
    }
    try {
      authenticated = await verifyLoginCode(config, phone, code, options);
      break;
    } catch (error) {
      if (!(error instanceof HeyboxApiError) || !error.retryCode || attempt === 2) throw error;
      log(`${error.message}；请核对验证码后重输，或直接回车取消`);
    }
  }
  if (!authenticated) throw new Error('登录未完成，原配置已保留');
  saveConfig(authenticated, options.file);
  log('登录成功，账号配置已保存');
}
