import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileCriteria, matchRow } from '../src/criteria.js';
import { createRuntime, type RuntimeOptions } from '../src/runtime.js';
import { mockDatastore } from './zcql-mock.js';

// ZCQL is SQL three-valued: `col = null` is not a null test (a comparison with
// NULL is UNKNOWN and can be refused outright). The documented null tests are
// `IS NULL` / `IS NOT NULL` (Catalyst ZCQL WHERE operators,
// https://docs.catalyst.zoho.com/en/cloud-scale/help/zcql/where/). A Creator
// `Field == null` criteria therefore compiles to `Field IS NULL`, on every
// field type, and the in-memory matcher follows the same rule.

test('== null compiles to IS NULL, != null to IS NOT NULL, on any field', () => {
  assert.equal(compileCriteria({ op: '==', field: 'Lookup', value: null }), 'Lookup IS NULL');
  assert.equal(compileCriteria({ op: '!=', field: 'Lookup', value: null }), 'Lookup IS NOT NULL');
  assert.equal(compileCriteria({ op: '==', field: 'Name', value: null }), 'Name IS NULL');
  assert.equal(compileCriteria({ op: '!=', field: 'Name', value: null }), 'Name IS NOT NULL');
  assert.equal(compileCriteria({ op: '==', field: 'Count', value: null }), 'Count IS NULL');
  assert.equal(compileCriteria({ op: '==', field: 'Due', value: null }), 'Due IS NULL');
  // undefined is the same blank as null.
  assert.equal(compileCriteria({ op: '==', field: 'Lookup', value: undefined }), 'Lookup IS NULL');
});

test('a null comparison on logical ID is never / always true', () => {
  assert.equal(compileCriteria({ op: '==', field: 'ID', value: null }), '(c2c_source_id IS NULL AND ROWID IS NULL)');
  assert.equal(compileCriteria({ op: '!=', field: 'ID', value: null }), '(c2c_source_id IS NOT NULL OR ROWID IS NOT NULL)');
});

test('an IN list holding null matches NULL rows too', () => {
  assert.equal(compileCriteria({ op: 'in', field: 'Status', value: [null, 'open', 'shut'] }), "(Status IN ('open', 'shut') OR Status IS NULL)");
  assert.equal(compileCriteria({ op: 'in', field: 'Status', value: [null] }), 'Status IS NULL');
  assert.equal(compileCriteria({ op: 'in', field: 'ID', value: [null] }), '(ROWID IS NULL)');
  assert.equal(compileCriteria({ op: 'in', field: 'ID', value: [null, '42'] }), "((c2c_source_id IS NOT NULL AND c2c_source_id IN ('42')) OR ROWID IN ('42'))");
});

test('a relational comparison to null never matches a row', () => {
  for (const op of ['<', '>', '<=', '>='] as const) {
    assert.equal(compileCriteria({ op, field: 'Amount', value: null }), '(ROWID IS NULL)');
    assert.equal(compileCriteria({ op, field: 'ID', value: null }), '(ROWID IS NULL)');
  }
});

test('a text-match against null is the empty pattern: every row', () => {
  assert.equal(compileCriteria({ op: 'contains', field: 'Name', value: null }), '(ROWID IS NOT NULL)');
  assert.equal(compileCriteria({ op: 'contains', field: 'ID', value: null }), '(ROWID IS NOT NULL)');
});

test('null comparisons nest under AND/OR/NOT', () => {
  assert.equal(
    compileCriteria({ op: 'not', arg: { op: '==', field: 'Lookup', value: null } }),
    '(NOT Lookup IS NULL)',
  );
  assert.equal(
    compileCriteria({ op: 'and', args: [{ op: '==', field: 'Lookup', value: null }, { op: '==', field: 'Name', value: 'a' }] }),
    "(Lookup IS NULL AND Name = 'a')",
  );
});

test('matchRow agrees: null equality, in-list, and relational-vs-null', () => {
  const blank = { Lookup: null, Name: null };
  const filled = { Lookup: '7', Name: 'a' };
  assert.equal(matchRow(blank, { op: '==', field: 'Lookup', value: null }), true);
  assert.equal(matchRow(filled, { op: '==', field: 'Lookup', value: null }), false);
  assert.equal(matchRow(blank, { op: '!=', field: 'Lookup', value: null }), false);
  assert.equal(matchRow(filled, { op: '!=', field: 'Lookup', value: null }), true);
  assert.equal(matchRow(blank, { op: 'in', field: 'Lookup', value: [null, '7'] }), true);
  assert.equal(matchRow(filled, { op: 'in', field: 'Lookup', value: [null, '7'] }), true);
  // Three-valued logic, as ZCQL: a comparison with a NULL operand is never TRUE.
  assert.equal(matchRow(blank, { op: '<', field: 'Name', value: 'b' }), false);
  for (const op of ['<', '>', '<=', '>='] as const) {
    assert.equal(matchRow(filled, { op, field: 'Lookup', value: null }), false);
    assert.equal(matchRow(blank, { op, field: 'Lookup', value: null }), false);
  }
});

function live() {
  const store = mockDatastore({});
  const options: RuntimeOptions = { dryRun: false, appTimeZone: 'UTC', datastore: store.datastore };
  const runtime = createRuntime(options);
  return { runtime, ctx: runtime.context({}), store };
}

test('a live read over the compiled WHERE returns the blank rows', async () => {
  const { runtime, ctx, store } = live();
  await runtime.shim.datastore.insert(ctx, 'Contact', { Lookup: '77', Name: 'a' });
  await runtime.shim.datastore.insert(ctx, 'Contact', { Lookup: null, Name: 'b' });
  await runtime.shim.datastore.insert(ctx, 'Contact', { Lookup: '88', Name: 'c' });
  const blanks = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Contact', { op: '==', field: 'Lookup', value: null }));
  assert.deepEqual(blanks.map((r) => r.values.Name), ['b']);
  const filled = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Contact', { op: '!=', field: 'Lookup', value: null }));
  assert.deepEqual(filled.map((r) => r.values.Name), ['a', 'c']);
  assert.deepEqual(store.calls.map((c) => c.where), ['Lookup IS NULL', 'Lookup IS NOT NULL']);

  const nullName = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Contact', { op: '==', field: 'Name', value: null }));
  assert.deepEqual(nullName, []);
  await runtime.shim.datastore.insert(ctx, 'Contact', { Name: null });
  const nullName2 = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Contact', { op: '==', field: 'Name', value: null }));
  assert.deepEqual(nullName2.length, 1);
});

test('a dry-run seed filters by the same null rule', async () => {
  const runtime = createRuntime({
    dryRun: true,
    seed: { Contact: [{ Lookup: '77', Name: 'a' }, { Lookup: null, Name: 'b' }, { Lookup: '88', Name: 'c' }] },
  });
  const ctx = runtime.context({});
  const blanks = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Contact', { op: '==', field: 'Lookup', value: null }));
  assert.deepEqual(blanks.map((r) => r.values.Name), ['b']);
  const filled = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Contact', { op: '!=', field: 'Lookup', value: null }));
  assert.deepEqual(filled.map((r) => r.values.Name), ['a', 'c']);
});
