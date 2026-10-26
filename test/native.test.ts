import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSignature } from '../dist/native.js';
import { createLoginConfig } from '../dist/login.js';

test('native signing works without Java or Android assets and preserves the caller config', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1793040000000 });
  const config = createLoginConfig('');
  config.session.device_id = 'offline-recovery-probe';
  const before = structuredClone(config);
  const previous = { JAVA_HOME: process.env.JAVA_HOME, HEYBOX_ASSETS: process.env.HEYBOX_ASSETS };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.JAVA_HOME = '/nonexistent-java';
  process.env.HEYBOX_ASSETS = '/nonexistent-assets';
  const result = nativeSignature('///account//login_code', config);
  assert.equal(result._time, '1793040000');
  assert.equal(result.hkey, 'BFDB9883');
  assert.equal(result._rnd, '14:8226521A');
  assert.match(result.nonce, /^[A-Za-z0-9]{32}$/);
  assert.deepEqual(config, before);
});

test('unverified APP builds and shader versions fail before signing', () => {
  for (const field of ['version', 'build', 'shaderVersion'] as const) {
    const config = createLoginConfig('');
    config.app[field] = 'future';
    assert.throws(() => nativeSignature('/account/get_login_code/', config), /原生签名仅支持/);
  }
});
