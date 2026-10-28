import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenPool } from '../src/token-pool.ts';
import { LoginTiming } from '@heybox/contracts';

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

test('transient token failure retries once in a fresh process and retains safe diagnostics and timings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'token-retry-'));
  const childPath = join(dir, 'child.mjs');
  const marker = join(dir, 'attempts');
  await writeFile(childPath, `
    import fs from 'node:fs';
    process.send({type:'ready'});
    process.once('message', () => {
      const file = ${JSON.stringify(marker)};
      const attempt = fs.existsSync(file) ? 2 : 1;
      fs.appendFileSync(file, String(process.pid)+'\\n');
      const timing = 'token_upstream;dur=3';
      if (attempt === 1) process.send({type:'error', timing, diagnostic:{stage:'request_token', sdkCode:-1,
        networkCode:'ETIMEDOUT', networkPhase:'tls', message:'private-token', httpStatus:0}}, () => process.exit(1));
      else process.send({type:'token', timing, token:'B'+'x'.repeat(88)}, () => process.exit(0));
    });
  `);
  const pool = new TokenPool({ childPath, prewarm: false });
  t.after(async () => { await pool.stop(); await rm(dir, { recursive: true, force: true }); });
  const timing = new LoginTiming(); const attempts: unknown[] = [];
  assert.match(await pool.generate(new AbortController().signal, timing, value => attempts.push(value)), /^B/);
  assert.equal(timing.values.token_upstream, 6);
  assert.deepEqual(attempts, [{ attempt: 1, diagnostic: { stage:'request_token', sdkCode:-1,
    networkCode:'ETIMEDOUT', networkPhase:'tls', httpStatus:0 }, retry: true }]);
  const { readFile } = await import('node:fs/promises');
  const pids = (await readFile(marker, 'utf8')).trim().split('\n');
  assert.equal(new Set(pids).size, 2);
});

test('retry is bounded and integrity, rejection, cancellation and malformed errors are not retried', async t => {
  for (const [diagnostic, expected] of [
    [{ stage: 'request_token', sdkCode: -1, networkCode: 'ECONNRESET' }, 2],
    [{ stage: 'request_token', sdkCode: -2, httpStatus: 503 }, 2],
    [{ stage: 'sdk_integrity' }, 1], [{ stage: 'request_token', sdkCode: -3, upstreamCode: 1902 }, 1],
    [{ stage: 'request_token', sdkCode: -2, httpStatus: 403 }, 1], [{ stage: 'private-secret' }, 1],
    [{ stage: 'wait_token' }, 1], [{ stage: 'wait_token', networkCode: 'ETIMEDOUT' }, 2],
    [{ stage: 'execute_sdk' }, 1],
  ] as const) {
    const pool = await fixture(t, `process.removeAllListeners('message'); process.on('message', () =>
      process.send({type:'error',diagnostic:${JSON.stringify(diagnostic)}}, () => process.exit(1)));`, { prewarm:false });
    const attempts: unknown[] = [];
    await assert.rejects(pool.generate(new AbortController().signal, undefined, value => attempts.push(value)));
    assert.equal(attempts.length, expected);
    assert.ok(!JSON.stringify(attempts).includes('private-secret'));
  }
  const pool = await fixture(t, '', { prewarm:false });
  const controller = new AbortController(); const attempts: unknown[] = [];
  const result = pool.generate(controller.signal, undefined, value => attempts.push(value));
  controller.abort(); await assert.rejects(result);
  assert.equal(attempts.length, 0);
  assert.equal(pool.snapshot().children, 0);
});

test('cancellation between attempts prevents retry and both attempts share one deadline', async t => {
  const script = `process.on('message', () => setTimeout(() => process.send({type:'error',
    diagnostic:{stage:'request_token',sdkCode:-1,networkCode:'ETIMEDOUT'}}, () => process.exit(1)), 40));`;
  const pool = await fixture(t, script, { requestMs: 150, prewarm: false });
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(pool.generate(controller.signal, undefined, () => { calls++; controller.abort(); }));
  assert.equal(calls, 1);
  assert.equal(pool.snapshot().children, 0);
  const dir = await mkdtemp(join(tmpdir(), 'token-deadline-'));
  const childPath = join(dir, 'child.mjs');
  await writeFile(childPath, `
    import fs from 'node:fs';
    process.send({type:'ready'});
    process.once('message', () => {
      const marker = new URL('./attempted', import.meta.url);
      if (fs.existsSync(marker)) { setInterval(() => {}, 1000); return; }
      fs.writeFileSync(marker, 'yes');
      process.send({type:'error', diagnostic:{stage:'request_token',sdkCode:-1}}, () => process.exit(1));
    });
  `);
  const bounded = new TokenPool({ childPath, prewarm: false, requestMs: 250 });
  t.after(async () => { await bounded.stop(); await rm(dir, { recursive:true, force:true }); });
  const failures: Array<{ diagnostic: { stage: string } }> = [];
  const start = performance.now();
  await assert.rejects(bounded.generate(new AbortController().signal, undefined, value => failures.push(value)));
  assert.equal(failures.at(-1)!.diagnostic.stage, 'deadline');
  assert.ok(performance.now() - start < 800);
  assert.equal(bounded.snapshot().children, 0);
});
