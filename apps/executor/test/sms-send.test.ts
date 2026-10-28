import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../../packages/hosting/test/database.ts';
import { LoginFailure } from '@heybox/contracts';
import { sendWithCooldown } from '../src/sms-send.ts';
import type { Config } from 'heybox-daily/types';

const config = {} as Config;
test('independent CAPTCHA challenges for a phone cannot both send, and known CAPTCHA does not consume a send', async t => {
  const f = fixture(); t.after(() => f.close());
  const send = (action: Parameters<typeof sendWithCooldown>[3]) => sendWithCooldown(f.store, 'secret', '+8613800138000', action);
  await send(async () => ({ status: 'captcha', config, appId: '123' }));
  let release!: () => void; let sends = 0;
  const first = send(async () => { sends++; await new Promise<void>(r => release = r); return { status: 'sent', config }; });
  while (!release) await new Promise(r => setTimeout(r, 0));
  await assert.rejects(send(async () => { sends++; return { status: 'sent', config }; }),
    error => error instanceof LoginFailure && error.code === 'sms_cooldown' && error.retryAt! > f.store.now());
  release(); await first;
  f.advance(59_999);
  await assert.rejects(send(async () => ({ status: 'sent', config })), LoginFailure);
  f.advance(1);
  await send(async () => { sends++; return { status: 'sent', config }; });
  assert.equal(sends, 2);
});

test('ambiguous upstream failure keeps cooldown and never automatically resends', async t => {
  const f = fixture(); t.after(() => f.close()); let calls = 0;
  const send = () => sendWithCooldown(f.store, 'secret', '+8613800138000', async () => { calls++; throw new Error('lost response'); });
  await assert.rejects(send(), /lost response/);
  await assert.rejects(send(), LoginFailure);
  assert.equal(calls, 1);
});
