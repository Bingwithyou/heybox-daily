import { constants, publicEncrypt, randomUUID } from 'node:crypto';
import { HeyboxApiError, HeyboxClient } from './client.js';
import { saveConfig, validateConfig } from './config.js';
import { getDeviceToken } from './device-token.js';
import { nativeSignature } from './native.js';
import { androidBase64 } from './report.js';
import { inspect } from './tasks.js';
import type { Config } from './types.js';

// Public login encryption key returned by the verified APP's NDKTools.getrsakey.
const loginKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDZgjVwAiKTjZ55nG+mW6r3TSU4
ECvNYqDMIS/bhCj2QaH5GI/KZb2TBp+CBvUj9SLFnmJQ0kzHzHoGZCQ88VevCffF
7JePGF9cmKQqotlfTKbV4oxV5iLz7JSG6b/Vg7AXtrTolNtWsa8HiB0tI0YClYaQ
lOXm4UxLeSxQwSFETwIDAQAB
-----END PUBLIC KEY-----`;

interface LoginResult {
  profile?: { heybox_id?: string | number };
  account_detail?: { userid?: string | number };
  pkey?: string;
}
type LoginClient = Pick<HeyboxClient, 'native' | 'tasks' | 'signState'>;
export interface LoginDependencies {
  getDeviceToken?: () => Promise<string>;
  clientFactory?: (config: Config) => LoginClient;
  preflight?: (config: Config) => void;
}
interface LoginOptions extends LoginDependencies {
  ask(question: string): Promise<string>;
  log?(message: string): void;
  file?: string;
}

export function normalizePhone(value: string) {
  const phone = value.trim();
  if (/^1[3-9]\d{9}$/.test(phone)) return '+86' + phone;
  if (/^\+[1-9]\d{7,14}$/.test(phone)) return phone;
  throw new Error('手机号格式不正确，海外号码请包含 + 和国家或地区区号');
}

export function encryptPhone(phone: string, key = loginKey) {
  return androidBase64(publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(phone)));
}

export function createLoginConfig(token: string): Config {
  return {
    session: { heybox_id: '-1', pkey: '', device_id: randomUUID(), x_xhh_tokenid: token },
    device: { model: 'PKJ110', osVersion: '17' },
    app: { version: '1.3.398', build: '1142', shaderVersion: '14' },
  };
}

export async function prepareLogin(options: LoginDependencies = {}) {
  const config = createLoginConfig('');
  (options.preflight || (value => nativeSignature('/account/get_login_code/', value)))(config);
  const token = await (options.getDeviceToken || getDeviceToken)();
  if (!/^B[A-Za-z0-9+/=_-]{88}$/.test(token)) throw new Error('官网返回的设备令牌格式异常');
  config.session.x_xhh_tokenid = token;
  return config;
}

export async function sendLoginCode(config: Config, phone: string, options: LoginDependencies = {}) {
  const client = (options.clientFactory || (value => new HeyboxClient(value)))(config);
  await client.native('/account/get_login_code/', {}, new URLSearchParams({ phone_num: encryptPhone(normalizePhone(phone)) }));
}

export async function verifyLoginCode(config: Config, phone: string, code: string, options: LoginDependencies = {}) {
  if (!/^\d{4,8}$/.test(code)) throw new Error('验证码应为 4 至 8 位数字');
  const factory = options.clientFactory || (value => new HeyboxClient(value));
  const result = await factory(config).native<LoginResult>('/account/login_code/', { code, is_new_device: '1' },
    new URLSearchParams({ phone_num: encryptPhone(normalizePhone(phone)) }));
  const account = String(result?.profile?.heybox_id ?? '');
  if (!/^\d+$/.test(account) || account !== String(result?.account_detail?.userid) || !result?.pkey) {
    throw new Error('登录响应中的账号或凭据无效，原配置已保留');
  }
  const authenticated = validateConfig({ ...config, session: { ...config.session, heybox_id: account, pkey: result.pkey } });
  await inspect(factory(authenticated), account);
  return authenticated;
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
