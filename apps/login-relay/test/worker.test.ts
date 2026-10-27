import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker.ts';

const env = { LOGIN_RELAY_TOKEN: 'relay-fixture-'.repeat(4) };
const input = { url: 'https://api.xiaoheihe.cn/account/get_login_code/?nonce=fixture', method: 'POST',
  headers: { cookie: 'pkey=fixture; x_xhh_tokenid=fixture', 'content-type': 'application/x-www-form-urlencoded',
    authorization: 'must-not-forward', 'x-forwarded-for': '192.0.2.1' }, body: 'phone_num=encrypted%2Bvalue' };
const request = (value: unknown = input, token = env.LOGIN_RELAY_TOKEN) => new Request('https://relay.example/relay', {
  method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(value),
});
const never = async (): Promise<Response> => assert.fail('upstream must not be called');

test('requires configured authentication before reading the body or calling upstream', async () => {
  assert.equal((await handle(request(), { LOGIN_RELAY_TOKEN: '' }, never)).status, 503);
  assert.equal((await handle(request(input, 'wrong'), env, never)).status, 401);
  assert.equal((await handle(new Request('https://relay.example/relay', { headers: {
    authorization: `Bearer ${env.LOGIN_RELAY_TOKEN}` } }), env, never)).status, 405);
});

test('restricts origin, credentials, path, method, body and streaming body size', async () => {
  for (const value of [
    { ...input, url: 'http://api.xiaoheihe.cn/account/get_login_code/' },
    { ...input, url: 'https://api.xiaoheihe.cn.evil.test/account/get_login_code/' },
    { ...input, url: 'https://private@api.xiaoheihe.cn/account/get_login_code/' },
    { ...input, url: 'https://api.xiaoheihe.cn:8443/account/get_login_code/' },
    { ...input, url: 'https://api.xiaoheihe.cn/account/get_login_code/#private' },
    { ...input, url: 'https://api.xiaoheihe.cn/task/sign_v3/sign' },
    { ...input, method: 'GET' }, { ...input, body: {} },
    { ...input, headers: null },
    { ...input, url: 'https://api.xiaoheihe.cn/task/list_v2/', method: 'GET' },
  ]) assert.equal((await handle(request(value), env, never)).status, 400);
  const large = new Request('https://relay.example/relay', { method: 'POST', headers: {
    authorization: `Bearer ${env.LOGIN_RELAY_TOKEN}` }, body: 'x'.repeat(32769) });
  assert.equal((await handle(large, env, never)).status, 413);
});

test('preserves signed query, CAPTCHA proof, form body and needed headers without forwarding service headers', async () => {
  const value = { ...input, url: input.url + '&captcha_type=confirm&ticket=fixture%2Bticket&randstr=fixture' };
  let calls = 0;
  const result = await handle(request(value), env, async (url, options) => {
    calls++; assert.equal(String(url), value.url); assert.equal(options?.body, input.body);
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('cookie'), input.headers.cookie);
    assert.equal(headers.get('authorization'), null); assert.equal(headers.get('x-forwarded-for'), null);
    assert.equal(options?.redirect, 'manual');
    return Response.json({ status: 'show_captcha', result: { appid: '2061805035' } });
  });
  assert.deepEqual(await result.json(), { status: 'show_captcha', result: { appid: '2061805035' } });
  assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(calls, 1);
});

test('daily endpoints require the exact origin and method and preserve signed requests', async () => {
  const endpoints = [
    ['api.xiaoheihe.cn', '/task/sign_v3/sign', 'GET'],
    ['api.xiaoheihe.cn', '/bbs/app/feeds', 'GET'],
    ['api.xiaoheihe.cn', '/game/all_recommend/v2', 'GET'],
    ['api.xiaoheihe.cn', '/bbs/app/link/game/comments', 'GET'],
    ['api.xiaoheihe.cn', '/game/comment/share_data/', 'GET'],
    ['data.xiaoheihe.cn', '/account/data_report/', 'POST'],
    ['api.xiaoheihe.cn', '/store/roll_room_v2/room_list', 'GET'],
    ['api.xiaoheihe.cn', '/store/roll_room_v2/get_home_info', 'GET'],
    ['api.xiaoheihe.cn', '/bbs/app/profile/user/profile', 'GET'],
    ['api.xiaoheihe.cn', '/store/roll_room_v2/data_report', 'POST'],
    ['api.xiaoheihe.cn', '/bbs/app/profile/follow/user', 'POST'],
    ['api.xiaoheihe.cn', '/store/roll_room_v2/join', 'POST'],
  ];
  for (const [host, path, method] of endpoints) {
    const value = { ...input, url: `https://${host}${path}?hkey=fixture%2Bsignature&time=123`, method,
      body: method === 'POST' ? 'data=encrypted%2Breport&key=fixture&sid=fixture' : null };
    let calls = 0;
    const response = await handle(request(value), env, async (url, options) => {
      calls++; assert.equal(String(url), value.url); assert.equal(options?.method, method);
      assert.equal(options?.body, value.body ?? undefined);
      assert.equal(new Headers(options?.headers).get('cookie'), input.headers.cookie);
      assert.equal(new Headers(options?.headers).get('authorization'), null);
      return Response.json({ status: 'ok', result: {} });
    });
    assert.equal(response.status, 200); assert.equal(calls, 1);
    const otherHost = host === 'api.xiaoheihe.cn' ? 'data.xiaoheihe.cn' : 'api.xiaoheihe.cn';
    assert.equal((await handle(request({ ...value, url: value.url.replace(host, otherHost) }), env, never)).status, 400);
    assert.equal((await handle(request({ ...value, method: method === 'GET' ? 'POST' : 'GET', body: method === 'GET' ? '' : null }), env, never)).status, 400);
  }
});

test('forwards upstream HTTP errors and does not follow redirects, retry, or expose errors', async () => {
  const rejected = await handle(request(), env, async () => Response.json({ status: 'failed' }, { status: 429 }));
  assert.equal(rejected.status, 429); assert.deepEqual(await rejected.json(), { status: 'failed' });
  const redirected = await handle(request(), env, async () => new Response(null, {
    status: 302, headers: { location: 'https://private.example/' } }));
  assert.equal(redirected.status, 502); assert.equal(redirected.headers.get('location'), null);
  let calls = 0;
  const unavailable = await handle(request(), env, async () => { calls++; throw Error('private-token'); });
  assert.equal(unavailable.status, 502); assert.equal(calls, 1);
  assert.ok(!(await unavailable.text()).includes('private-token'));
});
