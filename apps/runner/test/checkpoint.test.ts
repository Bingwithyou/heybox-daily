import test from 'node:test';
import assert from 'node:assert/strict';
import { beijingDate } from '@heybox/contracts';
import { createDailyCheckpoint } from '@heybox/hosting/checkpoint';

test('short jobs check at start and forced finish; long jobs check at 30 seconds', async () => {
  let now = Date.parse('2026-10-28T01:00:00+08:00'); let calls = 0;
  const check = createDailyCheckpoint(beijingDate(now), async () => { calls++; }, () => now);
  await check();
  for (let step = 0; step < 15; step++) { now += 1000; await check(); }
  assert.equal(calls, 1);
  await check(true); assert.equal(calls, 2);
  now += 29_999; await check(); assert.equal(calls, 2);
  now++; await check(); assert.equal(calls, 3);
});

test('a rejected check is never cached and cross-day cancellation is always local', async () => {
  let now = Date.parse('2026-10-28T23:59:59+08:00'); let reject = true; let calls = 0;
  const check = createDailyCheckpoint(beijingDate(now), async () => {
    calls++; if (reject) throw new Error('cancelled');
  }, () => now);
  await assert.rejects(check(), /cancelled/);
  reject = false; await check(); assert.equal(calls, 2);
  now += 1000; await assert.rejects(check(), /cross_day/); assert.equal(calls, 2);
});
