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
import * as schema from "./schema.ts";
import { Store } from "./store.ts";
import type { Env } from "./env.ts";
import { privateKey, runnerRequest } from "./security.ts";
import { notifyRunner } from "./notify.ts";

export function createAuth(env: Env) {
  const store = new Store(env.DB);
  const cookie =
    new URL(env.SITE_URL).protocol === "https:" ? "__Host-heybox-challenge" : "heybox-challenge";
  async function limit(value: string, count: number, window: number) {
    if (!(await store.quota(await privateKey(value, env.BETTER_AUTH_SECRET), count, window))) {
      throw new APIError("TOO_MANY_REQUESTS", { message: "请求过于频繁，请稍后再试" });
    }
  }
  async function finish(
    ctx: Parameters<typeof setSessionCookie>[0],
    result: z.infer<typeof runnerLoginResultSchema>,
  ) {
    if (result.status !== "authenticated") return ctx.json(result);
    const userId = await store.enroll(result.credential);
    const user = await ctx.context.internalAdapter.findUserById(userId);
    if (!user) throw new APIError("INTERNAL_SERVER_ERROR", { message: "无法建立网站会话，请重试" });
    const session = await ctx.context.internalAdapter.createSession(user.id);
    if (!session)
      throw new APIError("INTERNAL_SERVER_ERROR", { message: "无法建立网站会话，请重试" });
    await setSessionCookie(ctx, { session, user });
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
      sendHeyboxCode: createAuthEndpoint(
        "/heybox/send-code",
        { method: "POST", body: z.object({ phone: phoneSchema }) },
        async (ctx) => {
          const ip = ctx.request?.headers.get("cf-connecting-ip") || "local";
          await limit(`sms:ip:minute:${ip}`, 3, 60_000);
          await limit(`sms:ip:day:${ip}`, 30, 86400_000);
          await limit(`sms:phone:minute:${ctx.body.phone}`, 1, 60_000);
          await limit(`sms:phone:day:${ctx.body.phone}`, 6, 86400_000);
          const binding = [...crypto.getRandomValues(new Uint8Array(32))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          let data: z.infer<typeof beginResultSchema>;
          try {
            data = beginResultSchema.parse(
              await runnerRequest(env, "/login/begin", { phone: ctx.body.phone, binding }),
            );
          } catch (error) {
            if (error instanceof LoginFailure)
              throw new APIError("BAD_REQUEST", { code: error.code, message: error.message });
            console.warn("登录执行端暂时不可用");
            throw new APIError("BAD_GATEWAY", { message: "小黑盒暂时无法发送验证码，请稍后重试" });
          }
          ctx.setCookie(cookie, binding, {
            httpOnly: true,
            secure: cookie.startsWith("__Host-"),
            sameSite: "strict",
            path: "/",
            maxAge: 300,
          });
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
            `verify:ip:${ctx.request?.headers.get("cf-connecting-ip") || "local"}`,
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
            `captcha:ip:${ctx.request?.headers.get("cf-connecting-ip") || "local"}`,
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
          const allowed = await store.quota(
            await privateKey(`auth:${key}`, env.BETTER_AUTH_SECRET),
            rule.max,
            rule.window * 1000,
          );
          return { allowed, retryAfter: allowed ? 0 : rule.window };
        },
      },
    },
    logger: { disabled: true },
  });
}
