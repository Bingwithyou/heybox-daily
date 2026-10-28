import { RPCHandler } from "@orpc/server/fetch";
import {
  finishSchema,
  heartbeatSchema,
  activityAccessSchema,
  type LoginTiming,
} from "@heybox/contracts";
import { createAuth } from "./auth.ts";
import type { Env } from "./env.ts";
import { router } from "./rpc.ts";
import { runnerRequest } from "./security.ts";
import { boundedBody, sameOrigin, serviceAuthorized } from "@heybox/hosting/security";
import { Store } from "@heybox/hosting/store";
import { publicStats } from "./stats.ts";
import { notifyRunner } from "./notify.ts";

const rpc = new RPCHandler(router);
const authPaths = new Set([
  "/api/auth/heybox/send-code",
  "/api/auth/heybox/verify-code",
  "/api/auth/heybox/complete-captcha",
  "/api/auth/heybox/confirm-login",
  "/api/auth/get-session",
  "/api/auth/heybox/accounts",
  "/api/auth/heybox/switch",
  "/api/auth/heybox/logout",
  "/api/auth/heybox/delete",
]);
export async function api(
  request: Request,
  env: Env,
  execution: Pick<ExecutionContext, "waitUntil">,
  loginTiming?: LoginTiming,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/") && !path.startsWith("/rpc/") && !path.startsWith("/internal/"))
    return null;
  if (
    !env.BETTER_AUTH_SECRET ||
    env.BETTER_AUTH_SECRET.length < 32 ||
    !env.RUNNER_SERVICE_TOKEN ||
    env.RUNNER_SERVICE_TOKEN.length < 32
  ) {
    return Response.json({ message: "服务尚未配置完成" }, { status: 503 });
  }
  if (path === "/api/stats" && request.method === "GET") {
    return publicStats(request, env, execution);
  }
  if (path.startsWith("/internal/")) {
    if (!(await serviceAuthorized(request, env.RUNNER_SERVICE_TOKEN)))
      return new Response(null, { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (path === "/internal/executor/wake") {
      return new Response(null, { status: (await notifyRunner(env)) ? 204 : 503 });
    }
    const store = new Store(env.DB);
    try {
      if (path === "/internal/claim") {
        if (env.DAILY_EXECUTOR === "cloudflare")
          return Response.json(null, { headers: { "retry-after": "1800" } });
        const job = await store.claim();
        return Response.json(job, {
          headers: job ? {} : { "retry-after": String(store.retryAfter) },
        });
      }
      if (path === "/internal/executor/health") {
        return Response.json(await runnerRequest(env, "/health", {}, "cloudflare"));
      }
      const raw = await request.text();
      if (raw.length > 16_384) return new Response(null, { status: 413 });
      const body = JSON.parse(raw) as unknown;
      if (path === "/internal/executor/inspect") {
        const account =
          body && typeof body === "object" && "account" in body ? body.account : undefined;
        if (typeof account !== "string" || !/^\d{1,20}$/.test(account))
          return new Response(null, { status: 400 });
        const credential = await store.activityCredential(`heybox:${account}`);
        if (!credential) return new Response(null, { status: 404 });
        return Response.json(
          await runnerRequest(env, "/diagnostics/inspect", credential, "cloudflare"),
        );
      }
      if (path === "/internal/activities/check") {
        const value = activityAccessSchema.parse(body);
        return new Response(null, {
          status: (await store.activityAccess(value.account, value.version)) ? 204 : 409,
        });
      }
      if (path === "/internal/heartbeat") {
        const value = heartbeatSchema.parse(body);
        return new Response(null, {
          status: (await store.heartbeat(value.id, value.lease, value.version)) ? 204 : 409,
        });
      }
      if (path === "/internal/finish") {
        const value = finishSchema.parse(body);
        return new Response(null, {
          status: (await store.finish(value.id, value.lease, value.version, value.result))
            ? 204
            : 409,
        });
      }
      return new Response(null, { status: 404 });
    } catch {
      return Response.json({ message: "请求无效" }, { status: 400 });
    }
  }
  if (path.startsWith("/rpc/") && request.method !== "POST")
    return new Response(null, { status: 405 });
  if (request.method !== "GET" && !sameOrigin(request, env.SITE_URL))
    return Response.json({ message: "请求来源无效，请刷新页面" }, { status: 403 });
  if (Number(request.headers.get("content-length") || 0) > 4096)
    return new Response(null, { status: 413 });
  if (request.method === "POST") {
    try {
      const body = await boundedBody(request);
      const headers = new Headers(request.headers);
      request = new Request(request.url, { method: "POST", headers, body, signal: request.signal });
    } catch {
      return new Response(null, { status: 413 });
    }
  }
  if (path.startsWith("/api/auth/")) {
    if (!authPaths.has(path)) return new Response(null, { status: 404 });
    return createAuth(env, execution, loginTiming).handler(request);
  }
  const result = await rpc.handle(request, {
    prefix: "/rpc",
    context: { env, request, execution },
  });
  return result.matched ? result.response : new Response(null, { status: 404 });
}
