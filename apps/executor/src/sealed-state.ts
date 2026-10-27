import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function seal(value: unknown, secret: string, identity: string) {
  const key = Buffer.from(secret, 'base64');
  if (key.length !== 32) throw new Error('Invalid state key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`heybox:login-challenge:v1:${identity}`));
  const content = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
}
export function unseal<T>(value: string, secret: string, identity: string): T {
  const content = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(secret, 'base64'), content.subarray(0, 12));
  cipher.setAAD(Buffer.from(`heybox:login-challenge:v1:${identity}`));
  cipher.setAuthTag(content.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(content.subarray(28)), cipher.final()]).toString('utf8')) as T;
}
