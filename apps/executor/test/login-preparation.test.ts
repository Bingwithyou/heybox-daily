import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginTiming } from '@heybox/contracts';
import { beginPreparedLogin } from '../src/login-preparation.ts';

const env = { TOKEN_SERVICE_URL: 'https://token.invalid', TOKEN_SERVICE_TOKEN: 'a'.repeat(64) };
const data = { challenge: crypto.randomUUID(), phone: '13800138000', binding: 'a'.repeat(64) };
const token = 'B' + 'x'.repeat(88);
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; };

test('DO initialization overlaps token generation and begin is called only after both succeed', async () => {
  const prepared = deferred<Response>(); const generated = deferred<Response>(); const paths: string[] = [];
  const timing = new LoginTiming();
  const stub = { fetch: (async (url: string | Request, init?: RequestInit) => {
    paths.push(new URL(String(url)).pathname);
    if (paths.length === 1) {
      assert.deepEqual(JSON.parse(init!.body as string), { challenge: data.challenge });
      return prepared.promise;
    }
    assert.deepEqual(JSON.parse(init!.body as string), { ...data, token });
    return Response.json({ status: 'sent' }, { headers: { 'server-timing': 'sms_upstream;dur=5' } });
  }) as typeof fetch };
  let tokenStarted = false;
  const result = beginPreparedLogin(stub, data, env, timing, undefined, async () => { tokenStarted = true; return generated.promise; });
  assert.ok(tokenStarted);
  assert.deepEqual(paths, ['/prepare']);
  prepared.resolve(Response.json({ ready: true }));
  await new Promise(r => setTimeout(r, 0)); assert.deepEqual(paths, ['/prepare']);
  generated.resolve(Response.json({ token }));
  const response = await result;
  assert.deepEqual(paths, ['/prepare', '/begin']);
  assert.equal((await response.json() as { status: string }).status, 'sent');
  assert.match(response.headers.get('server-timing')!, /challenge_prepare;dur=/);
  assert.match(response.headers.get('server-timing')!, /token_http;dur=/);
});

test('failed preparation aborts the token fetch and never sends an SMS', async () => {
  let signal: AbortSignal | null | undefined; let doCalls = 0;
  const stub = { fetch: (async () => { doCalls++; return new Response('{}', { status: 400 }); }) as typeof fetch };
  await assert.rejects(beginPreparedLogin(stub, data, env, new LoginTiming(), undefined, async (_url, init) => {
    signal = init?.signal;
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  }));
  assert.ok(signal!.aborted); assert.equal(doCalls, 1);
});

test('failed token generation, cancellation and timeout cannot reach begin', async () => {
  for (const mode of ['token', 'cancel', 'timeout']) {
    let calls = 0;
    const stub = { fetch: (async () => { calls++; return Response.json({ ready: true }); }) as typeof fetch };
    const controller = new AbortController();
    const result = beginPreparedLogin(stub, data, env, new LoginTiming(), controller.signal, async (_url, init) => {
      if (mode === 'token') return new Response('{}', { status: 503 });
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error(mode)), { once: true }));
    }, 20);
    if (mode === 'cancel') controller.abort();
    await assert.rejects(result); assert.equal(calls, 1);
  }
});

test('a failed begin response is returned once without retrying or exposing the token', async () => {
  let calls = 0;
  const stub = { fetch: (async () => ++calls === 1 ? Response.json({ ready: true }) : Response.json({ error: 'failed' }, { status: 400 })) as typeof fetch };
  const response = await beginPreparedLogin(stub, data, env, new LoginTiming(), undefined, async () => Response.json({ token }));
  assert.equal(response.status, 400); assert.equal(calls, 2);
  assert.ok(!(await response.text()).includes(token));
});
