import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Store, type Database, type Statement } from "../src/server/store.ts";
import { beijingDate, nextRunAt, type Credential } from "@heybox/contracts";

function fixture() {
  const db = new DatabaseSync(":memory:");
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
