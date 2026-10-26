import { setTimeout } from 'node:timers/promises';
import type { Config } from 'heybox-daily/types';
import { jobSchema, outcomeSchema, type Outcome } from '@heybox/contracts';
import { ChallengeStore } from './challenges.ts';
import { createRunnerServer } from './server.ts';
import { runChild } from './process.ts';

const token = process.env.RUNNER_SERVICE_TOKEN || '';
const key = process.env.CREDENTIAL_KEY || '';
const website = process.env.WEBSITE_URL || '';
if (token.length < 32 || Buffer.from(key, 'base64').length !== 32 || !/^https?:\/\//.test(website)) throw new Error('请配置 RUNNER_SERVICE_TOKEN、CREDENTIAL_KEY 和 WEBSITE_URL');
if (!website.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(website)) throw new Error('WEBSITE_URL 必须使用 HTTPS');
const store = new ChallengeStore({ begin: phone => runChild<Config>({ action: 'begin', phone }, 120_000),
  verify: (config, phone, code) => runChild<Config>({ action: 'verify', config, phone, code }, 120_000) });
const server = createRunnerServer(store, token, key);
server.listen(Number(process.env.PORT || 8788), process.env.HOST || '127.0.0.1', () => console.log('Heybox runner ready'));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopping = true; server.close(); });
async function request(path: string, body: unknown) {
  return fetch(`${website}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: 'error' });
}
while (!stopping) {
  try {
    const response = await request('/internal/claim', {});
    if (!response.ok) throw new Error('claim unavailable');
    const payload = await response.json();
    if (!payload) { await setTimeout(10_000); continue; }
    const job = jobSchema.parse(payload);
    let result: Outcome;
    try { result = outcomeSchema.parse(await runChild<Outcome>({ action: 'daily', job }, 240_000)); }
    catch { result = { status: 'failed', reason: 'timeout' }; }
    const finish = { id: job.id, lease: job.lease, version: job.credential.version, result };
    for (let retry = 0; retry < 3; retry++) {
      try { const done = await request('/internal/finish', finish); if (done.ok || done.status === 409) break; } catch { /* retry result delivery only */ }
      await setTimeout(2000 * (retry + 1));
    }
  } catch { console.error('任务服务暂时不可用，稍后重试'); await setTimeout(15_000); }
}
