import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { translate } from '../../deluge/src/translate.js';

const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', now: new Date('2000-01-01T00:00:00Z') });

test('edate clamps month ends, handles negative months, and discards source time', () => {
  const ctx = runtime.context({});
  assert.equal(runtime.shim.date.edate('2020-01-31 23:59:58', 1, ctx)?.toString(), '2020-02-29T00:00:00');
  assert.equal(runtime.shim.date.edate('2021-01-31', 1, ctx)?.toString(), '2021-02-28T00:00:00');
  assert.equal(runtime.shim.date.edate('2020-03-31', -1, ctx)?.toString(), '2020-02-29T00:00:00');
  assert.equal(runtime.shim.date.edate('2020-02-29', 12, ctx)?.toString(), '2021-02-28T00:00:00');
});

test('subBusinessDay follows documented weekends and holidays and leaves nonpositive counts unchanged', () => {
  const ctx = runtime.context({});
  assert.equal(runtime.shim.date.subBusinessDay('2021-07-21', 5, ['Sunday'], ['2021-07-20', '2021-07-19'], ctx)?.toString(), '2021-07-13T00:00:00');
  assert.equal(runtime.shim.date.subBusinessDay('2021-07-21', 5, ctx)?.toString(), '2021-07-14T00:00:00');
  assert.equal(runtime.shim.date.subBusinessDay('2021-07-21', 5, ['Sunday'], ctx)?.toString(), '2021-07-15T00:00:00');
  assert.equal(runtime.shim.date.subBusinessDay('2021-07-21', -1, ctx)?.toString(), '2021-07-21T00:00:00');
  assert.throws(() => runtime.shim.date.subBusinessDay('2021-07-21', 366, ctx), /365/);
});

test('field tasks read maps and record values with a stable key order', () => {
  const ctx = runtime.context({ record: { Zed: 3, Alpha: 'a', Middle: null } });
  assert.deepEqual(runtime.shim.record.getFieldNames({ Zed: 3, Alpha: 'a', Middle: null }), ['Alpha', 'Middle', 'Zed']);
  const row = runtime.shim.record.bind(ctx, { Zed: 3, Alpha: 'a', Middle: null }, 'Form');
  assert.deepEqual(runtime.shim.record.getFieldNames([row]), ['Alpha', 'Middle', 'Zed']);
  assert.equal(runtime.shim.record.getFieldValue(row, 'Zed'), 3);
  assert.equal(runtime.shim.record.getFieldValue(row, 'Missing'), null);
  assert.deepEqual(translate('return edate("2020-01-31", 1);').server.includes('shim.date.edate'), true);
  assert.deepEqual(translate('return subBusinessDay("2021-07-21", 1);').server.includes('shim.date.subBusinessDay'), true);
  assert.deepEqual(translate('return getFieldNames();').server.includes('shim.record.getFieldNames(ctx.record)'), true);
  assert.deepEqual(translate('return input.getFieldValue("Alpha");').server.includes('shim.record.getFieldValue'), true);
});
