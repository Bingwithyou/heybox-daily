import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "../../../packages/hosting/test/database.ts";
import { Store } from "@heybox/hosting/store";
import { api } from "../src/server/api.ts";
import type { Env } from "../src/server/env.ts";
import { PersistentChallenge, type ChallengeStorage } from "../../executor/src/challenge.ts";
import type { LoginStep } from "@heybox/hosting/login";

class MemoryStorage implements ChallengeStorage {
  value?: string;
  async get<T>() {
    return this.value as T | undefined;
  }
  async put(_key: string, value: string) {
    this.value = value;
  }
  async setAlarm() {}
  async deleteAlarm() {}
  async deleteAll() {
    this.value = undefined;
  }
  async transaction<T>(fn: (tx: Pick<ChallengeStorage, "put" | "setAlarm">) => Promise<T>) {
    return fn(this);
  }
}
const config: LoginStep["config"] = {
  session: {
    heybox_id: "123",
    pkey: "fixture",
    device_id: "fixture",
    x_xhh_tokenid: "B" + "a".repeat(88),
  },
  device: { model: "test", osVersion: "17" },
  app: { version: "1.3.398", build: "1142", shaderVersion: "14" },
};

for (const failedWrite of ["enrollment", "session"] as const)
  test(`login recovers after ${failedWrite} failure and lost cookie response without duplicate verification, credentials or sessions`, async (t) => {
    const f = fixture(Date.now());
    t.after(() => f.close());
    let verifies = 0;
    let fail = false;
    let confirmations = 0;
    const prepare = f.adapter.prepare;
    f.adapter.prepare = (sql) => {
      if (
        fail &&
        (failedWrite === "enrollment"
          ? sql.includes("INSERT INTO user")
          : /insert into .?session/i.test(sql))
      ) {
        fail = false;
        throw new Error("injected D1 write failure");
      }
      return prepare(sql);
    };
    const states = new Map<string, MemoryStorage>();
    const key = Buffer.alloc(32, 7).toString("base64");
    const operations = {
      begin: async () => ({ status: "sent" as const, config }),
      send: async () => ({ status: "sent" as const, config }),
      verify: async () => {
        verifies++;
        return { status: "authenticated" as const, config };
      },
    };
    const env = {
      DB: f.adapter as D1Database,
      SITE_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "fixture-auth-secret-".repeat(4),
      RUNNER_SERVICE_TOKEN: "fixture-service-secret-".repeat(3),
      EXECUTOR_ENABLED: "true",
      DAILY_EXECUTOR: "cloudflare",
      EXECUTOR: {
        fetch: async (url: string, init: RequestInit) => {
          const path = new URL(url).pathname;
          if (path === "/tasks/wake") return new Response(null, { status: 204 });
          const input = JSON.parse(String(init.body));
          const id = input.challenge ?? randomUUID();
          const storage = states.get(id) ?? new MemoryStorage();
          states.set(id, storage);
          const challenge = new PersistentChallenge(storage, key, id, operations);
          await challenge.load();
          try {
            if (path === "/login/begin")
              return Response.json(await challenge.begin(input.phone, input.binding));
            if (path === "/login/confirm") {
              await challenge.confirm(input.binding);
              confirmations++;
              return Response.json({ confirmed: true });
            }
            return Response.json(await challenge.verify(input.code, input.binding));
          } catch {
            return Response.json({ error: "challenge rejected" }, { status: 400 });
          }
        },
      },
    } as unknown as Env;
    let cookies = new Map<string, string>();
    const call = async (path: string, input: unknown, acceptCookies = true) => {
      const response = await api(
        new Request(`${env.SITE_URL}/api/auth/heybox/${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: env.SITE_URL,
            cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
          },
          body: JSON.stringify(input),
        }),
        env,
        { waitUntil: () => {} },
      );
      assert.ok(response);
      if (acceptCookies)
        for (const cookie of response.headers.getSetCookie()) {
          const [name, ...value] = cookie.split(";")[0].split("=");
          if (value.join("=")) cookies.set(name, value.join("="));
          else cookies.delete(name);
        }
      return response;
    };
    const start = await call("send-code", { phone: "13800138000" });
    assert.equal(start.status, 200);
    const { challenge } = (await start.json()) as { challenge: string };
    const input = { challenge, code: "123456" };
    const intentCookies = new Map(cookies);
    assert.equal((await call("confirm-login", { challenge })).status, 401);
    fail = true;
    assert.equal((await call("verify-code", input, false)).status, 500);
    assert.equal(fail, false, "the intended write failure must have been exercised");
    assert.equal(verifies, 1);
    assert.equal(
      (await call("verify-code", input, false)).status,
      200,
      "successful response is intentionally lost",
    );
    const store = new Store(f.adapter);
    const job = (await store.claim())!;
    assert.ok(job);
    const responses = await Promise.all([
      call("verify-code", input, false),
      call("verify-code", input),
    ]);
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(verifies, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM session").get()!.n, 1);
    assert.equal(await store.heartbeat(job.id, job.lease, job.credential.version), true);
    assert.equal((await call("confirm-login", { challenge })).status, 200);
    assert.equal(confirmations, 1);
    assert.equal(states.get(challenge)!.value, undefined);
    assert.equal((await call("confirm-login", { challenge })).status, 200);
    cookies = intentCookies;
    assert.equal((await call("verify-code", input)).status, 400);
    assert.equal(verifies, 1);
  });
