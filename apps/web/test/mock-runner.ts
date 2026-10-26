// Local integration fixture only. It cannot contact the real Heybox service.
import { ChallengeStore } from "../../runner/src/challenges.ts";
import { createRunnerServer } from "../../runner/src/server.ts";
import type { Config } from "../../../dist/types.js";
import { fileURLToPath } from "node:url";
import { LoginFailure } from "@heybox/contracts";

export function createMockRunner(token: string, key: string) {
  const store = new ChallengeStore({
    begin: async (phone) => {
      if (phone === "+8613900000000") throw new LoginFailure();
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
      return ["+8613900000001", "+8613900000003"].includes(phone)
        ? { status: "captcha", config, appId: "1234567890" }
        : { status: "sent", config };
    },
    send: async (config, _phone, proof) => {
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
  return createRunnerServer(store, token, key);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  createMockRunner(process.env.RUNNER_SERVICE_TOKEN || "", process.env.CREDENTIAL_KEY || "").listen(
    8788,
    "127.0.0.1",
  );
