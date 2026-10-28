import test from "node:test";
import assert from "node:assert/strict";
import { runScheduled } from "../src/server/schedule.ts";
import type { Env } from "../src/server/env.ts";
import type { Statement } from "@heybox/hosting/store";

test("24 hourly checks clean expired rows once, at Beijing 00:30, and only wake for new jobs", async () => {
  let schedules = 0;
  let cleanups = 0;
  let notifications = 0;
  const db = {
    prepare: () => {
      const statement: Statement = {
        bind: () => statement,
        first: async () => null,
        all: async <T>() => {
          schedules++;
          return { results: (schedules === 1 ? [{ id: "new-job" }] : []) as T[] };
        },
        run: async () => {
          cleanups++;
        },
      };
      return statement;
    },
    batch: (statements: Statement[]) => Promise.all(statements.map((statement) => statement.run())),
  };
  const env = {
    DB: db,
    RUNNER_URL: "https://runner.invalid",
    RUNNER_SERVICE_TOKEN: "a".repeat(64),
  } as unknown as Env;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    notifications++;
    return new Response(null, { status: 204 });
  };
  try {
    for (let hour = 0; hour < 24; hour++) {
      await runScheduled(env, Date.parse("2026-10-27T00:30:00+08:00") + hour * 3600_000);
      assert.equal(cleanups, 5);
    }
    assert.equal(schedules, 24);
    assert.equal(notifications, 1);
  } finally {
    globalThis.fetch = original;
  }
});
