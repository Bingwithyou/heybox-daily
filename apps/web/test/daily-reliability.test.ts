import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../../../packages/hosting/test/database.ts";
import { nextRunAt, taskIds, type Outcome } from "@heybox/contracts";
import { retryDelay } from "../../../packages/hosting/src/retry.ts";

test("pausing a running job records no future retry after a transient failure", async () => {
  const f = fixture();
  try {
    const user = await f.store.enroll(credential());
    const job = (await f.store.claim())!;
    await f.store.setEnabled(user, false);
    await f.store.finish(job.id, job.lease, job.credential.version, {
      status: "failed",
      reason: "upstream",
    });
    assert.equal(f.store.nextRetryAt, null);
    assert.equal(f.db.prepare("SELECT retry_at FROM job_attempts").get()!.retry_at, null);
  } finally {
    f.close();
  }
});

test("attempt lookup uses its lease index and result/history commit together", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential());
    const job = (await f.store.claim())!;
    const plan = f.db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE lease=? AND status='running'")
      .all(job.lease);
    assert.ok(plan.some((row) => String(row.detail).includes("jobs_lease")));
    f.db.exec(
      "CREATE TRIGGER fail_finish BEFORE UPDATE ON job_attempts BEGIN SELECT RAISE(ABORT, 'test unavailable'); END",
    );
    await assert.rejects(f.store.finish(job.id, job.lease, job.credential.version, completed));
    assert.equal(f.db.prepare("SELECT status FROM jobs").get()!.status, "running");
    assert.equal(f.db.prepare("SELECT status FROM job_attempts").get()!.status, "running");
    f.db.exec("DROP TRIGGER fail_finish");
    assert.equal(await f.store.finish(job.id, job.lease, job.credential.version, completed), true);
  } finally {
    f.close();
  }
});

const credential = () => ({
  account: "123",
  version: crypto.randomUUID(),
  ciphertext: "x".repeat(64),
});
const completed: Outcome = {
  status: "completed",
  snapshot: { exp: 1, coin: 1, tasks: taskIds.map((id) => ({ id, state: "finish" })) },
};

test("retry policy differentiates transient, rate limited and permanent failures", () => {
  const failure = (
    category: NonNullable<Outcome["failure"]>["category"],
    httpStatus?: number,
    retryAfterMs?: number,
  ): Outcome => ({
    status: "failed",
    failure: { category, stage: "inspect", durationMs: 1, httpStatus, retryAfterMs },
  });
  assert.equal(
    retryDelay(failure("network"), 1, () => 0),
    300_000,
  );
  assert.equal(
    retryDelay(failure("timeout"), 2, () => 0),
    1200_000,
  );
  assert.equal(
    retryDelay(failure("rate_limit"), 1, () => 0),
    900_000,
  );
  assert.equal(
    retryDelay(failure("rate_limit"), 2, () => 0),
    1800_000,
  );
  assert.equal(
    retryDelay(failure("rate_limit", 429, 2400_000), 1, () => 0),
    2400_000,
  );
  assert.equal(
    retryDelay(failure("http", 503), 1, () => 0),
    300_000,
  );
  assert.equal(
    retryDelay(failure("http", 408), 1, () => 0),
    300_000,
  );
  for (const category of ["captcha", "protocol", "rejected", "internal", "auth"] as const)
    assert.equal(retryDelay(failure(category), 1), null);
  assert.equal(retryDelay(failure("http", 403), 1), null);
  assert.equal(retryDelay(failure("network"), 5), null);
});

test("retry cannot run into the next Beijing day and Cron does not reset failed attempts", async () => {
  const f = fixture(Date.parse("2026-10-29T23:58:00+08:00"));
  try {
    const user = await f.store.enroll(credential());
    const job = (await f.store.claim())!;
    await f.store.finish(job.id, job.lease, job.credential.version, {
      status: "failed",
      reason: "timeout",
    });
    assert.equal((await f.store.dashboard(user))!.today!.status, "failed");
    await f.store.schedule();
    assert.equal((await f.store.dashboard(user))!.today!.attempts, 1);
    assert.equal(await f.store.claim(), null);
  } finally {
    f.close();
  }
});

test("claim rolls back if attempt history cannot be saved and lease loss remains unknown", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential());
    f.db.exec(
      "CREATE TRIGGER fail_attempt BEFORE INSERT ON job_attempts BEGIN SELECT RAISE(ABORT, 'test unavailable'); END",
    );
    await assert.rejects(f.store.claim());
    assert.equal(f.db.prepare("SELECT attempts FROM jobs").get()!.attempts, 0);
    f.db.exec("DROP TRIGGER fail_attempt");
    const job = (await f.store.claim())!;
    f.advance(300_001);
    await f.store.reserveDispatch();
    const attempt = f.db.prepare("SELECT * FROM job_attempts WHERE id=?").get(job.lease)!;
    assert.equal(attempt.status, "unknown");
    assert.equal(await f.store.finish(job.id, job.lease, job.credential.version, completed), false);
  } finally {
    f.close();
  }
});

test("daily start is 00:30, with immediate manual enrollment", async () => {
  const time = Date.parse("2026-10-29T00:29:59+08:00");
  const f = fixture(time);
  try {
    assert.equal(nextRunAt(time), time + 1000);
    await f.store.enroll(credential());
    assert.ok(await f.store.claim());
    f.db.exec("DELETE FROM jobs");
    assert.equal(await f.store.schedule(), 0);
    f.advance(1000);
    assert.equal(await f.store.schedule(), 1);
    assert.equal(await f.store.schedule(), 0);
  } finally {
    f.close();
  }
});

test("attempts persist across retries, duplicate delivery and terminal success", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential());
    const [message] = await f.store.reserveDispatch();
    const first = (await f.store.claimQueued(message))!;
    assert.equal(await f.store.claimQueued(message), null);
    await f.store.finish(first.id, first.lease, first.credential.version, {
      status: "failed",
      reason: "upstream",
      failure: { category: "network", stage: "inspect", durationMs: 10 },
    });
    const row = f.db.prepare("SELECT * FROM jobs").get()!;
    assert.ok(Number(row.available_at) - Number(row.updated_at) >= 300_000);
    assert.ok(Number(row.available_at) - Number(row.updated_at) <= 360_000);
    assert.equal(await f.store.claim(), null);
    f.advance(360_000);
    const second = (await f.store.claim())!;
    await f.store.finish(second.id, second.lease, second.credential.version, completed);
    const attempts = f.db.prepare("SELECT * FROM job_attempts ORDER BY started_at").all();
    assert.deepEqual(
      attempts.map((a) => a.status),
      ["failed", "completed"],
    );
    assert.equal(attempts[0].id, first.lease);
    assert.equal(attempts[1].id, second.lease);
    assert.match(String(attempts[0].result), /network/);
    assert.equal(
      await f.store.finish(first.id, first.lease, first.credential.version, completed),
      false,
    );
  } finally {
    f.close();
  }
});

test("permanent errors stop and malformed completed results cannot become success", async () => {
  for (const outcome of [
    {
      status: "failed",
      reason: "upstream",
      failure: { category: "captcha", stage: "inspect", durationMs: 1 },
    },
    { status: "completed" },
    {
      status: "completed",
      snapshot: {
        exp: 1,
        coin: 1,
        tasks: Array.from({ length: 4 }, () => ({ id: "sign", state: "finish" })),
      },
    },
  ] as Outcome[]) {
    const f = fixture();
    try {
      const user = await f.store.enroll(credential());
      const job = (await f.store.claim())!;
      await f.store.finish(job.id, job.lease, job.credential.version, outcome);
      assert.equal((await f.store.dashboard(user))!.today!.status, "failed");
    } finally {
      f.close();
    }
  }
});

test("retry tiers extend through attempt four and honor a longer rate limit", () => {
  const failed: Outcome = {
    status: "failed",
    failure: { category: "network", stage: "inspect", durationMs: 1 },
  };
  for (const [attempt, delay] of [
    [1, 300000],
    [2, 1200000],
    [3, 3600000],
    [4, 7200000],
  ])
    assert.equal(
      retryDelay(failed, attempt, () => 0),
      delay,
    );
  const limited: Outcome = {
    ...failed,
    failure: { ...failed.failure!, category: "rate_limit", retryAfterMs: 1000 },
  };
  assert.equal(
    retryDelay(limited, 4, () => 0),
    7200000,
  );
  limited.failure!.retryAfterMs = 10800000;
  assert.equal(
    retryDelay(limited, 4, () => 0),
    10800000,
  );
  assert.equal(retryDelay(failed, 5), null);
});

test("relogin, pause/resume and manual retry preserve the daily budget and next day renews it", async () => {
  const f = fixture();
  try {
    const user = await f.store.enroll(credential());
    const job = (await f.store.claim())!;
    await f.store.finish(job.id, job.lease, job.credential.version, {
      status: "failed",
      failure: { category: "captcha", stage: "inspect", durationMs: 1 },
    });
    await f.store.enqueue(user, true);
    assert.equal((await f.store.dashboard(user))!.today!.attempts, 1);
    await f.store.setEnabled(user, false);
    await f.store.setEnabled(user, true);
    await f.store.enroll(credential());
    assert.equal((await f.store.dashboard(user))!.today!.attempts, 1);
    f.db.exec("UPDATE jobs SET status='failed',attempts=5,lease_until=NULL");
    await f.store.enqueue(user, true);
    await f.store.setEnabled(user, false);
    await f.store.setEnabled(user, true);
    await f.store.enroll(credential());
    assert.equal((await f.store.dashboard(user))!.today!.attempts, 5);
    assert.equal(await f.store.claim(), null);
    assert.deepEqual(await f.store.reserveDispatch(), []);
    f.advance(86400000);
    await f.store.schedule();
    assert.ok(await f.store.claim());
    assert.equal((await f.store.dashboard(user))!.today!.attempts, 1);
  } finally {
    f.close();
  }
});
