import { HeyboxApiError } from 'heybox-daily/client';
import type { ActivityRequest } from '@heybox/contracts';

export class ActivityTrace {
  readonly requestId = crypto.randomUUID();
  readonly started = performance.now();
  readonly stages: Record<string, number> = {};
  stage = 'acquire';
  private since = this.started;
  readonly input: Pick<ActivityRequest, 'mode'> & { activityId?: string };
  constructor(input: Pick<ActivityRequest, 'mode'> & { activityId?: string }) { this.input = input; }
  enter(stage: string) {
    const now = performance.now();
    this.stages[this.stage] = Math.round(((this.stages[this.stage] || 0) + now - this.since) * 10) / 10;
    this.stage = stage;
    this.since = now;
  }
  log(event: string, details: Record<string, unknown> = {}) {
    console.log(JSON.stringify({ event, requestId: this.requestId, mode: this.input.mode,
      activityId: this.input.activityId, stage: this.stage,
      durationMs: Math.round(performance.now() - this.started), ...details }));
  }
  async upstream<T>(endpoint: string, action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      this.log('executor_activity_upstream_failed', { endpoint, upstreamMs: Math.round(performance.now() - started),
        upstreamCode: error instanceof HeyboxApiError ? error.status : undefined,
        httpStatus: /^HTTP (\d{3})：/.exec(message)?.[1],
        category: error instanceof HeyboxApiError ? 'upstream_rejected'
          : /请求失败或超时/.test(message) ? 'upstream_network'
          : /^HTTP /.test(message) ? 'upstream_http' : /登录已过期|设备令牌无效/.test(message) ? 'auth' : 'upstream_response' });
      throw error;
    }
  }
}
