import test from 'node:test';
import assert from 'node:assert/strict';
import { HeyboxApiError, HeyboxClient, HeyboxRequestError, parseRetryAfter } from 'heybox-daily/client';
import { dailyFailure, DailyTrace } from '../src/daily-trace.ts';
import { encryptCredential } from '@heybox/hosting/crypto';
import { beijingDate } from '@heybox/contracts';
import { executeDaily } from '../src/operations.ts';

const config = { session: { heybox_id: '12345', pkey: 'SECRET', x_xhh_tokenid: 'SECRET-TOKEN', device_id: 'device' },
  device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };

test('HTTP, business and transport diagnostics preserve safe evidence without raw data', async () => {
  for (const [response, category] of [[new Response('SECRET', { status: 429, headers: { 'retry-after': '900' } }), 'rate_limit'],
    [new Response('SECRET', { status: 503 }), 'http'], [new Response('SECRET'), 'protocol'],
    [Response.json({ status: 'relogin', msg: 'SECRET' }), 'auth']] as const) {
    const client = new HeyboxClient(config, { fetchImpl: async () => response });
    await assert.rejects(client.tasks(), (error: unknown) => {
      const record = dailyFailure(error, 'inspect', 12);
      assert.equal(record.category, category);
      assert.equal(record.endpoint, '/task/list_v2/');
      if (category === 'rate_limit') assert.equal(record.retryAfterMs, 900_000);
      assert.ok(!JSON.stringify(record).includes('SECRET'));
      return true;
    });
  }
  const client = new HeyboxClient(config, { fetchImpl: async () => { throw new Error('SECRET'); } });
  await assert.rejects(client.tasks(), (error: unknown) => dailyFailure(error, 'inspect', 2).category === 'network');
  assert.equal(dailyFailure(new HeyboxApiError('/task/list_v2/', 'show_captcha', 'SECRET'), 'inspect', 3).category, 'captcha');
  assert.equal(dailyFailure(new HeyboxApiError('/task/list_v2/', 'failed', '请求太频繁 SECRET'), 'inspect', 3).category, 'rate_limit');
  assert.equal(parseRetryAfter('Thu, 29 Oct 2026 00:01:00 GMT', Date.parse('2026-10-29T00:00:00Z')), 60_000);
  assert.equal(parseRetryAfter('-1'), undefined);
  assert.equal(parseRetryAfter('bad'), undefined);
});

test('daily trace includes stable attempt identity and excludes raw error messages', t => {
  const logs: string[] = [];
  t.mock.method(console, 'warn', (value: string) => logs.push(value));
  const trace = new DailyTrace({ id: 'job', lease: 'attempt', date: '2026-10-29' });
  trace.fail(new HeyboxRequestError('SECRET', '/task/list_v2/', 'http', 503));
  assert.equal(JSON.parse(logs[0]).attemptId, 'attempt');
  assert.ok(!logs[0].includes('SECRET'));
});

test('failed initial observation can only become success after a fresh four-task confirmation', async t => {
  t.mock.method(console, 'warn', () => {});
  const key = Buffer.alloc(32, 7).toString('base64');
  const credential = encryptCredential(config, key);
  const job = { id: crypto.randomUUID(), lease: crypto.randomUUID(), date: beijingDate(), credential };
  const taskResult = { user: { userid: '12345', level_info: { exp: 20, coin: 30 } },
    task_list: [{ title: '每日任务', tasks: ['1', '19', '31'].map(id => ({ report_extra: { task_id: id }, state: 'finish', title: id })) }] };
  let calls = 0;
  const result = await executeDaily(job, key, { heartbeat: async () => true }, async url => {
    calls++;
    if (calls === 1) return new Response('SECRET', { status: 503 });
    return Response.json({ status: 'ok', result: String(url).includes('get_sign_state')
      ? { state: 'ok', signed_date: Math.floor((Date.now() / 1000 + 8 * 3600) / 86400) } : taskResult });
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.snapshot?.tasks.filter(t => t.state === 'finish').length, 4);
  assert.equal(result.coinDelta, undefined);
  assert.equal(result.failure?.httpStatus, 503);
  assert.equal(result.uncertain, true);
  const unconfirmed = await executeDaily(job, key, { heartbeat: async () => true }, async () => new Response('SECRET', { status: 503 }));
  assert.equal(unconfirmed.status, 'failed');
  assert.equal(unconfirmed.errors?.length, 2);
  assert.equal(unconfirmed.coinDelta, undefined);
  assert.equal(unconfirmed.snapshot, undefined);
});
