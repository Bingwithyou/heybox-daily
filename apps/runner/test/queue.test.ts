import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { TaskQueue } from '../src/queue.ts';
import type { Job } from '@heybox/contracts';

const idle = (seconds = '1800') => Response.json(null, { headers: { 'retry-after': seconds } });
const job: Job = { id: crypto.randomUUID(), date: '2026-10-27', lease: crypto.randomUUID(),
  credential: { account: '123', version: crypto.randomUUID(), ciphertext: 'x'.repeat(32) } };

test('an empty queue checks only 48 times in a day and stops without waiting 30 minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let claims = 0;
  const queue = new TaskQueue({ concurrency: 8, request: async () => { claims++; return idle(); }, execute: async () => assert.fail('no job') });
  const running = queue.run();
  await setImmediate();
  for (let halfHour = 1; halfHour < 48; halfHour++) { t.mock.timers.tick(1_800_000); await setImmediate(); }
  assert.equal(claims, 48);
  t.mock.timers.tick(1_799_999); await setImmediate();
  assert.equal(claims, 48);
  queue.stop(); await running;
});

test('a wakeup during an empty claim is not lost before the idle timer is armed', async () => {
  let release!: (value: Response) => void;
  let claims = 0;
  const queue = new TaskQueue({ request: async () => {
    claims++;
    if (claims === 1) return new Promise<Response>(resolve => { release = resolve; });
    queue.stop(); return idle();
  }, execute: async () => assert.fail('no job') });
  const running = queue.run();
  queue.wake(); release(idle());
  await running;
  assert.equal(claims, 2);
});

test('waking an idle or busy worker drains new jobs serially without duplicate execution', async () => {
  const pending: Job[] = [];
  let release!: () => void;
  let active = 0; let maximum = 0; let executions = 0; let claims = 0;
  const queue = new TaskQueue({ request: async path => {
    if (path === '/internal/finish') return new Response(null, { status: 204 });
    claims++; return pending.length ? Response.json(pending.shift()) : idle();
  }, execute: async () => {
    active++; maximum = Math.max(maximum, active); executions++;
    if (executions === 1) await new Promise<void>(resolve => { release = resolve; });
    active--; return { status: 'completed' };
  } });
  const running = queue.run(); await setImmediate();
  pending.push(job); queue.wake(); await setImmediate();
  assert.equal(executions, 1);
  pending.push({ ...job, id: crypto.randomUUID() });
  queue.wake(); queue.wake(); queue.wake();
  assert.equal(executions, 1);
  release(); await setImmediate(); await setImmediate();
  assert.equal(executions, 2); assert.equal(maximum, 1); assert.equal(claims, 4);
  queue.stop(); await running;
});

test('the server retry time preserves near-term retries and old servers keep the legacy interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let claims = 0;
  const queue = new TaskQueue({ request: async () => {
    claims++;
    return claims === 1 ? idle('60') : Response.json(null);
  }, execute: async () => assert.fail('no job') });
  const running = queue.run(); await setImmediate();
  t.mock.timers.tick(59_999); await setImmediate(); assert.equal(claims, 1);
  t.mock.timers.tick(1); await setImmediate(); assert.equal(claims, 2);
  t.mock.timers.tick(10_000); await setImmediate(); assert.equal(claims, 3);
  queue.stop(); await running;
});

test('service failures back off, while a notification can retry immediately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let claims = 0; let failures = 0;
  const queue = new TaskQueue({ request: async () => { claims++; throw new Error('unavailable'); },
    execute: async () => assert.fail('no job'), warn: () => { failures++; } });
  const running = queue.run(); await setImmediate();
  t.mock.timers.tick(15_000); await setImmediate(); assert.equal(claims, 2);
  t.mock.timers.tick(29_999); await setImmediate(); assert.equal(claims, 2);
  queue.wake(); await setImmediate(); assert.equal(claims, 3);
  assert.equal(failures, 3);
  queue.stop(); await running;
});

test('a failed child delivers its failure result and retries delivery without rerunning the job', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let claims = 0; let executes = 0; let finishes = 0;
  const queue = new TaskQueue({ request: async (path, body) => {
    if (path === '/internal/claim') { claims++; return claims === 1 ? Response.json(job) : idle(); }
    finishes++;
    assert.deepEqual(body, { id: job.id, lease: job.lease, version: job.credential.version,
      result: { status: 'failed', reason: 'timeout' } });
    return new Response(null, { status: finishes === 1 ? 503 : 204 });
  }, execute: async () => { executes++; throw new Error('child timed out'); } });
  const running = queue.run(); await setImmediate();
  t.mock.timers.tick(2000); await setImmediate();
  assert.equal(finishes, 2); assert.equal(executes, 1);
  queue.stop(); await running;
});

test('concurrency must be an integer from one to eight', () => {
  for (const concurrency of [0, -1, 1.5, 9, NaN, Infinity]) {
    assert.throws(() => new TaskQueue({ concurrency, request: async () => idle(), execute: async () => ({ status: 'completed' }) }), /TASK_CONCURRENCY/);
  }
});

test('eight slots refill independently, notifications never overclaim, and stop drains claimed jobs', async () => {
  const pending = Array.from({ length: 12 }, (_, index) => ({ ...job, id: crypto.randomUUID(),
    credential: { ...job.credential, account: String(index + 1) } }));
  const releases: Array<() => void> = [];
  const executed: string[] = []; const finished: string[] = [];
  let active = 0; let maximum = 0; let claims = 0; let stopped = false;
  const queue = new TaskQueue({ concurrency: 8, request: async (path, body) => {
    if (path === '/internal/finish') {
      finished.push((body as { id: string }).id); return new Response(null, { status: 204 });
    }
    claims++; return pending.length ? Response.json(pending.shift()) : idle();
  }, execute: async value => {
    executed.push(value.id); active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => releases.push(resolve));
    active--; return { status: 'completed' };
  } });
  const running = queue.run().then(() => { stopped = true; });
  try {
    await setImmediate();
    assert.equal(active, 8); assert.equal(claims, 8);
    for (let n = 0; n < 20; n++) queue.wake();
    await setImmediate(); assert.equal(claims, 8);
    releases[3](); await setImmediate();
    assert.equal(executed.length, 9); assert.equal(active, 8);
    assert.equal(finished.length, 1, 'a slow first job must not block a later slot');
    queue.stop(); await setImmediate();
    assert.equal(stopped, false, 'stop waits for all active executions and result deliveries');
    assert.equal(claims, 9); assert.equal(pending.length, 3);
  } finally {
    queue.stop(); releases.forEach(release => release()); await running;
  }
  assert.equal(maximum, 8); assert.equal(new Set(executed).size, 9);
  assert.equal(finished.length, 9); assert.equal(active, 0);
});

test('parallel result-delivery retries have independent timers and keep their slots until delivered', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const jobs = Array.from({ length: 3 }, () => ({ ...job, id: crypto.randomUUID() }));
  const finishes = new Map<string, number>();
  let claimed = 0; let executed = 0;
  const queue = new TaskQueue({ concurrency: 2, request: async (path, body) => {
    if (path === '/internal/claim') return claimed < jobs.length ? Response.json(jobs[claimed++]) : idle();
    const id = (body as { id: string }).id;
    const attempts = (finishes.get(id) || 0) + 1;
    finishes.set(id, attempts);
    return new Response(null, { status: attempts === 1 ? 503 : 204 });
  }, execute: async () => { executed++; return { status: 'completed' }; } });
  const running = queue.run();
  try {
    await setImmediate();
    assert.equal(executed, 2); assert.equal(claimed, 2);
    queue.wake(); queue.wake(); await setImmediate();
    assert.equal(finishes.get(jobs[0].id), 1, 'notifications must not bypass delivery backoff');
    t.mock.timers.tick(2000); await setImmediate();
    assert.equal(finishes.get(jobs[0].id), 2); assert.equal(finishes.get(jobs[1].id), 2);
    assert.equal(executed, 3);
    queue.stop();
  } finally {
    queue.stop(); t.mock.timers.tick(10_000); await running;
  }
  assert.equal(finishes.get(jobs[2].id), 2);
});

test('stop during a claim still executes and reports the accepted lease without claiming another', async () => {
  let deliver!: (value: Response) => void; let complete!: () => void;
  let claims = 0; let finishes = 0; let stopped = false;
  const queue = new TaskQueue({ concurrency: 8, request: async path => {
    if (path === '/internal/finish') { finishes++; return new Response(null, { status: 204 }); }
    claims++; return new Promise<Response>(resolve => { deliver = resolve; });
  }, execute: async () => {
    await new Promise<void>(resolve => { complete = resolve; }); return { status: 'completed' };
  } });
  const running = queue.run().then(() => { stopped = true; });
  queue.stop(); deliver(Response.json(job)); await setImmediate();
  assert.equal(stopped, false); assert.equal(claims, 1);
  complete(); await running;
  assert.equal(finishes, 1); assert.equal(claims, 1);
});
