import { test } from 'node:test';
import * as assert from 'node:assert';
import { nthLargest, nthSmallest, round, sqrt, log, toHex, toWords } from '../src/number.js';
import { DelugeConversionError } from '../src/convert.js';

test('round', () => {
  assert.strictEqual(round(9007199254740993n), 9007199254740993n);
  assert.strictEqual(round(9007199254740993n, 2), 9007199254740993n);
  assert.strictEqual(round(1.5), 2);
  assert.strictEqual(round(-1.5), -2);
});

test('sqrt', () => {
  assert.strictEqual(sqrt(16n), 4);
  assert.strictEqual(sqrt(9007199254740993n * 9007199254740993n), 9007199254740993n);
  assert.throws(() => sqrt(9007199254740993n * 9007199254740993n + 1n), DelugeConversionError);
  assert.throws(() => sqrt(9007199254740993n), DelugeConversionError);
  assert.strictEqual(sqrt(16), 4);
  assert.strictEqual(sqrt(-1), null);
});

test('log', () => {
  assert.throws(() => log(9007199254740993n), DelugeConversionError);
  assert.strictEqual(log(10), Math.log(10));
  assert.strictEqual(log(10n), Math.log(10));
});

test('log of negative', () => {
  assert.strictEqual(Number.isNaN(log(-1)), true);
});

test('Deluge collection ranks are one-based, numerically sorted values', () => {
  // Numeric ordering matters here: a lexicographic sort would put 10 before 2.
  assert.equal(nthLargest([10, 2, 3], 2), 3);
  assert.equal(nthLargest([300, 455, 124, 926, 780], 5), 124);
  assert.equal(nthSmallest([300, 455, 124, 926, 780], 2), 300);
  assert.equal(nthLargest([], 1), null);
  assert.throws(() => nthSmallest([1, {}], 1), /non-numeric/);
});

test('Deluge number text conversions are deterministic English / hexadecimal', () => {
  assert.equal(toHex(100), '64');
  assert.equal(toHex(-255n), '-ff');
  assert.equal(toWords(1989, 'en-us'), 'one thousand nine hundred eighty-nine');
  assert.equal(toWords('1989.13', 'en-us'), 'one thousand nine hundred eighty-nine point one three');
  assert.equal(toWords(-12, 'en-gb'), 'minus twelve');
  assert.equal(toWords(10000000, 'en-in'), 'one crore');
  assert.throws(() => toWords(3, 'fr'), /unsupported language/);
});
