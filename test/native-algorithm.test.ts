import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeNativeNonce, signNative } from '../dist/native-algorithm.js';
import type { NativeSignatureInput } from '../dist/native-algorithm.js';
import type { NativeSignature } from '../dist/types.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-v14.json', import.meta.url), 'utf8')) as {
  records: { id: string; input: NativeSignatureInput; signature: NativeSignature }[];
  nonceReplay: { timeSeconds: string; indices: number[]; actual: string; alphabet: string };
};
for (const record of fixture.records) test(`native signature golden: ${record.id}`, () => {
  const actual = signNative(record.input);
  for (const field of ['_time', 'hkey', '_rnd'] as const) assert.equal(actual[field], record.signature[field], field);
  assert.match(actual.nonce, /^[A-Za-z0-9]{32}$/);
});
test('nonce generation reproduces the native output using its observed random indices', () => {
  const replay = fixture.nonceReplay;
  let cursor = 0;
  assert.equal(makeNativeNonce(replay.timeSeconds, max => {
    assert.equal(max, 32);
    return replay.indices[cursor++];
  }), replay.actual);
  assert.equal(cursor, 32);
});
test('interleaving account inputs preserves each signature without shared account state', () => {
  const before = JSON.stringify(fixture.records);
  for (let i = 0; i < 100; i++) {
    const record = fixture.records[(i * 7) % fixture.records.length];
    const actual = signNative(record.input);
    assert.equal(actual.hkey, record.signature.hkey);
    assert.equal(actual._rnd, record.signature._rnd);
  }
  assert.equal(JSON.stringify(fixture.records), before);
});
test('repeated signatures use fresh random nonces', () => {
  assert.equal(new Set(Array.from({ length: 100 }, () => signNative(fixture.records[0].input).nonce)).size, 100);
});
