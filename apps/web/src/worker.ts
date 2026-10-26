import start from "@tanstack/react-start/server-entry";
import type { Env } from "./server/env.ts";
import { api } from "./server/api.ts";
import { Store } from "./server/store.ts";

export default {
  async fetch(request: Request, env: Env) {
    const started = performance.now();
    let response: Response;
    try {
      response = (await api(request, env)) || (await start.fetch(request));
    } catch {
      response = Response.json({ message: "服务暂时不可用，请稍后重试" }, { status: 503 });
    }
    const result = new Response(response.body, response);
    result.headers.set("x-content-type-options", "nosniff");
    result.headers.set("referrer-policy", "same-origin");
    result.headers.set("x-frame-options", "DENY");
    result.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    result.headers.set("cache-control", "no-store");
    result.headers.set("server-timing", `app;dur=${(performance.now() - started).toFixed(1)}`);
    return result;
  },
  async scheduled(_event: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(new Store(env.DB).schedule());
  },
};
