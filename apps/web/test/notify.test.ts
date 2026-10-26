import test from "node:test";
import assert from "node:assert/strict";
import { notifyRunner } from "../src/server/notify.ts";
import type { Env } from "../src/server/env.ts";

const env = { RUNNER_URL: "https://runner.invalid", RUNNER_SERVICE_TOKEN: "a".repeat(64) } as Env;

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
