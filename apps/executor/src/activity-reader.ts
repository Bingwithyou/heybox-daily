import { DurableObject } from 'cloudflare:workers';
import { activityRequestSchema, activityAccessSchema, ActivityFailure, type ActivityResult } from '@heybox/contracts';
import { Store } from '@heybox/hosting/store';
import { ActivityReadCache } from './activity-cache.ts';
import { ActivityTrace } from './activity-trace.ts';
import { withActivityLease } from './activity-lifecycle.ts';
import { executeActivity } from './operations.ts';
import type { Env } from './env.ts';

// Each account has one coordinator. Only public activity results are cached in memory.
export class ActivityReader extends DurableObject<Env> {
  private readonly cache = new ActivityReadCache<ActivityResult>();
  async fetch(request: Request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    try {
      const input = await request.json();
      const path = new URL(request.url).pathname;
      const data = path === '/invalidate' ? activityAccessSchema.parse(input) : activityRequestSchema.parse(input);
      const credential = 'credential' in data ? data.credential : data;
      if (this.env.ACTIVITY_READERS.idFromName(credential.account).toString() !== this.ctx.id.toString())
        return new Response(null, { status: 400 });
      if (path === '/invalidate') { this.cache.invalidate(); return new Response(null, { status: 204 }); }
      if (path !== '/list' || !('mode' in data) || data.mode !== 'list') return new Response(null, { status: 404 });
      const store = new Store(this.env.DB);
      const check = async () => {
        if (!await store.activityAccess(credential.account, credential.version)) throw new ActivityFailure('activity_auth');
      };
      await check();
      const result = await this.cache.read(credential.version, request.signal, signal => {
        const gate = this.env.ACTIVITY_GATE.get(this.env.ACTIVITY_GATE.idFromName('reads'));
        const trace = new ActivityTrace(data);
        return withActivityLease(gate, credential.account, signal, this.ctx, trace,
          () => executeActivity(data, this.env.CREDENTIAL_KEY, store, fetch, signal, trace));
      });
      await check();
      return Response.json(result);
    } catch (error) {
      const failure = error instanceof ActivityFailure ? error : new ActivityFailure('activity_upstream');
      return Response.json({ code: failure.code, error: failure.message },
        { status: ['activity_busy', 'activity_capacity'].includes(failure.code) ? 409 : 400 });
    }
  }
}
