import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../../../packages/hosting/test/database.ts";
import { Store } from "../../../packages/hosting/src/store.ts";
import { retryDelay } from "../../../packages/hosting/src/retry.ts";
import type { Outcome } from "@heybox/contracts";

const credential = (account: number) => ({
  account: String(account),
  version: crypto.randomUUID(),
  ciphertext: "x".repeat(64),
});

test("retry windows grow with the tier and Retry-After is a floor for HTTP errors", () => {
  for (const category of ["http", "rate_limit"] as const) {
    const failure: Outcome = {
      status: "failed",
      failure: {
        category,
        httpStatus: category === "http" ? 403 : 429,
        stage: "inspect",
        durationMs: 1,
      },
    };
    const bases =
      category === "http"
        ? [300000, 1200000, 3600000, 7200000]
        : [900000, 1800000, 3600000, 7200000];
    for (const [index, base] of bases.entries()) {
      assert.equal(
        retryDelay(failure, index + 1, () => 0),
        base,
      );
      assert.equal(
        retryDelay(failure, index + 1, () => 0.99999999),
        base * 2,
      );
    }
    failure.failure!.retryAfterMs = 10800000;
    assert.equal(
      retryDelay(failure, 1, () => 0),
      10800000,
    );
    assert.equal(retryDelay(failure, 5), null);
  }
});

test("simultaneous consumers share one actual-start gate, without counting blocked or duplicate deliveries", async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 8; i++) await f.store.enroll(credential(i));
    const messages = await f.store.reserveDispatch();
    f.advance(60_000); // Simulate a delayed delivery of all slots at once.
    const consumers = messages.map(() => new Store(f.adapter, f.store.now));
    const claims = await Promise.all(messages.map((m, i) => consumers[i].claimQueued(m)));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(f.db.prepare("SELECT SUM(attempts) n FROM jobs").get()!.n, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM job_attempts").get()!.n, 1);
    const blocked = claims.findIndex((job) => !job);
    assert.equal(consumers[blocked].nextStartAt, f.store.now() + 4000);
    const claimedIndex = claims.findIndex(Boolean);
    f.advance(3999);
    assert.equal(await consumers[blocked].claimQueued(messages[blocked]), null);
    f.advance(1);
    assert.equal(await consumers[claimedIndex].claimQueued(messages[claimedIndex]), null);
    assert.equal(consumers[claimedIndex].nextStartAt, null);
    assert.ok(await consumers[blocked].claimQueued(messages[blocked]));
    const starts = f.db.prepare("SELECT started_at FROM job_attempts ORDER BY started_at").all();
    assert.equal(Number(starts[1].started_at) - Number(starts[0].started_at), 4000);
    f.advance(3600_000);
    const remaining = messages.filter((_, i) => i !== blocked && i !== claimedIndex);
    const afterIdle = await Promise.all(
      remaining.map((m) => new Store(f.adapter, f.store.now).claimQueued(m)),
    );
    assert.equal(
      afterIdle.filter(Boolean).length,
      1,
      "idle time does not accumulate burst credits",
    );
  } finally {
    f.close();
  }
});

test("failed attempt bookkeeping rolls back the start gate and legacy claims use the same gate", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential(1));
    await f.store.enroll(credential(2));
    const messages = await f.store.reserveDispatch();
    f.db.exec(
      "CREATE TRIGGER reject_attempt BEFORE INSERT ON job_attempts BEGIN SELECT RAISE(ABORT,'failed history'); END",
    );
    await assert.rejects(f.store.claimQueued(messages[0]), /failed history/);
    f.db.exec("DROP TRIGGER reject_attempt");
    assert.ok(await f.store.claimQueued(messages[0]));
    assert.equal(await new Store(f.adapter, f.store.now).claim(), null);
    f.advance(4000);
    assert.ok(await new Store(f.adapter, f.store.now).claim());
  } finally {
    f.close();
  }
});

test("concurrent dispatch keeps only 32 in flight, spaces slots, and does not count waiting as attempts", async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 40; i++) await f.store.enroll(credential(i));
    const second = new Store(f.adapter, f.store.now);
    const groups = await Promise.all([f.store.reserveDispatch(100), second.reserveDispatch(100)]);
    const messages = groups.flat();
    assert.equal(messages.length, 32);
    assert.equal(new Set(messages.map((m) => m.id)).size, 32);
    assert.deepEqual(
      messages.map((m) => m.delaySeconds).sort((a, b) => a - b),
      Array.from({ length: 32 }, (_, i) => i * 4),
    );
    assert.equal(f.db.prepare("SELECT SUM(attempts) n FROM jobs").get()!.n, 0);
    const last = messages.find((m) => m.delaySeconds === 124)!;
    assert.equal(await f.store.claimQueued(last), null);
    assert.equal(f.store.nextStartAt, f.store.now() + 124000);
    assert.deepEqual(await f.store.reserveDispatch(), []);
    const first = messages.find((m) => m.delaySeconds === 0)!;
    assert.ok(await f.store.claimQueued(first));
    assert.deepEqual(
      await f.store.reserveDispatch(),
      [],
      "running jobs still consume buffer capacity",
    );
  } finally {
    f.close();
  }
});

test("wide retry is persisted once and cannot schedule an execution across midnight", async (t) => {
  t.mock.method(Math, "random", () => 0.75);
  const f = fixture();
  const failure: Outcome = {
    status: "failed",
    failure: { category: "http", httpStatus: 403, stage: "inspect", durationMs: 1 },
  };
  try {
    const user = await f.store.enroll(credential(1));
    const job = (await f.store.claim())!;
    const failedAt = f.store.now();
    await f.store.finish(job.id, job.lease, job.credential.version, failure);
    const retryAt = f.store.nextRetryAt!;
    assert.equal(retryAt, failedAt + 525000);
    t.mock.method(Math, "random", () => 0);
    assert.deepEqual(await f.store.reserveDispatch(), []);
    assert.equal((await f.store.dashboard(user))!.today!.retryAt, retryAt);
    f.advance(retryAt - f.store.now());
    const [message] = await f.store.reserveDispatch();
    const second = (await f.store.claimQueued(message))!;
    f.advance(Date.parse("2026-10-27T23:50:00+08:00") - f.store.now());
    // Give this controlled execution a valid lease near midnight.
    f.db.prepare("UPDATE jobs SET lease_until=? WHERE id=?").run(f.store.now() + 300000, second.id);
    await f.store.finish(second.id, second.lease, second.credential.version, failure);
    assert.equal((await f.store.dashboard(user))!.today!.status, "failed");
    assert.equal(f.store.nextRetryAt, null);
    assert.equal((await f.store.dashboard(user))!.today!.attempts, 2);
  } finally {
    f.close();
  }
});
