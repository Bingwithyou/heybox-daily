import test from 'node:test';
import assert from 'node:assert/strict';
import { activityTransport, createActivityFetch, createDailyFetch, createLoginFetch, dailyTransport, loginRelayConfig } from '../src/login-relay.ts';
import { loginStep } from '../src/login.ts';
import { handle } from '../../login-relay/src/worker.ts';

const env = { LOGIN_RELAY_URL: 'https://relay.example', LOGIN_RELAY_TOKEN: 'relay-private-fixture-'.repeat(3) };
const config = { session: { heybox_id: '-1', pkey: '', device_id: 'same-device', x_xhh_tokenid: 'private-device-token' },
  device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };
const proof = { ticket: 'real-shaped-ticket', randstr: 'real-shaped-randstr' };
const taskResult = { user: { userid: '12345', level_info: { exp: 100, coin: 200 } }, task_list: [{ title: '每日任务', tasks:
  ['1', '19', '31'].map(id => ({ title: id, state: 'waiting', report_extra: { task_id: id } })) }] };

test('activity transport validates configuration and never retries a possibly accepted join', async () => {
  const direct: typeof fetch = async () => Response.json({});
  assert.equal(activityTransport({}), 'direct');
  assert.equal(createActivityFetch(env, direct), direct);
  assert.throws(() => createActivityFetch({ ACTIVITY_TRANSPORT: 'worker' }), /ACTIVITY_TRANSPORT/);
  assert.throws(() => createActivityFetch({ ...env, ACTIVITY_TRANSPORT: 'invalid' }), /ACTIVITY_TRANSPORT/);
  let calls = 0;
  const relay = createActivityFetch({ ...env, ACTIVITY_TRANSPORT: 'worker' }, async (url, options) => {
    calls++; assert.equal(String(url), env.LOGIN_RELAY_URL + '/relay');
    assert.equal(JSON.parse(String(options?.body)).body, 'award_id=123');
    throw new Error('response lost after acceptance');
  });
  await assert.rejects(relay('https://api.xiaoheihe.cn/store/roll_room_v2/join', { method: 'POST', body: 'award_id=123' }));
  assert.equal(calls, 1);
});

test('relay config is optional, paired, HTTPS and origin-only', () => {
  assert.equal(loginRelayConfig({}), undefined);
  for (const value of [{ LOGIN_RELAY_URL: env.LOGIN_RELAY_URL }, { LOGIN_RELAY_TOKEN: env.LOGIN_RELAY_TOKEN },
    { ...env, LOGIN_RELAY_TOKEN: 'short' }, ...['http://relay.example', 'https://user@relay.example',
      'https://relay.example/other', 'https://relay.example?token=private', 'https://relay.example#private'].map(LOGIN_RELAY_URL => ({ ...env, LOGIN_RELAY_URL }))]) {
    assert.throws(() => loginRelayConfig(value), /LOGIN_RELAY/);
  }
  assert.equal(loginRelayConfig(env)?.url, env.LOGIN_RELAY_URL);
});

test('daily relay is explicitly enabled and never silently falls back when misconfigured', async () => {
  const direct: typeof fetch = async () => Response.json({ direct: true });
  assert.equal(dailyTransport({}), 'direct');
  assert.equal(createDailyFetch(env, direct), direct);
  assert.throws(() => createDailyFetch({ DAILY_TRANSPORT: 'worker' }, direct), /DAILY_TRANSPORT/);
  assert.throws(() => createDailyFetch({ ...env, DAILY_TRANSPORT: 'typo' }, direct), /DAILY_TRANSPORT/);
  let calls = 0;
  const relay = createDailyFetch({ ...env, DAILY_TRANSPORT: 'worker' }, async (url, options) => {
    calls++; assert.equal(String(url), env.LOGIN_RELAY_URL + '/relay');
    const value = JSON.parse(String(options?.body));
    assert.equal(value.url, 'https://data.xiaoheihe.cn/account/data_report/?fixture=1');
    assert.equal(value.body, 'data=encrypted%2Bvalue');
    return new Response(null, { status: 403 });
  });
  const response = await relay('https://data.xiaoheihe.cn/account/data_report/?fixture=1', {
    method: 'POST', body: 'data=encrypted%2Bvalue',
  });
  assert.equal(response.status, 403); assert.equal(calls, 1);
});

test('unconfigured transport retains direct fetch; configured transport preserves body and cancellation', async () => {
  const upstream = 'https://api.xiaoheihe.cn/account/get_login_code/?nonce=1';
  const controller = new AbortController();
  let calls = 0;
  const direct: typeof fetch = async url => { calls++; assert.equal(url, upstream); return Response.json({}); };
  await createLoginFetch({}, direct)(upstream); assert.equal(calls, 1);
  const relayed = createLoginFetch(env, async (url, options) => {
    assert.equal(String(url), env.LOGIN_RELAY_URL + '/relay');
    assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${env.LOGIN_RELAY_TOKEN}`);
    assert.equal(options?.redirect, 'error'); assert.equal(options?.signal, controller.signal);
    const value = JSON.parse(String(options?.body));
    assert.equal(value.url, upstream); assert.equal(value.body, 'phone_num=a%2Bb');
    assert.equal(value.headers.cookie, 'fixture'); return Response.json({ status: 'ok' });
  });
  await relayed(upstream, { method: 'POST', body: new URLSearchParams({ phone_num: 'a+b' }),
    headers: { cookie: 'fixture' }, signal: controller.signal });
});

test('transport failure never retries or falls back to the original destination and hides URL/token', async () => {
  let calls = 0;
  const relay = createLoginFetch(env, async url => { calls++; assert.equal(String(url), env.LOGIN_RELAY_URL + '/relay');
    throw Error(`network ${env.LOGIN_RELAY_TOKEN} https://private.test/?code=1234`); });
  await assert.rejects(relay('https://api.xiaoheihe.cn/account/get_login_code/'), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('private')); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(calls, 1);
});

test('Runner sends CAPTCHA proof through the real relay handler and resumes verification without resending SMS', async t => {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), env.LOGIN_RELAY_URL + '/relay');
    return handle(new Request(String(url), options), env, async (target, upstream) => {
      const parsed = new URL(String(target)); paths.push(parsed.pathname);
      assert.match(new Headers(upstream?.headers).get('cookie')!, /x_xhh_tokenid=private-device-token/);
      if (parsed.pathname === '/task/list_v2/') return Response.json({ status: 'ok', result: taskResult });
      assert.equal(parsed.searchParams.get('imei'), 'same-device');
      if (!parsed.searchParams.has('ticket')) return Response.json({ status: 'show_captcha', result: { appid: '2061805035' } });
      assert.equal(parsed.searchParams.get('ticket'), proof.ticket);
      assert.equal(parsed.searchParams.get('randstr'), proof.randstr);
      if (parsed.pathname === '/account/get_login_code/') return Response.json({ status: 'ok', result: {} });
      assert.equal(parsed.searchParams.get('code'), '1234');
      return Response.json({ status: 'ok', result: { profile: { heybox_id: '12345' },
        account_detail: { userid: '12345' }, pkey: 'new-private-pkey' } });
    });
  });
  const sent = await loginStep({ action: 'send', phone: '13800138000', config, proof });
  assert.equal(sent.status, 'sent');
  const challenge = await loginStep({ action: 'verify', phone: '13800138000', config, code: '1234' });
  assert.equal(challenge.status, 'captcha');
  const done = await loginStep({ action: 'verify', phone: '13800138000', config, code: '1234', proof });
  assert.equal(done.status, 'authenticated'); assert.equal(done.config.session.pkey, 'new-private-pkey');
  assert.deepEqual(paths, ['/account/get_login_code/', '/account/login_code/', '/account/login_code/', '/task/list_v2/']);
});
