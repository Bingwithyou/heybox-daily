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
import { authRequest } from "../src/lib/client.ts";
import { LoginFailure } from "@heybox/contracts";
import type { SmsCooldown } from "../src/lib/login-cooldown.ts";

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

test("runner human-challenge errors keep their safe code instead of becoming a gateway failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ code: "captcha_required", error: "private-provider-details" }, { status: 400 });
  try {
    await assert.rejects(
      runnerRequest(
        { RUNNER_URL: "https://runner.invalid", RUNNER_SERVICE_TOKEN: "test" } as Env,
        "/login/begin",
        {},
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code: string }).code, "captcha_required");
        assert.match(error.message, /人机验证/);
        assert.ok(!error.message.includes("private-provider-details"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("upstream throttling keeps an actionable message without leaking provider details", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: "upstream_rate_limit", error: "private-provider-details" },
      { status: 400 },
    ),
  );
  await assert.rejects(
    runnerRequest(
      { RUNNER_URL: "https://runner.invalid", RUNNER_SERVICE_TOKEN: "test" } as Env,
      "/login/captcha",
      {},
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code: string }).code, "upstream_rate_limit");
      assert.match(error.message, /小黑盒.*频繁.*稍后/);
      assert.ok(!error.message.includes("人机验证"));
      assert.ok(!error.message.includes("private-provider-details"));
      return true;
    },
  );
});

test("the browser retains the throttle code so it can exit a rejected CAPTCHA flow", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: "upstream_rate_limit", message: "private-provider-details" },
      { status: 400 },
    ),
  );
  await assert.rejects(authRequest("heybox/complete-captcha", {}), (error) => {
    assert.ok(error instanceof LoginFailure);
    assert.equal(error.code, "upstream_rate_limit");
    assert.match(error.message, /小黑盒.*频繁.*稍后/);
    assert.ok(!error.message.includes("private-provider-details"));
    return true;
  });
});

test("a rejected SMS response still synchronizes its authoritative cooldown", async (t) => {
  const cooldown: SmsCooldown = {
    serverTime: 100_000,
    limits: [{ rule: "sms:phone:minute", retryAt: 146_000 }],
  };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        code: "upstream_rate_limit",
        smsCooldown: cooldown,
      },
      { status: 400 },
    ),
  );
  let received: SmsCooldown | undefined;
  await assert.rejects(
    authRequest("heybox/send-code", {}, (value) => {
      received = value;
    }),
    LoginFailure,
  );
  assert.deepEqual(received, cooldown);
});

test("the generic auth limiter has a Chinese message and honors its remaining retry time", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        message: "Too many requests. Please try again later.",
      },
      { status: 429, headers: { "X-Retry-After": "7" } },
    ),
  );
  let retrySeconds = 0;
  await assert.rejects(
    authRequest("heybox/send-code", {}, (value, authoritative) => {
      assert.equal(authoritative, false);
      assert.equal(value.limits[0].rule, "auth:ip:endpoint");
      retrySeconds = (value.limits[0].retryAt - value.serverTime) / 1000;
    }),
    /登录接口.*频繁/,
  );
  assert.equal(retrySeconds, 7);
});
