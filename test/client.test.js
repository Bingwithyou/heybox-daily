import test from 'node:test';
import assert from 'node:assert/strict';
import { HeyboxApiError, HeyboxClient } from '../dist/client.js';
import { validateConfig } from '../dist/config.js';
import { webSignature } from '../dist/signature.js';
import { androidBase64, shareEvent, encryptReport } from '../dist/report.js';
import { createHash } from 'node:crypto';

const config = { session: { heybox_id: '12345', pkey: 'secret', x_xhh_tokenid: 'device-token', device_id: 'device' },
  device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };

test('Web signature matches protocol vectors and normalizes repeated slashes', () => {
  assert.equal(webSignature('/task/list_v2/', 1793012400, '0123456789ABCDEF0123456789ABCDEF').hkey, '1I7SX12');
  assert.equal(webSignature('///game/comment/share_data', 1793012420, 'ABCDEF0123456789ABCDEF0123456789').hkey, 'UZ0ZZ44');
  assert.equal(webSignature('/account/data_report/', 1700000000, '00000000000000000000000000000000').hkey, '0TUZ223');
});
test('Android base64 includes line breaks and the final newline used by sid', () => {
  const encoded = androidBase64(Buffer.alloc(60));
  assert.deepEqual(encoded.split('\n').map(s => s.length), [76, 4, 0]);
  const payload = encryptReport([], '1700000000');
  const md5 = value => createHash('md5').update(value).digest('hex');
  assert.equal(payload.sid, md5(payload.key + payload.time) + md5(payload.data));
});
test('share show and tap use distinct event types and platform fields', () => {
  const addition = { src: 'game_comment', link_id: 'test' };
  assert.equal(shareEvent('show', addition, 'session').addition.plat, undefined);
  assert.equal(shareEvent('tap', addition, 'session').type, '4');
  assert.equal(shareEvent('success', addition, 'session').addition.plat, 'WechatSession');
  assert.throws(() => shareEvent('publish', addition, 'session'));
});
test('APP WebView profile and aliases are retained, redirects are disabled', async () => {
  const client = new HeyboxClient(config, { fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'api.xiaoheihe.cn');
    assert.equal(parsed.searchParams.get('x_app'), 'heybox');
    assert.equal(parsed.searchParams.get('x_os_type'), 'Android');
    assert.match(options.headers.Cookie, /x_pkey=secret/);
    assert.equal(options.redirect, 'error');
    return Response.json({ status: 'ok', result: { valid: true } });
  } });
  assert.deepEqual(await client.tasks(), { valid: true });
});
test('HTTP errors, expired login and malformed replies cannot be mistaken for success', async () => {
  for (const response of [new Response('private data', { status: 500 }), Response.json({ status: 'relogin', msg: 'secret' }), Response.json({ status: 'failed', msg: 'secret' }), new Response('not JSON')]) {
    const client = new HeyboxClient(config, { fetchImpl: async () => response });
    await assert.rejects(client.tasks(), error => !error.message.includes('secret') && !error.message.includes('private data'));
  }
});
test('invalid credentials and unsupported versions fail before network calls', () => {
  assert.equal(validateConfig(structuredClone(config)).app.version, '1.3.398');
  const invalid = structuredClone(config); invalid.session.pkey += '\r\nCookie: injected';
  assert.throws(() => validateConfig(invalid));
  const version = structuredClone(config); version.app.version = 'future';
  assert.throws(() => validateConfig(version), /配套资源/);
});

test('login error categories are useful without exposing raw service messages', () => {
  const wrong = new HeyboxApiError('/account/login_code/', 'failed', '验证码错误，private-value');
  assert.equal(wrong.retryCode, true);
  assert.ok(!wrong.message.includes('private-value'));
  for (const detail of ['验证码已过期 private-value', '请求过于频繁 private-value']) {
    const error = new HeyboxApiError('/account/login_code/', 'failed', detail);
    assert.equal(error.retryCode, false);
    assert.ok(!error.message.includes('private-value'));
  }
});
