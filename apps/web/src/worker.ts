import start from "@tanstack/react-start/server-entry";
import type { Env } from "./server/env.ts";
import { api } from "./server/api.ts";
import { runScheduled } from "./server/schedule.ts";
import { crawlerDocument, shouldNoindex } from "./server/seo.ts";
import { pageAccess } from "./server/page-access.ts";

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    const started = performance.now();
    let response: Response;
    try {
      response =
        crawlerDocument(request, env.DEPLOYMENT_ENV === "staging") ||
        (await pageAccess(request, env, context)) ||
        (await api(request, env, context)) ||
        (await start.fetch(request));
    } catch {
      response = Response.json({ message: "服务暂时不可用，请稍后重试" }, { status: 503 });
    }
    const result = new Response(response.body, response);
    if (
      env.DEPLOYMENT_ENV === "staging" ||
      shouldNoindex(new URL(request.url).pathname, response.status)
    )
      result.headers.set("x-robots-tag", "noindex, follow");
    result.headers.set("x-content-type-options", "nosniff");
    result.headers.set("referrer-policy", "same-origin");
    result.headers.set("x-frame-options", "DENY");
    result.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (new URL(request.url).pathname !== "/api/stats" || request.method !== "GET" || !response.ok)
      result.headers.set("cache-control", "no-store");
    result.headers.set("server-timing", `app;dur=${(performance.now() - started).toFixed(1)}`);
    return result;
  },
  async scheduled(event: ScheduledController, env: Env, context: ExecutionContext) {
    if (env.DEPLOYMENT_ENV === "staging") return;
    context.waitUntil(runScheduled(env, event.scheduledTime));
  },
};
