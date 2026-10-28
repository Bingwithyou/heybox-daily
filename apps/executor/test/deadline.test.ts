import test from 'node:test';
import assert from 'node:assert/strict';
import { deadline } from '../src/deadline.ts';

test('Worker fetch preserves redirect rejection and never forwards credentials to a redirect target', async () => {
  let calls = 0;
  const scope = deadline(1000, async (_input, init) => {
    calls++; assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://other.invalid' } });
  });
  try { await assert.rejects(scope.fetch('https://upstream.invalid', { redirect: 'error' }), /redirect/); assert.equal(calls, 1); }
  finally { scope.close(); }
});

test('execution deadline interrupts sleeps and rejects later upstream actions', async () => {
  let calls = 0;
  const scope = deadline(10, async () => { calls++; return new Response(); });
  try {
    await assert.rejects(scope.sleep(1000), /execution_timeout/);
    await assert.rejects(scope.fetch('https://upstream.invalid'), /execution_timeout/);
    assert.equal(calls, 0);
  } finally { scope.close(); }
});

test('request cancellation interrupts in-flight fetch, confirmation sleep and later actions', async () => {
  const controller = new AbortController();
  let calls = 0;
  const scope = deadline(100, async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  }, controller.signal);
  try {
    const request = scope.fetch('https://upstream.invalid');
    const sleep = scope.sleep(1000);
    controller.abort(new Error('client_cancelled'));
    await assert.rejects(request, /client_cancelled/);
    await assert.rejects(sleep, /client_cancelled/);
    await assert.rejects(scope.fetch('https://upstream.invalid'), /client_cancelled/);
    assert.equal(calls, 1);
  } finally { scope.close(); }
});
