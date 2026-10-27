// Local integration fixture only. It cannot contact the real Heybox service.
import { ChallengeStore } from "../../runner/src/challenges.ts";
import { createRunnerServer } from "../../runner/src/server.ts";
import type { Config } from "../../../dist/types.js";
import { fileURLToPath } from "node:url";
import { ActivityFailure, LoginFailure, type ActivityView } from "@heybox/contracts";
import { ActivityService } from "../../runner/src/activities.ts";

export function createMockRunner(token: string, key: string, wake = () => {}) {
  const store = new ChallengeStore({
    begin: async (phone) => {
      if (phone === "+8613900000000") throw new LoginFailure();
      if (phone === "+8613900000004") throw new LoginFailure("upstream_rate_limit");
      const config: Config = {
        session: {
          heybox_id: phone.slice(-5),
          pkey: "integration-fixture",
          device_id: crypto.randomUUID(),
          x_xhh_tokenid: "B" + "a".repeat(88),
        },
        device: { model: "test", osVersion: "17" },
        app: { version: "1.3.398", build: "1142", shaderVersion: "14" },
        profile: { nickname: "测试盒友" },
      };
      return ["+8613900000001", "+8613900000003", "+8613900000005"].includes(phone)
        ? { status: "captcha", config, appId: "1234567890" }
        : { status: "sent", config };
    },
    send: async (config, phone, proof) => {
      if (phone === "+8613900000005") throw new LoginFailure("upstream_rate_limit");
      if (proof.ticket === "ask-again") return { status: "captcha", config, appId: "1234567890" };
      if (proof.ticket !== "valid-ticket" || proof.randstr !== "valid-randstr")
        throw new Error("wrong proof");
      return { status: "sent", config };
    },
    verify: async (config, phone, code, proof) => {
      if (phone === "+8613900000002" && !proof)
        return { status: "captcha", config, appId: "1234567890" };
      if (proof && (proof.ticket !== "valid-ticket" || proof.randstr !== "valid-randstr"))
        throw new Error("wrong proof");
      if (code !== "123456") throw new Error("wrong");
      return { status: "authenticated", config };
    },
  });
  const activityState = new Map<string, ActivityView[]>();
  const activities = new ActivityService(async (input) => {
    const account = input.credential.account;
    let rows = activityState.get(account);
    if (!rows) {
      rows = [
        {
          id: "9317",
          name: "一加电竞好物盲盒",
          prizeCount: 5,
          endTime: "2026-10-29 15:00",
          joined: false,
          tickets: null,
          status: "follow_required",
          followAccounts: [{ id: "104298871", name: "关注「一加手机」官方账号" }],
        },
        {
          id: "9305",
          name: "PS5手柄＋漫步者耳机",
          prizeCount: 4,
          endTime: "2026-11-04 15:00",
          joined: false,
          tickets: null,
          status: "blocked",
          reason: "Steam库内拥有《愚者不灭》",
          followAccounts: [],
        },
        {
          id: "9351",
          name: "高票档完整伴手礼（随机）",
          prizeCount: 6,
          endTime: "2026-11-09 15:00",
          joined: true,
          tickets: 1200,
          status: "completed",
          followAccounts: [],
        },
      ];
      activityState.set(account, rows);
    }
    if (input.mode === "list") return { mode: "list", activities: rows };
    const row = rows.find((value) => value.id === input.activityId);
    if (!row || row.status === "blocked") throw new ActivityFailure("activity_blocked");
    if (row.followAccounts.some((target) => !input.approvedFollowIds.includes(target.id)))
      throw new ActivityFailure("activity_changed");
    if (!row.joined) {
      // Keep a visible pending state for the local browser interaction check.
      await new Promise((resolve) => setTimeout(resolve, 250));
      row.joined = true;
      row.tickets = 700;
      row.status = "completed";
      row.followAccounts = [];
    }
    return { mode: "participate", activity: row };
  });
  return createRunnerServer(store, token, key, wake, activities);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  createMockRunner(process.env.RUNNER_SERVICE_TOKEN || "", process.env.CREDENTIAL_KEY || "").listen(
    8788,
    "127.0.0.1",
  );
