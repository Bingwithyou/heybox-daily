import test from "node:test";
import assert from "node:assert/strict";
import { LoginTiming } from "@heybox/contracts";

test("login timings keep failed stages, accumulate repeated storage calls and accept only numeric known metrics", async () => {
  let now = 10;
  const timing = new LoginTiming(undefined, () => now);
  await timing.measure("challenge_save", async () => {
    now += 4;
  });
  const error = new Error("private upstream response");
  await assert.rejects(
    timing.measure("challenge_save", async () => {
      now += 6;
      throw error;
    }),
    (value) => value === error,
  );
  timing.merge(
    "token_service;dur=12.4, phone;dur=13800138000, sms_upstream;dur=NaN, token_http;dur=-1, executor;dur=999999999",
  );
  assert.deepEqual(timing.values, { challenge_save: 10, token_service: 12.4 });
  assert.equal(timing.header(), "challenge_save;dur=10, token_service;dur=12.4");
  assert.match(timing.id, /^[a-f0-9-]{36}$/);
  assert.ok(!JSON.stringify(timing).includes("private upstream response"));
  assert.notEqual(new LoginTiming("phone-or-token").id, "phone-or-token");
  assert.equal(new LoginTiming(timing.id).id, timing.id);
});
