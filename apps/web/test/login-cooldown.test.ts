import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyCooldownState,
  startSmsRequest,
  applySmsCooldown,
  applySentCooldown,
  activeCooldown,
  restoreCooldown,
  formatCooldown,
} from "../src/lib/login-cooldown.ts";

const phone = "+8613900000004";

test("a CAPTCHA-delayed SMS starts a fresh cooldown after the initial request has expired", () => {
  const initial = startSmsRequest(emptyCooldownState(), phone, 100_000);
  assert.equal(activeCooldown(initial, phone, 175_000), null);
  const sent = applySentCooldown(initial, phone, 60, 175_000);
  assert.equal(activeCooldown(sent, phone, 175_000)?.seconds, 60);
  assert.equal(activeCooldown(sent, phone, 175_000)?.rule, "sms:phone:minute");
  assert.equal(
    activeCooldown(restoreCooldown(JSON.stringify(sent), 185_000), phone, 185_000)?.seconds,
    50,
  );
  assert.equal(activeCooldown(sent, phone, 235_000), null);
});

test("normal SMS sends are disabled for the returned retry period and longer quotas survive", () => {
  const normal = applySentCooldown(emptyCooldownState(), phone, 60, 100_000);
  assert.equal(activeCooldown(normal, phone, 100_000)?.seconds, 60);
  assert.equal(activeCooldown(normal, "+8613900000005", 100_000), null);
  const limited = applySmsCooldown(
    normal,
    phone,
    {
      serverTime: 100_000,
      limits: [{ rule: "sms:phone:day", retryAt: 3_700_000 }],
    },
    100_000,
  );
  const sent = applySentCooldown(limited, phone, 60, 120_000);
  assert.equal(activeCooldown(sent, phone, 120_000)?.rule, "sms:phone:day");
  assert.equal(activeCooldown(sent, phone, 120_000)?.seconds, 3580);
});

test("a rejected verification returning sent with retryAfter zero does not restart the SMS timer", () => {
  const sent = applySentCooldown(emptyCooldownState(), phone, 60, 100_000);
  const retry = applySentCooldown(sent, phone, 0, 130_000);
  assert.equal(activeCooldown(retry, phone, 130_000)?.seconds, 30);
  assert.equal(activeCooldown(retry, phone, 160_000), null);
});

test("an unresolved or failed send keeps its cooldown across refresh", () => {
  const state = startSmsRequest(emptyCooldownState(), phone, 100_000);
  assert.equal(activeCooldown(state, phone, 100_000)?.seconds, 60);
  const restored = restoreCooldown(JSON.stringify(state), 112_000);
  assert.equal(restored.phone, phone);
  assert.equal(activeCooldown(restored, phone, 112_000)?.seconds, 48);
  assert.equal(activeCooldown(restored, phone, 160_000), null);
  assert.equal(activeCooldown(restored, "+8613900000005", 112_000), null);
});

test("server deadlines replace the provisional timer without depending on the browser clock", () => {
  const state = applySmsCooldown(
    startSmsRequest(emptyCooldownState(), phone, 7_200_000),
    phone,
    {
      serverTime: 100_000,
      limits: [{ rule: "sms:phone:minute", retryAt: 123_500 }],
    },
    7_205_000,
  );
  assert.equal(activeCooldown(state, phone, 7_205_000)?.seconds, 24);
  assert.equal(
    activeCooldown(restoreCooldown(JSON.stringify(state), 7_215_000), phone, 7_215_000)?.seconds,
    14,
  );
  assert.equal(activeCooldown(state, phone, 7_228_500), null);
});

test("phone limits stay with their number while shared IP limits survive changing numbers", () => {
  let state = applySmsCooldown(
    emptyCooldownState(),
    phone,
    {
      serverTime: 10_000,
      limits: [
        { rule: "sms:phone:day", retryAt: 3_610_000 },
        { rule: "sms:ip:minute", retryAt: 40_000 },
      ],
    },
    100_000,
  );
  assert.equal(activeCooldown(state, phone, 100_000)?.rule, "sms:phone:day");
  assert.equal(activeCooldown(state, "+8613900000005", 100_000)?.seconds, 30);
  assert.equal(activeCooldown(state, "+8613900000005", 130_000), null);
  state = applySmsCooldown(state, "+8613900000005", { serverTime: 20_000, limits: [] }, 140_000);
  assert.equal(activeCooldown(state, phone, 140_000)?.seconds, 3560);
});

test("generic auth throttling replaces only the unconfirmed attempt, preserving known quotas", () => {
  const state = applySmsCooldown(
    startSmsRequest(emptyCooldownState(), phone, 100_000),
    phone,
    {
      serverTime: 200_000,
      limits: [{ rule: "auth:ip:endpoint", retryAt: 207_000 }],
    },
    101_000,
    false,
  );
  assert.equal(activeCooldown(state, phone, 101_000)?.seconds, 7);
  assert.equal(activeCooldown(state, phone, 108_000), null);
});

test("invalid or expired saved state cannot produce a permanent disabled button", () => {
  assert.deepEqual(restoreCooldown("invalid", 100_000), emptyCooldownState());
  assert.deepEqual(
    restoreCooldown('{"phone":"private","entries":[]}', 100_000),
    emptyCooldownState(),
  );
  const state = startSmsRequest(emptyCooldownState(), phone, 100_000);
  assert.deepEqual(restoreCooldown(JSON.stringify(state), 160_000), emptyCooldownState());
  assert.equal(formatCooldown(42), "42 秒后重发");
  assert.equal(formatCooldown(3661), "1:01:01 后重试");
});
