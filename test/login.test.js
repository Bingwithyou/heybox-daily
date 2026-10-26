import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { HeyboxApiError, HeyboxClient } from '../dist/client.js';
import { saveConfig } from '../dist/config.js';
import { createLoginConfig, encryptPhone, normalizePhone, runSmsLogin } from '../dist/login.js';

const token = 'B' + 'a'.repeat(88);
const taskResult = { user: { userid: '12345', level_info: { exp: 100, coin: 200 } }, task_list: [{ title: '每日任务', tasks:
  ['1', '19', '31'].map(id => ({ title: id, state: 'waiting', report_extra: { task_id: id } })) }] };
const loginResult = { profile: { heybox_id: '12345' }, account_detail: { userid: '12345' }, pkey: 'new-private-key' };

function fixture(overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'heybox-login-'));
  const file = path.join(directory, 'config.json');
  writeFileSync(file, 'existing configuration', { mode: 0o600 });
  const questions = []; const logs = []; const requests = []; const answers = ['13800138000', '1234'];
  const options = {
    file, preflight: () => {}, getDeviceToken: async () => token,
    ask: async question => { questions.push(question); return answers.shift(); }, log: message => logs.push(message),
    clientFactory: config => ({
      native: async (endpoint, extra, body) => {
        requests.push({ endpoint, config, extra, body });
        if (endpoint === '/account/get_login_code/') return { remain_time: 60, not_register: 1 };
        return structuredClone(loginResult);
      },
      tasks: async () => taskResult,
      signState: async () => ({ state: 'ok', signed_date: 1 }),
    }),
    ...overrides,
  };
  return { directory, file, questions, logs, requests, options, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('phone validation happens before a request and RSA uses the Android wire format', () => {
  assert.equal(normalizePhone(' 13800138000 '), '+8613800138000');
  assert.equal(normalizePhone('+8613800138000'), '+8613800138000');
  assert.throws(() => normalizePhone('13800138000\nextra'), /手机号/);
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const encrypted = encryptPhone('+8613800138000', publicKey.export({ type: 'spki', format: 'pem' }).toString());
  assert.deepEqual(encrypted.split('\n').map(line => line.length), [76, 76, 20, 0]);
  const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(encrypted, 'base64'));
  assert.equal(block[1], 2);
  assert.equal(block.subarray(block.indexOf(0, 2) + 1).toString(), '+8613800138000');
});

test('native form requests keep device token without requiring an account pkey', async () => {
  const config = createLoginConfig(token);
  const client = new HeyboxClient(config, { signer: () => ({ hkey: 'signed', _rnd: '14:1', nonce: 'nonce', _time: '1' }), fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('heybox_id'), '-1');
    assert.equal(parsed.searchParams.get('code'), '1234');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Cookie, `pkey=; x_xhh_tokenid=${token}`);
    assert.equal(options.body.get('phone_num'), 'encrypted');
    return Response.json({ status: 'ok', result: loginResult });
  } });
  await client.native('/account/login_code/', { code: '1234' }, new URLSearchParams({ phone_num: 'encrypted' }));
});

test('SMS login starts anonymously, sends once and persists only after readback', async () => {
  const f = fixture();
  try {
    await runSmsLogin(f.options);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].config.session.heybox_id, '-1');
    assert.equal(f.requests[0].config.session.pkey, '');
    assert.equal(f.requests[0].config.session.x_xhh_tokenid, token);
    assert.equal(f.requests[1].extra.code, '1234');
    assert.equal(f.requests[1].extra.is_new_device, '1');
    assert.equal(f.questions.length, 2);
    const saved = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.equal(saved.session.pkey, 'new-private-key');
    assert.equal(saved.session.heybox_id, '12345');
    assert.equal(statSync(f.file).mode & 0o777, 0o600);
    assert.ok(!readFileSync(f.file, 'utf8').includes('13800138000'));
    assert.ok(f.logs.every(line => !line.includes('1234') && !line.includes('new-private-key')));
  } finally { f.cleanup(); }
});

test('SDK failure sends no SMS and preserves the existing config', async () => {
  const f = fixture({ getDeviceToken: async () => { throw new Error('SDK unavailable'); } });
  try {
    await assert.rejects(runSmsLogin(f.options), /SDK unavailable/);
    assert.equal(f.requests.length, 0);
    assert.equal(readFileSync(f.file, 'utf8'), 'existing configuration');
  } finally { f.cleanup(); }
});

test('verification failure cannot replace an existing configuration', async () => {
  const f = fixture({ clientFactory: () => ({ native: async endpoint => endpoint.includes('get_login_code') ? {} : loginResult,
    tasks: async () => { throw new Error('readback failed'); }, signState: async () => ({}) }) });
  try {
    await assert.rejects(runSmsLogin(f.options), /readback failed/);
    assert.equal(readFileSync(f.file, 'utf8'), 'existing configuration');
  } finally { f.cleanup(); }
});

test('a rejected code can be corrected in the same session without another SMS', async () => {
  let sends = 0; let attempts = 0; const devices = []; const answers = ['13800138000', '1111', '2222'];
  const f = fixture({ ask: async () => answers.shift(), clientFactory: config => ({
    native: async endpoint => {
      if (endpoint.includes('get_login_code')) { sends++; return {}; }
      devices.push(config.session.device_id);
      if (++attempts === 1) throw new HeyboxApiError('/account/login_code/', 'failed', '验证码错误');
      return loginResult;
    }, tasks: async () => taskResult, signState: async () => ({ state: 'ok', signed_date: 1 }),
  }) });
  try {
    await runSmsLogin(f.options);
    assert.equal(sends, 1);
    assert.equal(attempts, 2);
    assert.equal(new Set(devices).size, 1);
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).session.pkey, 'new-private-key');
  } finally { f.cleanup(); }
});

test('cancelling or exhausting code attempts preserves config and never resends SMS', async () => {
  for (const codes of [[''], ['1111', '2222', '3333']]) {
    let sends = 0; let attempts = 0; const answers = ['13800138000', ...codes];
    const f = fixture({ ask: async () => answers.shift(), clientFactory: () => ({ native: async endpoint => {
      if (endpoint.includes('get_login_code')) { sends++; return {}; }
      attempts++;
      throw new HeyboxApiError('/account/login_code/', 'failed', '验证码错误');
    } }) });
    try {
      await assert.rejects(runSmsLogin(f.options));
      assert.equal(sends, 1);
      assert.equal(attempts, codes[0] ? 3 : 0);
      assert.equal(readFileSync(f.file, 'utf8'), 'existing configuration');
    } finally { f.cleanup(); }
  }
});

test('wrong account fields and rejected verification codes never persist a session', async () => {
  for (const mode of ['mismatch', 'expired']) {
    const f = fixture({ clientFactory: () => ({ native: async endpoint => {
      if (endpoint.includes('get_login_code')) return {};
      if (mode === 'expired') throw new Error('expired');
      return { ...loginResult, account_detail: { userid: 'different' } };
    } }) });
    try {
      await assert.rejects(runSmsLogin(f.options));
      assert.equal(readFileSync(f.file, 'utf8'), 'existing configuration');
    } finally { f.cleanup(); }
  }
});

test('invalid config is rejected before touching the target file', () => {
  const f = fixture();
  try {
    assert.throws(() => saveConfig(createLoginConfig(token), f.file));
    assert.equal(readFileSync(f.file, 'utf8'), 'existing configuration');
  } finally { f.cleanup(); }
});
