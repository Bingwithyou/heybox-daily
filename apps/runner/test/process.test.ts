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
