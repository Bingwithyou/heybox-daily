import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginTiming, loginTimingHeader } from '@heybox/contracts';
import { loginOperations } from '../src/operations.ts';

test('send-code separates token transport from SMS upstream and forwards correlation only to the private token service', async () => {
  let now = 0;
  const timing = new LoginTiming(undefined, () => now);
  const calls: string[] = [];
  const operations = loginOperations({ TOKEN_SERVICE_URL: 'https://token.invalid', TOKEN_SERVICE_TOKEN: 'a'.repeat(64) }, async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (url.hostname === 'token.invalid') {
      assert.equal(new Headers(init?.headers).get(loginTimingHeader), timing.id);
      now += 100;
      return Response.json({ token: 'B' + 'a'.repeat(88) }, { headers: { 'server-timing': 'token_queue;dur=4, token_generate;dur=60, token_tls;dur=12' } });
    }
    assert.equal(new Headers(init?.headers).get(loginTimingHeader), null);
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    now += 50;
    return Response.json({ status: 'ok', result: {} });
  });
  assert.equal((await operations.begin('13800138000', timing)).status, 'sent');
  assert.deepEqual(calls, ['/token', '/account/get_login_code/']);
  assert.deepEqual(timing.values, { token_queue: 4, token_generate: 60, token_tls: 12, token_http: 100, sms_upstream: 50 });
});
test('token and upstream failures retain completed timing without replaying an SMS', async () => {
  for (const failedStage of ['token', 'sms']) {
    const timing = new LoginTiming(); let calls = 0;
    const operations = loginOperations({ TOKEN_SERVICE_URL: 'https://token.invalid', TOKEN_SERVICE_TOKEN: 'a'.repeat(64) }, async input => {
      calls++;
      if (new URL(String(input)).hostname === 'token.invalid') {
        if (failedStage === 'token') return new Response('{}', { status: 503 });
        return Response.json({ token: 'B' + 'a'.repeat(88) });
      }
      throw new Error('private transport error');
    });
    await assert.rejects(operations.begin('13800138000', timing));
    assert.equal(calls, failedStage === 'token' ? 1 : 2);
    assert.ok(timing.values.token_http! >= 0);
    assert.equal(timing.values.sms_upstream !== undefined, failedStage === 'sms');
    assert.ok(!JSON.stringify(timing.values).includes('13800138000'));
  }
});
