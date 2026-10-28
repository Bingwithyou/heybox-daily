export const loginTimingHeader = 'x-heybox-request-id';
const stages = ['auth_quota', 'web_accounts', 'sms_quota', 'sms_cooldown', 'executor', 'challenge_load',
  'challenge_save', 'challenge_clear', 'challenge_total', 'token_http', 'token_service',
  'token_queue', 'token_generate', 'sms_upstream', 'verify_upstream', 'challenge_prepare', 'login_prepare', 'challenge_begin',
  'token_sdk_download', 'token_initialize', 'token_sdk_execute', 'token_wait', 'token_upstream', 'token_dns', 'token_tcp', 'token_tls'] as const;
export type LoginStage = typeof stages[number];

// Only numeric durations and a random correlation ID may cross service boundaries.
// Never include URLs, arguments, headers or exception messages in these metrics.
export class LoginTiming {
  readonly id: string;
  readonly values: Partial<Record<LoginStage, number>> = {};
  private readonly now: () => number;
  constructor(id?: string | null, now = () => performance.now()) {
    this.id = id && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) ? id : crypto.randomUUID();
    this.now = now;
  }
  add(stage: LoginStage, duration: number) {
    if (Number.isFinite(duration) && duration >= 0 && duration <= 300_000)
      this.values[stage] = Math.round(((this.values[stage] || 0) + duration) * 10) / 10;
  }
  async measure<T>(stage: LoginStage, run: () => Promise<T>): Promise<T> {
    const started = this.now();
    try { return await run(); }
    finally { this.add(stage, this.now() - started); }
  }
  merge(header: string | null) {
    for (const metric of (header || '').split(',')) {
      const match = /^([a-z_]+);dur=(\d+(?:\.\d+)?)$/.exec(metric.trim());
      if (match && stages.includes(match[1] as LoginStage)) this.add(match[1] as LoginStage, Number(match[2]));
    }
  }
  header() {
    return Object.entries(this.values).map(([stage, duration]) => `${stage};dur=${duration}`).join(', ');
  }
}
