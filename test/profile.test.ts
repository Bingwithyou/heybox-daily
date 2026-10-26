import test from 'node:test';
import assert from 'node:assert/strict';
import { accountProfile } from '../dist/profile.js';

test('profile accepts the verified login and task field names without leaking other fields', () => {
  assert.deepEqual(accountProfile({ nickname: '  盒友\n小明  ', avatar: 'https://cdn.max-c.com/a.png', pkey: 'private' }),
    { nickname: '盒友小明', avatar: 'https://cdn.max-c.com/a.png' });
  assert.deepEqual(accountProfile({ username: '昵称' }), { nickname: '昵称' });
  assert.equal(accountProfile(null), undefined);
});

test('invalid avatar URLs and oversized profile fields cannot reach rendered content', () => {
  for (const avatar of ['javascript:alert(1)', 'http://example.com/a', 'https://secret@example.com/a', 'bad-url']) {
    assert.deepEqual(accountProfile({ username: '昵称', avatar }), { nickname: '昵称' });
  }
  assert.equal(accountProfile({ nickname: 'a'.repeat(1000) })?.nickname?.length, 80);
});
