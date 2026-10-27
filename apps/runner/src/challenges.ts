import { createHash, randomUUID } from 'node:crypto';
import type { Config } from 'heybox-daily/types';
import { normalizePhone } from 'heybox-daily/login';
import { captchaAppIdSchema, captchaProofSchema, LoginFailure, type CaptchaProof, type LoginProgress } from '@heybox/contracts';

export type LoginStep = { status: 'sent' | 'authenticated'; config: Config } | { status: 'captcha'; appId: string; config: Config };
type Phase = { status: 'sent' } | { status: 'captcha'; operation: 'send' | 'verify'; appId: string; code?: string };
type Challenge = { config: Config; phone: string; binding: string; expiresAt: number; attempts: number; captchaAttempts: number;
  usedTickets: Set<string>; phase: Phase; busy: boolean; timer: ReturnType<typeof setTimeout> };
type Result = LoginProgress | { status: 'authenticated'; config: Config };
interface Options {
  begin: (phone: string) => Promise<LoginStep>;
  send: (config: Config, phone: string, proof: CaptchaProof) => Promise<LoginStep>;
  verify: (config: Config, phone: string, code: string, proof?: CaptchaProof) => Promise<LoginStep>;
  now?: () => number;
}
const maxActiveOperations = 4;
export class ChallengeStore {
  private readonly pending = new Map<string, Challenge>();
  private readonly options: Options;
  private active = 0;
  constructor(options: Options) { this.options = options; }
  private now() { return (this.options.now || Date.now)(); }
  private remove(id: string) { const value = this.pending.get(id); if (value) clearTimeout(value.timer); this.pending.delete(id); }
  private cleanup() { for (const [id, value] of this.pending) if (value.expiresAt <= this.now()) this.remove(id); }
  private get(id: string, binding: string) {
    this.cleanup();
    const value = this.pending.get(id);
    if (!value || value.binding !== binding) throw new Error('登录挑战无效或已过期，请重新获取验证码');
    if (value.busy) throw new Error('验证处理中，请稍候');
    if (this.active >= maxActiveOperations) throw new Error('登录繁忙，请稍后再试');
    return value;
  }
  private progress(id: string, value: Challenge): LoginProgress {
    const common = { challenge: id, expiresAt: value.expiresAt };
    return value.phase.status === 'captcha' ? { ...common, status: 'captcha', appId: value.phase.appId }
      : { ...common, status: 'sent', retryAfter: 60 };
  }
  private accept(id: string, value: Challenge, result: LoginStep, operation: 'send' | 'verify', code?: string): Result {
    if (this.pending.get(id) !== value || value.expiresAt <= this.now()) {
      this.remove(id); throw new Error('登录挑战已过期，请重新获取验证码');
    }
    if (result.status === 'authenticated' && operation === 'verify') {
      this.remove(id); return { status: 'authenticated', config: result.config };
    }
    if (result.status === 'captcha') {
      if (value.captchaAttempts >= 3) { this.remove(id); throw new Error('人机验证次数已用完，请重新开始登录'); }
      value.phase = { status: 'captcha', operation, appId: captchaAppIdSchema.parse(result.appId), code };
    } else if (result.status === 'sent' && operation === 'send') value.phase = { status: 'sent' };
    else throw new Error('登录步骤无效');
    value.config = result.config;
    return this.progress(id, value);
  }
  async begin(phone: string, binding: string): Promise<LoginProgress> {
    this.cleanup();
    if (this.active >= maxActiveOperations || this.pending.size >= 100) throw new Error('登录繁忙，请稍后再试');
    this.active++;
    try {
      const normalized = normalizePhone(phone);
      const result = await this.options.begin(normalized);
      if (result.status === 'authenticated') throw new Error('登录步骤无效');
      const id = randomUUID();
      const expiresAt = this.now() + 5 * 60_000;
      const phase: Phase = result.status === 'captcha' ? { status: 'captcha', operation: 'send', appId: captchaAppIdSchema.parse(result.appId) } : { status: 'sent' };
      const timer = setTimeout(() => this.remove(id), 5 * 60_000); timer.unref();
      const value: Challenge = { config: result.config, phone: normalized, binding, expiresAt, attempts: 0, captchaAttempts: 0,
        usedTickets: new Set(), phase, busy: false, timer };
      this.pending.set(id, value);
      return this.progress(id, value);
    } finally { this.active--; }
  }
  async verify(id: string, code: string, binding: string): Promise<Result> {
    const value = this.get(id, binding);
    if (value.phase.status !== 'sent') throw new Error('请先完成人机验证');
    if (!/^\d{4,8}$/.test(code)) throw new Error('验证码格式不正确');
    value.busy = true; value.attempts++; this.active++;
    try {
      return this.accept(id, value, await this.options.verify(value.config, value.phone, code), 'verify', code);
    } catch (error) {
      if (value.attempts >= 3) this.remove(id);
      throw error;
    } finally { value.busy = false; this.active--; }
  }
  async completeCaptcha(id: string, input: CaptchaProof, binding: string): Promise<Result> {
    const value = this.get(id, binding);
    if (value.phase.status !== 'captcha') throw new Error('人机验证状态已变化，请刷新页面');
    const proof = captchaProofSchema.parse(input);
    const ticketHash = createHash('sha256').update(proof.ticket).digest('hex');
    if (value.usedTickets.has(ticketHash)) throw new Error('该人机验证凭据已使用，请重新验证');
    const phase = value.phase;
    value.usedTickets.add(ticketHash); value.captchaAttempts++; value.busy = true; this.active++;
    try {
      const result = phase.operation === 'send' ? await this.options.send(value.config, value.phone, proof)
        : await this.options.verify(value.config, value.phone, phase.code!, proof);
      return this.accept(id, value, result, phase.operation, phase.code);
    } catch (error) {
      if (phase.operation === 'send' && error instanceof LoginFailure && error.code === 'upstream_rate_limit') {
        this.remove(id); throw error;
      }
      if (value.captchaAttempts >= 3 || value.attempts >= 3 || value.expiresAt <= this.now()) this.remove(id);
      else if (phase.operation === 'verify' && this.pending.get(id) === value) {
        value.phase = { status: 'sent' };
        return { status: 'sent', challenge: id, expiresAt: value.expiresAt, retryAfter: 0,
          message: error instanceof LoginFailure ? error.message : '验证码未通过或小黑盒暂时不可用，请核对后重试' };
      }
      throw error;
    } finally { value.busy = false; this.active--; }
  }
}
