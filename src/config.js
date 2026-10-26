import { readFileSync } from 'node:fs';
import path from 'node:path';

export function validateConfig(config) {
  for (const [section, keys] of Object.entries({
    session: ['heybox_id', 'pkey', 'device_id', 'x_xhh_tokenid'],
    device: ['model', 'osVersion'], app: ['version', 'build', 'shaderVersion'],
  })) {
    for (const key of keys) {
      const value = config?.[section]?.[key];
      if (typeof value !== 'string' || !value || /[\r\n;]/.test(value)) throw new Error(`配置缺少或无效：${section}.${key}`);
    }
  }
  if (!/^\d+$/.test(config.session.heybox_id)) throw new Error('请填写真实的盒友 ID');
  if (config.app.version !== '1.3.398' || config.app.build !== '1142' || config.app.shaderVersion !== '14') {
    throw new Error('当前仅验证了 APP 1.3.398 / build 1142 / shader 14，请使用配套资源');
  }
  return config;
}

export function loadConfig() {
  const file = path.resolve(process.env.HEYBOX_CONFIG || 'private/config.json');
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('无法读取账号配置，请准备 private/config.json 或设置 HEYBOX_CONFIG'); }
  return validateConfig(data);
}
