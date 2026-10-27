import { ActivityFailure, activityResultSchema, type ActivityRequest, type ActivityResult } from '@heybox/contracts';

export class ActivityService {
  private readonly active = new Set<string>();
  private readonly execute: (request: ActivityRequest) => Promise<ActivityResult>;
  private readonly concurrency: number;
  constructor(execute: (request: ActivityRequest) => Promise<ActivityResult>, concurrency = 4) {
    this.execute = execute; this.concurrency = concurrency;
  }
  async run(request: ActivityRequest): Promise<ActivityResult> {
    const account = request.credential.account;
    if (this.active.has(account) || this.active.size >= this.concurrency) throw new ActivityFailure('activity_busy');
    this.active.add(account);
    try {
      const result = activityResultSchema.parse(await this.execute(request));
      if (result.mode !== request.mode || (result.mode === 'participate' && request.mode === 'participate' && result.activity.id !== request.activityId))
        throw new ActivityFailure('activity_invalid');
      return result;
    } finally { this.active.delete(account); }
  }
}
