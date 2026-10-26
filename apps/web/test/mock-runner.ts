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
      return {
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
    },
    verify: async (config: Config, _phone, code) => {
      if (code !== "123456") throw new Error("wrong");
      return config;
    },
  });
  return createRunnerServer(store, token, key);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  createMockRunner(process.env.RUNNER_SERVICE_TOKEN || "", process.env.CREDENTIAL_KEY || "").listen(
    8788,
    "127.0.0.1",
  );
