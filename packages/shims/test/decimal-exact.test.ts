import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decimal, quantizeDecimal, readExactDecimal } from '../src/decimal.js';


test('0.1 + 0.2, a wide decimal, and -0.005 quantize without float drift', () => {
  const sum = decimal.add('0.1', '0.2').toString();
  assert.equal(sum, '0.3');
  assert.equal(quantizeDecimal(sum, 2), '0.30');
  assert.equal(quantizeDecimal(sum, 3), '0.300');
  assert.equal(quantizeDecimal(sum, 4), '0.3000');
  assert.notEqual(quantizeDecimal(sum, 2), String(0.1 + 0.2));

  const wide = '12345678901234.56';
  assert.equal(quantizeDecimal(wide, 2), wide);
  assert.equal(quantizeDecimal(wide, 3), '12345678901234.560');
  assert.equal(quantizeDecimal(wide, 4), '12345678901234.5600');
  assert.throws(() => readExactDecimal(Number(wide)), /JS number/);

  assert.equal(quantizeDecimal('-0.005', 2), '-0.01');
  assert.equal(quantizeDecimal('-0.005', 3), '-0.005');
  assert.equal(quantizeDecimal('-0.005', 4), '-0.0050');
  assert.equal(decimal.cmp(quantizeDecimal('-0.005', 2), '-0.01', '=='), true);
  assert.equal(decimal.cmp('-1.5', '0', '<'), true);
  assert.equal(decimal.cmp('-1.5', '-2', '>'), true);
  assert.equal(decimal.cmp('', '1000', '>='), false);
  assert.equal(decimal.cmp(null, '1000', '>'), false);
  assert.equal(decimal.cmp('  ', 0, '<='), false);
  assert.equal(decimal.cmp('', '', '=='), true);
  assert.equal(decimal.cmp('', '0', '=='), false);
  assert.equal(decimal.cmp('', '0', '!='), true);
  assert.equal(decimal.cmp(10, 25.5, '<'), true);
  assert.throws(() => decimal.cmp('abc', '1', '>='), /not a number/);
});


test('accepts bigint', () => {
  assert.equal(decimal.add(decimal.from(5), 10n).toString(), '15');
});

test('readExactDecimal returns the canonical string and refuses a JS number', () => {
  assert.equal(readExactDecimal('0.30'), '0.30');
  assert.equal(readExactDecimal('12345678901234.56'), '12345678901234.56');
  assert.equal(readExactDecimal('-0.0050'), '-0.0050');
  assert.equal(readExactDecimal(decimal.from('0.10')), '0.10');
  assert.throws(() => readExactDecimal(0.1 + 0.2), /JS number/);
  assert.throws(() => readExactDecimal(Number('12345678901234.56')), /JS number/);
  assert.throws(() => readExactDecimal('00.10'), /canonical/);
  assert.throws(() => readExactDecimal('1e2'), /canonical/);
});
