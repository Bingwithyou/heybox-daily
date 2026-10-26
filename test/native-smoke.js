import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSignature } from '../dist/native.js';

// Run separately inside the built image with --network none and no private volume.
test('the image signs offline with bundled assets and no account configuration', () => {
  const signature = nativeSignature('/account/get_login_code/', {
    session: { heybox_id: '-1', pkey: '', device_id: 'offline-smoke-test', x_xhh_tokenid: '' },
    device: { model: 'PKJ110', osVersion: '17' },
    app: { version: '1.3.398', build: '1142', shaderVersion: '14' },
  });
  assert.match(signature.nonce, /^[A-Za-z0-9]{32}$/);
  assert.match(signature.hkey, /^[0-9A-F]{1,8}$/);
  assert.match(signature._rnd, /^14:[0-9A-F]{1,8}$/);
});
