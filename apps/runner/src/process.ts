import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LoginFailure, loginFailureSchema, jobSchema, outcomeSchema, ActivityFailure, activityFailureSchema } from '@heybox/contracts';
import { errorDiagnostic, type ErrorDiagnostic } from 'heybox-daily/diagnostics';
import { createLoginLog } from './login-logging.ts';

const categories = ['captcha_required', 'native_signer', 'device_token', 'upstream_rate_limit', 'verification_code', 'upstream_http', 'upstream_network', 'upstream_rejected', 'internal'];

export function runChild<T>(input: unknown, timeout = 240_000): Promise<T> {
  const loginLog = createLoginLog(input);
  const started = performance.now();
  const job = input && typeof input === 'object' && 'action' in input && input.action === 'daily' && 'job' in input
    ? jobSchema.safeParse(input.job) : undefined;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.ts', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32',
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    });
    let output = ''; let settled = false;
    let failure: { category: string; diagnostic?: ErrorDiagnostic } | undefined;
    const action = input && typeof input === 'object' && 'action' in input && ['begin', 'send', 'verify', 'daily', 'activities'].includes(String(input.action)) ? input.action : 'unknown';
    const kill = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const context = loginLog?.(value);
      const taskContext = job?.success ? { jobId: job.data.id, durationMs: Math.round(performance.now() - started) } : undefined;
      if (error) {
        console.warn(JSON.stringify({ event: 'runner_operation_failed', action, ...context, ...taskContext,
          ...(context && { outcome: 'failed' }),
          category: failure?.category || 'process', diagnostic: failure?.diagnostic || errorDiagnostic(error) }));
        kill(); reject(error);
      } else {
        if (context) console.info(JSON.stringify({ event: 'runner_operation_completed', action, ...context }));
        if (taskContext) {
          const result = outcomeSchema.safeParse(value);
          const category = value && typeof value === 'object' && 'category' in value && typeof value.category === 'string' && categories.includes(value.category) ? value.category : undefined;
          console.info(JSON.stringify({ event: 'runner_task_finished', ...taskContext,
            outcome: result.success ? result.data.status : 'invalid', reason: result.success ? result.data.reason : undefined, category }));
        }
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
          const category = categories.includes(parsed.category || '') ? parsed.category! : 'internal';
          failure = { category, diagnostic: parsed.diagnostic };
          const known = loginFailureSchema.safeParse(parsed);
          const activity = action === 'activities' ? activityFailureSchema.safeParse(parsed) : undefined;
          finish(activity?.success ? new ActivityFailure(activity.data.code) : known.success ? new LoginFailure(known.data.code) : new Error(parsed.error || '执行失败'));
        }
        else finish(undefined, parsed.value);
      } catch { finish(new Error('执行响应无效')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
