import { z } from "zod";
import { phoneSchema } from "@heybox/contracts";

export const loginLimitMessages = {
  "sms:ip:minute": "当前网络每分钟最多申请 3 次验证码，请等待倒计时结束后再试",
  "sms:ip:day": "当前网络已达到 24 小时内申请 30 次验证码的限额，请在冷却结束后再试",
  "sms:phone:minute": "该手机号每分钟只能申请 1 次验证码，请等待倒计时结束后再试",
  "sms:phone:day": "该手机号已达到 24 小时内申请 6 次验证码的限额，请在冷却结束后再试",
  "verify:ip": "当前网络已达到 5 分钟内校验 30 次短信验证码的限额，请稍后再试",
  "captcha:ip": "当前网络已达到 5 分钟内提交 30 次人机验证的限额，请稍后再试",
  "auth:ip:endpoint": "登录接口请求过于频繁，请稍后再试",
} as const;
export type LoginLimitRule = keyof typeof loginLimitMessages;
const cooldownRuleSchema = z.enum([
  "sms:ip:minute",
  "sms:ip:day",
  "sms:phone:minute",
  "sms:phone:day",
  "auth:ip:endpoint",
]);
export const smsCooldownSchema = z.object({
  serverTime: z.number().int().nonnegative(),
  limits: z.array(z.object({ rule: cooldownRuleSchema, retryAt: z.number().int().nonnegative() })),
});
export type SmsCooldown = z.infer<typeof smsCooldownSchema>;
const savedStateSchema = z.object({
  phone: phoneSchema.or(z.literal("")),
  entries: z.array(
    z.object({
      phone: phoneSchema.optional(),
      rule: cooldownRuleSchema.or(z.literal("pending")),
      until: z.number().int().nonnegative(),
    }),
  ),
});
export type CooldownState = z.infer<typeof savedStateSchema>;
export const cooldownStorageKey = "heybox-login-cooldown-v1";

export function emptyCooldownState(): CooldownState {
  return { phone: "", entries: [] };
}

export function restoreCooldown(raw: string | null, now = Date.now()): CooldownState {
  try {
    const parsed = savedStateSchema.safeParse(JSON.parse(raw || "null"));
    if (!parsed.success) return emptyCooldownState();
    const entries = parsed.data.entries.filter((entry) => entry.until > now);
    return entries.length ? { ...parsed.data, entries } : emptyCooldownState();
  } catch {
    return emptyCooldownState();
  }
}

export function startSmsRequest(
  state: CooldownState,
  phone: string,
  now = Date.now(),
): CooldownState {
  return {
    phone,
    // Keep a provisional deadline if the response is lost or the page reloads mid-request.
    entries: [
      ...state.entries.filter(
        (entry) => entry.until > now && !(entry.rule === "pending" && entry.phone === phone),
      ),
      { phone, rule: "pending", until: now + 60_000 },
    ],
  };
}

export function applySmsCooldown(
  state: CooldownState,
  phone: string,
  cooldown: SmsCooldown,
  now = Date.now(),
  authoritative = true,
): CooldownState {
  const entries = state.entries.filter((entry) => {
    if (entry.until <= now || (entry.rule === "pending" && entry.phone === phone)) return false;
    return authoritative
      ? entry.phone !== undefined && entry.phone !== phone
      : entry.rule !== "auth:ip:endpoint";
  });
  for (const limit of cooldown.limits) {
    const remaining = limit.retryAt - cooldown.serverTime;
    if (remaining > 0)
      entries.push({
        rule: limit.rule,
        phone: limit.rule.startsWith("sms:phone:") ? phone : undefined,
        // Convert the server's remaining time once; browser clock skew then cancels out.
        until: now + remaining,
      });
  }
  return { phone, entries };
}

export function activeCooldown(state: CooldownState, phone: string, now = Date.now()) {
  const entry = state.entries
    .filter((item) => item.until > now && (item.phone === undefined || item.phone === phone))
    .sort((a, b) => b.until - a.until)[0];
  return entry ? { ...entry, seconds: Math.ceil((entry.until - now) / 1000) } : null;
}

export function formatCooldown(seconds: number) {
  if (seconds <= 60) return `${seconds} 秒后重发`;
  const minutes = Math.floor(seconds / 60);
  const suffix = `${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:` : ""}${suffix} 后重试`;
}
