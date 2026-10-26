import { randomUUID } from 'node:crypto';
import type { Config } from 'heybox-daily/types';
import { normalizePhone } from 'heybox-daily/login';

type Challenge = { config: Config; phone: string; binding: string; expiresAt: number; attempts: number; busy: boolean; timer: ReturnType<typeof setTimeout> };
interface Options {
  begin: (phone: string) => Promise<Config>;
  verify: (config: Config, phone: string, code: string) => Promise<Config>;
  now?: () => number;
}
export class ChallengeStore {
  private readonly pending = new Map<string, Challenge>();
  private readonly options: Options;
  private active = 0;
  constructor(options: Options) { this.options = options; }
  private now() { return (this.options.now || Date.now)(); }
  private remove(id: string) { const value = this.pending.get(id); if (value) clearTimeout(value.timer); this.pending.delete(id); }
  private cleanup() { for (const [id, value] of this.pending) if (value.expiresAt <= this.now()) this.remove(id); }
  async begin(phone: string, binding: string) {
    this.cleanup();
    if (this.active >= 2 || this.pending.size >= 100) throw new Error('登录繁忙，请稍后再试');
    this.active++;
    try {
      const normalized = normalizePhone(phone);
      const config = await this.options.begin(normalized);
      const challenge = randomUUID();
      const expiresAt = this.now() + 5 * 60_000;
      const timer = setTimeout(() => this.remove(challenge), 5 * 60_000); timer.unref();
      this.pending.set(challenge, { config, phone: normalized, binding, expiresAt, attempts: 0, busy: false, timer });
      return { challenge, expiresAt, retryAfter: 60 };
    } finally { this.active--; }
  }
  async verify(id: string, code: string, binding: string) {
    this.cleanup();
    const challenge = this.pending.get(id);
    if (!challenge || challenge.binding !== binding) throw new Error('登录挑战无效或已过期，请重新获取验证码');
    if (challenge.busy) throw new Error('验证码处理中，请稍候');
    if (this.active >= 2) throw new Error('登录繁忙，请稍后再试');
    if (!/^\d{4,8}$/.test(code)) throw new Error('验证码格式不正确');
    challenge.busy = true; challenge.attempts++; this.active++;
    try {
      const config = await this.options.verify(challenge.config, challenge.phone, code);
      this.remove(id);
      return config;
    } catch (error) {
      if (challenge.attempts >= 3) this.remove(id);
      throw error;
    } finally { challenge.busy = false; this.active--; }
  }
}
