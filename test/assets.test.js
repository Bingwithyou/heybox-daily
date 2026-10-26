import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('bundled native resources match the verified version and SHA-256 manifest', () => {
  const directory = new URL('../third-party/heybox-assets/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
  assert.equal(manifest.appVersion, '1.3.398');
  assert.equal(manifest.appBuild, '1142');
  assert.equal(manifest.shaderVersion, '14');
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    'app-metadata.apk', 'libglesv3_1.so', 'libnative-lib.so', 'shader-code.bin',
  ]);
  for (const [file, hash] of Object.entries(manifest.files)) {
    const data = readFileSync(new URL(file, directory));
    assert.equal(createHash('sha256').update(data).digest('hex'), hash, file);
    if (file === 'app-metadata.apk') assert.ok(data.length < 100_000, 'only package metadata should be bundled');
  }
});
