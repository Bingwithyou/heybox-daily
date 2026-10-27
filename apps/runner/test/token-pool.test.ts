import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenPool } from '../src/token-pool.ts';

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, 'pool state timeout'); await new Promise(r => setTimeout(r, 5)); }
}
async function fixture(t: test.TestContext, script = '', options: Record<string, number | boolean> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'token-pool-'));
  const childPath = join(dir, 'child.mjs');
  await writeFile(childPath, `
    ${script}
    process.send({type:'ready'});
    process.once('message', () => setTimeout(() => {
      if (process.env.TOKEN_SERVICE_TOKEN || process.env.CREDENTIAL_KEY || process.env.RUNNER_SERVICE_TOKEN) process.exit(9);
      process.send({type:'token', token:'B'+String(process.pid).padStart(88,'0')}, () => process.exit(0));
    }, 80));
  `);
  const pool = new TokenPool({ childPath, ...options });
  t.after(async () => { await pool.stop(); await rm(dir, { recursive: true, force: true }); });
  return pool;
}

test('one idle process is ready before demand and each process serves exactly once', async t => {
  const pool = await fixture(t);
  await until(() => pool.snapshot().ready === 1);
  assert.deepEqual(pool.snapshot(), { children: 1, idle: 1, ready: 1, active: 0 });
  const first = await pool.generate(new AbortController().signal);
  await until(() => pool.snapshot().ready === 1);
  const second = await pool.generate(new AbortController().signal);
  assert.notEqual(first, second, 'different PID for every token');
});

test('the real SDK child can prewarm without generating a token and shuts down cleanly', async t => {
  const pool = new TokenPool();
  t.after(() => pool.stop());
  await until(() => pool.snapshot().ready === 1);
  assert.deepEqual(pool.snapshot(), { children: 1, idle: 1, ready: 1, active: 0 });
  await pool.stop();
  assert.equal(pool.snapshot().children, 0);
});

test('stopping while a request is active rejects it and leaves no child', async t => {
  const pool = await fixture(t);
  await until(() => pool.snapshot().ready === 1);
  const result = pool.generate(new AbortController().signal);
  const rejected = assert.rejects(result);
  await pool.stop(); await rejected;
  assert.equal(pool.snapshot().children, 0);
});

test('idle and active children together never exceed four and cancellation waits for exit', async t => {
  const pool = await fixture(t);
  await until(() => pool.snapshot().ready === 1);
  let peak = 0;
  const watch = setInterval(() => { peak = Math.max(peak, pool.snapshot().children); }, 1);
  t.after(() => clearInterval(watch));
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const jobs = controllers.map(c => pool.generate(c.signal));
  assert.equal(pool.snapshot().children, 4);
  await assert.rejects(pool.generate(new AbortController().signal), /繁忙/);
  controllers[0].abort();
  await assert.rejects(jobs[0]);
  const values = await Promise.all(jobs.slice(1));
  assert.equal(new Set(values).size, 3);
  assert.ok(peak <= 4);
  await pool.stop();
  assert.equal(pool.snapshot().children, 0);
  await assert.rejects(pool.generate(new AbortController().signal), /停止/);
});

test('abort before admission does not consume the idle process', async t => {
  const pool = await fixture(t);
  await until(() => pool.snapshot().ready === 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pool.generate(controller.signal));
  assert.equal(pool.snapshot().ready, 1);
});

test('disabled prewarming has no idle process but still generates one-shot tokens', async t => {
  const pool = await fixture(t, '', { prewarm: false });
  assert.equal(pool.snapshot().children, 0);
  assert.match(await pool.generate(new AbortController().signal), /^B[0-9]{88}$/);
  assert.equal(pool.snapshot().children, 0);
});

test('startup failure retries with delay and stop cancels the retry', async t => {
  const pool = await fixture(t, 'process.exit(7);', { retryMs: 200 });
  await until(() => pool.snapshot().children === 0);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(pool.snapshot().children, 0);
  await pool.stop();
  await new Promise(r => setTimeout(r, 250));
  assert.equal(pool.snapshot().children, 0);
});

test('startup and generation timeouts terminate the child without reusing it', async t => {
  const startup = await fixture(t, 'setInterval(()=>{},1000); await new Promise(() => {});',
    { prewarm: false, startupMs: 30, requestMs: 1000 });
  await assert.rejects(startup.generate(new AbortController().signal));
  assert.equal(startup.snapshot().children, 0);
  const running = await fixture(t, '', { requestMs: 20 });
  await until(() => running.snapshot().ready === 1);
  await assert.rejects(running.generate(new AbortController().signal));
  assert.equal(running.snapshot().children, 0);
});
