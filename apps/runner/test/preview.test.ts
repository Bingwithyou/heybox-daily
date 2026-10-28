import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createPreviewRunner, previewOutcome, previewWebsite } from '../src/preview.ts';
import { encryptCredential } from '@heybox/hosting/crypto';

const token = 'staging-test-service-token-32-characters';
const key = randomBytes(32).toString('base64');

test('preview callbacks reject production and unrelated sites', () => {
  assert.equal(previewWebsite('https://preview.heybox.cansiny.top').origin, 'https://preview.heybox.cansiny.top');
  assert.equal(previewWebsite('http://127.0.0.1:1234').hostname, '127.0.0.1');
  for (const url of ['https://heybox.cansiny.top', 'https://example.com', 'http://preview.heybox.cansiny.top'])
    assert.throws(() => previewWebsite(url));
});

test('preview login and activity changes stay within synthetic accounts', async () => {
  const calls: string[] = [];
  const server = createPreviewRunner({ token, key, websiteUrl: 'http://127.0.0.1:1234',
    fetch: async (url) => { calls.push(String(url)); return Response.json(null); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, auth = token) => fetch(base + path, {
    method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post('/login/begin', {}, 'wrong')).status, 401);
    assert.equal((await post('/login/begin', { phone: '+8613800000000', binding: 'a'.repeat(64) })).status, 400);
    const begin = await post('/login/begin', { phone: '+8613900000009', binding: 'a'.repeat(64) });
    assert.equal(begin.status, 200);
    const challenge = await begin.json() as { challenge: string; status: string };
    assert.equal(challenge.status, 'sent');
    assert.equal((await post('/login/verify', { challenge: challenge.challenge, code: '000000', binding: 'a'.repeat(64) })).status, 400);
    const verified = await post('/login/verify', { challenge: challenge.challenge, code: '123456', binding: 'a'.repeat(64) });
    const { credential } = await verified.json() as { credential: Record<string, unknown> };
    assert.equal(credential.account, '900000009');
    const list = await post('/activities', { mode: 'list', credential });
    const result = await list.json() as { activities: Array<{ id: string; status: string }> };
    assert.ok(result.activities.some(row => row.status === 'blocked'));
    assert.equal((await post('/activities', { mode: 'participate', credential, activityId: '9305', approvedFollowIds: [] })).status, 400);
    assert.equal((await post('/activities', { mode: 'participate', credential, activityId: '9317', approvedFollowIds: [] })).status, 400);
    const joined = await post('/activities', { mode: 'participate', credential, activityId: '9317', approvedFollowIds: ['104298871'] });
    const row = await joined.json() as { activity: { status: string; tickets: number } };
    assert.equal(row.activity.status, 'completed'); assert.equal(row.activity.tickets, 700);
    const repeated = await post('/activities', { mode: 'participate', credential, activityId: '9317', approvedFollowIds: [] });
    assert.equal((await repeated.json() as typeof row).activity.tickets, 700);
    assert.equal((await post('/activities', { mode: 'list', credential: { ...credential, account: '123' } })).status, 400);
    assert.deepEqual(calls, []);
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); }
});

test('preview outcomes expose completed and failed demonstration states', () => {
  assert.equal(previewOutcome('900000009').status, 'completed');
  assert.equal(previewOutcome('900000008').status, 'failed');
  assert.equal(previewOutcome('900000009').batteryDelta, 1);
  assert.throws(() => previewOutcome('12345'));
});


test('preview wakes finish synthetic jobs only through the allowed callback origin', async () => {
  const credential = encryptCredential({
    session: { heybox_id: '900000009', pkey: 'preview-only-not-a-real-session', device_id: 'preview-device', x_xhh_tokenid: 'B' + 'p'.repeat(88) },
    device: { model: 'preview', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' },
  }, key);
  let claims = 0;
  let finishes = 0;
  let done!: () => void;
  const completed = new Promise<void>(resolve => { done = resolve; });
  const server = createPreviewRunner({ token, key, websiteUrl: 'http://127.0.0.1:1234',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'http://127.0.0.1:1234');
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      if (url.pathname === '/internal/claim') {
        claims++;
        return Response.json(claims === 1 ? { id: 42, lease: 'test-lease', credential } : null);
      }
      assert.equal(url.pathname, '/internal/finish');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.id, 42); assert.equal(body.lease, 'test-lease');
      assert.equal(body.result.status, 'completed'); assert.equal(body.result.expDelta, 30);
      finishes++; done(); return Response.json({ ok: true });
    } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const wake = () => fetch(`http://127.0.0.1:${address.port}/tasks/wake`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal((await wake()).status, 204);
    assert.equal((await wake()).status, 204);
    await completed;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(finishes, 1);
    assert.ok(claims >= 2);
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); }
});
