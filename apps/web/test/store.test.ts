import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Store, type Database, type Statement } from "../src/server/store.ts";
import { beijingDate, nextRunAt, type Credential } from "@heybox/contracts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  db.exec(readFileSync(new URL("../migrations/0001_hosting.sql", import.meta.url), "utf8"));
  class Query implements Statement {
    readonly sql: string;
    values: unknown[] = [];
    constructor(sql: string) {
      this.sql = sql;
    }
    bind(...values: unknown[]) {
      this.values = values;
      return this;
    }
    execute() {
      queries.push({ sql: this.sql, values: this.values });
      const stmt = db.prepare(this.sql);
      return stmt.all(...(this.values as Array<string | number | null>));
    }
    async first<T>() {
      return (this.execute()[0] || null) as T | null;
    }
    async all<T>() {
      return { results: this.execute() as T[] };
    }
    async run() {
      return this.execute();
    }
  }
  const adapter: Database = {
    prepare: (sql) => new Query(sql),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        const results = statements.map((stmt) => (stmt as Query).execute());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  let now = Date.parse("2026-10-27T00:01:00+08:00");
  return {
    db,
    queries,
    store: new Store(adapter, () => now),
    advance: (ms: number) => {
      now += ms;
    },
    close: () => db.close(),
  };
}
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
    assert.equal(f.store.retryAfter, 60);
    f.advance(60_000);
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

test("a lease extending past midnight does not delay the cross-day check", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    f.advance(86339_000);
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
test("eight parallel claims remain isolated when one account pauses and another logs in again", async () => {
  const f = fixture();
  try {
    const users = [];
    for (let n = 0; n < 8; n++) users.push(await f.store.enroll(credential(String(1000 + n))));
    const jobs = await Promise.all(Array.from({ length: 8 }, () => f.store.claim()));
    assert.ok(jobs.every(Boolean));
    assert.equal(new Set(jobs.map((job) => job!.id)).size, 8);
    assert.equal(await f.store.claim(), null);
    await f.store.setEnabled(users[0], false);
    await f.store.enroll(credential("1001"));
    for (const job of jobs) {
      const active = !["1000", "1001"].includes(job!.credential.account);
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
test("expired leases recover with a new token and reject the old result", async () => {
  const f = fixture();
  try {
    await f.store.enroll(credential("123"));
    const old = (await f.store.claim())!;
    f.advance(301_000);
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
test("pause and delete revoke active leases, login expiry pauses future scheduling", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    const first = (await f.store.claim())!;
    await f.store.setEnabled(id, false);
    assert.equal(await f.store.heartbeat(first.id, first.lease, first.credential.version), false);
    assert.equal(
      await f.store.finish(first.id, first.lease, first.credential.version, {
        status: "cancelled",
        reason: "cancelled",
      }),
      false,
    );
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
test("transient failures back off and stop after three attempts", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    for (let i = 1; i <= 3; i++) {
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
      f.advance(180_000);
    }
    assert.equal((await f.store.dashboard(id))?.today?.status, "failed");
    assert.equal(await f.store.claim(), null);
    await f.store.enqueue(id, true);
    assert.ok(await f.store.claim());
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
    f.advance(60_000);
    const next = (await f.store.claim())!;
    await f.store.finish(next.id, next.lease, next.credential.version, {
      status: "completed",
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
      f.advance(60_000);
      const next = (await f.store.claim())!;
      await f.store.finish(next.id, next.lease, next.credential.version, {
        status: "completed",
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
    f.advance(60_000);
    const next = (await f.store.claim())!;
    await f.store.finish(next.id, next.lease, next.credential.version, {
      status: "completed",
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
      f.advance(60_000);
      const next = (await f.store.claim())!;
      await f.store.finish(next.id, next.lease, next.credential.version, {
        status: "completed",
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
test("the daily schedule uses Beijing 00:01 across UTC dates", () => {
  assert.equal(beijingDate(Date.parse("2026-10-26T16:01:00Z")), "2026-10-27");
  assert.equal(nextRunAt(Date.parse("2026-10-26T16:00:00Z")), Date.parse("2026-10-26T16:01:00Z"));
  assert.equal(nextRunAt(Date.parse("2026-10-26T16:01:00Z")), Date.parse("2026-10-27T16:01:00Z"));
});

test("a new day is enqueued at 00:01 and never at 00:00", async () => {
  const f = fixture();
  try {
    const id = await f.store.enroll(credential("123"));
    f.advance(86400_000 - 60_000);
    await f.store.schedule();
    assert.equal((await f.store.dashboard(id))?.today, null);
    f.advance(60_000);
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
        profile: { nickname: "过期进程" },
      }),
      false,
    );
    assert.equal((await f.store.dashboard(id))?.nickname, "重新登录后的昵称");
    const current = (await f.store.claim())!;
    assert.equal(
      await f.store.finish(current.id, current.lease, current.credential.version, {
        status: "completed",
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
