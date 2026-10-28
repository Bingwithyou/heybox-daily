import test from "node:test";
import assert from "node:assert/strict";
import { activityRequest } from "../src/server/activities.ts";
import type { Env } from "../src/server/env.ts";
import type { Store } from "@heybox/hosting/store";

const credential = {
  account: "123",
  version: crypto.randomUUID(),
  ciphertext: "private-credential".repeat(3),
};
const env = {
  RUNNER_URL: "https://runner.invalid",
  RUNNER_SERVICE_TOKEN: "private-service-token",
} as Env;
const store = { activityCredential: async () => credential } as Pick<Store, "activityCredential">;
const view = {
  id: "9",
  name: "活动",
  prizeCount: 1,
  endTime: null,
  joined: true,
  tickets: 700,
  status: "completed",
  followAccounts: [],
};

test("activity cancellation reaches the executor service binding", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let forwarded: AbortSignal | null | undefined;
  const cloudflare = {
    ...env,
    EXECUTOR_ENABLED: "true",
    EXECUTOR: {
      fetch: async (_url: unknown, init?: RequestInit) => {
        forwarded = init?.signal;
        entered();
        return new Promise<Response>((_resolve, reject) =>
          forwarded!.addEventListener("abort", () => reject(forwarded!.reason), { once: true }),
        );
      },
    },
  } as unknown as Env;
  const result = activityRequest(
    cloudflare,
    store,
    "heybox:123",
    { mode: "list", expectedAccount: "123" },
    controller.signal,
  );
  await ready;
  controller.abort();
  await assert.rejects(result);
  assert.ok(forwarded?.aborted);
});
test("activity calls check the active account before reading credentials or contacting the runner", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("unexpected request"));
  await assert.rejects(
    activityRequest(env, store, "heybox:456", { mode: "list", expectedAccount: "123" }),
    /账号/,
  );
  await assert.rejects(
    activityRequest(env, { activityCredential: async () => null }, "heybox:123", {
      mode: "list",
      expectedAccount: "123",
    }),
    /登录/,
  );
});
test("only the current server credential and selected activity consent are forwarded, and responses are reduced to the view contract", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init?.body)), {
      mode: "participate",
      credential,
      activityId: "9",
      approvedFollowIds: ["456"],
    });
    assert.equal(init?.redirect, "manual");
    return Response.json({
      mode: "participate",
      activity: { ...view, pkey: "private-provider-data" },
      help_code: "private",
    });
  });
  const result = await activityRequest(env, store, "heybox:123", {
    mode: "participate",
    expectedAccount: "123",
    activityId: "9",
    approvedFollowIds: ["456"],
  });
  assert.deepEqual(result, { mode: "participate", activity: view });
  assert.ok(!JSON.stringify(result).includes("private"));
});
test("runner replies for another activity or mode are rejected instead of updating the wrong row", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ mode: "participate", activity: { ...view, id: "888" } }),
  );
  await assert.rejects(
    activityRequest(env, store, "heybox:123", {
      mode: "participate",
      expectedAccount: "123",
      activityId: "9",
      approvedFollowIds: [],
    }),
    /暂时/,
  );
});
test("activity failure codes preserve a useful message without exposing upstream exception text", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: "activity_unconfirmed", error: "private-provider-data" },
      { status: 400 },
    ),
  );
  await assert.rejects(
    activityRequest(env, store, "heybox:123", {
      mode: "participate",
      expectedAccount: "123",
      activityId: "9",
      approvedFollowIds: [],
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /尚未确认/);
      assert.ok(!error.message.includes("private"));
      return true;
    },
  );
});
