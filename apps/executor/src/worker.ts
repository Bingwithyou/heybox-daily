import { beginSchema, verifySchema, completeCaptchaSchema, activityRequestSchema, credentialSchema, ActivityFailure, loginTimingHeader } from '@heybox/contracts';
import { Store } from '../../web/src/server/store.ts';
import { serviceAuthorized, boundedBody } from '../../web/src/server/security.ts';
import { decryptCredential } from '../../runner/src/crypto.ts';
import { HeyboxClient } from 'heybox-daily/client';
import { inspect } from 'heybox-daily/tasks';
import { dispatchDue, consume } from './queue.ts';
import { executeActivity } from './operations.ts';
import { deadline } from './deadline.ts';
import type { Env } from './env.ts';
export { LoginChallenge, ActivityGate } from './objects.ts';

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    if (!await serviceAuthorized(request, env.RUNNER_SERVICE_TOKEN || '')) return new Response(null, { status: 401 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ runtime: 'cloudflare', dailyEnabled: env.DAILY_ENABLED === 'true' });
    try {
      if (path === '/tasks/wake') {
        context.waitUntil(dispatchDue(env).catch(() => { console.warn(JSON.stringify({ event: 'executor_dispatch_failed' })); }));
        return new Response(null, { status: 204 });
      }
      const raw = await boundedBody(request, 16_384);
      const input: unknown = JSON.parse(new TextDecoder().decode(raw));
      if (path.startsWith('/login/')) {
        const data = path === '/login/begin' ? { ...beginSchema.parse(input), challenge: crypto.randomUUID() }
          : path === '/login/verify' ? verifySchema.parse(input) : path === '/login/captcha' ? completeCaptchaSchema.parse(input) : null;
        if (!data) return new Response(null, { status: 404 });
        return env.LOGIN_CHALLENGES.get(env.LOGIN_CHALLENGES.idFromName(data.challenge)).fetch(`https://challenge${path.slice(6)}`, {
          method: 'POST', body: JSON.stringify(data), headers: { 'content-type': 'application/json',
            [loginTimingHeader]: request.headers.get(loginTimingHeader) || '' },
        });
      }
      if (path === '/activities') {
        const data = activityRequestSchema.parse(input);
        const gate = env.ACTIVITY_GATE.get(env.ACTIVITY_GATE.idFromName('global'));
        const acquired = await gate.fetch('https://gate/acquire', { method: 'POST', body: JSON.stringify({ account: data.credential.account }) });
        if (!acquired.ok) throw new ActivityFailure('activity_busy');
        const { token } = await acquired.json() as { token: string | null };
        if (!token) throw new ActivityFailure('activity_busy');
        try { return Response.json(await executeActivity(data, env.CREDENTIAL_KEY, new Store(env.DB))); }
        finally {
          context.waitUntil(gate.fetch('https://gate/release', { method: 'POST', body: JSON.stringify({ account: data.credential.account, token }) })
            .catch(() => { console.warn(JSON.stringify({ event: 'executor_activity_release_failed' })); }));
        }
      }
      if (path === '/diagnostics/inspect') {
        // Authenticated operator check; only reads the current account's upstream task state.
        const credential = credentialSchema.parse(input);
        if (!await new Store(env.DB).activityAccess(credential.account, credential.version)) return new Response(null, { status: 409 });
        const scope = deadline(45_000);
        try {
          const config = decryptCredential(credential, env.CREDENTIAL_KEY);
          const state = await inspect(new HeyboxClient(config, { fetchImpl: scope.fetch }), credential.account);
          return Response.json({ signed: state.signed, tasks: state.tasks.map(({ id, state: status }) => ({ id, state: status })) });
        } finally { scope.close(); }
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      if (error instanceof ActivityFailure) return Response.json({ code: error.code, error: error.message }, { status: error.code === 'activity_busy' ? 409 : 400 });
      console.warn(JSON.stringify({ event: 'executor_request_failed', path }));
      return Response.json({ error: '执行服务暂时不可用' }, { status: 400 });
    }
  },
  async queue(batch: MessageBatch<unknown>, env: Env) { await consume(batch, env); },
  async scheduled(_event: ScheduledController, env: Env) { await dispatchDue(env); },
} satisfies ExportedHandler<Env>;
