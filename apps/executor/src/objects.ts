import { DurableObject } from 'cloudflare:workers';
import { beginSchema, verifySchema, completeCaptchaSchema, idSchema, LoginFailure, LoginTiming, loginTimingHeader } from '@heybox/contracts';
import { encryptCredential } from '../../runner/src/crypto.ts';
import { PersistentChallenge } from './challenge.ts';
import { loginOperations, failureCategory } from './operations.ts';
import type { Env } from './env.ts';

export class LoginChallenge extends DurableObject<Env> {
  private challenge?: PersistentChallenge;
  async fetch(request: Request) {
    const started = performance.now();
    const timing = new LoginTiming(request.headers.get(loginTimingHeader));
    const action = new URL(request.url).pathname;
    const reply = (value: unknown, status = 200) => {
      const response = Response.json(value, { status });
      timing.add('challenge_total', performance.now() - started);
      response.headers.set('server-timing', timing.header());
      response.headers.set(loginTimingHeader, timing.id);
      return response;
    };
    try {
      const input = await request.json() as Record<string, unknown>;
      const id = idSchema.parse(input.challenge);
      if (this.env.LOGIN_CHALLENGES.idFromName(id).toString() !== this.ctx.id.toString()) throw new Error('挑战身份无效');
      if (!this.challenge) await timing.measure('challenge_load', () => this.ctx.blockConcurrencyWhile(async () => {
        if (this.challenge) return;
        this.challenge = new PersistentChallenge(this.ctx.storage, this.env.CREDENTIAL_KEY, id, loginOperations(this.env));
        await this.challenge.load();
      }));
      if (action === '/prepare') {
        // Initialization only: no login state, alarm, token or SMS side effect.
        return Response.json({ ready: true }, { headers: { 'server-timing': timing.header(), [loginTimingHeader]: timing.id } });
      }
      let result;
      if (action === '/begin') {
        const value = beginSchema.parse(input);
        const token = input.token;
        if (token !== undefined && (typeof token !== 'string' || !/^B[A-Za-z0-9+/=_-]{88}$/.test(token))) throw new Error('设备令牌格式无效');
        result = await this.challenge!.begin(value.phone, value.binding, timing, token as string | undefined);
      } else if (action === '/verify') {
        const value = verifySchema.parse(input);
        result = await this.challenge!.verify(value.code, value.binding, timing);
      } else if (action === '/captcha') {
        const value = completeCaptchaSchema.parse(input);
        result = await this.challenge!.completeCaptcha(value, value.binding, timing);
      } else return new Response(null, { status: 404 });
      const response = reply(result.status === 'authenticated'
        ? { status: 'authenticated', credential: encryptCredential(result.config, this.env.CREDENTIAL_KEY) } : result);
      console.log(JSON.stringify({ event: 'executor_login', action, outcome: result.status,
        requestId: timing.id, durationMs: Math.round(performance.now() - started), stages: timing.values }));
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const safe = /挑战|处理中|繁忙|人机验证/.test(message) ? message : '验证码错误、已过期或小黑盒暂时不可用，请稍后重试';
      const response = reply(error instanceof LoginFailure ? { code: error.code, error: error.message } : { error: safe }, 400);
      console.warn(JSON.stringify({ event: 'executor_login_failed', action, category: failureCategory(error),
        requestId: timing.id, durationMs: Math.round(performance.now() - started), stages: timing.values }));
      return response;
    }
  }
  async alarm() {
    if (this.challenge) await this.challenge.expire();
    else await this.ctx.storage.deleteAll();
  }
}

type Reservation = { account: string; token: string; expiresAt: number };
export class ActivityGate extends DurableObject<Env> {
  private async save(values: Reservation[]) {
    if (!values.length) { await this.ctx.storage.deleteAll(); return; }
    await this.ctx.storage.transaction(async tx => {
      await tx.put('leases', values);
      await tx.setAlarm(Math.min(...values.map(value => value.expiresAt)));
    });
  }
  async fetch(request: Request) {
    const input = await request.json() as { account: string; token?: string };
    if (!/^\d{1,20}$/.test(input.account)) return new Response(null, { status: 400 });
    const action = new URL(request.url).pathname;
    return this.ctx.blockConcurrencyWhile(async () => {
      let leases = (await this.ctx.storage.get<Reservation[]>('leases') || []).filter(value => value.expiresAt > Date.now());
      if (action === '/release') {
        leases = leases.filter(value => value.account !== input.account || value.token !== input.token);
        await this.save(leases);
        return new Response(null, { status: 204 });
      }
      if (action !== '/acquire') return new Response(null, { status: 404 });
      if (leases.some(value => value.account === input.account)) return Response.json({ token: null, reason: 'account' });
      if (leases.length >= 4) return Response.json({ token: null, reason: 'capacity' });
      const token = crypto.randomUUID();
      leases.push({ account: input.account, token, expiresAt: Date.now() + 95_000 });
      await this.save(leases);
      return Response.json({ token });
    });
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const leases = (await this.ctx.storage.get<Reservation[]>('leases') || []).filter(value => value.expiresAt > Date.now());
      await this.save(leases);
    });
  }
}
