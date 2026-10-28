type Work<T> = { version: string; generation: number; controller: AbortController;
  promise: Promise<T>; waiters: number; settled: boolean };

export class ActivityReadCache<T> {
  private generation = 0;
  private cached?: { version: string; expiresAt: number; value: T };
  private work?: Work<T>;
  private readonly now: () => number;
  constructor(now = Date.now) { this.now = now; }
  invalidate() { this.generation++; this.cached = undefined; }

  async read(version: string, signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (;;) {
      signal.throwIfAborted();
      if (this.cached?.version === version && this.cached.expiresAt > this.now()) return this.cached.value;
      let work = this.work;
      if (!work || work.version !== version || work.generation !== this.generation || work.controller.signal.aborted) {
        const controller = new AbortController();
        work = { version, generation: this.generation, controller, waiters: 0, settled: false,
          promise: Promise.resolve().then(() => execute(controller.signal)) };
        const current = work;
        current.promise = current.promise.then(value => {
          if (current.generation === this.generation && this.work === current && !controller.signal.aborted)
            this.cached = { version, expiresAt: this.now() + 15_000, value };
          return value;
        }).finally(() => { current.settled = true; if (this.work === current) this.work = undefined; });
        this.work = current;
      }
      const value = await this.wait(work, signal);
      // A read started before participation cannot repopulate or return stale state after it.
      if (work.generation === this.generation) return value;
    }
  }
  private wait(work: Work<T>, signal: AbortSignal): Promise<T> {
    work.waiters++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const done = (value?: T, error?: unknown, failed = false) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', aborted);
        work.waiters--;
        if (!work.waiters && !work.settled) work.controller.abort();
        if (failed) reject(error); else resolve(value!);
      };
      const aborted = () => done(undefined, signal.reason, true);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      work.promise.then(value => done(value), error => done(undefined, error, true));
    });
  }
}
