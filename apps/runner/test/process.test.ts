import test from 'node:test';
import assert from 'node:assert/strict';
import { runChild } from '../src/process.ts';
import { createRunnerServer } from '../src/server.ts';
import { ChallengeStore } from '../src/challenges.ts';
import { failureCategory } from '../src/worker.ts';
import { HeyboxApiError } from 'heybox-daily/client';
import { encryptCredential } from '../src/crypto.ts';
import { beijingDate } from '@heybox/contracts';

test('failure diagnostics identify the stage without exposing exception text or credentials', () => {
  assert.equal(failureCategory(new HeyboxApiError('/account/get_login_code/', 'show_captcha', 'private-fixture')), 'captcha_required');
  assert.equal(failureCategory(new Error('未能从官网获取设备令牌')), 'device_token');
  assert.equal(failureCategory(new Error('请求过于频繁，请稍后再试')), 'upstream_rate_limit');
  assert.equal(failureCategory(new Error('HTTP 403：/account/get_login_code/')), 'upstream_http');
  assert.equal(failureCategory(new Error('HTTP 429：/task/list_v2/')), 'upstream_rate_limit');
  assert.equal(failureCategory(new Error('private-phone-and-secret')), 'internal');
});

test('daily failures log measured execution time and rate limits without account credentials', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'info', (message: string) => lines.push(message));
  const names = ['NODE_OPTIONS', 'CREDENTIAL_KEY', 'WEBSITE_URL', 'RUNNER_SERVICE_TOKEN'] as const;
  const previous = names.map(name => process.env[name]);
  const key = Buffer.alloc(32, 7).toString('base64');
  const config = { session: { heybox_id: '9876543210', pkey: 'private-key', device_id: 'private-device', x_xhh_tokenid: 'private-token' },
    device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };
  const job = { id: crypto.randomUUID(), lease: crypto.randomUUID(), date: beijingDate(), credential: encryptCredential(config, key) };
  const stub = `globalThis.fetch = async input => new URL(input).pathname === '/internal/heartbeat'
    ? new Response(null, {status:204}) : new Response(null, {status:429});`;
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --import=data:text/javascript,${encodeURIComponent(stub)}`;
  process.env.CREDENTIAL_KEY = key; process.env.WEBSITE_URL = 'https://website.invalid';
  process.env.RUNNER_SERVICE_TOKEN = 'service-token-fixture'.repeat(3);
  try {
    const result = await runChild<{ status: string; reason: string }>({ action: 'daily', job });
    assert.equal(result.status, 'failed'); assert.equal(result.reason, 'upstream');
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
  assert.equal(lines.length, 1);
  const log = JSON.parse(lines[0]);
  assert.equal(log.event, 'runner_task_finished'); assert.equal(log.jobId, job.id);
  assert.equal(log.outcome, 'failed'); assert.equal(log.category, 'upstream_rate_limit');
  assert.ok(log.durationMs > 0);
  for (const secret of [...Object.values(config.session), job.credential.ciphertext, key, 'service-token-fixture']) {
    assert.ok(!lines[0].includes(secret));
  }
});

test('child execution has a hard timeout and does not echo credentials on failure', async () => {
  await assert.rejects(runChild({ action: 'unknown', secret: 'private-fixture' }, 1), /执行超时/);
  await assert.rejects(runChild({ action: 'unknown', secret: 'private-fixture' }), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('private-fixture')); return true;
  });
});
test('child login failures log their action and concrete diagnostics without exposing them to callers', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'warn', (message: string) => lines.push(message));
  const config = { session: { heybox_id: '-1', pkey: 'private-key', device_id: 'private-device', x_xhh_tokenid: 'private-token' },
    device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };
  await assert.rejects(runChild({ action: 'verify', phone: '13800138000', code: 'invalid-secret', config }), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('invalid-secret'));
    assert.ok(!error.message.includes('4 至 8'));
    return true;
  });
  assert.equal(lines.length, 1);
  const log = JSON.parse(lines[0]);
  assert.equal(log.action, 'verify');
  assert.equal(log.category, 'verification_code');
  assert.match(log.diagnostic.message, /4 至 8 位数字/);
  for (const secret of ['13800138000', 'invalid-secret', 'private-key', 'private-device', 'private-token']) assert.ok(!lines[0].includes(secret));
});
test('device-token diagnostics survive the child boundary without attempting SMS', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'warn', (message: string) => lines.push(message));
  const previous = process.env.NODE_OPTIONS;
  const stub = `globalThis.fetch = async () => { throw new Error('SDK download unavailable'); };`;
  process.env.NODE_OPTIONS = `${previous || ''} --import=data:text/javascript,${encodeURIComponent(stub)}`;
  try {
    await assert.rejects(runChild({ action: 'begin', phone: '13800138000' }));
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
  assert.equal(lines.length, 1);
  const log = JSON.parse(lines[0]);
  assert.equal(log.action, 'begin');
  assert.equal(log.category, 'device_token');
  assert.equal(log.diagnostic.stage, 'download_sdk');
  assert.match(log.diagnostic.cause.message, /SDK download unavailable/);
  assert.ok(!lines[0].includes('13800138000'));
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
