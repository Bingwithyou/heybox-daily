import type { Outcome } from '@heybox/contracts';
import { ChallengeStore, type LoginStep } from './challenges.ts';
import { createRunnerServer } from './server.ts';
import { runChild } from './process.ts';
import { TaskQueue } from './queue.ts';
import { loginRelayConfig } from './login-relay.ts';

const token = process.env.RUNNER_SERVICE_TOKEN || '';
const key = process.env.CREDENTIAL_KEY || '';
const website = process.env.WEBSITE_URL || '';
if (token.length < 32 || Buffer.from(key, 'base64').length !== 32 || !/^https?:\/\//.test(website)) throw new Error('请配置 RUNNER_SERVICE_TOKEN、CREDENTIAL_KEY 和 WEBSITE_URL');
if (!website.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(website)) throw new Error('WEBSITE_URL 必须使用 HTTPS');
loginRelayConfig();
const store = new ChallengeStore({ begin: phone => runChild<LoginStep>({ action: 'begin', phone }, 120_000),
  send: (config, phone, proof) => runChild<LoginStep>({ action: 'send', config, phone, proof }, 120_000),
  verify: (config, phone, code, proof) => runChild<LoginStep>({ action: 'verify', config, phone, code, proof }, 120_000) });
const queue = new TaskQueue({ request,
  execute: job => runChild<Outcome>({ action: 'daily', job }, 240_000),
  warn: () => console.error('任务服务暂时不可用，稍后重试') });
const server = createRunnerServer(store, token, key, () => queue.wake());
server.listen(Number(process.env.PORT || 8788), process.env.HOST || '127.0.0.1', () => console.log('Heybox runner ready'));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { queue.stop(); server.close(); });
async function request(path: string, body: unknown) {
  return fetch(`${website}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: 'error' });
}
await queue.run();
