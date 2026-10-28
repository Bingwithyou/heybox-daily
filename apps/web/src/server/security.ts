import type { Env } from "./env.ts";
import {
  LoginFailure,
  loginFailureSchema,
  ActivityFailure,
  activityFailureSchema,
  LoginTiming,
  loginTimingHeader,
} from "@heybox/contracts";

export async function runnerRequest(
  env: Env,
  path: string,
  input: unknown,
  backend?: "legacy" | "cloudflare",
  timing?: LoginTiming,
  signal?: AbortSignal,
) {
  const started = performance.now();
  try {
    const cloudflare =
      (backend ?? (env.EXECUTOR_ENABLED === "true" ? "cloudflare" : "legacy")) === "cloudflare";
    if (cloudflare && !env.EXECUTOR) throw new Error("执行 Worker 绑定缺失");
    const url = new URL(cloudflare ? "https://executor.internal" : env.RUNNER_URL);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))
      throw new Error("执行端必须使用 HTTPS");
    const request = cloudflare ? env.EXECUTOR!.fetch.bind(env.EXECUTOR!) : fetch;
    const response = await request(new URL(path, url).toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RUNNER_SERVICE_TOKEN}`,
        "content-type": "application/json",
        ...(timing ? { [loginTimingHeader]: timing.id } : {}),
      },
      body: JSON.stringify(input),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
      redirect: "manual",
    });
    timing?.merge(response.headers.get("server-timing"));
    if (!response.ok) {
      if (path === "/activities" && [400, 409].includes(response.status)) {
        const failure = activityFailureSchema.safeParse(await response.json().catch(() => null));
        if (failure.success) throw new ActivityFailure(failure.data.code);
        throw new Error(`执行端响应 HTTP ${response.status}`);
      }
      if ([400, 429].includes(response.status)) {
        const failure = loginFailureSchema.safeParse(await response.json().catch(() => null));
        if (failure.success) throw new LoginFailure(failure.data.code, failure.data.retryAt);
      }
      throw new Error(`执行端响应 HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    timing?.add("executor", performance.now() - started);
  }
}
