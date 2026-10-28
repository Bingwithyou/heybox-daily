import { randomUUID } from 'node:crypto';
import { ActivityFailure, LoginFailure, taskIds, type ActivityView, type Outcome, type Job } from '@heybox/contracts';
import type { Config } from 'heybox-daily/types';
import { ChallengeStore } from './challenges.ts';
import { ActivityService } from './activities.ts';
import { decryptCredential } from '@heybox/hosting/crypto';
import { createRunnerServer } from './server.ts';

const accounts = new Map([['+8613900000009', '900000009'], ['+8613900000008', '900000008']]);
export function previewWebsite(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.origin === 'https://preview.heybox.cansiny.top' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))))
    throw new Error('模拟 Runner 只能连接预发布网站或本地测试地址');
  return url;
}
function demoConfig(phone: string): Config {
  const account = accounts.get(phone);
  if (!account) throw new LoginFailure();
  return {
    session: { heybox_id: account, pkey: 'preview-only-not-a-real-session', device_id: randomUUID(), x_xhh_tokenid: 'B' + 'p'.repeat(88) },
    device: { model: 'preview', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' },
    profile: { nickname: account === '900000009' ? '演示盒友' : '失败场景演示' },
  };
}
function assertDemoAccount(account: string) {
  if (![...accounts.values()].includes(account)) throw new Error('仅支持演示账号');
}
export function previewOutcome(account: string): Outcome {
  assertDemoAccount(account);
  if (account === '900000008') return { status: 'failed', reason: 'upstream' };
  return { status: 'completed', snapshot: { exp: 1300, coin: 1708, battery: 1318,
    tasks: taskIds.map(id => ({ id, state: 'finish' as const })) },
    expDelta: 30, coinDelta: 100, batteryDelta: 1,
    execution: { sign: 'skipped', '1': 'executed', '19': 'executed', '31': 'executed' } };
}
function initialActivities(): ActivityView[] {
  const end = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) + ' 15:00';
  return [
    { id: '9317', name: '一加电竞好物盲盒', prizeCount: 5, endTime: end(2), joined: false, tickets: null,
      status: 'follow_required', followAccounts: [{ id: '104298871', name: '关注「一加手机」官方账号' }] },
    { id: '9305', name: 'PS5手柄＋漫步者耳机', prizeCount: 4, endTime: end(8), joined: false, tickets: null,
      status: 'blocked', reason: 'Steam库内拥有《愚者不灭》', followAccounts: [] },
    { id: '9351', name: '高票档完整伴手礼（随机）', prizeCount: 6, endTime: end(13), joined: true, tickets: 1200,
      status: 'completed', followAccounts: [] },
    { id: '9991', name: '游戏周边礼包（演示）', prizeCount: 3, endTime: end(5), joined: false, tickets: null,
      status: 'available', followAccounts: [] },
  ];
}
export function createPreviewRunner(options: { token: string; key: string; websiteUrl: string; fetch?: typeof fetch }) {
  const website = previewWebsite(options.websiteUrl);
  if (options.token.length < 32 || Buffer.from(options.key, 'base64').length !== 32)
    throw new Error('预发布密钥未配置');
  const request = options.fetch || fetch;
  const state = new Map<string, ActivityView[]>();
  const store = new ChallengeStore({
    begin: async phone => ({ status: 'sent', config: demoConfig(phone) }),
    send: async () => { throw new LoginFailure(); },
    verify: async (config, phone, code) => {
      if (code !== '123456' || accounts.get(phone) !== config.session.heybox_id) throw new LoginFailure();
      return { status: 'authenticated', config };
    },
  });
  const activities = new ActivityService(async input => {
    try {
      const config = decryptCredential(input.credential, options.key);
      assertDemoAccount(config.session.heybox_id);
      if (config.session.pkey !== 'preview-only-not-a-real-session') throw new Error('invalid');
    } catch { throw new ActivityFailure('activity_auth'); }
    const account = input.credential.account;
    let rows = state.get(account);
    if (!rows) { rows = initialActivities(); state.set(account, rows); }
    if (input.mode === 'list') return { mode: 'list', activities: rows };
    const row = rows.find(value => value.id === input.activityId);
    if (!row || row.status === 'blocked') throw new ActivityFailure('activity_blocked');
    if (row.followAccounts.some(target => !input.approvedFollowIds.includes(target.id)))
      throw new ActivityFailure('activity_changed');
    if (!row.joined) {
      await new Promise(resolve => setTimeout(resolve, 300));
      row.joined = true; row.tickets = 700; row.status = 'completed'; row.followAccounts = [];
    }
    return { mode: 'participate', activity: row };
  });
  let active: Promise<void> | undefined;
  let pendingWake = false;
  async function api(path: string, body: unknown = {}) {
    const response = await request(new URL(path, website), {
      method: 'POST', headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`预发布回调 HTTP ${response.status}`);
    return response;
  }
  async function drain() {
    do {
      pendingWake = false;
      for (let i = 0; i < 20; i++) {
        const job = await (await api('/internal/claim')).json() as Job | null;
        if (!job) break;
        const config = decryptCredential(job.credential, options.key);
        assertDemoAccount(config.session.heybox_id);
        if (config.session.pkey !== 'preview-only-not-a-real-session') throw new Error('非演示凭据');
        await new Promise(resolve => setTimeout(resolve, 500));
        await api('/internal/finish', { id: job.id, lease: job.lease, version: job.credential.version,
          result: previewOutcome(job.credential.account) });
      }
    } while (pendingWake);
  }
  function wake() {
    pendingWake = true;
    if (active) return;
    active = drain().catch(() => { console.error(JSON.stringify({ event: 'preview_callback_failed' })); })
      .finally(() => { active = undefined; });
  }
  return createRunnerServer(store, options.token, options.key, wake, activities);
}
