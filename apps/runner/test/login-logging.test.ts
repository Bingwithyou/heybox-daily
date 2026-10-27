import test from 'node:test';
import assert from 'node:assert/strict';
import { runChild } from '../src/process.ts';
import { createLoginLog } from '../src/login-logging.ts';

const key = 'test-login-logging-key-'.repeat(3);
const config = { session: { heybox_id: '-1', pkey: 'private-pkey', device_id: 'private-device', x_xhh_tokenid: 'private-token' },
  device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };
const proof = { ticket: 'private-ticket', randstr: 'private-randstr' };

function environment(values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  const apply = (items: typeof values) => { for (const [name, value] of Object.entries(items)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } };
  apply(values);
  return () => apply(previous);
}
function mockedResponse(value: unknown) {
  return `--import=data:text/javascript,${encodeURIComponent(`globalThis.fetch = async () => Response.json(${JSON.stringify(value)});`)}`;
}

test('phone references require a secret, change with key rotation and cannot be matched to device references', () => {
  const input = { action: 'send', phone: '13800138000', config: { ...config, session: { ...config.session, device_id: '+8613800138000' } } };
  const first = createLoginLog(input, { RUNNER_SERVICE_TOKEN: key })!();
  const rotated = createLoginLog(input, { RUNNER_SERVICE_TOKEN: 'another-key-'.repeat(4) })!();
  assert.match(first.phoneRef!, /^p1_[a-f0-9]{24}$/);
  assert.notEqual(first.phoneRef, rotated.phoneRef);
  assert.notEqual(first.phoneRef!.slice(3), first.deviceRef!.slice(3));
  for (const invalidKey of [undefined, '', 'short-key']) {
    const log = createLoginLog(input, { RUNNER_SERVICE_TOKEN: invalidKey })!();
    assert.equal(log.phoneRef, undefined);
    assert.equal(log.deviceRef, undefined);
    assert.ok(!JSON.stringify(log).includes('13800138000'));
  }
  assert.equal(createLoginLog({ action: 'daily', phone: '13800138000' }), undefined);
});

test('untrusted configuration and unexpected results cannot add raw data to login logs', () => {
  for (const egressIp of ['', 'https://example.test', '203.0.113.8\nprivate-token', 'fe80::1%eth0']) {
    const log = createLoginLog({ action: 'begin', phone: 'private-invalid-phone' }, {
      RUNNER_SERVICE_TOKEN: key, RUNNER_EGRESS_IP: egressIp,
    })!({ status: 'private-unexpected-result', config, pkey: 'private-result-key' });
    assert.equal(log.phoneRef, undefined);
    assert.equal(log.egressIp, undefined);
    assert.equal(log.egressSource, 'unknown');
    assert.equal(log.outcome, undefined);
    for (const secret of ['private-invalid-phone', 'private-token', 'private-unexpected-result', 'private-result-key', 'private-device']) assert.ok(!JSON.stringify(log).includes(secret));
  }
  const ipv6 = createLoginLog({ action: 'begin' }, { RUNNER_EGRESS_IP: ' 2001:0DB8:0:0::8 ' })!();
  assert.equal(ipv6.egressIp, '2001:db8::8');
});

test('successful SMS, CAPTCHA and rejected attempts can be compared by phone and configured egress', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'info', (message: string) => lines.push(message));
  t.mock.method(console, 'warn', (message: string) => lines.push(message));
  const restore = environment({ RUNNER_SERVICE_TOKEN: key, RUNNER_EGRESS_IP: '203.0.113.8', NODE_OPTIONS: mockedResponse({ status: 'ok', result: {} }) });
  try {
    await runChild({ action: 'send', phone: '13800138000', config, proof });
    process.env.NODE_OPTIONS = mockedResponse({ status: 'show_captcha', result: { appid: '1234567890' } });
    await runChild({ action: 'send', phone: '+8613800138000', config, proof });
    process.env.NODE_OPTIONS = mockedResponse({ status: 'failed', msg: '获取验证码过于频繁', result: {} });
    await assert.rejects(runChild({ action: 'send', phone: '13800138000', config, proof }));
    process.env.NODE_OPTIONS = mockedResponse({ status: 'ok', result: {} });
    await runChild({ action: 'send', phone: '13800138001', config: { ...config, session: { ...config.session, device_id: 'another-device' } }, proof });
  } finally { restore(); }
  assert.equal(lines.length, 4);
  const logs = lines.map(line => JSON.parse(line));
  assert.deepEqual(logs.map(log => log.outcome), ['sent', 'captcha', 'failed', 'sent']);
  assert.equal(logs[2].event, 'runner_operation_failed');
  assert.equal(logs[2].category, 'upstream_rate_limit');
  assert.equal(logs[2].diagnostic.endpoint, '/account/get_login_code/');
  assert.equal(logs[0].event, 'runner_operation_completed');
  assert.equal(logs[0].phoneRef, logs[1].phoneRef);
  assert.equal(logs[0].phoneRef, logs[2].phoneRef);
  assert.notEqual(logs[0].phoneRef, logs[3].phoneRef);
  assert.equal(logs[0].deviceRef, logs[1].deviceRef);
  assert.notEqual(logs[0].deviceRef, logs[3].deviceRef);
  assert.equal(new Set(logs.map(log => log.operationId)).size, 4);
  for (const log of logs) {
    assert.match(log.phoneRef, /^p1_[a-f0-9]{24}$/);
    assert.match(log.deviceRef, /^d1_[a-f0-9]{24}$/);
    assert.equal(log.egressIp, '203.0.113.8');
    assert.equal(log.egressSource, 'configured');
    assert.equal(log.hasCaptchaProof, true);
    assert.ok(Number.isFinite(Date.parse(log.startedAt)));
    assert.ok(Number.isInteger(log.durationMs) && log.durationMs >= 0);
  }
  const output = lines.join('\n');
  for (const secret of [key, '13800138000', '13800138001', ...Object.values(config.session).filter(value => value !== '-1'), ...Object.values(proof), 'another-device']) {
    assert.ok(!output.includes(secret), secret);
  }
});

test('authenticated results log only the outcome and references, without account credentials', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'info', (message: string) => lines.push(message));
  const taskResult = { user: { userid: '99887766', level_info: { exp: 100, coin: 200 } }, task_list: [{ title: '每日任务', tasks:
    ['1', '19', '31'].map(id => ({ title: id, state: 'waiting', report_extra: { task_id: id } })) }] };
  const source = `globalThis.fetch = async url => Response.json({status:'ok',result: new URL(url).pathname === '/account/login_code/'
    ? {profile:{heybox_id:'99887766'},account_detail:{userid:'99887766'},pkey:'new-private-pkey'} : ${JSON.stringify(taskResult)}});`;
  const restore = environment({ RUNNER_SERVICE_TOKEN: key, RUNNER_EGRESS_IP: '2001:db8::8', NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(source)}` });
  try { await runChild({ action: 'verify', phone: '13800138000', code: '88776655', config }); }
  finally { restore(); }
  assert.equal(lines.length, 1);
  const log = JSON.parse(lines[0]);
  assert.equal(log.outcome, 'authenticated');
  assert.equal(log.egressIp, '2001:db8::8');
  assert.equal(log.hasCaptchaProof, false);
  for (const secret of ['99887766', '88776655', 'new-private-pkey', 'private-token', 'private-device', '13800138000']) assert.ok(!lines[0].includes(secret));
});

test('timeouts and token failures retain safe phone context even before a device is available', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'warn', (message: string) => lines.push(message));
  const source = `globalThis.fetch = async () => { throw new Error('SDK unavailable'); };`;
  const restore = environment({ RUNNER_SERVICE_TOKEN: key, RUNNER_EGRESS_IP: undefined, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(source)}` });
  try {
    await assert.rejects(runChild({ action: 'begin', phone: '13800138000' }, 1), /超时/);
    await assert.rejects(runChild({ action: 'begin', phone: '+8613800138000' }));
  } finally { restore(); }
  const logs = lines.map(line => JSON.parse(line));
  assert.equal(logs.length, 2);
  assert.match(logs[0].phoneRef, /^p1_[a-f0-9]{24}$/);
  assert.equal(logs[0].phoneRef, logs[1].phoneRef);
  assert.equal(logs[1].category, 'device_token');
  for (const log of logs) {
    assert.equal(log.deviceRef, undefined);
    assert.equal(log.egressIp, undefined);
    assert.equal(log.egressSource, 'unknown');
    assert.equal(log.outcome, 'failed');
  }
});
