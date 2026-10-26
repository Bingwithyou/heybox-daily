import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Credential } from '@heybox/contracts';
import type { Config } from 'heybox-daily/types';
import { validateConfig } from 'heybox-daily/config';

function keyBytes(key: string) {
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length !== 32) throw new Error('CREDENTIAL_KEY 必须是 32 字节的 Base64 密钥');
  return bytes;
}
export function encryptCredential(config: Config, key: string): Credential {
  const account = config.session.heybox_id;
  const version = randomUUID();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(Buffer.from(`${account}:${version}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  return { account, version, ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64') };
}
export function decryptCredential(credential: Credential, key: string): Config {
  const bytes = Buffer.from(credential.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${credential.account}:${credential.version}`));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const value = validateConfig(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')));
  if (value.session.heybox_id !== credential.account) throw new Error('凭据账号不匹配');
  return value;
}
