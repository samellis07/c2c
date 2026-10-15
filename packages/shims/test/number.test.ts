import { test } from 'node:test';
import * as assert from 'node:assert';
import { nthLargest, nthSmallest, round, sqrt, log, toHex, toWords } from '../src/number.js';
import { DelugeConversionError } from '../src/convert.js';
import { Decimal } from '../src/decimal.js';
import { DelugeRuntimeError, UntranslatedConstruct } from '../src/errors.js';

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
  // Ties keep their places, and the returned member keeps its own type.
  assert.equal(nthLargest([5, 5, 3], 2), 5);
  assert.equal(nthSmallest([5, 5, 3], 2), 5);
  const d = Decimal.from('0.123456789012345678901');
  assert.equal(nthLargest([d, 2, 1], 3), d);
  assert.equal(nthSmallest([d, 2, 1], 1), d);
  assert.ok(nthLargest([d, 2, 1], 3) instanceof Decimal);
  // "The index argument starts from 1" and "cannot be greater than the size
  // of the collection" (nth-largest / nth-smallest pages).
  for (const rank of [0, -1, 3]) assert.throws(() => nthLargest([1, 2], rank), DelugeRuntimeError, `rank ${rank}`);
  assert.throws(() => nthLargest([], 1), DelugeRuntimeError);
  assert.equal(nthLargest([1, 2], Decimal.from('2')), 1);
  // A fractional rank is documented as NUMBER / DECIMAL but its rounding is
  // not, so it refuses instead of guessing.
  assert.throws(() => nthLargest([1, 2], 1.5), UntranslatedConstruct);
  assert.throws(() => nthLargest([1, 2], Decimal.from('1.5')), UntranslatedConstruct);
  // Only a collection of NUMBER and DECIMAL values is documented: a null,
  // blank or non-numeric member refuses rather than shifting every rank.
  assert.throws(() => nthSmallest(1, 1), DelugeRuntimeError);
  for (const bad of [null, undefined, '', '   ', 'abc', {}]) {
    assert.throws(() => nthSmallest([1, bad], 1), UntranslatedConstruct, `member ${String(bad)}`);
  }
});

test('Deluge number text conversions are deterministic English / hexadecimal', () => {
  assert.equal(toHex(100), '64');
  assert.equal(toHex(255n), 'ff');
  // The toHex page shows a positive whole NUMBER (100 -> "64") only, so a
  // decimal, a negative, null and text refuse instead of guessing.
  for (const bad of [1.5, Decimal.from('100'), -255n, null, '100', {}]) {
    assert.throws(() => toHex(bad), UntranslatedConstruct, `toHex ${String(bad)}`);
  }
  assert.throws(() => toHex(9007199254740993), UntranslatedConstruct);
});

test('toWords renders the documented en-us examples and scale words', () => {
  assert.equal(toWords(1989, 'en-us'), 'one thousand nine hundred eighty-nine');
  assert.equal(toWords(1989.13, 'en-us'), 'one thousand nine hundred eighty-nine point one three');
  assert.equal(toWords(0, 'en-us'), 'zero');
  assert.equal(toWords(-12, 'en-us'), 'minus twelve');
  assert.equal(toWords(1000, 'en-us'), 'one thousand');
  assert.equal(toWords(1000000, 'en-us'), 'one million');
  assert.equal(toWords(1000000000, 'en-us'), 'one billion');
  assert.equal(toWords(1000000000000n, 'en-us'), 'one trillion');
  assert.equal(toWords(1000000000000000n, 'en-us'), 'one quadrillion');
  assert.equal(
    toWords(1234567890, 'en-us'),
    'one billion two hundred thirty-four million five hundred sixty-seven thousand eight hundred ninety',
  );
  // "A number input value can contain up to 18 digits"; a decimal's whole and
  // decimal parts "can collectively be up to 15 digits".
  assert.equal(toWords(999999999999999999n, 'en-us').includes('quadrillion'), true);
  assert.throws(() => toWords(1000000000000000000n, 'en-us'), UntranslatedConstruct);
  assert.equal(toWords(Decimal.from('123456789.123456'), 'en-us').includes('point'), true);
  assert.throws(() => toWords(Decimal.from('123456789.1234567'), 'en-us'), UntranslatedConstruct);
  // Whether a kept trailing zero is read out is not documented.
  assert.throws(() => toWords(Decimal.from('1.50'), 'en-us'), UntranslatedConstruct);
  // Only NUMBER / DECIMAL input is documented.
  for (const bad of [null, '1989', {}]) {
    assert.throws(() => toWords(bad, 'en-us'), UntranslatedConstruct, `toWords ${String(bad)}`);
  }
});

test('toWords en-gb and en-in follow the documented examples only', () => {
  // The page shows "minus twelve" and "ten million" for en-gb and "one crore"
  // for en-in; it never shows where British or Indian English puts "and", so
  // any spelling that would need it refuses instead of guessing.
  assert.equal(toWords(-12, 'en-gb'), 'minus twelve');
  assert.equal(toWords(10000000, 'en-gb'), 'ten million');
  assert.equal(toWords(10000000, 'en-in'), 'one crore');
  assert.equal(toWords(100000, 'en-in'), 'one lakh');
  assert.throws(() => toWords(123, 'en-gb'), UntranslatedConstruct);
  assert.throws(() => toWords(1234567, 'en-gb'), UntranslatedConstruct);
  assert.throws(() => toWords(1234567, 'en-in'), UntranslatedConstruct);
  // en-in is documented through crore; the page shows nothing larger.
  assert.throws(() => toWords(1000000000, 'en-in'), UntranslatedConstruct);
  // The other listed languages (ar, zh, fr, de, it, ja, ko, pt, es) are not
  // rendered here, and an unlisted language is not a documented call either.
  for (const lang of ['ar', 'zh', 'fr', 'de', 'it', 'ja', 'ko', 'pt', 'es', 'xx']) {
    assert.throws(() => toWords(3, lang), UntranslatedConstruct, `toWords ${lang}`);
  }
});
