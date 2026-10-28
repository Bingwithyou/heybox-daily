import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/server/api.ts";
import type { Env } from "../src/server/env.ts";

function fixture(fetch: NonNullable<Env["EXECUTOR"]>["fetch"]) {
  const env = {
    BETTER_AUTH_SECRET: "a".repeat(64),
    RUNNER_SERVICE_TOKEN: "b".repeat(64),
    DAILY_EXECUTOR: "cloudflare",
    EXECUTOR: { fetch },
  } as unknown as Env;
  const request = (method = "POST", authorized = true) =>
    new Request("https://site.invalid/internal/executor/wake", {
      method,
      headers: authorized ? { authorization: `Bearer ${env.RUNNER_SERVICE_TOKEN}` } : {},
    });
  return { env, request, execution: { waitUntil: () => {} } };
}

test("internal wake rejects unauthenticated requests and non-POST methods without dispatch", async () => {
  let calls = 0;
  const { env, request, execution } = fixture(async () => {
    calls++;
    return new Response(null, { status: 204 });
  });
  assert.equal((await api(request("POST", false), env, execution))?.status, 401);
  assert.equal((await api(request("GET"), env, execution))?.status, 405);
  assert.equal(calls, 0);
});

test("authenticated wake forwards once to the selected executor without a body or D1 access", async () => {
  let calls = 0;
  const { env, request, execution } = fixture(async (input, init) => {
    calls++;
    assert.equal(String(input), "https://executor.internal/tasks/wake");
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, undefined);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${env.RUNNER_SERVICE_TOKEN}`,
    );
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(null, { status: 204 });
  });
  assert.equal((await api(request(), env, execution))?.status, 204);
  assert.equal(calls, 1);
});

test("wake reports unavailable dispatch while keeping the durable queue untouched", async () => {
  for (const outcome of ["unavailable", "error", "missing"] as const) {
    const { env, request, execution } = fixture(async () => {
      if (outcome === "error") throw new Error("unavailable");
      return new Response(null, { status: 503 });
    });
    if (outcome === "missing") env.EXECUTOR = undefined;
    assert.equal((await api(request(), env, execution))?.status, 503);
  }
});
