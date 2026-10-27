import test from 'node:test';
import assert from 'node:assert/strict';
import { getDeviceToken } from '../dist/device-token.js';
import { errorDiagnostic } from '../dist/diagnostics.js';

const token = 'B' + 'a'.repeat(86) + '==';
const source = (script: string) => async () => script;

test('runs the SDK in an isolated browser environment and waits for the server token', async () => {
  const script = `
    if (!/Chrome\\//.test(navigator.userAgent) || navigator.platform !== 'Linux x86_64'
      || navigator.language !== 'zh-CN' || !screen.width || !navigator.hardwareConcurrency) throw new Error('Incomplete browser profile');
    if (!_smConf.organization || !_smConf.publicKey || _smConf.appId !== 'heybox_website') throw new Error('Missing public SDK config');
    const cpu = navigator.hardwareConcurrency;
    SMSdk.getDeviceId = () => 'Dpending';
    setTimeout(() => {
      if (cpu !== navigator.hardwareConcurrency) throw new Error('Profile changed during login');
      SMSdk.getDeviceId = () => '${token}';
      _smReadyFuncs.forEach(callback => callback());
    }, 5);
  `;
  assert.equal(await getDeviceToken({ loadSdk: source(script), timeoutMs: 500 }), token);
});

test('each login initializes fresh storage without reusing another login token', async () => {
  const script = `
    if (localStorage.getItem('previous-login')) throw new Error('Login storage leaked');
    localStorage.setItem('previous-login', 'yes');
    SMSdk.getDeviceId = () => '${token}';
  `;
  for (let i = 0; i < 2; i++) assert.equal(await getDeviceToken({ loadSdk: source(script), timeoutMs: 100 }), token);
});

test('pending and malformed device tokens cannot complete login', async () => {
  for (const invalid of ['', 'Dpending', 'Bshort', 'B' + '!'.repeat(88)]) {
    await assert.rejects(getDeviceToken({ loadSdk: source(`SMSdk.getDeviceId=()=>${JSON.stringify(invalid)}`), timeoutMs: 15 }), error => {
      const diagnostic = errorDiagnostic(error);
      assert.equal(diagnostic.stage, 'wait_token');
      assert.match(diagnostic.cause?.message || '', /超时/);
      return true;
    });
  }
});

test('download, script execution and asynchronous failures retain their stage', async () => {
  const cases = [
    { stage: 'download_sdk', loadSdk: async () => { throw new Error('network unavailable'); }, message: /network unavailable/ },
    { stage: 'execute_sdk', loadSdk: source("throw new Error('SDK initialization failed')"), message: /SDK initialization failed/ },
    { stage: 'wait_token', loadSdk: source("setTimeout(()=>{throw new Error('SDK callback failed')},0)"), message: /SDK callback failed/ },
  ];
  for (const item of cases) {
    await assert.rejects(getDeviceToken({ loadSdk: item.loadSdk, timeoutMs: 100 }), error => {
      const diagnostic = errorDiagnostic(error);
      assert.equal(diagnostic.stage, item.stage);
      assert.match(diagnostic.cause?.message || '', item.message);
      return true;
    });
  }
});

test('changed official SDK bytes fail integrity validation before execution', async () => {
  let calls = 0;
  await assert.rejects(getDeviceToken({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://static.portal101.cn/dist/web/v3.0.0/fp.min.js');
    assert.equal(options?.redirect, 'error');
    return new Response('throw new Error("Unreviewed SDK")');
  } }), error => {
    assert.equal(errorDiagnostic(error).stage, 'sdk_integrity');
    return true;
  });
  assert.equal(calls, 1);
});

test('SDK HTTP failures are surfaced without evaluating response text', async () => {
  await assert.rejects(getDeviceToken({ fetchImpl: async () => new Response('unavailable', { status: 503 }) }), error => {
    const diagnostic = errorDiagnostic(error);
    assert.equal(diagnostic.stage, 'download_sdk');
    assert.match(diagnostic.cause?.message || '', /503/);
    return true;
  });
});
