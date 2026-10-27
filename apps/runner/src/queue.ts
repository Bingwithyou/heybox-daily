import { jobSchema, outcomeSchema, type Job, type Outcome } from '@heybox/contracts';

interface Options {
  request: (path: string, body: unknown) => Promise<Response>;
  execute: (job: Job) => Promise<unknown>;
  concurrency?: number;
  warn?: () => void;
}

export class TaskQueue {
  private readonly options: Options;
  private readonly concurrency: number;
  private readonly active = new Set<Promise<void>>();
  private stopping = false;
  private revision = 0;
  private resume?: () => void;
  constructor(options: Options) {
    this.options = options;
    this.concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8) {
      throw new Error('TASK_CONCURRENCY 必须是 1 至 8 的整数');
    }
  }
  wake() { this.revision++; this.resume?.(); }
  stop() { this.stopping = true; this.wake(); }
  private wait(ms: number, revision: number) {
    if (this.stopping || revision !== this.revision) return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.resume = undefined; resolve(); };
      const timer = setTimeout(done, ms);
      this.resume = done;
    });
  }
  private async execute(job: Job) {
    let result: Outcome;
    try { result = outcomeSchema.parse(await this.options.execute(job)); }
    catch { result = { status: 'failed', reason: 'timeout' }; }
    const finish = { id: job.id, lease: job.lease, version: job.credential.version, result };
    for (let retry = 0; retry < 3; retry++) {
      try {
        const done = await this.options.request('/internal/finish', finish);
        if (done.ok || done.status === 409) return;
      } catch { /* retry result delivery only */ }
      // Each task owns its retry timer; only the dispatcher uses the wakeable wait.
      if (retry < 2) await new Promise(resolve => setTimeout(resolve, 2000 * (retry + 1)));
    }
    this.options.warn?.();
  }
  async run() {
    let failures = 0;
    while (!this.stopping) {
      // Capture before claiming so a notification arriving during the request cannot be lost.
      const revision = this.revision;
      if (this.active.size >= this.concurrency) {
        await this.wait(1_800_000, revision);
        continue;
      }
      try {
        const response = await this.options.request('/internal/claim', {});
        if (!response.ok) throw new Error('claim unavailable');
        const payload: unknown = await response.json();
        if (payload === null) {
          failures = 0;
          const seconds = Number(response.headers.get('retry-after'));
          // Old Workers do not send a hint: keep their 10-second polling until both sides are upgraded.
          const delay = Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 1800) * 1000 : 10_000;
          await this.wait(delay, revision);
          continue;
        }
        const job = jobSchema.parse(payload);
        failures = 0;
        const task = this.execute(job).finally(() => {
          this.active.delete(task);
          this.wake();
        });
        this.active.add(task);
      } catch {
        failures++;
        this.options.warn?.();
        await this.wait(Math.min(15_000 * 2 ** Math.min(failures - 1, 7), 1_800_000), revision);
      }
    }
    await Promise.all(this.active);
  }
}
