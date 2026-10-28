import { createHash } from 'node:crypto';
import type { Config } from 'heybox-daily/types';
import { normalizePhone } from 'heybox-daily/login-core';
import { captchaAppIdSchema, captchaProofSchema, codeSchema, LoginFailure, type LoginTiming, type CaptchaProof, type LoginProgress, type Credential } from '@heybox/contracts';
import { encryptCredential } from '@heybox/hosting/crypto';
import type { LoginStep } from '@heybox/hosting/login';
import { seal, unseal } from './sealed-state.ts';

export interface ChallengeStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: string): Promise<void>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
  transaction<T>(fn: (tx: Pick<ChallengeStorage, 'put' | 'setAlarm'>) => Promise<T>): Promise<T>;
}
export interface LoginOperations {
  begin(phone: string, timing?: LoginTiming, preparedToken?: string): Promise<LoginStep>;
  send(config: Config, phone: string, proof: CaptchaProof, timing?: LoginTiming): Promise<LoginStep>;
  verify(config: Config, phone: string, code: string, proof?: CaptchaProof, timing?: LoginTiming): Promise<LoginStep>;
}
type Phase = { status: 'initializing' | 'sent' } | { status: 'captcha'; operation: 'send' | 'verify'; appId: string; code?: string }
  | { status: 'authenticated'; credential: Credential };
type State = { phone: string; binding: string; expiresAt: number; config?: Config; phase: Phase;
  attempts: number; captchaAttempts: number; usedTickets: string[]; busy: boolean };
type Result = LoginProgress | { status: 'authenticated'; credential: Credential; recovery: { challenge: string; expiresAt: number } };

export class PersistentChallenge {
  private state?: State;
  private readonly storage: ChallengeStorage;
  private readonly key: string;
  private readonly id: string;
  private readonly operations: LoginOperations;
  private readonly now: () => number;
  constructor(storage: ChallengeStorage, key: string, id: string, operations: LoginOperations, now = Date.now) {
    this.storage = storage; this.key = key; this.id = id; this.operations = operations; this.now = now;
  }
  async load() {
    const encrypted = await this.storage.get<string>('challenge');
    if (!encrypted) return;
    this.state = unseal<State>(encrypted, this.key, this.id);
    // A persisted busy operation means its response may have been lost. Never replay an SMS or ticket.
    if (this.state.busy || this.state.expiresAt <= this.now()) await this.clear();
  }
  private async clear(timing?: LoginTiming) {
    const started = performance.now();
    try {
    this.state = undefined;
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
    } finally { timing?.add('challenge_clear', performance.now() - started); }
  }
  async expire() {
    if (!this.state || this.state.expiresAt <= this.now()) await this.clear();
    else await this.storage.setAlarm(this.state.expiresAt);
  }
  private async save(timing?: LoginTiming, state = this.state) {
    if (!state) return;
    const started = performance.now();
    try {
    const encrypted = seal(state, this.key, this.id);
    await this.storage.transaction(async tx => {
      await tx.put('challenge', encrypted);
      await tx.setAlarm(state.expiresAt);
    });
    } finally { timing?.add('challenge_save', performance.now() - started); }
  }
  private get(binding: string) {
    const value = this.state;
    if (!value || value.binding !== binding || value.expiresAt <= this.now())
      throw new Error('登录挑战无效或已过期，请重新获取验证码');
    if (value.busy) throw new Error('验证处理中，请稍后');
    return value;
  }
  private progress(value: State): LoginProgress {
    const common = { challenge: this.id, expiresAt: value.expiresAt };
    return value.phase.status === 'captcha' ? { ...common, status: 'captcha', appId: value.phase.appId }
      : { ...common, status: 'sent', retryAfter: 60 };
  }
  private authenticated(value: State): Result {
    if (value.phase.status !== 'authenticated') throw new Error('登录尚未完成');
    return { status: 'authenticated', credential: value.phase.credential,
      recovery: { challenge: this.id, expiresAt: value.expiresAt } };
  }
  async confirm(binding: string) {
    if (!this.state) return;
    const value = this.get(binding);
    if (value.phase.status !== 'authenticated') throw new Error('登录尚未完成');
    await this.clear();
  }
  private async accept(value: State, result: LoginStep, operation: 'send' | 'verify', code?: string, timing?: LoginTiming): Promise<Result> {
    if (this.state !== value || value.expiresAt <= this.now()) {
      await this.clear(timing); throw new Error('登录挑战已过期，请重新获取验证码');
    }
    if (result.status === 'authenticated' && operation === 'verify') {
      value.phase = { status: 'authenticated', credential: encryptCredential(result.config, this.key) };
      value.config = undefined;
      // The cached result uses one credential version and is durable before any caller can replay it.
      await this.save(timing, { ...value, busy: false });
      value.busy = false;
      return this.authenticated(value);
    }
    if (result.status === 'captcha') {
      if (value.captchaAttempts >= 3) { await this.clear(timing); throw new Error('人机验证次数已用完，请重新开始登录'); }
      value.phase = { status: 'captcha', operation, appId: captchaAppIdSchema.parse(result.appId), code };
    } else if (result.status === 'sent' && operation === 'send') value.phase = { status: 'sent' };
    else throw new Error('登录响应无效');
    value.config = result.config;
    return this.progress(value);
  }
  async begin(phone: string, binding: string, timing?: LoginTiming, preparedToken?: string): Promise<LoginProgress> {
    if (this.state) throw new Error('登录挑战已存在，请勿重复提交');
    const value: State = { phone: normalizePhone(phone), binding, expiresAt: this.now() + 300_000,
      phase: { status: 'initializing' }, attempts: 0, captchaAttempts: 0, usedTickets: [], busy: true };
    this.state = value;
    await this.save(timing);
    try {
      const result = await this.operations.begin(value.phone, timing, preparedToken);
      return await this.accept(value, result, 'send', undefined, timing) as LoginProgress;
    } catch (error) { await this.clear(timing); throw error; }
    finally { if (this.state === value) { value.busy = false; await this.save(timing); } }
  }
  async verify(code: string, binding: string, timing?: LoginTiming): Promise<Result> {
    const value = this.get(binding);
    if (value.phase.status === 'authenticated') return this.authenticated(value);
    if (value.phase.status !== 'sent' || !value.config) throw new Error('请先完成人机验证');
    codeSchema.parse(code);
    value.busy = true; value.attempts++;
    await this.save(timing);
    try {
      return await this.accept(value, await this.operations.verify(value.config, value.phone, code, undefined, timing), 'verify', code, timing);
    } catch (error) {
      if (value.attempts >= 3 || value.expiresAt <= this.now()) await this.clear(timing);
      throw error;
    } finally { if (this.state === value) { value.busy = false; await this.save(timing); } }
  }
  async completeCaptcha(input: CaptchaProof, binding: string, timing?: LoginTiming): Promise<Result> {
    const value = this.get(binding);
    if (value.phase.status === 'authenticated') return this.authenticated(value);
    if (value.phase.status !== 'captcha' || !value.config) throw new Error('人机验证状态已变化，请刷新页面');
    const proof = captchaProofSchema.parse(input);
    const hash = createHash('sha256').update(proof.ticket).digest('hex');
    if (value.usedTickets.includes(hash)) throw new Error('该人机验证凭据已使用，请重新验证');
    const phase = value.phase;
    value.usedTickets.push(hash); value.captchaAttempts++; value.busy = true;
    await this.save(timing);
    try {
      const result = phase.operation === 'send' ? await this.operations.send(value.config, value.phone, proof, timing)
        : await this.operations.verify(value.config, value.phone, phase.code!, proof, timing);
      return await this.accept(value, result, phase.operation, phase.code, timing);
    } catch (error) {
      if (phase.operation === 'send' && error instanceof LoginFailure && error.code === 'upstream_rate_limit') {
        await this.clear(timing); throw error;
      }
      if (value.captchaAttempts >= 3 || value.attempts >= 3 || value.expiresAt <= this.now()) await this.clear(timing);
      else if (phase.operation === 'verify' && this.state === value) {
        value.phase = { status: 'sent' };
        return { status: 'sent', challenge: this.id, expiresAt: value.expiresAt, retryAfter: 0,
          message: error instanceof LoginFailure ? error.message : '验证码未通过或小黑盒暂时不可用，请核对后重试' };
      }
      throw error;
    } finally { if (this.state === value) { value.busy = false; await this.save(timing); } }
  }
}
