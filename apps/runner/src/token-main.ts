import { TokenQueue, createTokenServer } from './token-service.ts';
import { TokenPool } from './token-pool.ts';

const token = process.env.TOKEN_SERVICE_TOKEN || '';
if (token.length < 32) throw new Error('TOKEN_SERVICE_TOKEN 未配置');
if (process.env.CREDENTIAL_KEY || process.env.RUNNER_SERVICE_TOKEN) throw new Error('设备令牌服务不应持有账号密钥或旧执行端认证');
const pool = new TokenPool({ prewarm: process.env.TOKEN_PREWARM !== 'false' });
const queue = new TokenQueue(signal => pool.generate(signal));
const server = createTokenServer(queue, token, () => pool.snapshot());
server.listen(Number(process.env.PORT || 8789), process.env.HOST || '127.0.0.1', () => console.log('Heybox device-token service ready (concurrency: 4)'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { queue.stop(); server.close(); void pool.stop(); });
