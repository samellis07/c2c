import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDate } from '../src/date.js';

test('isDate validates month and day ranges, including leap years', () => {
  assert.equal(isDate('2026-13-40'), false);
  assert.equal(isDate('32-Jan-2020'), false);
  assert.equal(isDate('2024-02-29'), true);
  assert.equal(isDate('2026-02-29'), false);
  assert.equal(isDate('2023-04-31'), false);
});

test('isDate validates time ranges', () => {
  assert.equal(isDate('2026-01-01 25:99'), false);
  assert.equal(isDate('2026-01-01 23:60'), false);
  assert.equal(isDate('2026-01-01 23:59:60'), false);
  assert.equal(isDate('2026-01-01 23:59:59'), true);
});
