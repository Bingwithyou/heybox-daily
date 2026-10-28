import test from 'node:test';
import assert from 'node:assert/strict';
import { executeActivity } from '../src/operations.ts';
import { encryptCredential } from '@heybox/hosting/crypto';

const key = Buffer.alloc(32, 7).toString('base64');
const credential = encryptCredential({ session: { heybox_id: '123', pkey: 'private-pkey', device_id: 'private-device', x_xhh_tokenid: 'private-token' },
  device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } }, key);
const store = { activityAccess: async () => true };
const home = { logined: true, heybox_id: '123', joined: false, baned: false,
  award_info: { award_id: 9, award_name: '测试活动', status: 0 }, front_task: [], task_list: [] };

test('business rejection logs the precise stage and code without account or credential data', async t => {
  const logs: string[] = []; t.mock.method(console, 'log', (line: string) => logs.push(line));
  await assert.rejects(executeActivity({ mode: 'participate', credential, activityId: '9', approvedFollowIds: [] }, key, store,
    async () => Response.json({ status: 'ok', result: { ...home, baned: true } })), { code: 'activity_blocked' });
  const failed = JSON.parse(logs.at(-1)!);
  assert.equal(failed.stage, 'eligibility'); assert.equal(failed.code, 'activity_blocked');
  assert.equal(failed.category, 'business'); assert.ok(failed.stages.load_home >= 0);
  assert.match(failed.requestId, /^[a-f0-9-]{36}$/);
  for (const secret of [credential.ciphertext, 'private-pkey', 'private-token', 'private-device', key]) assert.ok(!logs.join().includes(secret));
  assert.equal(failed.account, undefined);
});

test('a rejected join records the upstream code and final confirmation failure without replaying the write', async t => {
  const logs: string[] = []; t.mock.method(console, 'log', (line: string) => logs.push(line));
  let writes = 0;
  await assert.rejects(executeActivity({ mode: 'participate', credential, activityId: '9', approvedFollowIds: [] }, key, store,
    async (_url, init) => {
      if (init?.method === 'POST') { writes++; return Response.json({ status: 'failed', msg: 'private-upstream-reply' }); }
      return Response.json({ status: 'ok', result: home });
    }), { code: 'activity_unconfirmed' });
  assert.equal(writes, 1);
  const events = logs.map(line => JSON.parse(line));
  const upstream = events.find(e => e.event === 'executor_activity_upstream_failed');
  assert.equal(upstream.stage, 'join_submit'); assert.equal(upstream.upstreamCode, 'failed');
  const failed = events.at(-1);
  assert.equal(failed.stage, 'join_confirm'); assert.equal(failed.code, 'activity_unconfirmed');
  assert.equal(failed.requestId, upstream.requestId); assert.ok(failed.stages.join_confirm >= 7000);
  assert.ok(!logs.join().includes('private-upstream-reply'));
});

test('cancellation is recorded separately from a business 400 and stops the upstream read', async t => {
  const logs: string[] = []; t.mock.method(console, 'log', (line: string) => logs.push(line));
  const controller = new AbortController();
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const result = executeActivity({ mode: 'list', credential }, key, store, async (_url, init) => {
    entered(); return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  }, controller.signal);
  await ready; controller.abort(); await assert.rejects(result, { code: 'activity_upstream' });
  const failed = JSON.parse(logs.at(-1)!);
  assert.equal(failed.category, 'cancelled'); assert.equal(failed.stage, 'list_rooms');
});
