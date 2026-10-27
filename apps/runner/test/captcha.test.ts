import test from 'node:test';
import assert from 'node:assert/strict';
import { ChallengeStore, type LoginStep } from '../src/challenges.ts';
import type { Config } from 'heybox-daily/types';
import { LoginFailure } from '@heybox/contracts';

const config: Config = { session: { heybox_id: '123', pkey: 'private-key', device_id: 'original-device', x_xhh_tokenid: 'private-token' },
  device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };
const binding = 'a'.repeat(64);
const captcha = (): LoginStep => ({ status: 'captcha', appId: '1234567890', config });
const sent = (): LoginStep => ({ status: 'sent', config });
const authenticated = (): LoginStep => ({ status: 'authenticated', config });
const proof = { ticket: 'verified-ticket', randstr: 'verified-randstr' };

test('a browser-bound CAPTCHA resumes the original device and sends SMS exactly once', async () => {
  let sends = 0;
  const store = new ChallengeStore({ begin: async () => captcha(),
    send: async (original, phone, value) => {
      sends++; assert.equal(original, config); assert.equal(phone, '+8613800138000'); assert.deepEqual(value, proof); return sent();
    }, verify: async () => authenticated() });
  const start = await store.begin('13800138000', binding);
  assert.equal(start.status, 'captcha');
  assert.ok(!JSON.stringify(start).includes('private'));
  assert.ok(!JSON.stringify(start).includes('13800138000'));
  await assert.rejects(store.verify(start.challenge, '1234', binding), /人机验证/);
  await assert.rejects(store.completeCaptcha(start.challenge, proof, 'b'.repeat(64)), /挑战/);
  const ready = await store.completeCaptcha(start.challenge, proof, binding);
  assert.equal(ready.status, 'sent');
  await assert.rejects(store.completeCaptcha(start.challenge, proof, binding), /验证状态/);
  const done = await store.verify(start.challenge, '1234', binding);
  assert.equal(done.status, 'authenticated');
  await assert.rejects(store.verify(start.challenge, '1234', binding), /挑战/);
  assert.equal(sends, 1);
});

test('CAPTCHA callbacks cannot run concurrently or replay a ticket, even when upstream asks again', async () => {
  let release!: () => void; let calls = 0;
  const store = new ChallengeStore({ begin: async () => captcha(), send: async () => {
    calls++; await new Promise<void>(resolve => release = resolve); return captcha();
  }, verify: async () => authenticated() });
  const start = await store.begin('13800138000', binding);
  const first = store.completeCaptcha(start.challenge, proof, binding);
  await assert.rejects(store.completeCaptcha(start.challenge, { ...proof, ticket: 'second' }, binding), /处理中/);
  release(); assert.equal((await first).status, 'captcha');
  await assert.rejects(store.completeCaptcha(start.challenge, proof, binding), /已使用/);
  assert.equal(calls, 1);
});

test('verification CAPTCHA resumes the saved SMS code and only yields credentials after upstream accepts', async () => {
  const codes: string[] = [];
  const store = new ChallengeStore({ begin: async () => sent(), send: async () => assert.fail('must not resend SMS'),
    verify: async (original, _phone, code, value) => {
      assert.equal(original, config); codes.push(code);
      return value ? authenticated() : captcha();
    } });
  const start = await store.begin('13800138000', binding);
  const challenge = await store.verify(start.challenge, '1234', binding);
  assert.equal(challenge.status, 'captcha');
  assert.ok(!JSON.stringify(challenge).includes('private-key'));
  const done = await store.completeCaptcha(start.challenge, proof, binding);
  assert.equal(done.status, 'authenticated');
  assert.deepEqual(codes, ['1234', '1234']);
});

test('expired CAPTCHA and late upstream success cannot complete a login', async () => {
  let now = 0; let release!: () => void;
  const store = new ChallengeStore({ now: () => now, begin: async () => sent(), send: async () => sent(),
    verify: async () => { await new Promise<void>(resolve => release = resolve); return authenticated(); } });
  const start = await store.begin('13800138000', binding);
  const pending = store.verify(start.challenge, '1234', binding);
  now = start.expiresAt + 1; release();
  await assert.rejects(pending, /过期/);
  await assert.rejects(store.completeCaptcha(start.challenge, proof, binding), /挑战/);
});

test('three rejected CAPTCHA submissions discard the temporary login', async () => {
  let calls = 0;
  const store = new ChallengeStore({ begin: async () => captcha(), send: async () => { calls++; return captcha(); }, verify: async () => authenticated() });
  const start = await store.begin('13800138000', binding);
  for (let i = 0; i < 2; i++) assert.equal((await store.completeCaptcha(start.challenge, { ...proof, ticket: `ticket-${i}` }, binding)).status, 'captcha');
  await assert.rejects(store.completeCaptcha(start.challenge, { ...proof, ticket: 'ticket-2' }, binding), /次数/);
  await assert.rejects(store.completeCaptcha(start.challenge, { ...proof, ticket: 'ticket-3' }, binding), /挑战/);
  assert.equal(calls, 3);
});

test('a rejected SMS code after CAPTCHA returns to code entry without sending another SMS', async () => {
  let calls = 0;
  const store = new ChallengeStore({ begin: async () => sent(), send: async () => assert.fail('unexpected SMS'),
    verify: async (_config, _phone, code) => {
      calls++;
      if (calls === 1) return captcha();
      if (calls === 2) throw new Error('wrong code');
      assert.equal(code, '5678'); return authenticated();
    } });
  const start = await store.begin('13800138000', binding);
  await store.verify(start.challenge, '1234', binding);
  const retry = await store.completeCaptcha(start.challenge, proof, binding);
  assert.equal(retry.status, 'sent');
  if (retry.status === 'sent') { assert.equal(retry.retryAfter, 0); assert.match(retry.message!, /验证码未通过/); }
  assert.equal((await store.verify(start.challenge, '5678', binding)).status, 'authenticated');
});

test('CAPTCHA continuations and verification share the global four-operation limit with new logins', async () => {
  const releases: Array<() => void> = [];
  const store = new ChallengeStore({ begin: async phone => phone.endsWith('8004') ? sent() : captcha(), send: async () => {
    await new Promise<void>(resolve => releases.push(resolve)); return sent();
  }, verify: async () => { await new Promise<void>(resolve => releases.push(resolve)); return authenticated(); } });
  const one = await store.begin('13800138000', binding);
  const two = await store.begin('13800138001', binding);
  const three = await store.begin('13800138002', binding);
  const four = await store.begin('13800138003', binding);
  const five = await store.begin('13800138004', binding);
  const first = store.completeCaptcha(one.challenge, proof, binding);
  const second = store.completeCaptcha(two.challenge, proof, binding);
  const third = store.completeCaptcha(three.challenge, proof, binding);
  const fourth = store.verify(five.challenge, '1234', binding);
  try {
    assert.equal(releases.length, 4);
    await assert.rejects(store.completeCaptcha(four.challenge, proof, binding), /繁忙/);
    await assert.rejects(store.begin('13800138005', binding), /繁忙/);
  } finally {
    releases.forEach(release => release());
    await Promise.allSettled([first, second, third, fourth]);
  }
  assert.equal((await store.begin('13800138005', binding)).status, 'captcha');
});

test('four new logins can run together and a failed login releases its operation slot', async () => {
  const releases: Array<(fail?: boolean) => void> = [];
  const store = new ChallengeStore({ begin: async () => {
    await new Promise<void>((resolve, reject) => releases.push(fail => fail ? reject(new Error('upstream unavailable')) : resolve()));
    return sent();
  }, send: async () => sent(), verify: async () => authenticated() });
  const starts = Array.from({ length: 4 }, (_, index) => store.begin(`1380013800${index}`, binding));
  const observed = Promise.allSettled(starts);
  try {
    assert.equal(releases.length, 4);
    await assert.rejects(store.begin('13800138005', binding), /繁忙/);
    releases[0](true);
    await assert.rejects(starts[0], /upstream unavailable/);
    const retry = store.begin('13800138005', binding);
    assert.equal(releases.length, 5);
    releases[4]();
    assert.equal((await retry).status, 'sent');
  } finally {
    releases.forEach(release => release());
    await observed;
  }
});

test('upstream SMS throttling ends the CAPTCHA challenge instead of encouraging another challenge', async () => {
  let sends = 0;
  const store = new ChallengeStore({ begin: async () => captcha(), send: async () => {
    sends++; throw new LoginFailure('upstream_rate_limit');
  }, verify: async () => authenticated() });
  const start = await store.begin('13800138000', binding);
  await assert.rejects(store.completeCaptcha(start.challenge, proof, binding), error =>
    error instanceof LoginFailure && error.code === 'upstream_rate_limit');
  await assert.rejects(store.completeCaptcha(start.challenge, { ...proof, ticket: 'another' }, binding), /挑战/);
  assert.equal(sends, 1);
});

test('verification throttling preserves the SMS session and the actual error message', async () => {
  const store = new ChallengeStore({ begin: async () => sent(), send: async () => assert.fail('unexpected SMS'),
    verify: async (_config, _phone, _code, proof) => {
      if (!proof) return captcha();
      throw new LoginFailure('upstream_rate_limit');
    } });
  const start = await store.begin('13800138000', binding);
  assert.equal(start.status, 'sent');
  if (start.status === 'sent') assert.equal(start.retryAfter, 60);
  await store.verify(start.challenge, '1234', binding);
  const retry = await store.completeCaptcha(start.challenge, proof, binding);
  assert.equal(retry.status, 'sent');
  if (retry.status === 'sent') {
    assert.match(retry.message!, /小黑盒.*频繁.*稍后/);
    assert.ok(!retry.message!.includes('核对'));
  }
});
