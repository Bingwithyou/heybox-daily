import test from 'node:test';
import assert from 'node:assert/strict';
import { errorDiagnostic } from '../dist/diagnostics.js';
import { HeyboxApiError, HeyboxClient } from '../dist/client.js';
import { DeviceTokenError } from '../dist/device-token.js';

test('API diagnostics preserve rejection reasons but redact credentials and request parameters', () => {
  const error = new HeyboxApiError('/account/login_code/', 'failed',
    '验证码 123456 错误，phone=+8613800138000 pkey=private-key ticket=proof-secret https://api.xiaoheihe.cn/login?code=123456&token=token-secret');
  const diagnostic = errorDiagnostic(error, ['123456', 'private-key', 'proof-secret', 'token-secret']);
  assert.equal(diagnostic.endpoint, '/account/login_code/');
  assert.equal(diagnostic.status, 'failed');
  assert.match(diagnostic.upstreamMessage!, /验证码.*错误/);
  const text = JSON.stringify(diagnostic);
  for (const secret of ['123456', '13800138000', 'private-key', 'proof-secret', 'token-secret', '?code=']) assert.ok(!text.includes(secret), secret);
  assert.ok(!error.message.includes('private-key'));
});

test('diagnostics retain network causes and bound cyclic or oversized errors', async () => {
  const config = { session: { heybox_id: '12345', pkey: 'secret', x_xhh_tokenid: 'device-token', device_id: 'device' },
    device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };
  const cause = Object.assign(new Error('connect timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  const client = new HeyboxClient(config, { fetchImpl: async () => { throw new TypeError('fetch failed', { cause }); } });
  await assert.rejects(client.tasks(), error => {
    const diagnostic = errorDiagnostic(error);
    assert.equal(diagnostic.cause?.cause?.code, 'UND_ERR_CONNECT_TIMEOUT');
    return true;
  });
  const cyclic = new Error('x'.repeat(5000)); cyclic.cause = cyclic;
  assert.ok(JSON.stringify(errorDiagnostic(cyclic)).length < 2500);
  assert.ok(!JSON.stringify(errorDiagnostic({ secret: 'private-value' })).includes('private-value'));
});

test('diagnostics redact encoded proofs, cookie headers and credentials in nested causes', () => {
  const proof = 'private+proof/with=padding';
  const error = new Error(`ticket=${encodeURIComponent(proof)}\nCookie: pkey=private-key; token=private-token`, {
    cause: new Error(`验证码：123456，连接失败，${proof}`),
  });
  const text = JSON.stringify(errorDiagnostic(error, [proof, '123456']));
  for (const secret of [proof, encodeURIComponent(proof), '123456', 'private-key', 'private-token']) assert.ok(!text.includes(secret));
  assert.match(text, /连接失败/);
});

test('device-token diagnostics project only bounded numeric error metadata', () => {
  const valid = new DeviceTokenError('request_token', '设备令牌服务拒绝请求', undefined, {
    sdkCode: -3, httpStatus: 200, upstreamCode: 1902, requestDurationMs: 35,
  });
  assert.deepEqual(errorDiagnostic(valid), {
    name: 'Error', message: '设备令牌服务拒绝请求', stage: 'request_token',
    sdkCode: -3, httpStatus: 200, upstreamCode: 1902, requestDurationMs: 35,
  });
  const invalid = new DeviceTokenError('sdk_error', '设备令牌服务失败', undefined, {
    sdkCode: 'private-code', httpStatus: 999, upstreamCode: 13800138000,
    requestDurationMs: 'private-value', response: { token: 'private-token' },
  } as never);
  assert.deepEqual(errorDiagnostic(invalid), {
    name: 'Error', message: '设备令牌服务失败', stage: 'sdk_error',
  });
});
