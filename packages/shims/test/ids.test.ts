import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonReplacer, parseJsonLossless, quoteUnsafeIntegers, sameId } from '../src/ids.js';

test('parseJsonLossless keeps integers past 2^53 as digit text and leaves everything else to JSON.parse', () => {
  const text = '{"id":1000000000000000001,"neg":-1000000000000000001,"row":10000000000315013,"n":9007199254740991,"d":1.5,"e":1e21,"s":"1000000000000000001 \\"9999999999999999999\\"","a":[0,-1,12345678901234567890]}';
  assert.deepEqual(parseJsonLossless(text), {
    id: '1000000000000000001',
    neg: '-1000000000000000001',
    row: '10000000000315013',
    n: 9007199254740991,
    d: 1.5,
    e: 1e21,
    s: '1000000000000000001 "9999999999999999999"',
    a: [0, -1, '12345678901234567890'],
  });
  const plain = '{"a":1,"b":"x"}';
  assert.equal(quoteUnsafeIntegers(plain), plain);
  assert.throws(() => parseJsonLossless('{bad'), SyntaxError);
});

test('sameId is exact across text, number and bigint', () => {
  assert.equal(sameId('1000000000000000001', 1000000000000000001n), true);
  assert.equal(sameId(1000000000000000001n, '1000000000000000002'), false);
  assert.equal(sameId(5n, 5), true);
  assert.equal(sameId(5n, 'x'), false);
  assert.equal(sameId('5', 5), false, 'text against number keeps the strict answer');
  assert.equal(sameId('a', 'a'), true);
});

test('jsonReplacer writes a bigint as its digits', () => {
  assert.equal(JSON.stringify({ id: 1000000000000000001n }, jsonReplacer), '{"id":"1000000000000000001"}');
});
