import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import {
  deleteSessionCookie,
  expireCookie,
  parseCookies,
  setSessionCookie,
} from "better-auth/cookies";
import { z } from "zod";
import type { Store } from "@heybox/hosting/store";

type Context = Parameters<typeof setSessionCookie>[0];
const expectedAccountSchema = z.object({ expectedAccount: z.string().min(1).max(64) });
const accountOf = (userId: string) => userId.replace(/^heybox:/, "");

// Use Better Auth's signed, HttpOnly device-session cookie convention. Tokens never
// enter localStorage or the public account list. Include the old primary cookie so
// existing single-account logins can be adopted without logging in again.
export async function deviceSessions(ctx: Context) {
  const config = ctx.context.authCookies.sessionToken;
  const names = [...parseCookies(ctx.headers?.get("cookie") || "").keys()].filter(
    (key) => key === config.name || key.startsWith(`${config.name}_multi-`),
  );
  const tokens: string[] = [];
  const signed = new Map<string, string>();
  for (const name of names) {
    const token = await ctx.getSignedCookie(name, ctx.context.secret);
    if (typeof token === "string") {
      tokens.push(token);
      signed.set(name, token);
    } else expireCookie(ctx, { name, attributes: config.attributes });
  }
  const sessions = tokens.length
    ? (
        await ctx.context.internalAdapter.findSessions([...new Set(tokens)], {
          onlyActiveSessions: true,
        })
      ).filter((item) => item.session.expiresAt > new Date())
    : [];
  const live = new Set(sessions.map((item) => item.session.token));
  for (const [name, token] of signed) {
    if (!live.has(token)) expireCookie(ctx, { name, attributes: config.attributes });
  }
  return sessions;
}

export async function rememberSession(ctx: Context, value: Parameters<typeof setSessionCookie>[1]) {
  const config = ctx.context.authCookies.sessionToken;
  await ctx.setSignedCookie(
    `${config.name}_multi-${value.session.token.toLowerCase()}`,
    value.session.token,
    ctx.context.secret,
    { ...config.attributes, expires: value.session.expiresAt },
  );
}

export async function requireAccount(ctx: Context, expectedAccount: string) {
  const session = await getSessionFromCtx(ctx);
  if (!session) throw new APIError("UNAUTHORIZED", { message: "请先登录" });
  if (accountOf(session.user.id) !== expectedAccount)
    throw new APIError("CONFLICT", { message: "当前账号已变化，请刷新页面后重试" });
  return session;
}

export async function forgetAccount(
  ctx: Context,
  userId: string,
  sessions: Awaited<ReturnType<typeof deviceSessions>>,
) {
  const config = ctx.context.authCookies.sessionToken;
  for (const value of sessions.filter((item) => item.user.id === userId)) {
    await ctx.context.internalAdapter.deleteSession(value.session.token);
    expireCookie(ctx, {
      name: `${config.name}_multi-${value.session.token.toLowerCase()}`,
      attributes: config.attributes,
    });
  }
}

export function accountEndpoints(store: Store) {
  async function leave(ctx: Context, expectedAccount: string, remove: boolean) {
    const current = await requireAccount(ctx, expectedAccount);
    const sessions = await deviceSessions(ctx);
    // Commit the task stop first. A failed session cleanup must never leave work running.
    if (remove) await store.deleteUser(current.user.id);
    else await store.setEnabled(current.user.id, false);
    await forgetAccount(ctx, current.user.id, sessions);
    const next = sessions.find((item) => item.user.id !== current.user.id);
    if (next) {
      await rememberSession(ctx, next);
      await setSessionCookie(ctx, next);
    } else deleteSessionCookie(ctx);
    return ctx.json({ ok: true, account: next ? accountOf(next.user.id) : null });
  }
  return {
    heyboxAccounts: createAuthEndpoint(
      "/heybox/accounts",
      { method: "GET", requireHeaders: true },
      async (ctx) => {
        const sessions = await deviceSessions(ctx);
        const current = await getSessionFromCtx(ctx);
        const unique = sessions.filter(
          (item, i) => sessions.findIndex((other) => other.user.id === item.user.id) === i,
        );
        return ctx.json({
          activeAccount: current ? accountOf(current.user.id) : null,
          accounts: unique.map(({ user }) => ({
            account: accountOf(user.id),
            nickname: user.name,
            avatar: user.image || null,
          })),
        });
      },
    ),
    switchHeyboxAccount: createAuthEndpoint(
      "/heybox/switch",
      {
        method: "POST",
        requireHeaders: true,
        body: z.object({ account: z.string().min(1).max(64) }),
      },
      async (ctx) => {
        const sessions = await deviceSessions(ctx);
        const target = sessions.find((item) => accountOf(item.user.id) === ctx.body.account);
        if (!target)
          throw new APIError("UNAUTHORIZED", { message: "该账号登录已过期，请重新登录" });
        for (const session of sessions) await rememberSession(ctx, session);
        await setSessionCookie(ctx, target);
        return ctx.json({ ok: true });
      },
    ),
    logoutHeyboxAccount: createAuthEndpoint(
      "/heybox/logout",
      {
        method: "POST",
        requireHeaders: true,
        body: expectedAccountSchema,
      },
      (ctx) => leave(ctx, ctx.body.expectedAccount, false),
    ),
    deleteHeyboxAccount: createAuthEndpoint(
      "/heybox/delete",
      {
        method: "POST",
        requireHeaders: true,
        body: expectedAccountSchema.extend({ confirm: z.literal(true) }),
      },
      (ctx) => leave(ctx, ctx.body.expectedAccount, true),
    ),
  };
}
