import test from 'node:test';
import assert from 'node:assert/strict';
import { FingerprintGenerator } from 'fingerprint-generator';
import { getDeviceToken } from '../dist/device-token.js';
import { errorDiagnostic } from '../dist/diagnostics.js';

const token = 'B' + 'a'.repeat(86) + '==';
const source = (script: string) => async () => script;

for (const platform of ['Linux x86_64', 'Linux armv81']) {
  test(`runs the SDK with ${platform} and waits for the server token`, async t => {
    const profile = new FingerprintGenerator().getFingerprint({
      browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['linux'], locales: ['zh-CN', 'zh'],
    });
    profile.fingerprint.navigator.platform = platform;
    const generated = t.mock.method(FingerprintGenerator.prototype, 'getFingerprint', (options: Parameters<FingerprintGenerator['getFingerprint']>[0]) => {
      assert.deepEqual(options, {
        browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['linux'], locales: ['zh-CN', 'zh'],
      });
      return profile;
    });
    const { navigator, screen } = profile.fingerprint;
    const script = `
      if (navigator.userAgent !== ${JSON.stringify(navigator.userAgent)} || navigator.platform !== '${platform}'
        || navigator.language !== ${JSON.stringify(navigator.language)} || screen.width !== ${screen.width}
        || navigator.hardwareConcurrency !== ${navigator.hardwareConcurrency}) throw new Error('Incomplete browser profile');
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
    assert.equal(generated.mock.callCount(), 1, 'generate one stable profile per login');
  });
}

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
