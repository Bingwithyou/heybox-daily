// Run against a local Worker with test/mock-runner.ts, never against production.
import assert from "node:assert/strict";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { router } from "../src/server/rpc.ts";
import { jobSchema, taskIds } from "@heybox/contracts";
import { decryptCredential } from "../../runner/src/crypto.ts";

const base = process.env.TEST_SITE_URL || "http://localhost:3000";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Integration tests only allow localhost");
const token = process.env.RUNNER_SERVICE_TOKEN || "";
class Browser {
  cookies = new Map<string, string>();
  readonly ip = `127.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.1`;
  async fetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("origin", base);
    headers.set("cf-connecting-ip", this.ip);
    headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(input, { ...init, headers });
    for (const value of response.headers.getSetCookie()) {
      assert.match(value.toLowerCase(), /httponly/);
      const [name, ...body] = value.split(";")[0].split("=");
      if (body.join("=")) this.cookies.set(name, body.join("="));
      else this.cookies.delete(name);
    }
    return response;
  }
  rpc: RouterClient<typeof router> = createORPCClient(
    new RPCLink({ url: `${base}/rpc`, fetch: (input, init) => this.fetch(input, init) }),
  );
  auth(path: string, body: unknown) {
    return this.fetch(`${base}/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}
async function internal(path: string, body: unknown) {
  return fetch(`${base}/internal/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const a = new Browser();
const b = new Browser();
const guest = new Browser();
await assert.rejects(guest.rpc.dashboard(), /请先登录/);
const humanChallenge = await guest.auth("heybox/send-code", { phone: "13900000000" });
assert.equal(humanChallenge.status, 400);
const challengeError = (await humanChallenge.json()) as { code: string; message: string };
assert.equal(challengeError.code, "captcha_required");
assert.match(challengeError.message, /人机验证/);
assert.equal(guest.cookies.size, 0);
const captchaBrowser = new Browser();
const captchaStart = await captchaBrowser.auth("heybox/send-code", { phone: "13900000001" });
assert.equal(captchaStart.status, 200);
const captchaState = (await captchaStart.json()) as {
  status: string;
  challenge: string;
  appId: string;
};
assert.equal(captchaState.status, "captcha");
assert.equal(captchaState.appId, "1234567890");
assert.ok(!JSON.stringify(captchaState).includes("integration-fixture"));
const proof = {
  challenge: captchaState.challenge,
  ticket: "valid-ticket",
  randstr: "valid-randstr",
};
assert.equal((await guest.auth("heybox/complete-captcha", proof)).status, 400);
assert.equal(
  (
    await captchaBrowser.auth("heybox/verify-code", {
      challenge: captchaState.challenge,
      code: "123456",
    })
  ).status,
  400,
);
assert.equal(
  (
    await captchaBrowser.auth("heybox/complete-captcha", {
      ...proof,
      ticket: "trerror_1001_fallback",
    })
  ).status,
  400,
);
const captchaSent = await captchaBrowser.auth("heybox/complete-captcha", proof);
assert.equal(captchaSent.status, 200);
assert.equal(((await captchaSent.json()) as { status: string }).status, "sent");
assert.equal((await captchaBrowser.auth("heybox/complete-captcha", proof)).status, 400);
assert.equal(
  (
    await captchaBrowser.auth("heybox/verify-code", {
      challenge: captchaState.challenge,
      code: "123456",
    })
  ).status,
  200,
);
assert.equal((await captchaBrowser.rpc.dashboard()).account, "00001");
await captchaBrowser.rpc.deleteAccount({ confirm: true });
const verificationBrowser = new Browser();
const verificationStart = await verificationBrowser.auth("heybox/send-code", {
  phone: "13900000002",
});
const verificationState = (await verificationStart.json()) as { challenge: string };
const verificationChallenge = await verificationBrowser.auth("heybox/verify-code", {
  challenge: verificationState.challenge,
  code: "123456",
});
assert.equal(((await verificationChallenge.json()) as { status: string }).status, "captcha");
const verified = await verificationBrowser.auth("heybox/complete-captcha", {
  ...proof,
  challenge: verificationState.challenge,
});
assert.equal(verified.status, 200);
assert.equal(((await verified.json()) as { status: string }).status, "authenticated");
assert.equal((await verificationBrowser.rpc.dashboard()).account, "00002");
await verificationBrowser.rpc.deleteAccount({ confirm: true });
assert.equal(
  (
    await fetch(`${base}/api/auth/heybox/send-code`, {
      method: "POST",
      headers: { origin: "https://evil.invalid", "content-type": "application/json" },
      body: "{}",
    })
  ).status,
  403,
);
assert.equal((await fetch(`${base}/internal/claim`, { method: "POST" })).status, 401);
assert.equal((await fetch(`${base}/rpc/setEnabled`)).status, 405);
assert.equal(
  (
    await fetch(`${base}/api/auth/heybox/send-code`, {
      method: "POST",
      headers: { origin: base },
      body: "x".repeat(5000),
    })
  ).status,
  413,
);
const suffix = String(Date.now()).slice(-5);
async function login(browser: Browser, phone: string) {
  const sent = await browser.auth("heybox/send-code", { phone });
  assert.equal(sent.status, 200, await sent.clone().text());
  const challenge = (await sent.json()) as { challenge: string };
  const oldCookies = new Map(browser.cookies);
  assert.equal(
    (await browser.auth("heybox/verify-code", { challenge: challenge.challenge, code: "111111" }))
      .status,
    400,
  );
  assert.equal(
    (await browser.auth("heybox/verify-code", { challenge: challenge.challenge, code: "123456" }))
      .status,
    200,
  );
  const authenticatedCookies = browser.cookies;
  browser.cookies = oldCookies;
  assert.equal(
    (await browser.auth("heybox/verify-code", { challenge: challenge.challenge, code: "123456" }))
      .status,
    400,
  );
  browser.cookies = authenticatedCookies;
  return challenge;
}
await login(a, `130001${suffix}`);
await login(
  b,
  `131002${String(Number(suffix) + 1)
    .padStart(5, "0")
    .slice(-5)}`,
);
const first = await a.rpc.dashboard();
const second = await b.rpc.dashboard();
assert.notEqual(first.account, second.account);
assert.equal(first.nickname, "测试盒友");
assert.equal(first.avatar, null);
const existingSessionChallenge = await b.auth("heybox/send-code", { phone: "13900000003" });
const existingChallenge = (await existingSessionChallenge.json()) as { challenge: string };
assert.equal(
  (
    await b.auth("heybox/complete-captcha", {
      ...proof,
      challenge: existingChallenge.challenge,
      ticket: "invalid-proof",
    })
  ).status,
  400,
);
assert.equal((await b.rpc.dashboard()).account, second.account);
assert.ok(first.enabled && second.enabled);
assert.ok(!JSON.stringify(first).includes("ciphertext"));
assert.ok(!JSON.stringify(first).includes("pkey"));
const accounts = new Set([first.account, second.account]);
for (let count = 0; count < 10 && accounts.size; count++) {
  const response = await internal("claim", {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  if (!payload) break;
  const job = jobSchema.parse(payload);
  assert.equal(
    decryptCredential(job.credential, process.env.CREDENTIAL_KEY || "").session.heybox_id,
    job.credential.account,
  );
  assert.equal(
    (await internal("heartbeat", { id: job.id, lease: job.lease, version: job.credential.version }))
      .status,
    204,
  );
  const result = {
    status: "completed",
    snapshot: { exp: 130, coin: 200, tasks: taskIds.map((id) => ({ id, state: "finish" })) },
    expDelta: 130,
    coinDelta: 200,
  };
  assert.equal(
    (
      await internal("finish", {
        id: job.id,
        lease: job.lease,
        version: job.credential.version,
        result,
      })
    ).status,
    204,
  );
  accounts.delete(job.credential.account);
}
assert.equal(accounts.size, 0);
assert.equal((await a.rpc.dashboard()).today?.status, "completed");
await a.rpc.setEnabled({ enabled: false });
assert.equal((await a.rpc.dashboard()).enabled, false);
assert.equal((await b.rpc.dashboard()).enabled, true);
await a.rpc.deleteAccount({ confirm: true });
await assert.rejects(a.rpc.dashboard(), /请先登录/);
assert.equal((await b.rpc.dashboard()).today?.status, "completed");
await b.rpc.deleteAccount({ confirm: true });
await assert.rejects(b.rpc.dashboard(), /请先登录/);
console.log(
  "PASS: local D1 + Better Auth + oRPC + runner login, cookies, replay prevention, two-user isolation, jobs, pause and deletion",
);
