import { outcomeSchema, queueMessageSchema, type Job, type Outcome } from '@heybox/contracts';
import { Store } from '../../web/src/server/store.ts';
import { executeDaily } from './operations.ts';
import type { Env } from './env.ts';

export async function dispatchDue(env: Pick<Env, 'DB' | 'DAILY_QUEUE' | 'DAILY_ENABLED'>) {
  if (env.DAILY_ENABLED !== 'true') return 0;
  const store = new Store(env.DB);
  let count = 0;
  // Bound each invocation; the next minute continues a larger backlog.
  for (let page = 0; page < 10; page++) {
    const messages = await store.reserveDispatch();
    if (!messages.length) break;
    await env.DAILY_QUEUE.sendBatch(messages.map(body => ({ body })));
    await store.markDispatched(messages[0].token);
    count += messages.length;
  }
  if (count) console.log(JSON.stringify({ event: 'executor_dispatched', count }));
  return count;
}
export async function consume(batch: MessageBatch<unknown>, env: Env, execute: (job: Job, key: string, store: Store) => Promise<Outcome & { category?: string }> = executeDaily) {
  const store = new Store(env.DB);
  for (const message of batch.messages) {
    const parsed = queueMessageSchema.safeParse(message.body);
    if (!parsed.success) { console.warn(JSON.stringify({ event: 'executor_invalid_message' })); message.ack(); continue; }
    const started = performance.now();
    try {
      if (batch.queue.endsWith('-dead')) {
        await store.deadLetter(parsed.data);
        console.warn(JSON.stringify({ event: 'executor_dead_letter', jobId: parsed.data.id }));
        message.ack(); continue;
      }
      if (env.DAILY_ENABLED !== 'true') { message.retry({ delaySeconds: 300 }); continue; }
      const job = await store.claimQueued(parsed.data);
      if (!job) { message.ack(); continue; }
      let result: Outcome & { category?: string };
      try { result = await execute(job, env.CREDENTIAL_KEY, store); }
      catch { result = { status: 'failed', reason: 'timeout', category: 'internal' }; }
      const outcome = outcomeSchema.parse(result);
      let accepted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { accepted = await store.finish(job.id, job.lease, job.credential.version, outcome); break; }
        catch (error) {
          if (attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      console.log(JSON.stringify({ event: 'executor_task_finished', jobId: job.id, outcome: outcome.status,
        category: result.category, accepted, durationMs: Math.round(performance.now() - started) }));
      message.ack();
    } catch {
      console.warn(JSON.stringify({ event: 'executor_delivery_failed', jobId: parsed.data.id }));
      message.retry({ delaySeconds: 60 });
    }
  }
}
