import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityService } from '../src/activities.ts';
import { ActivityFailure, type ActivityRequest, type ActivityResult } from '@heybox/contracts';
import { createRunnerServer } from '../src/server.ts';
import { ChallengeStore } from '../src/challenges.ts';
import { encryptCredential } from '../src/crypto.ts';
import { runChild } from '../src/process.ts';

const credential = { account: '123', version: crypto.randomUUID(), ciphertext: 'encrypted-fixture'.repeat(3) };
const request: ActivityRequest = { mode: 'participate', credential, activityId: '9', approvedFollowIds: ['456'] };
const result: ActivityResult = { mode: 'participate', activity: { id: '9', name: '活动', prizeCount: 1, endTime: null, joined: true, tickets: 700, status: 'completed', followAccounts: [] } };
test('one account cannot run concurrent activity writes and the lock is released after completion', async () => {
  let release!: () => void; let calls = 0;
  const service = new ActivityService(async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return result; });
  const first = service.run(request);
  await assert.rejects(service.run(request), error => error instanceof ActivityFailure && error.code === 'activity_busy');
  assert.equal(calls, 1); release(); await first;
  const second = service.run(request); release(); await second; assert.equal(calls, 2);
});
test('failures release the account lock and invalid result data never reaches callers', async () => {
  let calls = 0;
  const service = new ActivityService(async () => { if (!calls++) throw new Error('private-provider-data'); return { ...result, mode: 'list' } as unknown as ActivityResult; });
  await assert.rejects(service.run(request), /private-provider-data/);
  await assert.rejects(service.run(request));
  assert.equal(calls, 2);
});
test('the runner validates activity inputs after service authentication and redacts execution failures', async () => {
  const store = new ChallengeStore({ begin: async () => assert.fail(), send: async () => assert.fail(), verify: async () => assert.fail() });
  let calls = 0;
  const service = new ActivityService(async input => {
    calls++; assert.equal(input.credential.account, '123');
    if (calls === 1) throw new ActivityFailure('activity_changed');
    if (calls === 2) throw new Error('private-provider-data');
    return result;
  });
  const token = 'a'.repeat(64);
  const server = createRunnerServer(store, token, Buffer.alloc(32).toString('base64'), undefined, service);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/activities`;
  const post = (body: unknown, authenticated = true) => fetch(url, { method: 'POST', body: JSON.stringify(body), headers: authenticated ? { authorization: `Bearer ${token}` } : {} });
  try {
    assert.equal((await post(request, false)).status, 401); assert.equal(calls, 0);
    assert.equal((await post({ ...request, activityId: 'https://other.invalid' })).status, 400); assert.equal(calls, 0);
    const changed = await post(request); assert.equal(changed.status, 400); assert.equal((await changed.json()).code, 'activity_changed');
    const failure = await post(request); assert.equal(failure.status, 400); assert.ok(!(await failure.text()).includes('private-provider-data'));
    assert.deepEqual(await (await post(request)).json(), result);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('activity children decrypt only their account, apply actual prerequisites, and honor credential revocation', async t => {
  const names = ['NODE_OPTIONS', 'CREDENTIAL_KEY', 'WEBSITE_URL', 'RUNNER_SERVICE_TOKEN'] as const;
  const previous = names.map(name => process.env[name]);
  const key = Buffer.alloc(32, 7).toString('base64');
  const config = { session: { heybox_id: '123', pkey: 'private-pkey', device_id: 'private-device', x_xhh_tokenid: 'private-token' },
    device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };
  const encrypted = encryptCredential(config, key);
  const lines: string[] = [];
  t.mock.method(console, 'warn', (line: string) => lines.push(line));
  const home = { logined: true, heybox_id: '123', joined: false, baned: false,
    award_info: { award_id: 9, award_name: '测试活动', status: 0 },
    front_task: [{ task_id: 10, task_key: 'own_game', task_name: '需拥有游戏', finished: false }], task_list: [] };
  const stub = `globalThis.fetch = async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/internal/activities/check') return new Response(null, { status: 204 });
    if (init?.method === 'POST') throw new Error('unexpected external mutation');
    if (path === '/store/roll_room_v2/room_list') return Response.json({ status: 'ok', result: [{ award_id: 9, status: 0 }] });
    if (path === '/store/roll_room_v2/get_home_info') return Response.json({ status: 'ok', result: ${JSON.stringify(home)} });
    throw new Error('unexpected external endpoint');
  };`;
  process.env.CREDENTIAL_KEY = key; process.env.WEBSITE_URL = 'https://site.invalid'; process.env.RUNNER_SERVICE_TOKEN = 'a'.repeat(64);
  process.env.NODE_OPTIONS = `${previous[0] || ''} --import=data:text/javascript,${encodeURIComponent(stub)}`;
  try {
    const list = await runChild<ActivityResult>({ action: 'activities', request: { mode: 'list', credential: encrypted } });
    assert.equal(list.mode, 'list');
    assert.ok(list.mode === 'list' && list.activities[0].status === 'blocked');
    await assert.rejects(runChild({ action: 'activities', request: { ...request, credential: encrypted } }), error => error instanceof ActivityFailure && error.code === 'activity_blocked');
    process.env.NODE_OPTIONS = `${previous[0] || ''} --import=data:text/javascript,${encodeURIComponent("globalThis.fetch = async () => new Response(null, { status: 409 });")}`;
    await assert.rejects(runChild({ action: 'activities', request: { mode: 'list', credential: encrypted } }), error => error instanceof ActivityFailure && error.code === 'activity_auth');
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
  for (const secret of ['private-pkey', 'private-device', 'private-token', encrypted.ciphertext, key]) assert.ok(!lines.join().includes(secret));
});
