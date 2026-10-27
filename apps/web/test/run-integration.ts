import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { createMockRunner } from "./mock-runner.ts";

const web = fileURLToPath(new URL("../", import.meta.url));
const wrangler = path.join(web, "node_modules/wrangler/bin/wrangler.js");
const directory = await mkdtemp(path.join(tmpdir(), "heybox-integration-"));
const token = randomBytes(32).toString("hex");
const key = randomBytes(32).toString("base64");
let notifications = 0;
const runner = createMockRunner(token, key, () => {
  notifications++;
});
await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve));
const runnerAddress = runner.address();
if (!runnerAddress || typeof runnerAddress === "string") throw new Error("Runner port unavailable");
const portProbe = createServer();
await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const address = portProbe.address();
if (!address || typeof address === "string") throw new Error("Web port unavailable");
await new Promise<void>((resolve, reject) =>
  portProbe.close((error) => (error ? reject(error) : resolve())),
);
const url = `http://127.0.0.1:${address.port}`;
const configPath = path.join(directory, "wrangler.json");
const config = JSON.parse(await readFile(path.join(web, "dist/server/wrangler.json"), "utf8"));
delete config.configPath;
delete config.userConfigPath;
// Wrangler rewrites Origin to a configured custom domain even in local mode.
// Keep the isolated test server on its own loopback origin.
config.routes = [];
delete config.account_id;
config.main = path.join(web, "dist/server/index.js");
config.assets.directory = path.join(web, "dist/client");
config.vars = {
  SITE_URL: url,
  RUNNER_URL: `http://127.0.0.1:${runnerAddress.port}`,
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  RUNNER_SERVICE_TOKEN: token,
};
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
const common = ["--config", configPath, "--persist-to", path.join(directory, "state")];
function run(script: string, args: string[], env = process.env) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (value) => (output += value));
  child.stderr.on("data", (value) => (output += value));
  const done = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(output || `Process exited: ${code}`)),
    );
  });
  return { child, done, output: () => output };
}
let worker: ReturnType<typeof run> | undefined;
try {
  await run(wrangler, [
    "d1",
    "execute",
    "heybox-daily",
    "--local",
    "--file",
    path.join(web, "migrations/0001_hosting.sql"),
    ...common,
  ]).done;
  // An exhausted legacy site quota must not block unrelated users.
  const exhaustedQuotas = [
    ["sms:site:hour", 60],
    ["sms:phone:day:+8613900000008", 6],
    ["sms:ip:day:127.255.0.1", 30],
    ["verify:ip:127.255.0.2", 30],
    ["captcha:ip:127.255.0.3", 30],
    ["auth:127.255.0.4|/get-session", 100],
  ] as const;
  const quotaValues = exhaustedQuotas.map(([value, count]) => {
    const hashed = createHmac("sha256", config.vars.BETTER_AUTH_SECRET).update(value).digest("hex");
    return `('${hashed}',${count},${Date.now() + 3600_000})`;
  });
  await run(wrangler, [
    "d1",
    "execute",
    "heybox-daily",
    "--local",
    "--command",
    `INSERT INTO rate_limits(key,count,expires_at) VALUES${quotaValues.join(",")}`,
    ...common,
  ]).done;
  worker = run(wrangler, [
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(address.port),
    ...common,
  ]);
  void worker.done.catch(() => {});
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${url}/login`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* server is starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Worker did not start: ${worker.output()}`);
  const result = await run(path.join(web, "test/integration.ts"), [], {
    ...process.env,
    TEST_SITE_URL: url,
    RUNNER_SERVICE_TOKEN: token,
    CREDENTIAL_KEY: key,
  }).done;
  console.log(result.trim());
  const rateLimitEvents = [
    ...worker.output().matchAll(/\{"event":"auth_rate_limited"[^\n]+\}/g),
  ].map(([line]) => JSON.parse(line) as Record<string, unknown>);
  const expectedLimits = [
    ["sms:ip:minute", 3, 60],
    ["sms:ip:day", 30, 86400],
    ["sms:phone:minute", 1, 60],
    ["sms:phone:day", 6, 86400],
    ["verify:ip", 30, 300],
    ["captcha:ip", 30, 300],
    ["auth:ip:endpoint", 100, 10],
  ] as const;
  assert.equal(rateLimitEvents.length, expectedLimits.length + 1);
  assert.equal(rateLimitEvents.filter((event) => event.rule === "sms:phone:minute").length, 2);
  for (const [rule, limit, windowSeconds] of expectedLimits) {
    assert.deepEqual(
      rateLimitEvents.find((event) => event.rule === rule),
      { event: "auth_rate_limited", rule, limit, windowSeconds },
      "rate-limit diagnostics identify the rule without logging phone, IP, cookie or quota key",
    );
  }
  console.log("PASS: all seven auth limits emit distinct, credential-free diagnostics");
  assert.equal(
    notifications,
    14,
    "successful logins, resume and retry must reach the authenticated runner wakeup endpoint",
  );
  console.log(
    "PASS: login, resume and retry notifications reach the runner; pause does not wake it",
  );
} finally {
  worker?.child.kill("SIGTERM");
  await new Promise<void>((resolve) => runner.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
