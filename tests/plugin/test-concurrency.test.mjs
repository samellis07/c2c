import test from 'node:test';
import assert from 'node:assert';
import { getTestConcurrencyArgs } from '../../scripts/test-concurrency.mjs';

test('unset -> no flag', () => {
  let warned = false;
  const args = getTestConcurrencyArgs({}, () => { warned = true; });
  assert.deepEqual(args, []);
  assert.equal(warned, false);
});

test('empty -> no flag', () => {
  let warned = false;
  const args = getTestConcurrencyArgs({ C2C_TEST_CONCURRENCY: '' }, () => { warned = true; });
  assert.deepEqual(args, []);
  assert.equal(warned, false);
});

test('4 -> --test-concurrency=4', () => {
  let warned = false;
  const args = getTestConcurrencyArgs({ C2C_TEST_CONCURRENCY: '4' }, () => { warned = true; });
  assert.deepEqual(args, ['--test-concurrency=4']);
  assert.equal(warned, false);
});

test('0 -> no flag + warning', () => {
  let warning = '';
  const args = getTestConcurrencyArgs({ C2C_TEST_CONCURRENCY: '0' }, (msg) => { warning = msg; });
  assert.deepEqual(args, []);
  assert.equal(warning, "Warning: ignoring invalid C2C_TEST_CONCURRENCY value '0'");
});

test('x -> no flag + warning', () => {
  let warning = '';
  const args = getTestConcurrencyArgs({ C2C_TEST_CONCURRENCY: 'x' }, (msg) => { warning = msg; });
  assert.deepEqual(args, []);
  assert.equal(warning, "Warning: ignoring invalid C2C_TEST_CONCURRENCY value 'x'");
});

test('-1 -> no flag + warning', () => {
  let warning = '';
  const args = getTestConcurrencyArgs({ C2C_TEST_CONCURRENCY: '-1' }, (msg) => { warning = msg; });
  assert.deepEqual(args, []);
  assert.equal(warning, "Warning: ignoring invalid C2C_TEST_CONCURRENCY value '-1'");
});

test('4.5 -> no flag + warning', () => {
  let warning = '';
  const args = getTestConcurrencyArgs({ C2C_TEST_CONCURRENCY: '4.5' }, (msg) => { warning = msg; });
  assert.deepEqual(args, []);
  assert.equal(warning, "Warning: ignoring invalid C2C_TEST_CONCURRENCY value '4.5'");
});
