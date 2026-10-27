import { HeyboxClient, HeyboxApiError } from 'heybox-daily/client';
import { runDaily, inspect, experienceDelta } from 'heybox-daily/tasks';
import { ActivityError, listActivities, participateActivity } from 'heybox-daily/activities';
import { createLoginConfig, sendLoginCode, verifyLoginCode } from 'heybox-daily/login-core';
import type { Inspection, TaskSnapshot as InspectionSnapshot } from 'heybox-daily/types';
import { taskIds, ActivityFailure, LoginFailure, LoginTiming, loginTimingHeader, type Job, type Outcome, type TaskSnapshot, type ActivityRequest, type ActivityResult } from '@heybox/contracts';
import { decryptCredential } from '../../runner/src/crypto.ts';
import { createDailyCheckpoint } from '../../runner/src/checkpoint.ts';
import type { Store } from '../../web/src/server/store.ts';
import { deadline } from './deadline.ts';
import type { LoginOperations } from './challenge.ts';
import type { Env } from './env.ts';

export function failureCategory(error: unknown) {
  if (error instanceof HeyboxApiError && error.captchaRequired) return 'captcha_required';
  const text = error instanceof Error ? error.message : '';
  if (/频繁|次数.*限制|^HTTP 429：/.test(text)) return 'upstream_rate_limit';
  if (/^HTTP \d{3}：/.test(text)) return 'upstream_http';
  if (/请求失败或超时/.test(text)) return 'upstream_network';
  if (/接口未成功/.test(text)) return 'upstream_rejected';
  if (/验证码/.test(text)) return 'verification_code';
  if (/execution_timeout/.test(text)) return 'timeout';
  return 'internal';
}
function publicSnapshot(value: Inspection): TaskSnapshot {
  return { exp: value.exp, coin: value.coin, battery: value.battery, tasks: taskIds.map(id => ({ id,
    state: (id === 'sign' ? value.signed : value.tasks.find(task => task.id === id)?.state === 'finish') ? 'finish' : 'waiting' })) };
}
export async function executeDaily(job: Job, key: string, store: Pick<Store, 'heartbeat'>, fetchImpl: typeof fetch = fetch): Promise<Outcome & { category?: string }> {
  const scope = deadline(240_000, fetchImpl);
  try {
    const config = decryptCredential(job.credential, key);
    const client = new HeyboxClient(config, { fetchImpl: scope.fetch });
    const check = createDailyCheckpoint(job.date, async () => {
      scope.signal.throwIfAborted();
      if (!await store.heartbeat(job.id, job.lease, job.credential.version)) throw new Error('cancelled');
    });
    let before: InspectionSnapshot | undefined;
    let latest: InspectionSnapshot | undefined;
    let expDelta: number | undefined;
    const execution: NonNullable<Outcome['execution']> = {};
    try {
      const result = await runDaily(client, config.session.heybox_id, { log: () => {}, checkpoint: check, sleep: scope.sleep,
        onSnapshot: (value, delta) => { before ||= value; latest = value; expDelta = delta; },
        onTask: (id, action) => { execution[id] = action; } });
      await check(true);
      return { status: 'completed', expDelta: result.expDelta, coinDelta: result.coinDelta,
        batteryDelta: result.batteryDelta, execution, profile: result.snapshot.profile, snapshot: publicSnapshot(result.snapshot) };
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      if (text === 'cancelled' || text === 'cross_day') return { status: 'cancelled', reason: text, execution };
      if (/登录已过期|登录已失效|设备令牌无效/.test(text)) return { status: 'auth_expired', reason: 'auth_expired', execution };
      let snapshot: TaskSnapshot | undefined;
      try {
        await check(true);
        const state = await inspect(client, config.session.heybox_id);
        const gain = latest && experienceDelta(latest, state);
        expDelta = expDelta === undefined || gain === undefined ? undefined : expDelta + gain;
        latest = state; snapshot = publicSnapshot(state);
      } catch { /* A failed observation cannot become a confirmed result. */ }
      return { status: 'failed', reason: scope.signal.aborted ? 'timeout' : 'upstream',
        category: scope.signal.aborted ? 'timeout' : failureCategory(error), snapshot, execution, expDelta,
        coinDelta: before && latest ? latest.coin - before.coin : undefined,
        batteryDelta: before?.battery === undefined || latest?.battery === undefined ? undefined : latest.battery - before.battery };
    }
  } finally { scope.close(); }
}
export async function executeActivity(input: ActivityRequest, key: string, store: Pick<Store, 'activityAccess'>, fetchImpl: typeof fetch = fetch): Promise<ActivityResult> {
  const scope = deadline(90_000, fetchImpl);
  try {
    const config = decryptCredential(input.credential, key);
    const client = new HeyboxClient(config, { fetchImpl: scope.fetch });
    const check = async () => {
      scope.signal.throwIfAborted();
      if (!await store.activityAccess(input.credential.account, input.credential.version)) throw new ActivityError('activity_auth');
    };
    await check();
    if (input.mode === 'list') return { mode: 'list', activities: await listActivities(client, config.session.heybox_id) };
    return { mode: 'participate', activity: await participateActivity(client, config.session.heybox_id,
      input.activityId, input.approvedFollowIds, { checkpoint: check, sleep: scope.sleep }) };
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    throw new ActivityFailure(error instanceof ActivityError ? error.code
      : /登录已过期|登录已失效|设备令牌无效/.test(text) ? 'activity_auth' : 'activity_upstream');
  } finally { scope.close(); }
}
export function loginOperations(env: Pick<Env, 'TOKEN_SERVICE_URL' | 'TOKEN_SERVICE_TOKEN'>, fetchImpl: typeof fetch = fetch): LoginOperations {
  const operation = async <T>(action: (request: typeof fetch) => Promise<T>): Promise<T> => {
    const scope = deadline(120_000, fetchImpl);
    try { return await action(scope.fetch); }
    catch (error) {
      if (failureCategory(error) === 'upstream_rate_limit') throw new LoginFailure('upstream_rate_limit');
      throw error;
    } finally { scope.close(); }
  };
  const step = async (action: 'send' | 'verify', request: typeof fetch, config: Parameters<LoginOperations['send']>[0], phone: string,
    timing: LoginTiming, proof?: Parameters<LoginOperations['send']>[2], code?: string) => {
    const options = { clientFactory: (value: typeof config) => new HeyboxClient(value, { fetchImpl: request }), captcha: proof };
    try {
      if (action === 'verify') return { status: 'authenticated' as const,
        config: await timing.measure('verify_upstream', () => verifyLoginCode(config, phone, code!, options)) };
      await timing.measure('sms_upstream', () => sendLoginCode(config, phone, options));
      return { status: 'sent' as const, config };
    } catch (error) {
      if (error instanceof HeyboxApiError && error.captchaRequired && error.captchaAppId)
        return { status: 'captcha' as const, appId: error.captchaAppId, config };
      throw error;
    }
  };
  return {
    begin: (phone, timing = new LoginTiming()) => operation(async request => {
      const url = new URL('/token', env.TOKEN_SERVICE_URL);
      if (url.protocol !== 'https:' || env.TOKEN_SERVICE_TOKEN.length < 32) throw new Error('Invalid token service configuration');
      const token = await timing.measure('token_http', async () => {
        const response = await request(url, { method: 'POST', redirect: 'manual',
          headers: { authorization: `Bearer ${env.TOKEN_SERVICE_TOKEN}`, 'content-type': 'application/json',
            [loginTimingHeader]: timing.id }, body: '{}' });
        timing.merge(response.headers.get('server-timing'));
        if (!response.ok) throw new Error('设备令牌服务暂时繁忙');
        const result = await response.json() as { token?: string };
        if (typeof result.token !== 'string' || !/^B[A-Za-z0-9+/=_-]{88}$/.test(result.token)) throw new Error('设备令牌格式无效');
        return result.token;
      });
      return step('send', request, createLoginConfig(token), phone, timing);
    }),
    send: (config, phone, proof, timing = new LoginTiming()) => operation(request => step('send', request, config, phone, timing, proof)),
    verify: (config, phone, code, proof, timing = new LoginTiming()) => operation(request => step('verify', request, config, phone, timing, proof, code)),
  };
}
