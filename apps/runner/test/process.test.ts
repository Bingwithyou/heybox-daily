import test from 'node:test';
import assert from 'node:assert/strict';
import { runChild } from '../src/process.ts';
import { createRunnerServer } from '../src/server.ts';
import { ChallengeStore } from '../src/challenges.ts';
import { failureCategory } from '../src/worker.ts';
import { HeyboxApiError } from 'heybox-daily/client';

test('failure diagnostics identify the stage without exposing exception text or credentials', () => {
  assert.equal(failureCategory(new HeyboxApiError('/account/get_login_code/', 'show_captcha', 'private-fixture')), 'captcha_required');
  assert.equal(failureCategory(new Error('未能从官网获取设备令牌')), 'device_token');
  assert.equal(failureCategory(new Error('请求过于频繁，请稍后再试')), 'upstream_rate_limit');
  assert.equal(failureCategory(new Error('HTTP 403：/account/get_login_code/')), 'upstream_http');
  assert.equal(failureCategory(new Error('private-phone-and-secret')), 'internal');
});

test('child execution has a hard timeout and does not echo credentials on failure', async () => {
  await assert.rejects(runChild({ action: 'unknown', secret: 'private-fixture' }, 1), /执行超时/);
  await assert.rejects(runChild({ action: 'unknown', secret: 'private-fixture' }), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('private-fixture')); return true;
  });
});
test('the login server requires service authentication before parsing or calling upstream', async () => {
  const store = new ChallengeStore({ begin: async () => assert.fail('unexpected login'), send: async () => assert.fail('unexpected captcha'), verify: async () => assert.fail('unexpected verify') });
  const server = createRunnerServer(store, 'a'.repeat(64), Buffer.alloc(32).toString('base64'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/login/begin`, { method: 'POST', body: 'invalid body' });
    assert.equal(response.status, 401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('the wakeup endpoint requires the service token and only signals the existing queue', async () => {
  let wakes = 0;
  const store = new ChallengeStore({ begin: async () => assert.fail('unexpected login'),
    send: async () => assert.fail('unexpected captcha'), verify: async () => assert.fail('unexpected verify') });
  const token = 'a'.repeat(64);
  const server = createRunnerServer(store, token, Buffer.alloc(32).toString('base64'), () => { wakes++; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/tasks/wake`;
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal(wakes, 0);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status, 204);
    assert.equal(wakes, 1);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 405);
    assert.equal(wakes, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
