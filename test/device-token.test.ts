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

test('SDK errors reject before a later token can hide the failure', async () => {
  for (const sdkCode of [-1, -2, -3, -4]) {
    await assert.rejects(getDeviceToken({ loadSdk: source(`
      setTimeout(() => {
        _smConf.onError(${sdkCode});
        SMSdk.getDeviceId = () => '${token}';
        _smReadyFuncs.forEach(callback => callback());
      }, 0);
    `), timeoutMs: 500 }), error => {
      const diagnostic = errorDiagnostic(error);
      assert.equal(diagnostic.stage, sdkCode === -4 ? 'sdk_error' : 'request_token');
      assert.equal(diagnostic.sdkCode, sdkCode);
      assert.ok(!diagnostic.message.includes('超时'));
      return true;
    });
  }
});

test('device-service failures retain only numeric response diagnostics without sending requests', async () => {
  for (const fixture of [
    { httpStatus: 0, sdkCode: -1, upstreamCode: undefined },
    { httpStatus: 503, sdkCode: -2, upstreamCode: undefined },
    { httpStatus: 429, sdkCode: -2, upstreamCode: undefined },
    { httpStatus: 200, sdkCode: -3, upstreamCode: '1902' },
  ]) {
    await assert.rejects(getDeviceToken({ loadSdk: source(`
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://fp-it.portal101.cn/deviceprofile/v4?token=private-query');
      Object.defineProperties(xhr, {
        readyState: { value: 4 }, status: { value: ${fixture.httpStatus} },
        response: { value: ${JSON.stringify({ code: fixture.upstreamCode, message: 'private-message', detail: { deviceId: 'private-device' } })} },
      });
      xhr.dispatchEvent(new Event('readystatechange'));
      _smConf.onError(${fixture.sdkCode});
    `), timeoutMs: 500 }), error => {
      const diagnostic = errorDiagnostic(error);
      assert.equal(diagnostic.stage, 'request_token');
      assert.equal(diagnostic.sdkCode, fixture.sdkCode);
      assert.equal(diagnostic.httpStatus, fixture.httpStatus);
      assert.equal(diagnostic.upstreamCode, fixture.upstreamCode ? Number(fixture.upstreamCode) : undefined);
      assert.ok(Number.isInteger(diagnostic.requestDurationMs) && diagnostic.requestDurationMs! >= 0);
      assert.ok(!JSON.stringify(diagnostic).includes('private-'));
      return true;
    });
  }
});

test('unrelated requests and unrecognized SDK error values cannot leak into diagnostics', async () => {
  await assert.rejects(getDeviceToken({ loadSdk: source(`
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://unrelated.example/private?token=private-query');
    Object.defineProperties(xhr, {
      readyState: { value: 4 }, status: { value: 503 }, response: { value: { code: 1902 } },
    });
    xhr.dispatchEvent(new Event('readystatechange'));
    _smConf.onError({ message: 'private-error', token: 'private-token' });
  `), timeoutMs: 500 }), error => {
    const diagnostic = errorDiagnostic(error);
    assert.equal(diagnostic.stage, 'sdk_error');
    assert.equal(diagnostic.sdkCode, undefined);
    assert.equal(diagnostic.httpStatus, undefined);
    assert.equal(diagnostic.upstreamCode, undefined);
    assert.ok(!JSON.stringify(diagnostic).includes('private-'));
    return true;
  });
});

test('nonnumeric response codes are omitted from device-service diagnostics', async () => {
  await assert.rejects(getDeviceToken({ loadSdk: source(`
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://fp-it.portal101.cn/deviceprofile/v4');
    Object.defineProperties(xhr, {
      readyState: { value: 4 }, status: { value: 200 },
      response: { value: { code: 'private-code', message: 'private-message' } },
    });
    xhr.dispatchEvent(new Event('readystatechange'));
    _smConf.onError(-3);
  `), timeoutMs: 500 }), error => {
    const diagnostic = errorDiagnostic(error);
    assert.equal(diagnostic.httpStatus, 200);
    assert.equal(diagnostic.upstreamCode, undefined);
    assert.ok(!JSON.stringify(diagnostic).includes('private-'));
    return true;
  });
});
