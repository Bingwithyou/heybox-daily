import { beijingDate } from '@heybox/contracts';

export function createDailyCheckpoint(date: string, verify: () => Promise<void>, now = Date.now) {
  let lastVerified: number | undefined;
  return async (force = false) => {
    const started = now();
    if (date !== beijingDate(started)) throw new Error('cross_day');
    if (!force && lastVerified !== undefined && started - lastVerified < 30_000) return;
    await verify();
    lastVerified = started;
  };
}
