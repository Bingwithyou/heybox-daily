import test from "node:test";
import assert from "node:assert/strict";
import { readCaptchaProof } from "../src/lib/captcha.ts";

test("only real success-shaped CAPTCHA callbacks can be submitted, and cancellation does nothing", () => {
  assert.equal(readCaptchaProof({ ret: 2 }), null);
  assert.deepEqual(
    readCaptchaProof({ ret: 0, ticket: "verified-ticket", randstr: "verified-randstr" }),
    { ticket: "verified-ticket", randstr: "verified-randstr" },
  );
  for (const result of [
    { ret: 0, ticket: "trerror_1001_appid_time", randstr: "fallback", errorCode: 1001 },
    { ret: 0, ticket: "trerror_1001_appid_time", randstr: "fallback" },
    { ret: 0, ticket: "ticket", randstr: "fallback", errorCode: 1006 },
    { ret: 0, ticket: "ticket\n", randstr: "randstr" },
    { ret: 0 },
    { ret: 1 },
    { ret: "0", ticket: "ticket", randstr: "randstr" },
  ])
    assert.throws(() => readCaptchaProof(result));
});
