import { ActivityFailure } from '@heybox/contracts';
import type { ActivityTrace } from './activity-trace.ts';

// Register the complete lifecycle before acquisition can suspend the request.
// Release is deliberately independent of the aborted incoming signal.
export function withActivityLease<T>(gate: Pick<Fetcher, 'fetch'>, account: string, signal: AbortSignal,
  context: Pick<ExecutionContext, 'waitUntil'>, trace: ActivityTrace, execute: () => Promise<T>): Promise<T> {
  const operation = (async () => {
    signal.throwIfAborted();
    const acquired = await gate.fetch('https://gate/acquire', { method: 'POST', body: JSON.stringify({ account }) });
    if (!acquired.ok) throw new ActivityFailure('activity_upstream');
    const { token, reason } = await acquired.json() as { token: string | null; reason?: 'account' | 'capacity' };
    if (!token) {
      trace.log('executor_activity_failed', { code: 'activity_busy', busyScope: reason });
      throw new ActivityFailure('activity_busy');
    }
    trace.log('executor_activity_acquired');
    try { signal.throwIfAborted(); return await execute(); }
    finally {
      trace.enter('release');
      try {
        const released = await gate.fetch('https://gate/release', { method: 'POST', body: JSON.stringify({ account, token }) });
        if (!released.ok) throw new Error('release_failed');
        trace.log('executor_activity_released');
      } catch { trace.log('executor_activity_release_failed'); }
    }
  })();
  context.waitUntil(operation.then(() => {}, () => {}));
  return operation;
}
