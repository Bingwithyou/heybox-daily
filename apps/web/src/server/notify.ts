import type { Env } from "./env.ts";

export function notifyRunnerInBackground(env: Env, execution: Pick<ExecutionContext, "waitUntil">) {
  execution.waitUntil(notifyRunner(env));
}

export async function notifyRunner(env: Env) {
  try {
    if (env.DAILY_EXECUTOR === "cloudflare") {
      if (!env.EXECUTOR) return false;
      const response = await env.EXECUTOR.fetch("https://executor.internal/tasks/wake", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RUNNER_SERVICE_TOKEN}` },
        signal: AbortSignal.timeout(2000),
      });
      return response.status === 204;
    }
    const url = new URL("/tasks/wake", env.RUNNER_URL);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))
      return false;
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RUNNER_SERVICE_TOKEN}` },
      signal: AbortSignal.timeout(2000),
      redirect: "manual",
    });
    return response.status === 204;
  } catch {
    // The job is already durable. The runner's periodic check will find it.
    return false;
  }
}
