import test from "node:test";
import assert from "node:assert/strict";
import { RPCHandler } from "@orpc/server/fetch";
import { api } from "../src/server/api.ts";
import type { Env } from "../src/server/env.ts";

test("bounded API request reconstruction preserves client cancellation into the RPC context", async (t) => {
  const controller = new AbortController();
  const env = {
    SITE_URL: "https://site.invalid",
    BETTER_AUTH_SECRET: "a".repeat(64),
    RUNNER_SERVICE_TOKEN: "b".repeat(64),
  } as Env;
  let called = false;
  t.mock.method(
    RPCHandler.prototype,
    "handle",
    async (request: Request, options: { context: { request: Request } }) => {
      called = true;
      assert.equal(await request.text(), '{"json":{"expectedAccount":"123"}}');
      controller.abort();
      assert.ok(request.signal.aborted);
      assert.ok(options.context.request.signal.aborted);
      return { matched: true, response: Response.json({ ok: true }) };
    },
  );
  const request = new Request("https://site.invalid/rpc/activities", {
    method: "POST",
    headers: { origin: "https://site.invalid", "content-type": "application/json" },
    body: '{"json":{"expectedAccount":"123"}}',
    signal: controller.signal,
  });
  assert.equal((await api(request, env, { waitUntil: () => {} }))?.status, 200);
  assert.ok(called);
});
