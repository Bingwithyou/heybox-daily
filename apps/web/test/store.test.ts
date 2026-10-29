import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../../../packages/hosting/test/database.ts";
import { beijingDate, nextRunAt, taskIds, type Credential } from "@heybox/contracts";

const confirmed = {
  snapshot: { exp: 0, coin: 0, tasks: taskIds.map((id) => ({ id, state: "finish" as const })) },
};

test("paused delivery stays queued without attempts and stale delivery cannot undo a new reservation", async () => {
  const f = fixture();
  try {
    const user = await f.store.enroll(credential("123"));
    const [message] = await f.store.reserveDispatch();
    await f.store.markDispatched(message.token);
    await f.store.deferQueued(message);
    const paused = (await f.store.dashboard(user))!.today!;
    assert.equal(paused.status, "queued");
    assert.equal(paused.attempts, 0);
    const [replacement] = await f.store.reserveDispatch();
    assert.notEqual(replacement.token, message.token);
    await f.store.deferQueued(message);
    assert.equal(await f.store.claimQueued(message), null);
    f.advance(replacement.delaySeconds * 1000);
    const job = await f.store.claimQueued(replacement);
    assert.ok(job);
    await f.store.deferQueued(replacement);
    assert.equal((await f.store.dashboard(user))!.today!.status, "running");
  } finally {
    f.close();
  }
});

test("lost execution results stay uncertain after a zero-reward all-skipped retry", async () => {
  const f = fixture();
  try {
    const user = await f.store.enroll(credential("123"));
    const original = (await f.store.claim())!;
    // The upstream side effect succeeded, but every result write was lost.
    f.advance(300_001);
    assert.equal(await f.store.claim(), null);
    f.advance(600_000);
    const retry = (await f.store.claim())!;
    assert.equal(retry.id, original.id);
    assert.notEqual(retry.lease, original.lease);
    assert.equal(
      await f.store.finish(original.id, original.lease, original.credential.version, {
        status: "completed",
        ...confirmed,
        expDelta: 10,
      }),
      false,
    );
    await f.store.finish(retry.id, retry.lease, retry.credential.version, {
      status: "completed",
      ...confirmed,
      expDelta: 0,
      coinDelta: 0,
      batteryDelta: 0,
      execution: { sign: "skipped", "1": "skipped", "19": "skipped", "31": "skipped" },
      snapshot: { exp: 110, coin: 0, tasks: taskIds.map((id) => ({ id, state: "finish" })) },
    });
    const result = (await f.store.dashboard(user))!.today!.result!;
    assert.equal(result.uncertain, true);
    assert.equal(result.expDelta, undefined);
    assert.equal(result.coinDelta, undefined);
    assert.equal(result.batteryDelta, undefined);
    assert.deepEqual(result.execution, {});
    assert.ok(result.snapshot!.tasks.every((task) => task.state === "finish"));
  } finally {
    f.close();
  }
});

test("SMS send admission is atomic across challenges and old owners cannot release a new send", async () => {
  const f = fixture();
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.store.acquireSmsSend("phone-hash")),
    );
    const accepted = results.filter((row) => row.token);
    assert.equal(accepted.length, 1);
    const first = accepted[0];
    await f.store.finishSmsSend("phone-hash", first.token!, false);
    const second = await f.store.acquireSmsSend("phone-hash");
    assert.ok(second.token);
    await f.store.finishSmsSend("phone-hash", first.token!, false);
    assert.equal((await f.store.acquireSmsSend("phone-hash")).token, undefined);
    await f.store.finishSmsSend("phone-hash", second.token!, true);
    f.advance(59_999);
    assert.equal((await f.store.acquireSmsSend("phone-hash")).token, undefined);
    f.advance(1);
    assert.ok((await f.store.acquireSmsSend("phone-hash")).token);
  } finally {
    f.close();
  }
});

test("login receipts make enrollment atomic and idempotent without resetting current work or newer credentials", async () => {
  const f = fixture();
  try {
    const value = credential("123");
    const receipt = { challenge: crypto.randomUUID(), expiresAt: f.store.now() + 300_000 };
    const user = await f.store.enroll(value, receipt);
    const job = (await f.store.claim())!;
    await Promise.all([f.store.enroll(value, receipt), f.store.enroll(value, receipt)]);
    assert.equal((await f.store.dashboard(user))!.today!.status, "running");
    assert.equal((await f.store.dashboard(user))!.today!.attempts, 1);
    assert.equal(await f.store.heartbeat(job.id, job.lease, value.version), true);
    const newer = credential("123");
    await f.store.enroll(newer);
    await assert.rejects(f.store.enroll(value, receipt), /新的登录/);
    assert.equal((await f.store.activityCredential(user))!.version, newer.version);
    f.advance(300_001);
    await assert.rejects(f.store.enroll(value, receipt), /过期/);
  } finally {
    f.close();
  }
});

test("a failed initial job insert rolls back the login receipt and credentials together", async () => {
  const f = fixture();
  try {
    const value = credential("123");
    const receipt = { challenge: crypto.randomUUID(), expiresAt: f.store.now() + 300_000 };
    f.db.exec(
      "CREATE TRIGGER reject_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
    );
    await assert.rejects(f.store.enroll(value, receipt), /injected failure/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM user").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM login_receipts").get()!.n, 0);
    f.db.exec("DROP TRIGGER reject_job");
    assert.equal(await f.store.enroll(value, receipt), "heybox:123");
    assert.ok(await f.store.claim());
  } finally {
    f.close();
  }
});

test("queue outbox reserves messages once and permits replay only after a lost send lease", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    const first = await f.store.reserveDispatch();
    assert.equal(first.length, 1);
    assert.deepEqual(await f.store.reserveDispatch(), []);
    f.advance(61_000);
    const resent = await f.store.reserveDispatch();
    assert.equal(resent[0].id, first[0].id);
    assert.notEqual(resent[0].token, first[0].token);
    assert.equal(await f.store.claimQueued(first[0]), null);
    await f.store.markDispatched(resent[0].token);
    f.advance(1800_000);
    assert.deepEqual(
      await f.store.reserveDispatch(),
      [],
      "published messages stay in the reliable queue without repeated resends",
    );
    const job = await f.store.claimQueued(resent[0]);
    assert.ok(job);
    assert.equal(
      await f.store.claimQueued(resent[0]),
      null,
      "duplicate delivery cannot claim the same job",
    );
  } finally {
    f.close();
  }
});

test("a published message lost after exhausted dead-letter delivery is recovered without accepting its old token", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    const [lost] = await f.store.reserveDispatch();
    await f.store.markDispatched(lost.token);
    f.advance(3600_001);
    const recovered = await f.store.reserveDispatch();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, lost.id);
    assert.notEqual(recovered[0].token, lost.token);
    assert.equal(await f.store.claimQueued(lost), null);
    const job = (await f.store.claimQueued(recovered[0]))!;
    assert.ok(job);
    await f.store.finish(job.id, job.lease, job.credential.version, { status: "completed" });
    f.advance(3600_001);
    assert.deepEqual(await f.store.reserveDispatch(), []);
  } finally {
    f.close();
  }
});

test("queue delivery can beat publish bookkeeping and delayed business retries are republished", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    const [message] = await f.store.reserveDispatch();
    const job = (await f.store.claimQueued(message))!;
    assert.ok(job);
    await f.store.markDispatched(message.token);
    assert.equal(
      await f.store.finish(job.id, job.lease, job.credential.version, {
        status: "failed",
        reason: "upstream",
      }),
      true,
    );
    assert.deepEqual(await f.store.reserveDispatch(), []);
    f.advance(600_000);
    const [retry] = await f.store.reserveDispatch();
    assert.equal(retry.id, message.id);
    assert.notEqual(retry.token, message.token);
    assert.equal(await f.store.claimQueued(message), null);
    const second = (await f.store.claimQueued(retry))!;
    assert.ok(second);
    await f.store.finish(second.id, second.lease, second.credential.version, {
      status: "completed",
      ...confirmed,
    });
    assert.deepEqual(await f.store.reserveDispatch(), []);
  } finally {
    f.close();
  }
});

test("a killed queue consumer recovers only after its lease, with at most five business attempts", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    for (let attempt = 1; attempt <= 5; attempt++) {
      const [message] = await f.store.reserveDispatch();
      const job = (await f.store.claimQueued(message))!;
      assert.ok(job);
      assert.deepEqual(await f.store.reserveDispatch(), []);
      f.advance(300_001);
      assert.deepEqual(await f.store.reserveDispatch(), []);
      if (attempt < 5)
        f.advance(
          attempt === 1 ? 600_000 : attempt === 2 ? 2400_000 : attempt === 3 ? 7200_000 : 14400_000,
        );
    }
    assert.deepEqual(await f.store.reserveDispatch(), []);
    assert.equal((await f.store.dashboard("heybox:123"))?.today?.status, "failed");
  } finally {
    f.close();
  }
});

test("queue messages cannot revive paused, replaced, deleted or cross-day accounts", async () => {
  for (const action of ["pause", "relogin", "delete", "cross-day"]) {
    const f = fixture();
    try {
      const id = await f.store.enroll(credential("123"));
      const [message] = await f.store.reserveDispatch();
      if (action === "pause") await f.store.setEnabled(id, false);
      if (action === "relogin") await f.store.enroll(credential("123"));
      if (action === "delete") await f.store.deleteUser(id);
      if (action === "cross-day") f.advance(86400_000);
      assert.equal(await f.store.claimQueued(message), null, action);
    } finally {
      f.close();
    }
  }
});

test("dead letters after a failed pause handback remain pending when delivery resumes", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    const [message] = await f.store.reserveDispatch();
    await f.store.markDispatched(message.token);
    await f.store.deadLetter(message);
    assert.equal((await f.store.dashboard(id))?.today?.status, "queued");
    assert.equal((await f.store.dashboard(id))?.today?.attempts, 0);
    assert.deepEqual(await f.store.reserveDispatch(), []);
    f.advance(60_000);
    const [retry] = await f.store.reserveDispatch();
    await f.store.deadLetter(message);
    assert.ok(await f.store.claimQueued(retry), "a stale dead letter does not fail a new attempt");
  } finally {
    f.close();
  }
});
const credential = (account: string): Credential => ({
  account,
  version: crypto.randomUUID(),
  ciphertext: "encrypted-private-value",
});

test("activity access uses only the current user's valid credential and does not depend on daily automation", async () => {
  const f = fixture();
  try {
    const first = credential("123");
    const id = await f.store.enroll(first);
    await f.store.enroll(credential("456"));
    assert.deepEqual({ ...(await f.store.activityCredential(id)) }, first);
    assert.equal(await f.store.activityAccess("123", first.version), true);
    assert.equal(await f.store.activityAccess("456", first.version), false);
    await f.store.setEnabled(id, false);
    assert.equal(await f.store.activityAccess("123", first.version), true);
    const replacement = credential("123");
    await f.store.enroll(replacement);
    assert.equal(await f.store.activityAccess("123", first.version), false);
    f.db.prepare("UPDATE hosting SET credential_state='expired' WHERE user_id=?").run(id);
    assert.equal(await f.store.activityCredential(id), null);
    assert.equal(await f.store.activityAccess("123", replacement.version), false);
    await f.store.deleteUser("heybox:456");
    assert.equal(await f.store.activityCredential("heybox:456"), null);
  } finally {
    f.close();
  }
});

test("an idle queue uses one indexed read and no UPDATE, regardless of completed history", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    f.db.prepare("UPDATE jobs SET status='completed' WHERE user_id=?").run(id);
    const insert = f.db.prepare(
      "INSERT INTO jobs(id,user_id,date,status,available_at,created_at,updated_at) VALUES(?,?,?,'completed',0,0,0)",
    );
    for (let day = 1; day <= 1000; day++) insert.run(String(day), id, `history-${day}`);
    f.queries.length = 0;
    assert.equal(await f.store.claim(), null);
    assert.equal(f.store.retryAfter, 1800);
    assert.equal(f.queries.length, 1);
    const query = f.queries[0];
    assert.match(query.sql.trim(), /^SELECT/);
    const plan = f.db
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...(query.values as Array<string | number | null>));
    assert.ok(plan.some((row) => String(row.detail).includes("jobs_ready")));
    assert.ok(!plan.some((row) => /SCAN j\b/.test(String(row.detail))));
  } finally {
    f.close();
  }
});

test("idle retry hints respect delayed retries and a revoked process lease", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    const first = (await f.store.claim())!;
    await f.store.finish(first.id, first.lease, first.credential.version, {
      status: "failed",
      reason: "upstream",
    });
    assert.equal(await f.store.claim(), null);
    assert.ok(f.store.retryAfter >= 300 && f.store.retryAfter <= 600);
    f.advance(600_000);
    const second = (await f.store.claim())!;
    assert.ok(second);
    await f.store.enroll(credential("123"));
    assert.equal(await f.store.claim(), null);
    assert.equal(f.store.retryAfter, 301);
    f.advance(300_001);
    assert.ok(await f.store.claim());
  } finally {
    f.close();
  }
});

test("a ready queue of 625 accounts uses indexed order and bounded cross-day cleanup", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 625; n++) {
      await f.store.enroll(credential(String(10000 + n)));
      f.advance(1);
    }
    f.queries.length = 0;
    assert.equal((await f.store.claim())?.credential.account, "10000");
    const plans = f.queries.map((query) => ({
      sql: query.sql,
      details: f.db
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .all(...(query.values as Array<string | number | null>))
        .map((row) => String(row.detail)),
    }));
    // A LIMIT alone still sorts/scans the queue unless date and ordering share an index.
    for (const plan of plans.filter(({ sql }) => sql.includes("ORDER BY j.available_at"))) {
      assert.ok(plan.details.some((detail) => /jobs_ready.*status=\?.*date=\?/.test(detail)));
      assert.ok(!plan.details.some((detail) => /TEMP B-TREE.*ORDER BY/.test(detail)));
    }
    assert.ok(
      plans[0].details.some((detail) =>
        /jobs_ready.*status=\?.*date=\?.*available_at</.test(detail),
      ),
      "finding immediate work must stop at the first eligible indexed job",
    );
    const cleanup = plans.find(({ sql }) => sql.startsWith("UPDATE jobs SET status='cancelled'"))!;
    assert.ok(
      cleanup.details.some((detail) => /jobs_(ready|dispatch).*status=\?.*date</.test(detail)),
    );
    assert.ok(
      cleanup.details.some((detail) => /jobs_(ready|dispatch).*status=\?.*date>/.test(detail)),
    );
  } finally {
    f.close();
  }
});

test("ready work is not delayed by an earlier revoked lease or future retry", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    const revoked = (await f.store.claim())!;
    await f.store.enroll(credential("123"));
    f.advance(4000);
    await f.store.enroll(credential("456"));
    f.db
      .prepare("UPDATE jobs SET available_at=? WHERE user_id='heybox:456'")
      .run(f.store.now() + 60_000);
    await f.store.enroll(credential("789"));
    const ready = (await f.store.claim())!;
    assert.equal(ready.credential.account, "789");
    await f.store.finish(ready.id, ready.lease, ready.credential.version, { status: "completed" });
    assert.equal(await f.store.claim(), null);
    assert.equal(f.store.retryAfter, 60);
    f.advance(60_000);
    assert.equal((await f.store.claim())?.credential.account, "456");
    assert.equal(
      await f.store.heartbeat(revoked.id, revoked.lease, revoked.credential.version),
      false,
    );
  } finally {
    f.close();
  }
});

test("cross-day cleanup cancels both older and future jobs without cancelling today's work", async () => {
  const f = fixture();
  try {
    const user = await f.store.enroll(credential("123"));
    const insert = f.db.prepare(
      "INSERT INTO jobs(id,user_id,date,status,available_at,created_at,updated_at) VALUES(?,?,?,'queued',0,0,0)",
    );
    insert.run("past", user, "2026-10-26");
    insert.run("future", user, "2026-10-28");
    const job = (await f.store.claim())!;
    assert.equal(job.date, "2026-10-27");
    assert.equal(
      f.db.prepare("SELECT status FROM jobs WHERE id='past'").get()?.status,
      "cancelled",
    );
    assert.equal(
      f.db.prepare("SELECT status FROM jobs WHERE id='future'").get()?.status,
      "cancelled",
    );
  } finally {
    f.close();
  }
});

test("a lease extending past midnight does not delay the cross-day check", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    f.advance(84599_000);
    const old = (await f.store.claim())!;
    assert.ok(old);
    assert.equal(await f.store.claim(), null);
    assert.equal(f.store.retryAfter, 1);
    f.advance(1000);
    assert.equal(await f.store.claim(), null);
    assert.equal(
      f.db.prepare("SELECT status FROM jobs WHERE id=?").get(old.id)?.status,
      "cancelled",
    );
  } finally {
    f.close();
  }
});

test("hourly scheduling reports only newly created jobs and leaves cleanup to the daily pass", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    f.db.prepare("INSERT INTO rate_limits VALUES('expired',1,0)").run();
    f.queries.length = 0;
    assert.equal(await f.store.schedule(), 0);
    assert.ok(!f.queries.some((query) => /DELETE|UPDATE/.test(query.sql)));
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM rate_limits").get()?.n, 1);
    f.advance(86400_000);
    assert.equal(await f.store.schedule(), 1);
    assert.equal(await f.store.schedule(), 0);
    await f.store.cleanup();
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM rate_limits").get()?.n, 0);
  } finally {
    f.close();
  }
});

test("enrollment, scheduling and manual retries never duplicate a user/day job", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    await Promise.all([f.store.schedule(), f.store.schedule(), f.store.enqueue(id)]);
    const dashboard = await f.store.dashboard(id);
    assert.equal(dashboard?.history.length, 1);
    const [one, two] = await Promise.all([f.store.claim(), f.store.claim()]);
    assert.equal([one, two].filter(Boolean).length, 1);
    assert.ok(!JSON.stringify(dashboard).includes("encrypted-private-value"));
    assert.ok(!JSON.stringify(dashboard).includes("ciphertext"));
  } finally {
    f.close();
  }
});
test("two users cannot read, pause, delete or finish each other through an owner-scoped store operation", async () => {
  const f = fixture();
  try {
    const a = await f.store.enroll(credential("123"));
    const b = await f.store.enroll(credential("456"));
    await f.store.setEnabled(a, false);
    assert.equal((await f.store.dashboard(b))?.enabled, true);
    assert.equal((await f.store.claim())?.credential.account, "456");
    assert.equal((await f.store.dashboard(a))?.account, "123");
    await f.store.deleteUser(a);
    assert.equal(await f.store.dashboard(a), null);
    assert.equal((await f.store.dashboard(b))?.account, "456");
  } finally {
    f.close();
  }
});
test("eight concurrently running tasks remain isolated when one account pauses and another logs in again", async () => {
  const f = fixture();
  try {
    const users = [];
    for (let n = 0; n < 8; n++) users.push(await f.store.enroll(credential(String(1000 + n))));
    const jobs = [];
    for (let n = 0; n < 8; n++) {
      jobs.push(await f.store.claim());
      f.advance(4000);
    }
    assert.ok(jobs.every(Boolean));
    assert.equal(new Set(jobs.map((job) => job!.id)).size, 8);
    assert.equal(await f.store.claim(), null);
    await f.store.setEnabled(users[0], false);
    await f.store.enroll(credential("1001"));
    for (const job of jobs) {
      const active = job!.credential.account !== "1001";
      assert.equal(await f.store.heartbeat(job!.id, job!.lease, job!.credential.version), active);
      assert.equal(
        await f.store.finish(job!.id, job!.lease, job!.credential.version, { status: "completed" }),
        active,
      );
    }
    const replacement = (await f.store.claim())!;
    assert.equal(replacement.credential.account, "1001");
    assert.notEqual(
      replacement.credential.version,
      jobs.find((job) => job!.credential.account === "1001")!.credential.version,
    );
    assert.equal(await f.store.claim(), null);
  } finally {
    f.close();
  }
});
test("heartbeats validate every call but only renew near expiry", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    const job = (await f.store.claim())!;
    const initial = f.store.now();
    const leaseUntil = () =>
      f.db.prepare("SELECT lease_until FROM jobs WHERE id=?").get(job.id)?.lease_until;
    f.queries.length = 0;
    for (let i = 0; i < 10; i++) {
      f.advance(1_000);
      assert.equal(await f.store.heartbeat(job.id, job.lease, job.credential.version), true);
    }
    assert.equal(leaseUntil(), initial + 300_000);
    assert.ok(f.queries.every(({ sql }) => sql.startsWith("SELECT")));
    assert.equal(f.queries.length, 10);
    f.advance(170_001);
    assert.equal(await f.store.heartbeat(job.id, job.lease, job.credential.version), true);
    assert.equal(leaseUntil(), f.store.now() + 300_000);
    assert.equal(f.queries.filter(({ sql }) => sql.startsWith("UPDATE")).length, 1);
    assert.equal(await f.store.heartbeat(job.id, "wrong-lease", job.credential.version), false);
    assert.equal(await f.store.heartbeat(job.id, job.lease, "wrong-version"), false);
    f.advance(300_001);
    assert.equal(await f.store.heartbeat(job.id, job.lease, job.credential.version), false);
  } finally {
    f.close();
  }
});

test("heartbeat renewal rechecks revocation after its initial read", async (t) => {
  const f = fixture();
  try {
    const userId = await f.store.enroll(credential("123"));
    const job = (await f.store.claim())!;
    f.advance(181_000);
    const prepare = f.store.db.prepare.bind(f.store.db);
    let revoked = false;
    t.mock.method(f.store.db, "prepare", (sql: string) => {
      const query = prepare(sql);
      if (sql.startsWith("SELECT lease_until")) {
        const first = query.first.bind(query);
        query.first = async <T>() => {
          const result = await first<T>();
          f.db.prepare("UPDATE hosting SET version='replacement' WHERE user_id=?").run(userId);
          revoked = true;
          return result;
        };
      }
      return query;
    });
    assert.equal(await f.store.heartbeat(job.id, job.lease, job.credential.version), false);
    assert.equal(revoked, true);
  } finally {
    f.close();
  }
});

test("expired leases recover with a new token and reject the old result", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    const old = (await f.store.claim())!;
    f.advance(301_000);
    assert.equal(await f.store.claim(), null);
    f.advance(600_000);
    const fresh = (await f.store.claim())!;
    assert.ok(fresh);
    assert.equal(fresh.id, old.id);
    assert.notEqual(fresh.lease, old.lease);
    assert.equal(
      await f.store.finish(old.id, old.lease, old.credential.version, { status: "auth_expired" }),
      false,
    );
    assert.equal(
      await f.store.finish(fresh.id, fresh.lease, fresh.credential.version, {
        status: "completed",
        ...confirmed,
      }),
      true,
    );
  } finally {
    f.close();
  }
});
test("relogin invalidates old work without expiring the new credentials", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    const old = (await f.store.claim())!;
    await f.store.enroll(credential("123"));
    assert.equal(
      await f.store.claim(),
      null,
      "new credentials wait for the revoked process to stop",
    );
    assert.equal(await f.store.heartbeat(old.id, old.lease, old.credential.version), false);
    assert.equal(
      await f.store.finish(old.id, old.lease, old.credential.version, { status: "auth_expired" }),
      false,
    );
    assert.equal((await f.store.dashboard(id))?.credentialState, "valid");
    assert.notEqual((await f.store.claim())?.credential.version, old.credential.version);
  } finally {
    f.close();
  }
});
test("pause lets running work finish; login expiry and deletion still revoke access", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    const first = (await f.store.claim())!;
    await f.store.setEnabled(id, false);
    assert.equal(await f.store.heartbeat(first.id, first.lease, first.credential.version), true);
    assert.equal(
      await f.store.finish(first.id, first.lease, first.credential.version, {
        status: "failed",
        reason: "upstream",
      }),
      true,
    );
    assert.equal((await f.store.dashboard(id))?.today?.status, "failed");
    f.advance(600_000);
    assert.equal(await f.store.claim(), null);
    await f.store.setEnabled(id, true);
    const second = (await f.store.claim())!;
    assert.equal(
      await f.store.finish(second.id, second.lease, second.credential.version, {
        status: "auth_expired",
        reason: "auth_expired",
      }),
      true,
    );
    assert.equal((await f.store.dashboard(id))?.enabled, false);
    f.advance(86400_000);
    await f.store.schedule();
    assert.equal(await f.store.claim(), null);
    await f.store.enroll(credential("123"));
    const third = (await f.store.claim())!;
    await f.store.deleteUser(id);
    assert.equal(await f.store.heartbeat(third.id, third.lease, third.credential.version), false);
    assert.equal(
      await f.store.finish(third.id, third.lease, third.credential.version, {
        status: "completed",
        ...confirmed,
      }),
      false,
    );
    assert.equal(await f.store.claim(), null);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n, 0);
  } finally {
    f.close();
  }
});
test("cross-day execution is stopped and a new day receives a new job", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    const old = (await f.store.claim())!;
    f.advance(86400_000);
    await f.store.schedule();
    assert.equal(await f.store.heartbeat(old.id, old.lease, old.credential.version), false);
    const next = (await f.store.claim())!;
    assert.notEqual(next.id, old.id);
    assert.equal(next.date, "2026-10-28");
  } finally {
    f.close();
  }
});
test("transient failures back off and stop after five attempts", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    for (let i = 1; i <= 5; i++) {
      const job = (await f.store.claim())!;
      assert.ok(job);
      assert.equal(
        await f.store.finish(job.id, job.lease, job.credential.version, {
          status: "failed",
          reason: "upstream",
        }),
        true,
      );
      assert.equal(await f.store.claim(), null);
      if (i < 5) f.advance(i === 1 ? 600_000 : i === 2 ? 2400_000 : i === 3 ? 7200_000 : 14400_000);
    }
    assert.equal((await f.store.dashboard(id))?.today?.status, "failed");
    assert.equal(await f.store.claim(), null);
    await f.store.enqueue(id, true);
    assert.equal(await f.store.claim(), null);
  } finally {
    f.close();
  }
});
test("rate limit admission is atomic and resets only after its window", async () => {
  const f = fixture();
  try {
    assert.equal(
      (
        await Promise.all(Array.from({ length: 10 }, () => f.store.quota("hashed", 3, 60_000)))
      ).filter(Boolean).length,
      3,
    );
    f.advance(59_999);
    assert.equal(await f.store.quota("hashed", 3, 60_000), false);
    f.advance(1);
    assert.equal(await f.store.quota("hashed", 3, 60_000), true);
  } finally {
    f.close();
  }
});
test("quota state reads preserve the original reset deadline and never consume an attempt", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.store.quotaStates(["phone", "ip"]), []);
    assert.equal(await f.store.quota("phone", 1, 60_000), true);
    const [first] = await f.store.quotaStates(["phone", "ip"]);
    assert.equal(first.count, 1);
    f.advance(10_000);
    assert.equal(await f.store.quota("phone", 1, 60_000), false);
    assert.deepEqual(await f.store.quotaStates(["phone"]), [first]);
    assert.equal(first.retryAt - f.store.now(), 50_000);
    f.advance(50_000);
    assert.deepEqual(await f.store.quotaStates(["phone"]), []);
  } finally {
    f.close();
  }
});
test("ordered quotas use one database call and stop consuming after the first rejection", async () => {
  const rules = [
    { key: "ip-minute", limit: 3, windowMs: 60_000 },
    { key: "ip-day", limit: 30, windowMs: 86400_000 },
    { key: "phone-minute", limit: 1, windowMs: 60_000 },
    { key: "phone-day", limit: 6, windowMs: 86400_000 },
  ];
  for (const blocked of [-1, 0, 1, 2, 3]) {
    const f = fixture();
    try {
      if (blocked >= 0) {
        const rule = rules[blocked];
        f.db
          .prepare("INSERT INTO rate_limits VALUES(?,?,?)")
          .run(rule.key, rule.limit, f.store.now() + rule.windowMs);
      }
      const before = f.queries.length;
      assert.equal(await f.store.quotas(rules), blocked < 0 ? null : blocked);
      assert.equal(f.queries.length - before, 1, "four limits require only one D1 round trip");
      const states = await f.store.quotaStates(rules.map((rule) => rule.key));
      for (const [index, rule] of rules.entries()) {
        const state = states.find((value) => value.key === rule.key);
        assert.equal(
          state?.count,
          index === blocked ? rule.limit : blocked < 0 || index < blocked ? 1 : undefined,
        );
      }
    } finally {
      f.close();
    }
  }
});
test("ordered quotas preserve concurrent admission, original deadlines and window boundaries", async () => {
  const f = fixture();
  const rules = [
    { key: "ip", limit: 3, windowMs: 60_000 },
    { key: "phone", limit: 1, windowMs: 60_000 },
    { key: "daily", limit: 6, windowMs: 86400_000 },
  ];
  try {
    const attempts = await Promise.all(Array.from({ length: 10 }, () => f.store.quotas(rules)));
    assert.equal(attempts.filter((value) => value === null).length, 1);
    assert.deepEqual(attempts, [null, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    const previous = await f.store.quotaStates(rules.map((rule) => rule.key));
    assert.equal(previous.find((row) => row.key === "daily")?.count, 1);
    f.advance(59_999);
    assert.equal(await f.store.quotas(rules), 0);
    assert.deepEqual(await f.store.quotaStates(rules.map((rule) => rule.key)), previous);
    f.advance(1);
    assert.equal(await f.store.quotas(rules), null);
    const next = await f.store.quotaStates(rules.map((rule) => rule.key));
    assert.equal(next.find((row) => row.key === "daily")?.count, 2);
    assert.equal(
      next.find((row) => row.key === "daily")?.retryAt,
      previous.find((row) => row.key === "daily")?.retryAt,
    );
    assert.equal(next.find((row) => row.key === "phone")?.retryAt, f.store.now() + 60_000);
  } finally {
    f.close();
  }
});
test("retries preserve rewards already confirmed by a partially completed attempt", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    const first = (await f.store.claim())!;
    await f.store.finish(first.id, first.lease, first.credential.version, {
      status: "failed",
      reason: "upstream",
      expDelta: 100,
      coinDelta: 200,
    });
    f.advance(600_000);
    const next = (await f.store.claim())!;
    await f.store.finish(next.id, next.lease, next.credential.version, {
      status: "completed",
      ...confirmed,
      expDelta: 30,
      coinDelta: 0,
    });
    const result = (await f.store.dashboard(id))?.today?.result;
    assert.equal(result?.expDelta, 130);
    assert.equal(result?.coinDelta, 200);
  } finally {
    f.close();
  }
});
test("retries do not turn unknown experience into a confirmed partial total", async () => {
  for (const [firstDelta, nextDelta] of [
    [undefined, 30],
    [30, undefined],
  ]) {
    const f = fixture();
    try {
      const id = await f.store.enroll(credential("123"));
      const first = (await f.store.claim())!;
      await f.store.finish(first.id, first.lease, first.credential.version, {
        status: "failed",
        reason: "upstream",
        expDelta: firstDelta,
        coinDelta: 200,
      });
      f.advance(600_000);
      const next = (await f.store.claim())!;
      await f.store.finish(next.id, next.lease, next.credential.version, {
        status: "completed",
        ...confirmed,
        expDelta: nextDelta,
        coinDelta: 0,
      });
      const result = (await f.store.dashboard(id))?.today?.result;
      assert.equal(result?.expDelta, undefined);
      assert.equal(result?.coinDelta, 200);
    } finally {
      f.close();
    }
  }
});
test("retries accumulate battery gains and retain earlier executed tasks", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    const first = (await f.store.claim())!;
    await f.store.finish(first.id, first.lease, first.credential.version, {
      status: "failed",
      reason: "upstream",
      batteryDelta: 1,
      execution: { sign: "executed", "1": "skipped" },
    });
    f.advance(600_000);
    const next = (await f.store.claim())!;
    await f.store.finish(next.id, next.lease, next.credential.version, {
      status: "completed",
      ...confirmed,
      batteryDelta: 2,
      execution: { sign: "skipped", "1": "skipped", "19": "executed", "31": "executed" },
    });
    const result = (await f.store.dashboard(id))!.today!.result!;
    assert.equal(result.batteryDelta, 3);
    assert.deepEqual(result.execution, {
      sign: "executed",
      "1": "skipped",
      "19": "executed",
      "31": "executed",
    });
  } finally {
    f.close();
  }
});
test("legacy or missing retry data cannot become a known battery total or an all-skipped run", async () => {
  for (const [firstDelta, nextDelta] of [
    [undefined, 1],
    [1, undefined],
  ]) {
    const f = fixture();
    try {
      const id = await f.store.enroll(credential("123"));
      const first = (await f.store.claim())!;
      await f.store.finish(first.id, first.lease, first.credential.version, {
        status: "failed",
        batteryDelta: firstDelta,
      });
      f.advance(600_000);
      const next = (await f.store.claim())!;
      await f.store.finish(next.id, next.lease, next.credential.version, {
        status: "completed",
        ...confirmed,
        batteryDelta: nextDelta,
        execution: { sign: "skipped", "1": "skipped", "19": "skipped", "31": "skipped" },
      });
      const result = (await f.store.dashboard(id))!.today!.result!;
      assert.equal(result.batteryDelta, undefined);
      assert.deepEqual(result.execution, {});
    } finally {
      f.close();
    }
  }
});
test("history is account-scoped, includes today and exposes a task type for the latest fifteen records", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    await f.store.enroll(credential("456"));
    const insert = f.db.prepare(
      "INSERT INTO jobs(id,user_id,date,status,available_at,created_at,updated_at) VALUES(?,?,?,'completed',0,0,0)",
    );
    for (let day = 1; day <= 20; day++)
      insert.run(`past-${day}`, id, `2026-10-${String(day).padStart(2, "0")}`);
    const history = (await f.store.history(id))!;
    assert.equal(history.account, "123");
    assert.equal(history.records.length, 15);
    assert.equal(history.records[0].date, "2026-10-27");
    assert.equal(history.records[1].date, "2026-10-20");
    assert.equal(history.records[14].date, "2026-10-07");
    assert.ok(
      history.records.every((row) => row.taskType === "daily" && row.taskName === "每日任务"),
    );
    assert.equal((await f.store.history("heybox:456"))!.records.length, 1);
    assert.equal(await f.store.history("heybox:missing"), null);
  } finally {
    f.close();
  }
});
test("the daily schedule uses Beijing 00:30 across UTC dates", () => {
  assert.equal(beijingDate(Date.parse("2026-10-26T16:30:00Z")), "2026-10-27");
  assert.equal(nextRunAt(Date.parse("2026-10-26T16:00:00Z")), Date.parse("2026-10-26T16:30:00Z"));
  assert.equal(nextRunAt(Date.parse("2026-10-26T16:30:00Z")), Date.parse("2026-10-27T16:30:00Z"));
});

test("a new day is enqueued at 00:30 and never at 00:00", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    f.advance(86400_000 - 1800_000);
    await f.store.schedule();
    assert.equal((await f.store.dashboard(id))?.today, null);
    f.advance(1800_000);
    await f.store.schedule();
    assert.equal((await f.store.dashboard(id))?.today?.status, "queued");
    await f.store.schedule();
    assert.equal((await f.store.dashboard(id))?.history.length, 2);
  } finally {
    f.close();
  }
});

test("profile updates stay with their account and survive legacy credentials", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll({
      ...credential("123"),
      profile: { nickname: "测试盒友", avatar: "https://cdn.max-c.com/avatar/test.png" },
    });
    await f.store.enroll(credential("456"));
    assert.equal((await f.store.dashboard(id))?.nickname, "测试盒友");
    assert.equal((await f.store.dashboard(id))?.avatar, "https://cdn.max-c.com/avatar/test.png");
    await f.store.enroll(credential("123"));
    assert.equal((await f.store.dashboard(id))?.nickname, "测试盒友");
    assert.equal((await f.store.dashboard("heybox:456"))?.nickname, "盒友 456");
  } finally {
    f.close();
  }
});

test("only an accepted task result can refresh its account profile", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll({ ...credential("123"), profile: { nickname: "原昵称" } });
    const old = (await f.store.claim())!;
    await f.store.enroll({ ...credential("123"), profile: { nickname: "重新登录后的昵称" } });
    assert.equal(
      await f.store.finish(old.id, old.lease, old.credential.version, {
        status: "completed",
        ...confirmed,
        profile: { nickname: "过期进程" },
      }),
      false,
    );
    assert.equal((await f.store.dashboard(id))?.nickname, "重新登录后的昵称");
    f.advance(4000);
    const current = (await f.store.claim())!;
    assert.equal(
      await f.store.finish(current.id, current.lease, current.credential.version, {
        status: "completed",
        ...confirmed,
        profile: { nickname: "当前昵称", avatar: "https://cdn.max-c.com/current.png" },
      }),
      true,
    );
    assert.equal((await f.store.dashboard(id))?.nickname, "当前昵称");
  } finally {
    f.close();
  }
});

test("public count deduplicates accounts and includes paused/expired hosting until deletion", async () => {
  const f = fixture();
  try {
    assert.equal(await f.store.accountCount(), 0);
    const a = await f.store.enroll(credential("123"));
    await f.store.enroll(credential("123"));
    const b = await f.store.enroll(credential("456"));
    await f.store.setEnabled(a, false);
    f.db.prepare("UPDATE hosting SET credential_state='expired' WHERE user_id=?").run(b);
    assert.equal(await f.store.accountCount(), 2);
    await f.store.deleteUser(a);
    assert.equal(await f.store.accountCount(), 1);
  } finally {
    f.close();
  }
});

test("light dashboard reads only today's job and preserves the full response by default", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    f.advance(86400_000);
    await f.store.schedule();
    const full = (await f.store.dashboard(id))!;
    assert.equal(full.history.length, 2);
    f.queries.length = 0;
    const light = (await f.store.dashboard(id, false))!;
    assert.deepEqual(light, { ...full, history: [] });
    const jobsQuery = f.queries.find(({ sql }) => sql.includes("FROM jobs"))!;
    assert.match(jobsQuery.sql, /user_id=\? AND date=\?/);
    assert.equal(f.queries.length, 2);
    f.advance(86400_000);
    assert.equal((await f.store.dashboard(id, false))?.today, null);
  } finally {
    f.close();
  }
});
