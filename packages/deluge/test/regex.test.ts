import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { escapeRegExp } from '../src/regex.js';

test('escapeRegExp makes every metacharacter, backslash included, match literally', () => {
  for (const text of ['$x', 'a\\b', '\\', 'a.b', '(a|b)*', '[x]{2}', '^$', 'a-b/c', '$\\$']) {
    assert.ok(new RegExp(`^${escapeRegExp(text)}$`).test(text), text);
  }
  assert.equal(new RegExp(`^${escapeRegExp('a.b')}$`).test('axb'), false);
  assert.equal(new RegExp(`^${escapeRegExp('a\\')}b$`).test('a\\b'), true);
});
