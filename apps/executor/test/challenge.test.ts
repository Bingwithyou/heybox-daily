import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PersistentChallenge, type ChallengeStorage, type LoginOperations } from '../src/challenge.ts';
import type { Config } from 'heybox-daily/types';
import { LoginFailure } from '@heybox/contracts';

class MemoryStorage implements ChallengeStorage {
  data = new Map<string, string>(); alarm: number | null = null;
  async get<T>(key: string) { return this.data.get(key) as T | undefined; }
  async put(key: string, value: string) { this.data.set(key, value); }
  async setAlarm(time: number) { this.alarm = time; }
  async deleteAlarm() { this.alarm = null; }
  async deleteAll() { this.data.clear(); }
  async transaction<T>(fn: (tx: Pick<ChallengeStorage, 'put' | 'setAlarm'>) => Promise<T>) { return fn(this); }
}
const config: Config = { session: { heybox_id: '123', pkey: 'secret-credential', device_id: 'device', x_xhh_tokenid: 'secret-token' },
  device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };
const binding = 'a'.repeat(64);
const proof = { ticket: 'verified-ticket', randstr: 'verified-randstr' };
async function fixture(overrides: Partial<LoginOperations> = {}) {
  const storage = new MemoryStorage(); const id = randomUUID(); let now = 1000;
  const operations: LoginOperations = { begin: async () => ({ status: 'sent', config }),
    send: async () => ({ status: 'sent', config }), verify: async () => ({ status: 'authenticated', config }), ...overrides };
  const make = async () => { const value = new PersistentChallenge(storage, Buffer.alloc(32, 5).toString('base64'), id, operations, () => now); await value.load(); return value; };
  return { storage, id, operations, challenge: await make(), reload: make, advance: (ms: number) => { now += ms; } };
}
test('login state survives hibernation encrypted and preserves browser binding and single use', async () => {
  const f = await fixture();
  const start = await f.challenge.begin('13800138000', binding);
  assert.equal(start.challenge, f.id);
  const stored = JSON.stringify([...f.storage.data]);
  for (const secret of ['13800138000', 'secret-token', 'secret-credential', binding]) assert.ok(!stored.includes(secret));
  assert.equal(f.storage.alarm, start.expiresAt);
  const resumed = await f.reload();
  await assert.rejects(resumed.verify('1234', 'b'.repeat(64)), /挑战/);
  assert.equal((await resumed.verify('1234', binding)).status, 'authenticated');
  assert.equal(f.storage.data.size, 0); assert.equal(f.storage.alarm, null);
  await assert.rejects((await f.reload()).verify('1234', binding), /挑战/);
});
test('tickets and attempt counts are durable and same challenge cannot run concurrent requests', async () => {
  let release!: () => void; let sends = 0;
  const f = await fixture({ begin: async () => ({ status: 'captcha', appId: '123', config }),
    send: async () => { sends++; await new Promise<void>(r => release = r); return { status: 'captcha', appId: '123', config }; } });
  await f.challenge.begin('13800138000', binding);
  const sending = f.challenge.completeCaptcha(proof, binding);
  await new Promise(r => setTimeout(r, 0));
  await assert.rejects(f.challenge.completeCaptcha({ ...proof, ticket: 'other' }, binding), /处理中/);
  release(); await sending;
  const resumed = await f.reload();
  await assert.rejects(resumed.completeCaptcha(proof, binding), /已使用/);
  assert.equal(sends, 1);
});
test('interrupted upstream operation is not automatically retried after reconstruction', async () => {
  let release!: () => void; let calls = 0;
  const f = await fixture({ verify: async () => { calls++; await new Promise<void>(r => release = r); return { status: 'authenticated', config }; } });
  await f.challenge.begin('13800138000', binding);
  const pending = f.challenge.verify('1234', binding);
  await new Promise(r => setTimeout(r, 0));
  const replacement = await f.reload();
  await assert.rejects(replacement.verify('1234', binding), /挑战/);
  assert.equal(calls, 1); assert.equal(f.storage.data.size, 0);
  // A real eviction terminates the old invocation. Finish the test's detached promise only.
  release(); await pending;
});
test('alarm expiry rejects late upstream success and clears temporary state', async () => {
  let release!: () => void;
  const f = await fixture({ verify: async () => { await new Promise<void>(r => release = r); return { status: 'authenticated', config }; } });
  await f.challenge.begin('13800138000', binding);
  const pending = f.challenge.verify('1234', binding);
  await new Promise(r => setTimeout(r, 0));
  f.advance(300_001); await f.challenge.expire(); release();
  await assert.rejects(pending, /过期/);
  assert.equal(f.storage.data.size, 0); assert.equal(f.storage.alarm, null);
});
test('captcha verification resumes saved code after hibernation and a wrong code can be replaced', async () => {
  const codes: string[] = [];
  const f = await fixture({ verify: async (_config, _phone, code, captcha) => {
    codes.push(code);
    if (codes.length === 1) return { status: 'captcha', appId: '123', config };
    if (captcha) throw new Error('wrong code');
    return { status: 'authenticated', config };
  } });
  await f.challenge.begin('13800138000', binding);
  await f.challenge.verify('1234', binding);
  const resumed = await f.reload();
  const retry = await resumed.completeCaptcha(proof, binding);
  assert.equal(retry.status, 'sent');
  assert.equal((await resumed.verify('5678', binding)).status, 'authenticated');
  assert.deepEqual(codes, ['1234', '1234', '5678']);
});
test('SMS rate limits discard challenge and never cause another automatic send', async () => {
  let calls = 0;
  const f = await fixture({ begin: async () => ({ status: 'captcha', appId: '123', config }),
    send: async () => { calls++; throw new LoginFailure('upstream_rate_limit'); } });
  await f.challenge.begin('13800138000', binding);
  await assert.rejects(f.challenge.completeCaptcha(proof, binding), LoginFailure);
  await assert.rejects((await f.reload()).completeCaptcha({ ...proof, ticket: 'another' }, binding), /挑战/);
  assert.equal(calls, 1);
});
test('independent challenges do not share the old four-operation limit', async () => {
  const releases: Array<() => void> = [];
  const fixtures = await Promise.all(Array.from({ length: 8 }, () => fixture({ verify: async () => {
    await new Promise<void>(r => releases.push(r)); return { status: 'authenticated', config };
  } })));
  await Promise.all(fixtures.map(f => f.challenge.begin('13800138000', binding)));
  const pending = fixtures.map(f => f.challenge.verify('1234', binding));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(releases.length, 8); releases.forEach(r => r());
  assert.ok((await Promise.all(pending)).every(r => r.status === 'authenticated'));
});
