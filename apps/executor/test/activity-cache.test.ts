import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityReadCache } from '../src/activity-cache.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const signal = () => new AbortController().signal;
test('same-version reads coalesce and cache for exactly fifteen seconds, with version and account isolation', async () => {
  let now = 0; let calls = 0;
  const cache = new ActivityReadCache<number>(() => now);
  const first = deferred<number>();
  const run = async () => { calls++; return first.promise; };
  const waiting = [cache.read('v1', signal(), run), cache.read('v1', signal(), run)];
  await Promise.resolve(); assert.equal(calls, 1);
  first.resolve(1); assert.deepEqual(await Promise.all(waiting), [1, 1]);
  now = 14_999; assert.equal(await cache.read('v1', signal(), async () => ++calls), 1);
  now = 15_000; assert.equal(await cache.read('v1', signal(), async () => ++calls), 2);
  assert.equal(await cache.read('v2', signal(), async () => ++calls), 3);
  assert.equal(await new ActivityReadCache<number>().read('v2', signal(), async () => ++calls), 4);
});
test('one cancelled waiter cannot abort the shared read; the last cancellation does abort upstream', async () => {
  const cache = new ActivityReadCache<number>();
  const pending = deferred<number>(); let upstream!: AbortSignal;
  const run = async (s: AbortSignal) => { upstream = s; return pending.promise; };
  const a = new AbortController(); const b = new AbortController();
  const first = cache.read('v1', a.signal, run); const second = cache.read('v1', b.signal, run);
  await Promise.resolve();
  const rejected = assert.rejects(first, { name: 'AbortError' });
  a.abort(); await rejected; assert.equal(upstream.aborted, false);
  pending.resolve(5); assert.equal(await second, 5);
  cache.invalidate();
  const last = new AbortController(); const stalled = deferred<number>();
  const request = cache.read('v1', last.signal, async s => { upstream = s; return stalled.promise; });
  await Promise.resolve();
  const cancelled = assert.rejects(request, { name: 'AbortError' });
  last.abort(); await cancelled; assert.equal(upstream.aborted, true);
  stalled.resolve(99);
  assert.equal(await cache.read('v1', signal(), async () => 6), 6, 'abandoned result is not cached');
});
test('a late pre-participation read cannot overwrite or return stale cached state', async () => {
  const cache = new ActivityReadCache<string>();
  const before = deferred<string>(); let calls = 0;
  const old = cache.read('v1', signal(), async () => { calls++; return before.promise; });
  await Promise.resolve();
  cache.invalidate();
  assert.equal(await cache.read('v1', signal(), async () => { calls++; return 'joined'; }), 'joined');
  before.resolve('not joined');
  assert.equal(await old, 'joined');
  assert.equal(calls, 2);
});
test('failed reads are never cached and participation invalidates a successful result', async () => {
  const cache = new ActivityReadCache<number>();
  await assert.rejects(cache.read('v1', signal(), async () => { throw new Error('upstream'); }), /upstream/);
  assert.equal(await cache.read('v1', signal(), async () => 1), 1);
  cache.invalidate();
  assert.equal(await cache.read('v1', signal(), async () => 2), 2);
});
