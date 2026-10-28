import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenQueue, createTokenServer } from '../src/token-service.ts';
import { LoginTiming, loginTimingHeader } from '@heybox/contracts';
import { TokenGenerationError } from '../src/token-diagnostic.ts';

test('token initialization has four slots and FIFO admission independent of login verification', async () => {
  const starts: number[] = []; const releases: Array<() => void> = []; let n = 0;
  const queue = new TokenQueue(async () => { const id = n++; starts.push(id); await new Promise<void>(r => releases.push(r)); return `token-${id}`; }, { concurrency: 4, maxPending: 2 });
  const requests = Array.from({ length: 6 }, () => queue.run());
  assert.equal(queue.active, 4); assert.equal(queue.pending, 2);
  await assert.rejects(queue.run(), /繁忙/);
  releases[0](); assert.equal(await requests[0], 'token-0');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(queue.active, 4); assert.equal(queue.pending, 1); assert.deepEqual(starts, [0, 1, 2, 3, 4]);
  releases.slice(1).forEach(r => r());
  await new Promise(r => setTimeout(r, 0)); releases[5]();
  await Promise.all(requests); assert.equal(queue.active, 0);
});
test('queued cancellation and queue timeout do not start an SDK process', async () => {
  let release!: () => void; let starts = 0;
  const queue = new TokenQueue(async () => { starts++; await new Promise<void>(r => release = r); return 'token'; }, { concurrency: 1, waitMs: 15 });
  const active = queue.run();
  const abort = new AbortController(); const cancelled = queue.run(abort.signal); abort.abort();
  await assert.rejects(cancelled);
  await assert.rejects(queue.run(), /等待超时/);
  assert.equal(starts, 1); assert.equal(queue.pending, 0);
  release(); await active;
});
test('token HTTP service authenticates and accepts only an empty token-generation request', async () => {
  const token = 'service-fixture-'.repeat(3); let calls = 0;
  const queue = new TokenQueue(async () => { calls++; return 'B' + 'x'.repeat(88); });
  const server = createTokenServer(queue, token);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const timing = new LoginTiming();
  const send = (path: string, body: string, authorized = true) => fetch(url + path, { method: 'POST', body,
    headers: authorized ? { authorization: `Bearer ${token}`, [loginTimingHeader]: timing.id } : {} });
  try {
    assert.equal((await send('/token', '{}', false)).status, 401);
    assert.equal((await send('/token', '{"phone":"13800000000"}')).status, 400);
    assert.equal((await send('/login/begin', '{}')).status, 404);
    assert.equal((await send('/token', 'x'.repeat(65))).status, 400);
    assert.equal(calls, 0);
    const response = await send('/token', '{}');
    assert.deepEqual(await response.json(), { token: 'B' + 'x'.repeat(88) });
    assert.equal(response.headers.get(loginTimingHeader), timing.id);
    timing.merge(response.headers.get('server-timing'));
    for (const stage of ['token_queue', 'token_generate', 'token_service'] as const) assert.ok(timing.values[stage]! >= 0);
    assert.equal(calls, 1);
    assert.deepEqual(await (await send('/health', '{}')).json(), { service: 'device-token', active: 0, pending: 0 });
  } finally { queue.stop(); await new Promise<void>(r => server.close(() => r())); }
});
test('token failures retain queue and generation timing without logging token or error text', async (t) => {
  const messages: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { messages.push(line); });
  const queue = new TokenQueue(async () => { throw new Error('secret upstream error'); });
  const server = createTokenServer(queue, 'a'.repeat(64));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/token`, { method: 'POST', body: '{}',
      headers: { authorization: 'Bearer ' + 'a'.repeat(64), [loginTimingHeader]: 'private-invalid-id' } });
    assert.equal(response.status, 503);
    assert.match(response.headers.get(loginTimingHeader)!, /^[a-f0-9-]{36}$/);
    assert.match(response.headers.get('server-timing')!, /token_generate;dur=/);
    assert.equal(messages.length, 1);
    const log = JSON.parse(messages[0]);
    assert.equal(log.requestId, response.headers.get(loginTimingHeader));
    assert.equal(log.event, 'device_token_failed');
    assert.ok(log.stages.token_queue >= 0 && log.stages.token_generate >= 0);
    for (const secret of ['secret upstream error', 'private-invalid-id', 'a'.repeat(64)]) assert.ok(!messages[0].includes(secret));
  } finally { queue.stop(); await new Promise<void>(r => server.close(() => r())); }
});

test('attempt diagnostics and detailed timings reach service logs without reaching the HTTP error body', async t => {
  const messages: string[] = [];
  t.mock.method(console, 'warn', (line: string) => messages.push(line));
  const diagnostic = { stage: 'request_token', sdkCode: -1, networkCode: 'ETIMEDOUT', networkPhase: 'tls' } as const;
  const queue = new TokenQueue(async (_signal, timing, onAttempt) => {
    timing!.add('token_tls', 3000);
    onAttempt!({ attempt: 1, diagnostic, retry: true });
    throw new TokenGenerationError(diagnostic);
  });
  const server = createTokenServer(queue, 'a'.repeat(64));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/token`, { method: 'POST', body: '{}',
      headers: { authorization: 'Bearer ' + 'a'.repeat(64) } });
    assert.equal(response.status, 503);
    assert.match(response.headers.get('server-timing')!, /token_tls;dur=3000/);
    assert.ok(!(await response.text()).includes('ETIMEDOUT'));
    assert.equal(messages.length, 2);
    for (const message of messages) {
      const log = JSON.parse(message);
      assert.equal(log.requestId, response.headers.get(loginTimingHeader));
      assert.deepEqual(log.diagnostic, diagnostic);
    }
    assert.equal(JSON.parse(messages[0]).retry, true);
  } finally { queue.stop(); await new Promise<void>(r => server.close(() => r())); }
});
