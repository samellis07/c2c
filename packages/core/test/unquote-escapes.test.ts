import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unquote } from '../src/ir.js';

test('a four-digit \\u escape in a quoted export string is the character it names', () => {
  assert.equal(unquote('"\\u20B9 <b>5</b> \\u00A5"'), '₹ <b>5</b> ¥');
  assert.equal(unquote("'\\u00e9'"), 'é');
});

test('other escapes keep their meaning, and a short or non-hex \\u stays what it was', () => {
  assert.equal(unquote('"a\\nb\\tc\\"d\\\\e"'), 'a\nb\tc"d\\e');
  assert.equal(unquote('"\\u20B"'), 'u20B');
  assert.equal(unquote('"\\uZZZZ"'), 'uZZZZ');
  assert.equal(unquote('"\\\\u20B9"'), '\\u20B9');
});
