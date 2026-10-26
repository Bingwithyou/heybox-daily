import { os, ORPCError } from "@orpc/server";
import { z } from "zod";
import { createAuth } from "./auth.ts";
import { Store } from "./store.ts";
import type { Env } from "./env.ts";

const authenticated = os
  .$context<{ env: Env; request: Request }>()
  .use(async ({ context, next }) => {
    const session = await createAuth(context.env).api.getSession({
      headers: context.request.headers,
    });
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "请先登录" });
    return next({ context: { userId: session.user.id, store: new Store(context.env.DB) } });
  });
export const router = {
  dashboard: authenticated.handler(async ({ context }) => {
    const dashboard = await context.store.dashboard(context.userId);
    if (!dashboard) throw new ORPCError("UNAUTHORIZED", { message: "请重新登录" });
    return dashboard;
  }),
  setEnabled: authenticated
    .input(z.object({ enabled: z.boolean() }))
    .handler(async ({ context, input }) => {
      await context.store.setEnabled(context.userId, input.enabled);
      return { ok: true };
    }),
  retry: authenticated.handler(async ({ context }) => {
    if (!(await context.store.quota(`retry:${context.userId}`, 3, 3600_000)))
      throw new ORPCError("TOO_MANY_REQUESTS", { message: "补跑次数过多，请稍后重试" });
    await context.store.enqueue(context.userId, true);
    return { ok: true };
  }),
  deleteAccount: authenticated
    .input(z.object({ confirm: z.literal(true) }))
    .handler(async ({ context }) => {
      await context.store.deleteUser(context.userId);
      return { ok: true };
    }),
};
