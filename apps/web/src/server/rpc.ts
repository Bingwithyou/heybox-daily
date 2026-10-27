import { os, ORPCError } from "@orpc/server";
import { z } from "zod";
import { createAuth } from "./auth.ts";
import { Store } from "./store.ts";
import type { Env } from "./env.ts";
import { notifyRunner } from "./notify.ts";

const authenticated = os
  .$context<{ env: Env; request: Request }>()
  .use(async ({ context, next }) => {
    const session = await createAuth(context.env).api.getSession({
      headers: context.request.headers,
    });
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "请先登录" });
    return next({ context: { userId: session.user.id, store: new Store(context.env.DB) } });
  });
const accountInput = z.object({ expectedAccount: z.string().min(1).max(64) });
function checkAccount(userId: string, expectedAccount: string) {
  if (userId !== `heybox:${expectedAccount}`)
    throw new ORPCError("CONFLICT", { message: "当前账号已变化，请刷新页面后重试" });
}
export const router = {
  dashboard: authenticated.handler(async ({ context }) => {
    const dashboard = await context.store.dashboard(context.userId);
    if (!dashboard) throw new ORPCError("UNAUTHORIZED", { message: "请重新登录" });
    return dashboard;
  }),
  setEnabled: authenticated
    .input(accountInput.extend({ enabled: z.boolean() }))
    .handler(async ({ context, input }) => {
      checkAccount(context.userId, input.expectedAccount);
      await context.store.setEnabled(context.userId, input.enabled);
      if (input.enabled) await notifyRunner(context.env);
      return { ok: true };
    }),
  retry: authenticated.input(accountInput).handler(async ({ context, input }) => {
    checkAccount(context.userId, input.expectedAccount);
    if (!(await context.store.quota(`retry:${context.userId}`, 3, 3600_000)))
      throw new ORPCError("TOO_MANY_REQUESTS", { message: "补跑次数过多，请稍后重试" });
    await context.store.enqueue(context.userId, true);
    await notifyRunner(context.env);
    return { ok: true };
  }),
  deleteAccount: authenticated
    .input(accountInput.extend({ confirm: z.literal(true) }))
    .handler(async ({ context, input }) => {
      checkAccount(context.userId, input.expectedAccount);
      await context.store.deleteUser(context.userId);
      return { ok: true };
    }),
};
