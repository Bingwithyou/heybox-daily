import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { normalizePath } from './signature.js';
import type { Config, NativeSignature } from './types.js';

export function nativeSignature(endpoint: string, config: Config): NativeSignature {
  const assets = path.resolve(process.env.HEYBOX_ASSETS || 'private/assets');
  for (const file of ['app-metadata.apk', 'libnative-lib.so', 'libglesv3_1.so', 'shader-code.bin']) {
    if (!existsSync(path.join(assets, file))) throw new Error(`缺少签名资源：${file}`);
  }
  const target = path.resolve('signer/target');
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
  const input = {
    path: normalizePath(endpoint), account: config.session.heybox_id,
    debugInfo: config.session.device_id + config.session.heybox_id,
    model: config.device.model, osVersion: config.device.osVersion, version: config.app.version,
    shaderVersion: config.app.shaderVersion, time: String(Math.floor(Date.now() / 1000)),
  };
  const result = spawnSync(java, [
    '-Xms16m', '-Xmx128m', '-Dorg.slf4j.simpleLogger.defaultLogLevel=error',
    '-cp', [path.join(target, 'classes'), path.join(target, 'dependency/*')].join(path.delimiter), 'NativeSigner', assets,
  ], { input: JSON.stringify(input) + '\n', encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('本地原生签名失败，请检查 Java、镜像构建和配套签名资源');
  let signature: NativeSignature;
  try { signature = JSON.parse(result.stdout.trim()); } catch { throw new Error('本地原生签名返回格式异常'); }
  if (!/^[A-Za-z0-9]{32}$/.test(signature.nonce) || !/^[0-9A-F]{1,8}$/.test(signature.hkey) || !/^14:[0-9A-F]{1,8}$/.test(signature._rnd)) {
    throw new Error('本地原生签名校验失败');
  }
  return signature;
}
