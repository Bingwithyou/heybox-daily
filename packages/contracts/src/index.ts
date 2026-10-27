import { z } from 'zod';

export const phoneSchema = z.string().trim().transform(value => /^1[3-9]\d{9}$/.test(value) ? `+86${value}` : value)
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, '请输入有效手机号，海外号码需包含国家或地区区号'));
export const codeSchema = z.string().regex(/^\d{4,8}$/, '验证码应为 4 至 8 位数字');
export const idSchema = z.string().uuid();
export const bindingSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const taskIds = ['sign', '1', '19', '31'] as const;
export const taskNames = { sign: '每日签到', '1': '分享帖子', '19': '分享游戏', '31': '分享游戏评价' };
export const taskViewSchema = z.object({ id: z.enum(taskIds), state: z.enum(['waiting', 'finish']) });
export const snapshotSchema = z.object({ tasks: z.array(taskViewSchema).length(4), exp: z.number(), coin: z.number() });
export type TaskSnapshot = z.infer<typeof snapshotSchema>;
export const profileSchema = z.object({ nickname: z.string().min(1).max(80).optional(),
  avatar: z.url({ protocol: /^https$/ }).max(2048).optional() });
export const credentialSchema = z.object({ account: z.string().regex(/^\d{1,20}$/), version: idSchema,
  ciphertext: z.string().min(32).max(8192), profile: profileSchema.optional() });
export type Credential = z.infer<typeof credentialSchema>;
export const jobSchema = z.object({ id: idSchema, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lease: idSchema, credential: credentialSchema });
export type Job = z.infer<typeof jobSchema>;
export const outcomeSchema = z.object({ status: z.enum(['completed', 'failed', 'auth_expired', 'cancelled']),
  snapshot: snapshotSchema.optional(), expDelta: z.number().optional(), coinDelta: z.number().optional(),
  profile: profileSchema.optional(),
  reason: z.enum(['upstream', 'timeout', 'auth_expired', 'cancelled', 'cross_day']).optional() });
export type Outcome = z.infer<typeof outcomeSchema>;
export const beginSchema = z.object({ phone: phoneSchema, binding: bindingSchema });
export const verifySchema = z.object({ challenge: idSchema, code: codeSchema, binding: bindingSchema });
export const captchaAppIdSchema = z.string().regex(/^\d{1,32}$/);
export const captchaProofSchema = z.object({
  ticket: z.string().min(1).max(2048).refine(value => !/[^\x21-\x7e]/.test(value) && !/^trerror_/i.test(value)),
  randstr: z.string().min(1).max(256).refine(value => !/[^\x21-\x7e]/.test(value) && !/^trerror_/i.test(value)),
});
export type CaptchaProof = z.infer<typeof captchaProofSchema>;
export const completeCaptchaSchema = captchaProofSchema.extend({ challenge: idSchema, binding: bindingSchema });
export const finishSchema = z.object({ id: idSchema, lease: idSchema, version: idSchema, result: outcomeSchema });
export const heartbeatSchema = z.object({ id: idSchema, lease: idSchema, version: idSchema });
export const sentResultSchema = z.object({ status: z.literal('sent'), challenge: idSchema, expiresAt: z.number(), retryAfter: z.number(), message: z.string().max(120).optional() });
export const captchaResultSchema = z.object({ status: z.literal('captcha'), challenge: idSchema, expiresAt: z.number(), appId: captchaAppIdSchema });
export const beginResultSchema = z.discriminatedUnion('status', [sentResultSchema, captchaResultSchema]);
export type LoginProgress = z.infer<typeof beginResultSchema>;
export const runnerLoginResultSchema = z.discriminatedUnion('status', [sentResultSchema, captchaResultSchema,
  z.object({ status: z.literal('authenticated'), credential: credentialSchema })]);
const loginFailureMessages = {
  captcha_required: '请先完成人机验证，再继续登录',
  upstream_rate_limit: '小黑盒验证码请求过于频繁，请稍后再试',
};
export const loginFailureSchema = z.object({ code: z.enum(['captcha_required', 'upstream_rate_limit']) });
export class LoginFailure extends Error {
  readonly code: keyof typeof loginFailureMessages;
  constructor(code: keyof typeof loginFailureMessages = 'captcha_required') {
    super(loginFailureMessages[code]); this.code = code;
  }
}

export function beijingDate(now = Date.now()) { return new Date(now + 8 * 3600_000).toISOString().slice(0, 10); }
export function nextRunAt(now = Date.now()) {
  const today = Date.parse(`${beijingDate(now)}T00:01:00+08:00`);
  return today > now ? today : today + 86400_000;
}
export const publicReasons = { upstream: '小黑盒接口暂时不可用', timeout: '本次执行超时',
  auth_expired: '小黑盒登录已失效，请重新登录', cancelled: '任务已停止', cross_day: '已跨日，等待今天的任务' };
