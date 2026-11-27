/** Event parsing stays linear on long whitespace runs (CodeQL polynomial-regex alerts) and keeps its meaning. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalEvent, approvalEventGap } from '../src/generate.js';

test('approvalEvent drops a trailing `/ on load` and parses level and action', () => {
  assert.deepEqual(approvalEvent('on level 2 / on approve'), { level: 2, action: 'approve' });
  assert.deepEqual(approvalEvent('on reject  /  on load '), { level: 1, action: 'reject' });
  assert.deepEqual(approvalEvent('on approve\t/\ton load'), { level: 1, action: 'approve' });
  assert.equal(approvalEvent('on approve on load'), null);
  assert.equal(approvalEvent('on start'), null);
});

test('approvalEvent is fast on long tab runs', () => {
  const t0 = Date.now();
  assert.equal(approvalEvent('on approve' + '\t'.repeat(50000) + 'x on load'), null);
  assert.equal(approvalEvent('/' + '\t'.repeat(50000) + 'on loadx'), null);
  assert.ok(Date.now() - t0 < 1000, 'long whitespace input must not backtrack');
});

test('approvalEventGap still sees a trailing `/ on load` and not a bare `on load`', () => {
  const gap = (event: string) =>
    approvalEventGap({ event, span: { start: 1, end: 2 } } as never)?.construct ?? null;
  assert.equal(gap('on foo / on load'), 'approval-on-load');
  assert.equal(gap('on foo\t/\t on load  '), 'approval-on-load');
  assert.equal(gap('on foo on load'), 'approval-event');
  assert.equal(gap('on start'), null);
  assert.equal(gap('/' + '\t'.repeat(50000) + 'on loadx'), 'approval-event');
});
