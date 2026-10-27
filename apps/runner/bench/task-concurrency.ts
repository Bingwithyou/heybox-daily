import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beijingDate, type Job } from '@heybox/contracts';
import { TaskQueue } from '../src/queue.ts';
import { runChild } from '../src/process.ts';
import { encryptCredential } from '../src/crypto.ts';

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'heybox-concurrency-'));
const key = randomBytes(32).toString('base64');
const samples = 8;
// Only synthetic credentials. Child networking is fully replaced before application imports.
process.env.CREDENTIAL_KEY = key;
process.env.WEBSITE_URL = 'https://benchmark.invalid';
process.env.RUNNER_SERVICE_TOKEN = randomBytes(32).toString('hex');
process.env.NODE_OPTIONS = `--import=${new URL('./mock-upstream.ts', import.meta.url).href}`;
const info = console.info;
console.info = () => {}; // Per-task logs are validated by tests; print aggregate benchmark results only.
try {
  for (const concurrency of [1, 4, 8]) {
    const results = await mkdtemp(join(directory, `${concurrency}-`));
    process.env.HEYBOX_BENCH_RESULTS = results;
    const pending: Job[] = Array.from({ length: samples }, (_, index) => ({ id: randomUUID(), lease: randomUUID(), date: beijingDate(),
      credential: encryptCredential({ session: { heybox_id: String(1000 + index), pkey: 'benchmark-only', device_id: 'benchmark-device', x_xhh_tokenid: 'benchmark-token' },
        device: { model: 'benchmark', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } }, key) }));
    let active = 0; let peakActive = 0; let completed = 0; let peakRssKiB = 0; let sampling = false;
    const outcomes: string[] = [];
    const cpuStart = process.cpuUsage(); const start = performance.now();
    const queue = new TaskQueue({ concurrency, request: async (path, body) => {
      if (path === '/internal/claim') return pending.length ? Response.json(pending.shift()) : Response.json(null, { headers: { 'retry-after': '1800' } });
      outcomes.push((body as { result: { status: string } }).result.status);
      completed++;
      if (completed === samples) queue.stop();
      return new Response(null, { status: 204 });
    }, execute: async job => {
      active++; peakActive = Math.max(peakActive, active);
      try { return await runChild({ action: 'daily', job }); } finally { active--; }
    } });
    // Sample aggregate RSS of this Node process and its live Node children (not unrelated apps or ps).
    const sample = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm=']);
        const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/));
        let total = 0;
        for (const [pid, ppid, rss, ...command] of rows) {
          if ((Number(pid) === process.pid || Number(ppid) === process.pid) && /(?:^|\/)node$/.test(command.join(' '))) total += Number(rss);
        }
        peakRssKiB = Math.max(peakRssKiB, total);
      } finally { sampling = false; }
    };
    await sample();
    let monitorError: unknown;
    const timer = setInterval(() => { void sample().catch(error => { monitorError = error; }); }, 100);
    try { await queue.run(); } finally { clearInterval(timer); }
    if (monitorError) throw monitorError;
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const children = await Promise.all((await readdir(results)).map(async file => JSON.parse(await readFile(join(results, file), 'utf8')) as {
      cpu: { user: number; system: number }; requests: number; signed: boolean; shares: number;
    }));
    assert.equal(completed, samples); assert.equal(children.length, samples); assert.equal(peakActive, concurrency);
    assert.ok(outcomes.every(outcome => outcome === 'completed'), 'all synthetic tasks must finish successfully');
    assert.ok(children.every(child => child.signed && child.shares === 3));
    const cpuSeconds = (cpu.user + cpu.system + children.reduce((sum, child) => sum + child.cpu.user + child.cpu.system, 0)) / 1e6;
    console.log(JSON.stringify({ concurrency, completed, peakActive, wallSeconds: +(wallMs / 1000).toFixed(2),
      peakRssMiB: +(peakRssKiB / 1024).toFixed(1), cpuSeconds: +cpuSeconds.toFixed(2),
      averageCpuCores: +(cpuSeconds / (wallMs / 1000)).toFixed(3), simulatedRequests: children.reduce((sum, child) => sum + child.requests, 0) }));
  }
} finally {
  console.info = info;
  await rm(directory, { recursive: true, force: true });
}
