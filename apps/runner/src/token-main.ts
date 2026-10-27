import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TokenQueue, createTokenServer } from './token-service.ts';

const token = process.env.TOKEN_SERVICE_TOKEN || '';
if (token.length < 32) throw new Error('TOKEN_SERVICE_TOKEN 未配置');
if (process.env.CREDENTIAL_KEY || process.env.RUNNER_SERVICE_TOKEN) throw new Error('设备令牌服务不应持有账号密钥或旧执行端认证');
function generate(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./token-child.ts', import.meta.url))], {
      stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32',
      env: { PATH: process.env.PATH, NODE_ENV: 'production', TZ: 'Asia/Shanghai' },
    });
    let output = ''; let finished = false;
    const kill = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ } };
    const done = (value?: string) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (value) resolve(value); else { kill(); reject(new Error('设备令牌生成失败')); }
    };
    const abort = () => done();
    const timer = setTimeout(abort, 30_000);
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', abort);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024) done(); });
    child.on('exit', code => {
      if (code !== 0) { done(); return; }
      try {
        const value = JSON.parse(output) as { token?: string };
        done(typeof value.token === 'string' && /^B[A-Za-z0-9+/=_-]{88}$/.test(value.token) ? value.token : undefined);
      } catch { done(); }
    });
  });
}
const queue = new TokenQueue(generate);
const server = createTokenServer(queue, token);
server.listen(Number(process.env.PORT || 8789), process.env.HOST || '127.0.0.1', () => console.log('Heybox device-token service ready (concurrency: 4)'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { queue.stop(); server.close(); });
