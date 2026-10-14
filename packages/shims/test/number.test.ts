import { test } from 'node:test';
import * as assert from 'node:assert';
import { round, sqrt, log } from '../src/number.js';
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
