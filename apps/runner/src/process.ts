import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function runChild<T>(input: unknown, timeout = 240_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.ts', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32',
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    });
    let output = ''; let settled = false;
    const kill = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { kill(); reject(error); } else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('执行超时')), timeout);
    child.on('error', () => finish(new Error('执行进程无法启动')));
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 32_768) finish(new Error('执行响应过大'));
    });
    child.stdin.on('error', () => {});
    child.on('exit', code => {
      if (code !== 0) return finish(new Error('执行进程异常退出'));
      try {
        const parsed = JSON.parse(output) as { ok: boolean; value?: T; error?: string; category?: string };
        if (!parsed.ok) {
          const categories = ['native_signer', 'device_token', 'upstream_rate_limit', 'verification_code', 'upstream_http', 'upstream_network', 'upstream_rejected', 'internal'];
          const category = categories.includes(parsed.category || '') ? parsed.category : 'internal';
          console.warn(`Runner operation failed: ${category}`);
          finish(new Error(parsed.error || '执行失败'));
        }
        else finish(undefined, parsed.value);
      } catch { finish(new Error('执行响应无效')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
