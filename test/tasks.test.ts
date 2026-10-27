import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, signedToday, runDaily, selectShare, experienceDelta } from '../dist/tasks.js';
import type { ShareEvent, TaskClient } from '../dist/types.js';

type WebArguments = Parameters<TaskClient['web']>;
type ClientOverrides = Partial<Omit<TaskClient, 'web'>> & { web?: (...args: WebArguments) => Promise<unknown> };
function mockClient({ web, ...overrides }: ClientOverrides): TaskClient {
  const unexpected = () => assert.fail('unexpected API call');
  return {
    tasks: unexpected, signState: unexpected, sign: unexpected, report: unexpected,
    web: async <T>(...args: WebArguments) => {
      assert.ok(web, 'unexpected web API call');
      return await web(...args) as T;
    },
    ...overrides,
  };
}

const now = () => Date.parse('2026-10-26T12:00:00Z');
function result(states = ['finish', 'finish', 'finish']) {
  return { user: { userid: '12345', level_info: { exp: 100, coin: 200, level: 3, max_exp: 200 } }, task_list: [{ title: '每日任务', tasks: [
    { title: '签到', state: 'finish' },
    ...['1', '19', '31'].map((id, i) => ({ title: id, state: states[i], report_extra: { task_id: id } })),
  ] }] };
}
const state = { state: 'ok', signed_date: 20752 };
const quiet = () => {};

test('rejects empty data, a different account and the obsolete website task set', () => {
  assert.throws(() => snapshot({}, '12345'));
  assert.throws(() => snapshot(result(), '99999'), /账号/);
  const old = result();
  const task = old.task_list[0].tasks[3];
  assert.ok('report_extra' in task);
  task.report_extra.task_id = '11';
  assert.throws(() => snapshot(old, '12345'), /任务/);
});
test('signed_date must match the current day in Asia/Shanghai', () => {
  assert.equal(signedToday(state, now()), true);
  assert.equal(signedToday({ ...state, signed_date: 20751 }, now()), false);
  assert.equal(signedToday({ state: 'ok' }, now()), false);
  assert.equal(signedToday(state, Date.parse('2026-10-26T16:00:00Z')), false);
});
test('finished tasks never trigger a sign request or share events', async () => {
  const client = mockClient({ tasks: async () => result(), signState: async () => state,
    sign: () => assert.fail('unexpected sign'), report: () => assert.fail('unexpected report') });
  const summary = await runDaily(client, '12345', { now, log: quiet });
  assert.equal(summary.completed, true);
  assert.equal(summary.expDelta, 0);
});
test('experience includes the completed level when it resets on level-up', async () => {
  for (const remaining of [0, 25]) {
    let reads = 0;
    const client = mockClient({ tasks: async () => {
      const value = result();
      value.user.level_info = { exp: reads++ ? remaining : 110, coin: 200, level: reads === 1 ? 3 : 4, max_exp: 200 };
      return value;
    }, signState: async () => state });
    const summary = await runDaily(client, '12345', { now, log: quiet });
    assert.equal(summary.expDelta, 90 + remaining);
  }
});
test('experience uses the prior level threshold and preserves unknown or invalid metadata', () => {
  const before = snapshot(result(), '12345');
  assert.equal(experienceDelta(before, { ...before, exp: 130 }), 30);
  assert.equal(experienceDelta({ ...before, level: 0, exp: 190 }, { ...before, level: 1, exp: 10, maxExp: 400 }), 20);
  assert.equal(experienceDelta({ ...before, level: undefined }, before), undefined);
  assert.equal(experienceDelta({ ...before, maxExp: undefined }, { ...before, level: 4 }), undefined);
  assert.equal(experienceDelta(before, { ...before, level: 2 }), undefined);
});
test('experience accumulates observed level-ups and reports partial progress before a failure', async () => {
  const progress: Array<number | undefined> = [];
  let reads = 0;
  const levels = [{ level: 1, exp: 190 }, { level: 2, exp: 20 }, { level: 3, exp: 10 }];
  const client = mockClient({ tasks: async () => {
    const index = Math.min(reads++, 2);
    const value = result(index === 0 ? ['waiting', 'waiting', 'waiting'] : index === 1 ? ['finish', 'waiting', 'waiting'] : ['finish', 'finish', 'waiting']);
    Object.assign(value.user.level_info, levels[index]);
    return value;
  }, signState: async () => state, web: async endpoint => {
    if (endpoint === '/bbs/app/feeds') return { links: [{ linkid: 'post', h_src: 'source' }] };
    if (reads > 2) throw new Error('upstream unavailable');
    return { all_list: [{ appid: 'game', h_src: 'source' }] };
  }, report: async () => {} });
  await assert.rejects(runDaily(client, '12345', { now, log: quiet, sleep: async () => {},
    onSnapshot: (_value, delta) => progress.push(delta) }), /upstream unavailable/);
  assert.deepEqual(progress, [0, 30, 220]);
});
test('unobservable level jumps and decreasing experience are unknown rather than negative gains', async () => {
  for (const level of [3, 5]) {
    let reads = 0;
    const client = mockClient({ tasks: async () => {
      const value = result();
      if (reads++) Object.assign(value.user.level_info, { level, exp: 0 });
      return value;
    }, signState: async () => state });
    const summary = await runDaily(client, '12345', { now, log: quiet });
    assert.equal(summary.expDelta, undefined);
    assert.equal(summary.completed, true);
  }
});
test('sign ignore from a previous day is not counted as successful', async () => {
  const client = mockClient({ tasks: async () => result(), signState: async () => ({ state: 'ok', signed_date: 20751 }),
    sign: async () => ({ state: 'ignore', signed_date: 20751 }) });
  await assert.rejects(runDaily(client, '12345', { now, log: quiet, sleep: async () => {} }), /签到/);
});
test('report success without a finished task fails after bounded polling', async () => {
  const client = mockClient({ tasks: async () => result(['waiting', 'finish', 'finish']), signState: async () => state,
    web: async () => ({ links: [{ linkid: 'article', h_src: 'source' }] }), report: async () => ({}) });
  await assert.rejects(runDaily(client, '12345', { now, log: quiet, sleep: async () => {} }), /未结算/);
});
test('settlement is read back and already finished tasks stay skipped', async () => {
  let reads = 0; const events: ShareEvent[] = [];
  const client = mockClient({ tasks: async () => result([reads++ ? 'finish' : 'waiting', 'finish', 'finish']),
    signState: async () => state,
    web: async () => ({ links: [{ link_id: 'article', h_src: 'source' }] }),
    report: async e => { events.push(e); } });
  const summary = await runDaily(client, '12345', { now, log: quiet, sleep: async () => {} });
  assert.equal(summary.completed, true);
  assert.deepEqual(events.map(e => e.path), ['/share/behavior/show', '/share/behavior/tap', '/share/behavior/success']);
});
test('login/readback errors stop the job immediately', async () => {
  const client = mockClient({ tasks: async () => { throw new Error('登录过期'); }, signState: () => assert.fail() });
  await assert.rejects(runDaily(client, '12345', { log: quiet }), /登录过期/);
});
test('revoking a hosted job stops before the next external share action', async () => {
  const events: ShareEvent[] = [];
  const client = mockClient({ tasks: async () => result(['waiting', 'finish', 'finish']), signState: async () => state,
    web: async () => ({ links: [{ link_id: 'article', h_src: 'source' }] }), report: async event => { events.push(event); } });
  await assert.rejects(runDaily(client, '12345', { now, log: quiet, sleep: async () => {},
    checkpoint: async () => { if (events.length) throw new Error('revoked'); } }), /revoked/);
  assert.deepEqual(events.map(event => event.path), ['/share/behavior/show']);
});
test('post selection includes the feed pull parameters required by the API', async () => {
  const candidate = await selectShare(mockClient({ web: async (endpoint, query) => {
    assert.equal(endpoint, '/bbs/app/feeds');
    assert.ok(query);
    assert.equal(query.pull, '1');
    assert.equal(query.last_pull, '1');
    return { links: [{ link_id: 'existing-post', h_src: 'source' }] };
  } }), '1');
  assert.ok(candidate.src === 'link');
  assert.equal(candidate.link_id, 'existing-post');
});
test('game review share uses an existing review author and the canonical share_data path', async () => {
  const candidate = await selectShare(mockClient({ web: async (endpoint, query) => {
    if (endpoint === '/game/all_recommend/v2') return { all_list: [{ appid: 'game', h_src: 'source' }] };
    if (endpoint === '/bbs/app/link/game/comments') return { links: [{ linkid: 'review', userid: 'author' }] };
    assert.equal(endpoint, '/game/comment/share_data/');
    assert.ok(query);
    assert.equal(query.userid, 'author');
    return { comment_detail: { linkid: 'share-review' } };
  } }), '31');
  assert.deepEqual(candidate, { src: 'game_comment', link_id: 'share-review' });
});
