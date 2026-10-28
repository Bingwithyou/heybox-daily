import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptCredential, decryptCredential } from '@heybox/hosting/crypto';
import { ChallengeStore } from '../src/challenges.ts';
import type { Config } from 'heybox-daily/types';

const config: Config = { session: { heybox_id: '123', pkey: 'secret', device_id: 'device', x_xhh_tokenid: 'token' },
  device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };
test('credentials authenticate account/version and reject tampering or a different key', () => {
  const key = randomBytes(32).toString('base64');
  const encrypted = encryptCredential(config, key);
  assert.deepEqual(decryptCredential(encrypted, key), config);
  assert.ok(!encrypted.ciphertext.includes('secret'));
  for (const altered of [{ ...encrypted, account: '456' }, { ...encrypted, version: crypto.randomUUID() },
    { ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -8) + 'AAAAAAAA' }]) assert.throws(() => decryptCredential(altered, key));
  assert.throws(() => decryptCredential(encrypted, randomBytes(32).toString('base64')));
});
test('a challenge is browser bound, cannot verify concurrently, and is consumed once', async () => {
  let release!: () => void;
  const store = new ChallengeStore({ begin: async () => ({ status: 'sent', config }), send: async () => assert.fail('unexpected captcha'),
    verify: async () => { await new Promise<void>(resolve => release = resolve); return { status: 'authenticated', config }; } });
  const start = await store.begin('+8613800138000', 'a'.repeat(64));
  await assert.rejects(store.verify(start.challenge, '1111', 'b'.repeat(64)), /挑战/);
  const first = store.verify(start.challenge, '1111', 'a'.repeat(64));
  await assert.rejects(store.verify(start.challenge, '1111', 'a'.repeat(64)), /处理中/);
  release(); assert.deepEqual(await first, { status: 'authenticated', config });
  await assert.rejects(store.verify(start.challenge, '1111', 'a'.repeat(64)), /挑战/);
});
test('expiry and three failed attempts discard the challenge', async () => {
  let now = 0; let attempts = 0;
  const store = new ChallengeStore({ begin: async () => ({ status: 'sent', config }), send: async () => assert.fail('unexpected captcha'),
    verify: async () => { attempts++; throw new Error('wrong'); }, now: () => now });
  const expired = await store.begin('+8613800138000', 'a'.repeat(64));
  now = expired.expiresAt + 1;
  await assert.rejects(store.verify(expired.challenge, '1111', 'a'.repeat(64)), /挑战/);
  const start = await store.begin('+8613800138000', 'a'.repeat(64));
  for (let i = 0; i < 3; i++) await assert.rejects(store.verify(start.challenge, '1111', 'a'.repeat(64)), /wrong/);
  await assert.rejects(store.verify(start.challenge, '1111', 'a'.repeat(64)), /挑战/);
  assert.equal(attempts, 3);
});
