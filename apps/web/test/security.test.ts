import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedBody,
  runnerRequest,
  privateKey,
  sameOrigin,
  serviceAuthorized,
} from "../src/server/security.ts";
import type { Env } from "../src/server/env.ts";

test("service calls use Workers-compatible manual redirects and never follow them with credentials", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://other.invalid/" } });
  };
  try {
    await assert.rejects(
      runnerRequest(
        { RUNNER_URL: "https://runner.invalid", RUNNER_SERVICE_TOKEN: "test" } as Env,
        "/login/begin",
        {},
      ),
      /HTTP 302/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("service token, same-origin checks and hashed quotas do not trust user input", async () => {
  const token = "a".repeat(64);
  assert.equal(
    await serviceAuthorized(
      new Request("https://site.invalid", { headers: { authorization: `Bearer ${token}` } }),
      token,
    ),
    true,
  );
  assert.equal(await serviceAuthorized(new Request("https://site.invalid"), token), false);
  assert.equal(
    sameOrigin(
      new Request("https://site.invalid", { headers: { origin: "https://attacker.invalid" } }),
      "https://site.invalid",
    ),
    false,
  );
  assert.equal(sameOrigin(new Request("https://site.invalid"), "https://site.invalid"), false);
  const hashed = await privateKey("phone:13800138000", token);
  assert.equal(hashed.length, 64);
  assert.ok(!hashed.includes("13800138000"));
  assert.notEqual(hashed, await privateKey("phone:13800138000", "b".repeat(64)));
});
test("body limits apply to actual bytes even when Content-Length is absent", async () => {
  assert.equal(
    new TextDecoder().decode(
      await boundedBody(
        new Request("https://site.invalid", { method: "POST", body: '{"ok":true}' }),
      ),
    ),
    '{"ok":true}',
  );
  const body = await boundedBody(
    new Request("https://site.invalid", {
      method: "POST",
      body: new TextEncoder().encode('{"json":{}}'),
    }),
  );
  const forwarded = new Request("https://site.invalid", { method: "POST", body });
  assert.equal(forwarded.headers.get("content-type"), null);
  assert.deepEqual(await forwarded.json(), { json: {} });
  await assert.rejects(
    boundedBody(new Request("https://site.invalid", { method: "POST", body: "字".repeat(2000) })),
    /请求过大/,
  );
});
