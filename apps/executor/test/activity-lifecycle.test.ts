import test from 'node:test';
import assert from 'node:assert/strict';
import { withActivityLease } from '../src/activity-lifecycle.ts';
import { ActivityTrace } from '../src/activity-trace.ts';
import { deadline } from '../src/deadline.ts';

test('cancellation while acquiring retains cleanup until the lease token is known', async (t) => {
  t.mock.method(console, 'log', () => {});
  const controller = new AbortController();
  const calls: string[] = []; const pending: Promise<unknown>[] = [];
  let acquired!: (value: Response) => void;
  const gate = { fetch: (async (url, init) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path === '/acquire') return new Promise<Response>(resolve => { acquired = resolve; });
    assert.equal(init?.signal, undefined);
    assert.deepEqual(JSON.parse(init!.body as string), { account: '123', token: 'lease' });
    return new Response(null, { status: 204 });
  }) as typeof fetch };
  const operation = withActivityLease(gate, '123', controller.signal, { waitUntil: p => pending.push(p) },
    new ActivityTrace({ mode: 'list' }), async () => assert.fail('cancelled request must not execute'));
  assert.equal(pending.length, 1, 'lifecycle registered before acquisition resolves');
  controller.abort(); acquired(Response.json({ token: 'lease' }));
  await assert.rejects(operation, { name: 'AbortError' });
  await Promise.all(pending);
  assert.deepEqual(calls, ['/acquire', '/release']);
});

test('in-flight cancellation aborts upstream and releases exactly once before another request starts', async (t) => {
  t.mock.method(console, 'log', () => {});
  const controller = new AbortController(); let held = false; let releases = 0;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const pending: Promise<unknown>[] = [];
  const gate = { fetch: (async url => {
    if (String(url).endsWith('/release')) { held = false; releases++; return new Response(null, { status: 204 }); }
    if (held) return Response.json({ token: null, reason: 'account' });
    held = true; return Response.json({ token: 'lease' });
  }) as typeof fetch };
  const context = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const operation = withActivityLease(gate, '123', controller.signal, context, new ActivityTrace({ mode: 'list' }), async () => {
    const scope = deadline(1000, fetch, controller.signal);
    try { started(); await scope.sleep(900); } finally { scope.close(); }
  });
  await ready; assert.ok(held); controller.abort();
  await assert.rejects(operation, { name: 'AbortError' }); await Promise.all(pending);
  assert.equal(held, false); assert.equal(releases, 1);
  assert.equal(await withActivityLease(gate, '123', new AbortController().signal, context,
    new ActivityTrace({ mode: 'list' }), async () => 'ready'), 'ready');
  assert.equal(releases, 2);
});

test('business errors release the lease, while busy requests never release another owner', async (t) => {
  const logs: string[] = []; t.mock.method(console, 'log', (line: string) => logs.push(line));
  let releases = 0; let busy = false;
  const gate = { fetch: (async url => {
    if (String(url).endsWith('/release')) { releases++; return new Response(null, { status: 204 }); }
    return Response.json({ token: busy ? null : 'lease', reason: 'capacity' });
  }) as typeof fetch };
  const call = () => withActivityLease(gate, '123', new AbortController().signal, { waitUntil: () => {} },
    new ActivityTrace({ mode: 'participate', activityId: '9' }), async () => { throw new Error('fixture'); });
  await assert.rejects(call(), /fixture/); assert.equal(releases, 1);
  busy = true; await assert.rejects(call(), { code: 'activity_busy' }); assert.equal(releases, 1);
  assert.equal(JSON.parse(logs.at(-1)!).busyScope, 'capacity');
});
