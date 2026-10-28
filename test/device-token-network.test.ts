import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import https, { request } from 'node:https';
import { observeTokenNetwork } from '../dist/device-token-network.js';
import { getDeviceToken, prepareDeviceToken, DeviceTokenError } from '../dist/device-token.js';

test('stalled TLS is aborted by its own connection deadline and exposes only phase and error code', async t => {
  const server = createServer();
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(r => server.close(() => r())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const details: object[] = [];
  const observer = observeTokenNetwork(value => details.push(value), undefined, 30);
  const otherDetails: object[] = [];
  const other = observeTokenNetwork(value => otherDetails.push(value), undefined, 10);
  try {
    const error = await observer.run(() => new Promise<NodeJS.ErrnoException>(resolve => {
      const req = request(`https://127.0.0.1:${address.port}/deviceprofile/v4`, {
        method: 'POST', headers: { host: 'fp-it.portal101.cn' },
      });
      req.once('error', resolve); req.end('{}');
    }));
    assert.equal(error.code, 'ETIMEDOUT');
    assert.deepEqual(details.at(-1), { networkCode: 'ETIMEDOUT', networkPhase: 'tls' });
    assert.deepEqual(otherDetails, [], 'another SDK context cannot observe or abort this request');
  } finally { observer.close(); other.close(); }
});

test('SDK requests started by DOM load inherit the connection deadline and network diagnostics', async t => {
  await prepareDeviceToken();
  const server = createServer(); const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(r => server.close(() => r())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.mock.method(https, 'request', ((options: https.RequestOptions, callback?: (res: import('node:http').IncomingMessage) => void) => {
    assert.equal(options.hostname, 'fp-it.portal101.cn');
    return request({ ...options, hostname: '127.0.0.1', port: address.port, agent: false,
      headers: { ...options.headers, host: 'fp-it.portal101.cn' } }, callback);
  }) as typeof https.request);
  const timings: Record<string, number> = {};
  await assert.rejects(getDeviceToken({ connectTimeoutMs: 30, timeoutMs: 400,
    onTiming: (stage, value) => { timings[stage] = value; },
    loadSdk: async () => `window.addEventListener('load', () => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://fp-it.portal101.cn/deviceprofile/v4');
      xhr.onerror = () => _smConf.onError(-1);
      xhr.send('{}');
    });`,
  }), error => {
    assert.ok(error instanceof DeviceTokenError);
    assert.equal(error.stage, 'request_token');
    assert.equal(error.details.networkCode, 'ETIMEDOUT');
    assert.equal(error.details.networkPhase, 'tls');
    return true;
  });
  assert.ok(timings.token_tls >= 0);
  assert.ok(timings.token_upstream >= 0);
});
