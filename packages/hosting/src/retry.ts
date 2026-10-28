import { DAILY_ATTEMPT_LIMIT, type Outcome } from '@heybox/contracts';

export function retryDelay(outcome: Outcome, attempts: number, random = Math.random): number | null {
  if (outcome.status !== 'failed' || attempts >= DAILY_ATTEMPT_LIMIT) return null;
  const category = outcome.failure?.category;
  // Older executors only report upstream/timeout. Preserve rolling-deploy compatibility.
  if (category && !['network', 'timeout', 'http', 'rate_limit', 'unconfirmed'].includes(category)) return null;
  if (category === 'http' && outcome.failure?.httpStatus !== 408 && (outcome.failure?.httpStatus ?? 0) < 500) return null;
  const limited = category === 'rate_limit';
  const tiers = limited ? [900_000, 1800_000, 3600_000] : [300_000, 1200_000, 3600_000];
  const base = tiers[Math.max(0, attempts - 1)] ?? 7200_000;
  return Math.max(base, limited ? outcome.failure?.retryAfterMs ?? 0 : 0) + Math.floor(random() * 60_001);
}
