import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import {
  phoneSchema,
  codeSchema,
  idSchema,
  beginResultSchema,
  runnerLoginResultSchema,
  captchaProofSchema,
  LoginFailure,
} from "@heybox/contracts";
import {
  accountEndpoints,
  deviceSessions,
  forgetAccount,
  rememberSession,
  requireAccount,
} from "./accounts.ts";
import * as schema from "./schema.ts";
import { Store } from "./store.ts";
import type { Env } from "./env.ts";
import { privateKey, runnerRequest } from "./security.ts";
import { notifyRunner } from "./notify.ts";
import {
  loginLimitMessages,
  type LoginLimitRule,
  type SmsCooldown,
} from "../lib/login-cooldown.ts";

function logRateLimit(rule: LoginLimitRule, limit: number, windowMs: number) {
  console.warn(
    JSON.stringify({ event: "auth_rate_limited", rule, limit, windowSeconds: windowMs / 1000 }),
  );
}

export function createAuth(env: Env) {
  const store = new Store(env.DB);
  const cookie =
    new URL(env.SITE_URL).protocol === "https:" ? "__Host-heybox-challenge" : "heybox-challenge";
  async function limit(rule: LoginLimitRule, subject: string, count: number, window: number) {
    const key = await privateKey(`${rule}:${subject}`, env.BETTER_AUTH_SECRET);
    if (!(await store.quota(key, count, window))) {
      logRateLimit(rule, count, window);
      const [state] = await store.quotaStates([key]);
      const serverTime = Date.now();
      const retryAt = state?.retryAt ?? serverTime;
      throw new APIError(
        "TOO_MANY_REQUESTS",
        {
          code: "rate_limited",
          message: loginLimitMessages[rule],
          rateLimit: { rule, serverTime, retryAt },
        },
        { "Retry-After": String(Math.max(0, Math.ceil((retryAt - serverTime) / 1000))) },
      );
    }
  }
  async function smsCooldown(phone: string, ip: string): Promise<SmsCooldown> {
    const rules = [
      ["sms:ip:minute", ip, 3],
      ["sms:ip:day", ip, 30],
      ["sms:phone:minute", phone, 1],
      ["sms:phone:day", phone, 6],
    ] as const;
    const keys = await Promise.all(
      rules.map(([rule, subject]) => privateKey(`${rule}:${subject}`, env.BETTER_AUTH_SECRET)),
    );
    const states = await store.quotaStates(keys);
    const serverTime = Date.now();
    return {
      serverTime,
      limits: rules.flatMap(([rule, , max], i) => {
        const state = states.find((item) => item.key === keys[i]);
        return state && state.count >= max && state.retryAt > serverTime
          ? [{ rule, retryAt: state.retryAt }]
          : [];
      }),
    };
  }
  async function withSmsCooldown<T extends object>(
    phone: string,
    ip: string,
    run: () => Promise<T>,
  ) {
    try {
      return { ...(await run()), smsCooldown: await smsCooldown(phone, ip) };
    } catch (error) {
      if (error instanceof APIError) {
        const cooldown = await smsCooldown(phone, ip);
        const blocking = cooldown.limits.toSorted((a, b) => b.retryAt - a.retryAt)[0];
        const headers = new Headers(error.headers);
        const detail =
          error.body?.code === "rate_limited" && blocking
            ? {
                message: loginLimitMessages[blocking.rule],
                rateLimit: { ...blocking, serverTime: cooldown.serverTime },
              }
            : {};
        if (detail.rateLimit)
          headers.set(
            "Retry-After",
            String(Math.max(0, Math.ceil((detail.rateLimit.retryAt - cooldown.serverTime) / 1000))),
          );
        throw new APIError(
          error.status,
          { ...error.body, ...detail, smsCooldown: cooldown },
          headers,
        );
      }
      throw error;
    }
  }
  async function finish(
    ctx: Parameters<typeof setSessionCookie>[0],
    result: z.infer<typeof runnerLoginResultSchema>,
  ) {
    if (result.status !== "authenticated") return ctx.json(result);
    const intent = await ctx.getSignedCookie(`${cookie}-intent`, ctx.context.secret);
    const binding = ctx.getCookie(cookie);
    if (typeof intent !== "string")
      throw new APIError("BAD_REQUEST", { message: "登录已过期，请重新获取验证码" });
    const saved = JSON.parse(intent) as { binding: string; account?: string; expires: number };
    if (saved.binding !== binding || saved.expires < Date.now())
      throw new APIError("BAD_REQUEST", { message: "登录已过期，请重新获取验证码" });
    if (saved.account) {
      await requireAccount(ctx, saved.account);
      if (result.credential.account !== saved.account)
        throw new APIError("BAD_REQUEST", {
          message: "登录的账号与当前账号不一致，请使用当前账号的手机号",
        });
    }
    const sessions = await deviceSessions(ctx);
    const id = `heybox:${result.credential.account}`;
    if (
      !sessions.some((item) => item.user.id === id) &&
      new Set(sessions.map((item) => item.user.id)).size >= 5
    )
      throw new APIError("BAD_REQUEST", { message: "最多同时登录 5 个账号，请先退出一个账号" });
    const userId = await store.enroll(result.credential);
    const user = await ctx.context.internalAdapter.findUserById(userId);
    if (!user) throw new APIError("INTERNAL_SERVER_ERROR", { message: "无法建立网站会话，请重试" });
    const session = await ctx.context.internalAdapter.createSession(user.id);
    if (!session)
      throw new APIError("INTERNAL_SERVER_ERROR", { message: "无法建立网站会话，请重试" });
    // Preserve the other browser accounts, including pre-upgrade sessions.
    for (const existing of sessions.filter((item) => item.user.id !== userId))
      await rememberSession(ctx, existing);
    await forgetAccount(ctx, userId, sessions);
    await rememberSession(ctx, { session, user });
    await setSessionCookie(ctx, { session, user });
    ctx.setCookie(`${cookie}-intent`, "", {
      httpOnly: true,
      secure: cookie.startsWith("__Host-"),
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
    ctx.setCookie(cookie, "", {
      httpOnly: true,
      secure: cookie.startsWith("__Host-"),
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
    await notifyRunner(env);
    return ctx.json({
      status: "authenticated",
      account: result.credential.account,
      nickname: user.name,
      avatar: user.image || null,
    });
  }
  const heyboxPlugin = {
    id: "heybox",
    endpoints: {
      ...accountEndpoints(store),
      sendHeyboxCode: createAuthEndpoint(
        "/heybox/send-code",
        {
          method: "POST",
          body: z.object({
            phone: phoneSchema,
            expectedAccount: z.string().min(1).max(64).optional(),
          }),
        },
        async (ctx) => {
          if (ctx.body.expectedAccount) await requireAccount(ctx, ctx.body.expectedAccount);
          const devices = await deviceSessions(ctx);
          if (!ctx.body.expectedAccount && new Set(devices.map((item) => item.user.id)).size >= 5)
            throw new APIError("BAD_REQUEST", {
              message: "最多同时登录 5 个账号，请先退出一个账号",
            });
          const ip = ctx.request?.headers.get("cf-connecting-ip") || "local";
          const binding = [...crypto.getRandomValues(new Uint8Array(32))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          const data = await withSmsCooldown(ctx.body.phone, ip, async () => {
            await limit("sms:ip:minute", ip, 3, 60_000);
            await limit("sms:ip:day", ip, 30, 86400_000);
            await limit("sms:phone:minute", ctx.body.phone, 1, 60_000);
            await limit("sms:phone:day", ctx.body.phone, 6, 86400_000);
            try {
              return beginResultSchema.parse(
                await runnerRequest(env, "/login/begin", { phone: ctx.body.phone, binding }),
              );
            } catch (error) {
              if (error instanceof LoginFailure)
                throw new APIError("BAD_REQUEST", { code: error.code, message: error.message });
              console.warn("登录执行端暂时不可用");
              throw new APIError("BAD_GATEWAY", {
                message: "小黑盒暂时无法发送验证码，请稍后重试",
              });
            }
          });
          ctx.setCookie(cookie, binding, {
            httpOnly: true,
            secure: cookie.startsWith("__Host-"),
            sameSite: "strict",
            path: "/",
            maxAge: 300,
          });
          await ctx.setSignedCookie(
            `${cookie}-intent`,
            JSON.stringify({
              binding,
              account: ctx.body.expectedAccount,
              expires: Date.now() + 300_000,
            }),
            ctx.context.secret,
            {
              httpOnly: true,
              secure: cookie.startsWith("__Host-"),
              sameSite: "strict",
              path: "/",
              maxAge: 300,
            },
          );
          return ctx.json(data);
        },
      ),
      verifyHeyboxCode: createAuthEndpoint(
        "/heybox/verify-code",
        { method: "POST", body: z.object({ challenge: idSchema, code: codeSchema }) },
        async (ctx) => {
          const binding = ctx.getCookie(cookie);
          if (!binding || !/^[a-f0-9]{64}$/.test(binding))
            throw new APIError("BAD_REQUEST", { message: "登录已过期，请重新获取验证码" });
          await limit(
            "verify:ip",
            ctx.request?.headers.get("cf-connecting-ip") || "local",
            30,
            300_000,
          );
          let result: z.infer<typeof runnerLoginResultSchema>;
          try {
            result = runnerLoginResultSchema.parse(
              await runnerRequest(env, "/login/verify", { ...ctx.body, binding }),
            );
          } catch (error) {
            if (error instanceof LoginFailure)
              throw new APIError("BAD_REQUEST", { code: error.code, message: error.message });
            throw new APIError("BAD_REQUEST", {
              message: "验证码错误、已过期或小黑盒暂时不可用，请稍后重试",
            });
          }
          return finish(ctx, result);
        },
      ),
      completeHeyboxCaptcha: createAuthEndpoint(
        "/heybox/complete-captcha",
        { method: "POST", body: captchaProofSchema.extend({ challenge: idSchema }) },
        async (ctx) => {
          const binding = ctx.getCookie(cookie);
          if (!binding || !/^[a-f0-9]{64}$/.test(binding))
            throw new APIError("BAD_REQUEST", { message: "登录已过期，请重新获取验证码" });
          await limit(
            "captcha:ip",
            ctx.request?.headers.get("cf-connecting-ip") || "local",
            30,
            300_000,
          );
          let result: z.infer<typeof runnerLoginResultSchema>;
          try {
            result = runnerLoginResultSchema.parse(
              await runnerRequest(env, "/login/captcha", { ...ctx.body, binding }),
            );
          } catch (error) {
            if (error instanceof LoginFailure)
              throw new APIError("BAD_REQUEST", { code: error.code, message: error.message });
            throw new APIError("BAD_REQUEST", {
              message: "人机验证未通过、已过期或小黑盒暂时不可用，请重新验证",
            });
          }
          return finish(ctx, result);
        },
      ),
    },
  } satisfies BetterAuthPlugin;
  return betterAuth({
    appName: "Heybox Daily",
    baseURL: env.SITE_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.DB), { provider: "sqlite", schema }),
    plugins: [heyboxPlugin],
    trustedOrigins: [new URL(env.SITE_URL).origin],
    session: { expiresIn: 30 * 86400, updateAge: 86400, cookieCache: { enabled: false } },
    advanced: {
      useSecureCookies: env.SITE_URL.startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    rateLimit: {
      enabled: true,
      customStorage: {
        consume: async (key, rule) => {
          const hashed = await privateKey(`auth:${key}`, env.BETTER_AUTH_SECRET);
          const allowed = await store.quota(hashed, rule.max, rule.window * 1000);
          if (allowed) return { allowed, retryAfter: 0 };
          logRateLimit("auth:ip:endpoint", rule.max, rule.window * 1000);
          const [state] = await store.quotaStates([hashed]);
          return {
            allowed,
            retryAfter: Math.max(
              0,
              Math.ceil(((state?.retryAt ?? Date.now()) - Date.now()) / 1000),
            ),
          };
        },
      },
    },
    logger: { disabled: true },
  });
}
