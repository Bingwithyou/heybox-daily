import test from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright-core';
import { getDeviceToken } from '../dist/device-token.js';
import { errorDiagnostic } from '../dist/diagnostics.js';

test('device token failures retain the failing stage and original cause, including cleanup failures', async () => {
  for (const stage of ['launch', 'navigate', 'wait_token']) {
    let closed = false;
    const cause = Object.assign(new Error(stage === 'navigate' ? 'page.goto: net::ERR_NAME_NOT_RESOLVED' : 'Timeout 45000ms exceeded'), { name: 'TimeoutError' });
    const browser = { newContext: async () => ({ newPage: async () => ({
      goto: async () => { if (stage === 'navigate') throw cause; },
      waitForFunction: async () => { throw cause; },
    }) }), close: async () => { closed = true; throw new Error('cleanup failed'); } } as unknown as Browser;
    await assert.rejects(getDeviceToken({ executablePath: process.execPath, launch: async () => {
      if (stage === 'launch') throw cause;
      return browser;
    } }), error => {
      const diagnostic = errorDiagnostic(error);
      assert.equal(diagnostic.stage, stage);
      assert.equal(diagnostic.cause?.message, cause.message);
      return true;
    });
    assert.equal(closed, stage !== 'launch');
  }
});
