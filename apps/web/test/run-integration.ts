import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createMockRunner } from "./mock-runner.ts";

const web = fileURLToPath(new URL("../", import.meta.url));
const wrangler = path.join(web, "node_modules/wrangler/bin/wrangler.js");
const directory = await mkdtemp(path.join(tmpdir(), "heybox-integration-"));
const token = randomBytes(32).toString("hex");
const key = randomBytes(32).toString("base64");
const runner = createMockRunner(token, key);
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
} finally {
  worker?.child.kill("SIGTERM");
  await new Promise<void>((resolve) => runner.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
