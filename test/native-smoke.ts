import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { nativeSignature } from '../dist/native.js';

// Run separately inside the built image with --network none and no private volume.
test('the image signs offline without Java, Android assets or account configuration', () => {
  assert.equal(existsSync('/usr/bin/java'), false);
  assert.equal(existsSync('/app/signer'), false);
  assert.equal(existsSync('/app/third-party/heybox-assets'), false);
  const signature = nativeSignature('/account/get_login_code/', {
    session: { heybox_id: '-1', pkey: '', device_id: 'offline-smoke-test', x_xhh_tokenid: '' },
    device: { model: 'PKJ110', osVersion: '17' },
    app: { version: '1.3.398', build: '1142', shaderVersion: '14' },
  });
  assert.match(signature.nonce, /^[A-Za-z0-9]{32}$/);
  assert.match(signature.hkey, /^[0-9A-F]{1,8}$/);
  assert.match(signature._rnd, /^14:[0-9A-F]{1,8}$/);
});
