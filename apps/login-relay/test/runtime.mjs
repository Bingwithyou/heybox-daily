import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import assert from 'node:assert/strict';

// Use the runtime bundled with our pinned Wrangler, without making real upstream calls.
const require = createRequire(realpathSync(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare, convertV4MiniflareOptions, Response } = require('miniflare');
const { build } = require('esbuild');
const compiled = await build({ entryPoints: [new URL('../src/worker.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const token = 'local-runtime-fixture-token-'.repeat(2);
let requests = 0;
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0].text,
  compatibilityDate: '2026-10-27', cf: false, bindings: { LOGIN_RELAY_TOKEN: token }, outboundService: async request => {
    requests++;
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://api.xiaoheihe.cn');
    assert.equal(url.searchParams.get('ticket'), 'fixture-ticket');
    assert.equal(await request.text(), 'phone_num=fixture');
    return Response.json({ status: 'show_captcha', result: { appid: '2061805035' } });
  } }));
try {
  const denied = await runtime.dispatchFetch('https://relay.local/relay', { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
  const result = await runtime.dispatchFetch('https://relay.local/relay', { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({
      url: 'https://api.xiaoheihe.cn/account/get_login_code/?ticket=fixture-ticket', method: 'POST',
      headers: { cookie: 'fixture' }, body: 'phone_num=fixture',
    }) });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: 'show_captcha', result: { appid: '2061805035' } });
  assert.equal(requests, 1);
  console.log('workerd: authentication and CAPTCHA relay passed; no real upstream calls');
} finally { await runtime.dispose(); }
