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
