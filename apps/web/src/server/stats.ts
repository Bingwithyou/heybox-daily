import type { Env } from "./env.ts";
import { Store } from "./store.ts";

export async function publicStats(
  request: Request,
  env: Env,
  execution: Pick<ExecutionContext, "waitUntil">,
  cache: Pick<Cache, "match" | "put"> = (caches as CacheStorage & { default: Cache }).default,
) {
  // All visitors share this public value; cookies and query strings are not cache keys.
  const key = new Request(new URL("/api/stats", request.url));
  const cached = await cache.match(key).catch(() => undefined);
  if (cached) {
    const response = new Response(cached.body, cached);
    // Cache API hits can carry the zone's longer Browser Cache TTL.
    response.headers.set("Cache-Control", "public, max-age=300");
    return response;
  }
  const response = Response.json(
    { accounts: await new Store(env.DB).accountCount() },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
  execution.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  return response;
}
