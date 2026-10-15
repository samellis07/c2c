import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyInitialValues, type WriteField } from '../src/access.js';
import { UntranslatedConstruct } from '../src/errors.js';
import { LIMITS, createRuntime } from '../src/runtime.js';
import { reportCriteria } from '../../deluge/src/translate.js';
import { mockDatastore } from './zcql-mock.js';

test('a relative criteria without a usable zone fails closed instead of reading every row', async () => {
  const calls: string[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query(_form, where) {
        calls.push(where);
        return [{ ROWID: '1', Due: '2020-01-01' }];
      },
    },
  });
  const relative = reportCriteria('Due is today');
  const ctx = runtime.context({});
  // With the zone the marker binds to a window.
  assert.equal(runtime.shim.datastore.query(ctx, 'Task', relative).criteria.op, 'and');
  ctx.appTimeZone = '';
  const query = runtime.shim.datastore.query(ctx, 'Task', relative);
  assert.deepEqual(query.criteria, { op: 'todo', construct: 'criteria-dynamic' });
  await assert.rejects(() => runtime.shim.datastore.rows(ctx, query), UntranslatedConstruct);
  assert.throws(() => runtime.shim.datastore.matches(ctx, { Due: '2020-01-01' }, relative), UntranslatedConstruct);
  assert.deepEqual(calls, []);
});

test('historyRows reads a missing history table as empty and rethrows every other store error', async () => {
  const missing: unknown[] = [
    Object.assign(new Error('boom'), { status: 404 }),
    Object.assign(new Error('boom'), { statusCode: 404 }),
    Object.assign(new Error('boom'), { code: 'TABLE_NOT_FOUND' }),
    Object.assign(new Error('boom'), { code: 'invalid_table_name' }),
    new Error('no such table: C2C_Flow_History'),
    new Error('Table C2C_Flow_History does not exist'),
    new Error("table 'C2C_Flow_History' not found"),
  ];
  const other: unknown[] = [
    Object.assign(new Error('Internal error'), { status: 500 }),
    Object.assign(new Error('boom'), { code: 'TABLE_NOT_FOUND_EXTRA' }),
    new Error('row not found'),
    new Error('Table exists. Column Actor not found'),
    'no such table',
  ];
  const run = (err: unknown) => {
    const runtime = createRuntime({
      dryRun: false,
      appTimeZone: 'UTC',
      flowHistoryTable: 'C2C_Flow_History',
      datastore: {
        async query() {
          throw err;
        },
      },
    });
    return runtime.shim.datastore.historyRows(runtime.context({}), 'C2C_Flow_History', { op: 'true' });
  };
  for (const err of missing) assert.deepEqual(await run(err), [], String((err as Error).message));
  for (const err of other) {
    await assert.rejects(run(err), (got: unknown) => got === err, String(err));
  }
});

test('lookupMap sends distinct non-empty keys, reads lookup objects by id, and batches by the page size', async () => {
  const store = mockDatastore({ Customer: { Code: 'string', Name: 'string' } });
  const rows = [];
  for (let id = 1; id <= LIMITS.zcqlRowsPerQuery + 5; id++) rows.push({ ROWID: String(id), Code: `C${id}`, Name: `Name ${id}` });
  // A duplicate key row: the first match wins.
  rows.push({ ROWID: '9999', Code: 'C1', Name: 'Later' });
  store.tables.set('Customer', rows);
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore: store.datastore });
  const ctx = runtime.context({});

  const small = await runtime.shim.datastore.lookupMap(ctx, 'Customer', 'Code', 'Name', [
    'C1',
    null,
    '',
    'C1',
    'C2',
    undefined,
    // The same key as a lookup object is still one key.
    { id: 'C1', label: 'first' },
  ]);
  assert.deepEqual([...small.entries()], [
    ['C1', 'Name 1'],
    ['C2', 'Name 2'],
  ]);
  assert.equal(store.calls.length, 1);
  assert.match(store.calls[0]!.where, /Code IN \('C1', 'C2'\)\)?$/);

  store.calls.length = 0;
  const keys = rows.map((row) => row.Code);
  const big = await runtime.shim.datastore.lookupMap(ctx, 'Customer', 'Code', 'Name', keys);
  assert.equal(big.size, LIMITS.zcqlRowsPerQuery + 5);
  assert.equal(big.get('C1'), 'Name 1');
  // One IN list per page of keys (a list can still page past 300 rows).
  assert.equal(new Set(store.calls.map((call) => call.where)).size, 2);

  // No adapter on a live runtime: the read is refused and noted, never guessed.
  const bare = createRuntime({ dryRun: false, appTimeZone: 'UTC' });
  const out = await bare.shim.datastore.lookupMap(bare.context({}), 'Customer', 'Code', 'Name', ['C1']);
  assert.equal(out.size, 0);
  assert.equal(bare.transcript.some((entry) => entry.op === 'live-refused' && entry.call === 'fetch'), true);
});

test('rowsMap groups every row per key and aggregateMap aggregates per key', async () => {
  const store = mockDatastore({ Line: { Order: 'string', Qty: 'double' } });
  store.tables.set('Line', [
    { ROWID: '1', Order: 'A', Qty: '2' },
    { ROWID: '2', Order: 'A', Qty: '3' },
    { ROWID: '3', Order: 'B', Qty: '7' },
    { ROWID: '4', Order: 'C', Qty: '1' },
  ]);
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore: store.datastore });
  const ctx = runtime.context({});
  const grouped = await runtime.shim.datastore.rowsMap(ctx, 'Line', 'Order', ['A', { id: 'B' }, 'Z']);
  assert.deepEqual([...grouped.keys()], ['A', 'B']);
  assert.deepEqual(grouped.get('A')!.map((row) => row.values.ROWID), ['1', '2']);
  assert.equal(grouped.get('B')![0]!.form, 'Line');

  const counts = await runtime.shim.datastore.aggregateMap(ctx, 'Line', 'Order', ['A', 'B'], 'count');
  assert.deepEqual([...counts.entries()], [
    ['A', 2],
    ['B', 1],
  ]);
  const sums = await runtime.shim.datastore.aggregateMap(ctx, 'Line', 'Order', ['A', 'B'], 'sum', 'Qty', {
    op: '>',
    field: 'Qty',
    value: 2,
  });
  assert.equal(Number(sums.get('A')), 3);
  assert.equal(Number(sums.get('B')), 7);
  assert.match(store.calls.at(-1)!.where, /Order IN \('A', 'B'\) AND Qty > 2/);
});

test('compare.eq reads a lookup by its id or label and a multi lookup by any member', () => {
  const { shim } = createRuntime({ dryRun: true });
  const lookup = { id: '42', label: 'Acme' };
  assert.equal(shim.compare.eq(lookup, '42'), true);
  assert.equal(shim.compare.eq(lookup, 42), true);
  assert.equal(shim.compare.eq(lookup, 'Acme'), true);
  assert.equal(shim.compare.eq(lookup, '43'), false);
  assert.equal(shim.compare.ne(lookup, '42'), false);
  assert.equal(shim.compare.ne(lookup, '43'), true);
  assert.equal(shim.compare.eq({ __row: true, form: 'Customer', values: { ID: '7' } }, '7'), true);
  assert.equal(shim.compare.eq([{ id: '1' }, { id: '2' }], '2'), true);
  assert.equal(shim.compare.eq([{ id: '1' }, { id: '2' }], '3'), false);
  assert.equal(shim.compare.eq('5', 5), true);
  // An object with no id or label members compares as itself, never by a member.
  assert.equal(shim.compare.eq({ other: '42' }, '42'), false);
  assert.equal(shim.compare.eq(null, null), true);
});

test('applyInitialValues fills only absent non-readonly plain fields, hidden included', () => {
  const fields: WriteField[] = [
    { name: 'Status', defaultValue: 'Open' },
    { name: 'Notes', defaultValue: 'none' },
    { name: 'Priority', defaultValue: 'Low' },
    { name: 'Locked', readOnly: true, defaultValue: 'x' },
    { name: 'Flag', hidden: true, defaultValue: 'on' },
    { name: 'Owner', kind: 'lookup', defaultValue: '1' },
    { name: 'Doc', kind: 'file', defaultValue: 'k' },
    { name: 'NoDefault' },
    { name: 'Lines', kind: 'subform', fields: [{ name: 'Qty', defaultValue: '1' }] },
    { name: 'Address', kind: 'composite', fields: [{ name: 'country', defaultValue: 'IN' }] },
  ];
  const values: Record<string, unknown> = {
    Notes: '',
    Priority: null,
    Lines: [{}, { Qty: 5 }, 'not a row'],
    Address: { city: 'Chennai' },
  };
  applyInitialValues(values, fields);
  assert.deepEqual(values, {
    Status: 'Open',
    Notes: '',
    Priority: 'Low',
    Flag: 'on',
    Lines: [{ Qty: '1' }, { Qty: 5 }, 'not a row'],
    Address: { city: 'Chennai', country: 'IN' },
  });
  const untouched = { A: 1 };
  applyInitialValues(untouched, undefined);
  assert.deepEqual(untouched, { A: 1 });
});
