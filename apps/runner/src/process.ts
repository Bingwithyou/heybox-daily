import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LoginFailure, loginFailureSchema } from '@heybox/contracts';
import { errorDiagnostic, type ErrorDiagnostic } from 'heybox-daily/diagnostics';
import { createLoginLog } from './login-logging.ts';

export function runChild<T>(input: unknown, timeout = 240_000): Promise<T> {
  const loginLog = createLoginLog(input);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.ts', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32',
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    });
    let output = ''; let settled = false;
    let failure: { category: string; diagnostic?: ErrorDiagnostic } | undefined;
    const action = input && typeof input === 'object' && 'action' in input && ['begin', 'send', 'verify', 'daily'].includes(String(input.action)) ? input.action : 'unknown';
    const kill = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const context = loginLog?.(value);
      if (error) {
        console.warn(JSON.stringify({ event: 'runner_operation_failed', action, ...context,
          ...(context && { outcome: 'failed' }),
          category: failure?.category || 'process', diagnostic: failure?.diagnostic || errorDiagnostic(error) }));
        kill(); reject(error);
      } else {
        if (context) console.info(JSON.stringify({ event: 'runner_operation_completed', action, ...context }));
        resolve(value!);
      }
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
        const parsed = JSON.parse(output) as { ok: boolean; value?: T; error?: string; category?: string; code?: string; diagnostic?: ErrorDiagnostic };
        if (!parsed.ok) {
          const categories = ['captcha_required', 'native_signer', 'device_token', 'upstream_rate_limit', 'verification_code', 'upstream_http', 'upstream_network', 'upstream_rejected', 'internal'];
          const category = categories.includes(parsed.category || '') ? parsed.category! : 'internal';
          failure = { category, diagnostic: parsed.diagnostic };
          const known = loginFailureSchema.safeParse(parsed);
          finish(known.success ? new LoginFailure(known.data.code) : new Error(parsed.error || '执行失败'));
        }
        else finish(undefined, parsed.value);
      } catch { finish(new Error('执行响应无效')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
