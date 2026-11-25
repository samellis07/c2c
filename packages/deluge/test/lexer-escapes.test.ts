import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lex } from '../src/lexer.js';

const value = (src: string): string | undefined => lex(src)[0]?.value;

test('a string keeps the backslash of an escape it does not define, so a regex reaches the pattern as written', () => {
  assert.equal(value('"(?<!\\.\\d)(?=\\d+\\b)"'), '(?<!\\.\\d)(?=\\d+\\b)');
  assert.equal(value('"\\w+\\s*"'), '\\w+\\s*');
});

test('a string still reads the escapes Deluge defines', () => {
  assert.equal(value('"a\\nb\\tc\\rd"'), 'a\nb\tc\rd');
  assert.equal(value('"say \\"hi\\" \\\\ done"'), 'say "hi" \\ done');
  assert.equal(value('"it\\\'s"'), "it's");
});
