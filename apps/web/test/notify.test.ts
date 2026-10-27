import test from "node:test";
import assert from "node:assert/strict";
import { notifyRunner, notifyRunnerInBackground } from "../src/server/notify.ts";
import type { Env } from "../src/server/env.ts";

const env = { RUNNER_URL: "https://runner.invalid", RUNNER_SERVICE_TOKEN: "a".repeat(64) } as Env;

test("task dispatch switches independently from login and activity migration", async (t) => {
  let bound = 0;
  let legacy = 0;
  t.mock.method(globalThis, "fetch", async () => {
    legacy++;
    return new Response(null, { status: 204 });
  });
  const migrated = {
    ...env,
    EXECUTOR_ENABLED: "true",
    DAILY_EXECUTOR: "legacy",
    EXECUTOR: {
      fetch: async () => {
        bound++;
        return new Response(null, { status: 204 });
      },
    },
  } as unknown as Env;
  assert.equal(await notifyRunner(migrated), true);
  assert.equal(bound, 0);
  assert.equal(legacy, 1);
  migrated.DAILY_EXECUTOR = "cloudflare";
  assert.equal(await notifyRunner(migrated), true);
  assert.equal(bound, 1);
  assert.equal(legacy, 1);
});

test("task notifications use existing service authentication, no account data and a short timeout", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://runner.invalid/tasks/wake");
    assert.equal(init?.method, "POST");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${env.RUNNER_SERVICE_TOKEN}`,
    );
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(null, { status: 204 });
  };
  try {
    assert.equal(await notifyRunner(env), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("a slow wakeup is retained by waitUntil without blocking the request", async () => {
  const original = globalThis.fetch;
  let complete!: (response: Response) => void;
  const request = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  globalThis.fetch = () => request;
  const pending: Promise<unknown>[] = [];
  try {
    const result = notifyRunnerInBackground(env, {
      waitUntil: (work) => {
        pending.push(work);
      },
    });
    assert.equal(result, undefined);
    assert.equal(pending.length, 1);
    complete(new Response(null, { status: 204 }));
    assert.equal(await pending[0], true);
  } finally {
    globalThis.fetch = original;
  }
});

test("a lost notification does not fail a committed login or enqueue", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("private network error");
    };
    assert.equal(await notifyRunner(env), false);
    globalThis.fetch = async () =>
      new Response(null, { status: 302, headers: { location: "https://other.invalid" } });
    assert.equal(await notifyRunner(env), false);
  } finally {
    globalThis.fetch = original;
  }
});
