import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileCriteria, type Criteria } from '../src/criteria.js';
import { decimal } from '../src/decimal.js';
import { createRuntime, type RuntimeOptions } from '../src/runtime.js';
import { mockDatastore } from './zcql-mock.js';

// Decimal, currency, and percent columns are VarChar(64). ZCQL compares a varchar as
// text: '20.00' <= '100.00' is false and '90.00' sorts after '1000.00'. These tests
// run the runtime against a store that types columns that way.

const POS = { Add_Discount: { Total_price: { shadow: 'Total_price__n', scale: 2 } } };
const RATE = { Rates: { Rate: { shadow: 'Rate__n', scale: 17 } } };

function live(decimalColumns: RuntimeOptions['decimalColumns']) {
  const doubles: Record<string, string[]> = {};
  for (const [form, fields] of Object.entries(decimalColumns ?? {})) doubles[form] = Object.values(fields).map((spec) => spec.shadow);
  const store = mockDatastore(doubles);
  const options: RuntimeOptions = { dryRun: false, appTimeZone: 'UTC', datastore: store.datastore, decimalColumns };
  const runtime = createRuntime(options);
  return { runtime, ctx: runtime.context({}), store };
}

function seeded(decimalColumns: RuntimeOptions['decimalColumns'], seed: Record<string, Record<string, unknown>[]>) {
  const options: RuntimeOptions = { dryRun: true, seed, decimalColumns };
  const runtime = createRuntime(options);
  return { runtime, ctx: runtime.context({}) };
}

const POS_PRICES = ['20.00', '100.00', '15.00', '1000.00'];
// Add_Discount[Total_price <= input.Total] sort by Total_price desc range from 0 to 0
const POS_CRITERIA: Criteria = { op: '<=', field: 'Total_price', value: '150.00' };
const POS_OPTS = { sort: { field: 'Total_price', dir: 'desc' }, range: { from: 0, to: 0 } };

test('point-of-sale discount query returns the numerically largest price <= Total (live ZCQL)', async () => {
  const { runtime, ctx, store } = live(POS);
  for (const price of POS_PRICES) await runtime.shim.datastore.insert(ctx, 'Add_Discount', { Total_price: price });
  for (const total of ['150.00', decimal.from('150')]) {
    const q = runtime.shim.datastore.query(ctx, 'Add_Discount', { ...POS_CRITERIA, value: total }, POS_OPTS);
    const rows = await runtime.shim.datastore.rows(ctx, q);
    assert.deepEqual(rows.map((r) => r.values.Total_price), ['100.00']);
    assert.equal(await runtime.shim.datastore.field(ctx, q, 'Total_price'), '100.00');
  }
  // The shadow column is written next to the varchar and never returned to app code.
  assert.deepEqual(store.tables.get('Add_Discount')!.map((r) => r.Total_price__n), ['20', '100', '15', '1000']);
  const all = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Add_Discount', { op: 'true' }, { sort: { field: 'Total_price', dir: 'desc' } }));
  assert.deepEqual(all.map((r) => r.values.Total_price), ['1000.00', '100.00', '20.00', '15.00']);
  assert.equal(all.some((r) => Object.hasOwn(r.values, 'Total_price__n')), false);
  for (const call of store.calls) {
    assert.doesNotMatch(call.where, /\bTotal_price\s*(<|>|=)/, 'no text comparison on the varchar');
    if (call.orderBy.includes('Total_price')) assert.match(call.orderBy, /^ORDER BY Total_price__n (DESC|ASC), ROWID$/);
  }
});

test('point-of-sale discount query returns the numerically largest price <= Total (dry-run seed)', async () => {
  const { runtime, ctx } = seeded(POS, { Add_Discount: POS_PRICES.map((Total_price) => ({ Total_price })) });
  const q = runtime.shim.datastore.query(ctx, 'Add_Discount', POS_CRITERIA, POS_OPTS);
  const rows = await runtime.shim.datastore.rows(ctx, q);
  assert.deepEqual(rows.map((r) => r.values.Total_price), ['100.00']);
  const sorted = await runtime.shim.datastore.column(ctx, runtime.shim.datastore.query(ctx, 'Add_Discount', { op: 'true' }, { sort: { field: 'Total_price' } }), 'Total_price');
  assert.deepEqual(sorted, ['15.00', '20.00', '100.00', '1000.00']);
});

// Three values one binary64 cannot tell apart: all three are the double 0.3.
const A = '0.30000000000000001';
const B = '0.3';
const C = '0.29999999999999999';

async function rateValues(runtime: ReturnType<typeof createRuntime>, ctx: ReturnType<ReturnType<typeof createRuntime>['context']>, c: Criteria, opts?: { sort?: { field: string; dir?: string }; range?: { from: number; to: number } }) {
  return runtime.shim.datastore.column(ctx, runtime.shim.datastore.query(ctx, 'Rates', c, opts), 'Rate');
}

for (const mode of ['live ZCQL', 'dry-run seed'] as const) {
  test(`values equal in binary64 are filtered and ordered exactly (${mode})`, async () => {
    assert.equal(Number(A), Number(B));
    assert.equal(Number(C), Number(B));
    assert.notEqual(0.1 + 0.2, 0.3);
    let runtime: ReturnType<typeof createRuntime>;
    let ctx: ReturnType<ReturnType<typeof createRuntime>['context']>;
    if (mode === 'live ZCQL') {
      ({ runtime, ctx } = live(RATE));
      // ROWID order A, B, C is the reverse of exact ascending order.
      for (const Rate of [A, B, C]) await runtime.shim.datastore.insert(ctx, 'Rates', { Rate });
    } else {
      ({ runtime, ctx } = seeded(RATE, { Rates: [A, B, C].map((Rate, i) => ({ ROWID: String(1000 + i), Rate })) }));
    }
    assert.deepEqual(await rateValues(runtime, ctx, { op: '>', field: 'Rate', value: B }), [A]);
    assert.deepEqual(await rateValues(runtime, ctx, { op: '<', field: 'Rate', value: B }), [C]);
    assert.deepEqual(await rateValues(runtime, ctx, { op: '<=', field: 'Rate', value: B }), [B, C]);
    assert.deepEqual(await rateValues(runtime, ctx, { op: '>=', field: 'Rate', value: A }), [A]);
    assert.deepEqual(await rateValues(runtime, ctx, { op: '==', field: 'Rate', value: decimal.add('0.1', '0.2') }), [B]);
    assert.deepEqual(await rateValues(runtime, ctx, { op: '!=', field: 'Rate', value: B }), [A, C]);
    assert.deepEqual(await rateValues(runtime, ctx, { op: 'in', field: 'Rate', value: [A, C] }), [A, C]);
    assert.deepEqual(await rateValues(runtime, ctx, { op: 'not', arg: { op: '<=', field: 'Rate', value: B } }), [A]);
    assert.deepEqual(await rateValues(runtime, ctx, { op: 'true' }, { sort: { field: 'Rate' } }), [C, B, A]);
    assert.deepEqual(await rateValues(runtime, ctx, { op: 'true' }, { sort: { field: 'Rate' }, range: { from: 0, to: 0 } }), [C]);
    assert.deepEqual(await rateValues(runtime, ctx, { op: 'true' }, { sort: { field: 'Rate', dir: 'desc' }, range: { from: 0, to: 0 } }), [A]);
    assert.deepEqual(await rateValues(runtime, ctx, { op: 'true' }, { sort: { field: 'Rate', dir: 'desc' }, range: { from: 2, to: 3 } }), [B, C]);
  });
}

test('range applies after the exact filter and pages 300 rows at a time', async () => {
  const cols = { Items: { Amount: { shadow: 'Amount__n', scale: 2 } } };
  const { runtime, ctx, store } = live(cols);
  const rows = Array.from({ length: 700 }, (_, i) => ({ Amount: `${i + 1}.00` }));
  for (const row of rows) await runtime.shim.datastore.insert(ctx, 'Items', row);
  store.calls.length = 0;
  // `!=` has no shadow superset (ROWID IS NOT NULL), so ZCQL returns every row and the exact pass drops one.
  const got = await runtime.shim.datastore.column(ctx, runtime.shim.datastore.query(ctx, 'Items', { op: '!=', field: 'Amount', value: '5' }, { range: { from: 400, to: 401 } }), 'Amount');
  assert.deepEqual(got, ['401.00', '402.00']);
  assert.deepEqual(store.calls.map((c) => [c.limit, c.offset]), [[300, 0], [300, 300]]);
  // A decimal sort with a window keeps paging past rows tied on the shadow, then stops.
  store.calls.length = 0;
  const top = await runtime.shim.datastore.column(ctx, runtime.shim.datastore.query(ctx, 'Items', { op: '>=', field: 'Amount', value: '90' }, { sort: { field: 'Amount', dir: 'desc' }, range: { from: 1, to: 3 } }), 'Amount');
  assert.deepEqual(top, ['700.00', '699.00', '698.00']);
  // One query for the NULL-shadow rows (none here), one for the window.
  assert.deepEqual(store.calls.map((c) => c.where), ['((Amount__n >= 89.98999999999991 OR Amount__n IS NULL)) AND Amount__n IS NULL', '((Amount__n >= 89.98999999999991 OR Amount__n IS NULL)) AND Amount__n IS NOT NULL']);
  const count = await runtime.shim.datastore.aggregate(ctx, runtime.shim.datastore.query(ctx, 'Items', { op: '<', field: 'Amount', value: '100' }), 'count');
  assert.equal(count, 99);
});

test('update and setField write the shadow, so a later numeric sort sees the new value', async () => {
  const { runtime, ctx, store } = live(POS);
  for (const price of POS_PRICES) await runtime.shim.datastore.insert(ctx, 'Add_Discount', { Total_price: price });
  await runtime.shim.datastore.update(ctx, 'Add_Discount', { op: '==', field: 'Total_price', value: '20' }, { Total_price: '2000.00' });
  const q = runtime.shim.datastore.query(ctx, 'Add_Discount', { op: 'true' }, { sort: { field: 'Total_price', dir: 'desc' }, range: { from: 0, to: 0 } });
  assert.equal(await runtime.shim.datastore.field(ctx, q, 'Total_price'), '2000.00');
  await runtime.shim.datastore.setField(ctx, runtime.shim.datastore.query(ctx, 'Add_Discount', { op: '==', field: 'Total_price', value: '15' }), 'Total_price', '');
  const blank = store.tables.get('Add_Discount')!.find((r) => r.Total_price === '');
  assert.equal(blank?.Total_price__n, null);
  assert.deepEqual(await runtime.shim.datastore.column(ctx, runtime.shim.datastore.query(ctx, 'Add_Discount', { op: '>', field: 'Total_price', value: '0' }, { sort: { field: 'Total_price' } }), 'Total_price'), ['100.00', '1000.00', '2000.00']);
});

test('compileCriteria: decimal leaves are a widened superset on the shadow; others are unchanged', () => {
  const dec = POS.Add_Discount;
  assert.equal(compileCriteria({ op: '<=', field: 'Total_price', value: '100.00' }), "Total_price <= '100.00'");
  assert.equal(compileCriteria({ op: '<=', field: 'Total_price', value: '100.00' }, new Set(), dec), '(Total_price__n <= 100.0100000000001 OR Total_price__n IS NULL)');
  assert.equal(compileCriteria({ op: '>', field: 'Total_price', value: '100' }, new Set(), dec), '(Total_price__n >= 99.9899999999999 OR Total_price__n IS NULL)');
  assert.equal(compileCriteria({ op: '==', field: 'Total_price', value: '-5' }, new Set(), dec), '((Total_price__n >= -5.010000000000005 AND Total_price__n <= -4.989999999999995) OR Total_price__n IS NULL)');
  assert.equal(compileCriteria({ op: '!=', field: 'Total_price', value: '5' }, new Set(), dec), '(ROWID IS NOT NULL)');
  // NOT of a superset would be a subset of the negation; the operand is compiled as a subset instead.
  // A NULL shadow makes the bound UNKNOWN and NOT UNKNOWN drops the row, so it is added back.
  assert.equal(compileCriteria({ op: 'not', arg: { op: '<', field: 'Total_price', value: '5' } }, new Set(), dec), '(NOT (Total_price__n < 4.989999999999995) OR Total_price__n IS NULL)');
  assert.equal(compileCriteria({ op: 'not', arg: { op: '>=', field: 'Total_price', value: '5' } }, new Set(), dec), '(NOT (Total_price__n > 5.010000000000005) OR Total_price__n IS NULL)');
  // Deeper under NOT, a subset leaf is FALSE (not UNKNOWN) on a NULL shadow.
  assert.equal(
    compileCriteria({ op: 'not', arg: { op: 'and', args: [{ op: '<', field: 'Total_price', value: '5' }, { op: '>=', field: 'To', value: '2024-01-01' }] } }, new Set(), dec),
    "(NOT ((Total_price__n IS NOT NULL AND Total_price__n < 4.989999999999995) AND To >= '2024-01-01'))",
  );
  assert.equal(compileCriteria({ op: 'not', arg: { op: '==', field: 'Total_price', value: '5' } }, new Set(), dec), '(NOT (ROWID IS NULL))');
  // Not a number: no bound, the exact pass decides.
  assert.equal(compileCriteria({ op: '<', field: 'Total_price', value: 'abc' }, new Set(), dec), '(ROWID IS NOT NULL)');
  const mixed: Criteria = { op: 'and', args: [{ op: '>=', field: 'To', value: '2024-01-01' }, { op: 'isNull', field: 'Total_price' }] };
  assert.equal(compileCriteria(mixed, new Set(), dec), compileCriteria(mixed));
});

const RATE2 = { Rates: { Rate: { shadow: 'Rate__n', scale: 2 } } };

/** Live store with rows inserted in this order; `stale` rows then lose their shadow, as rows that predate the column do. */
async function liveRates(values: string[], stale: string[] = []) {
  const { runtime, ctx, store } = live(RATE2);
  for (const Rate of values) await runtime.shim.datastore.insert(ctx, 'Rates', { Rate });
  for (const row of store.tables.get('Rates')!) if (stale.includes(row.Rate!)) row.Rate__n = null;
  return { runtime, ctx, store };
}

test('zcql-mock: WHERE is three-valued (NULL comparison is UNKNOWN, NOT UNKNOWN is UNKNOWN)', async () => {
  const store = mockDatastore({ T: ['N'] });
  await store.datastore.insert('T', [{ N: 1 }, { N: null }, { N: 9 }]);
  const ids = async (where: string) => (await store.datastore.query('T', where, 300)).map((r) => r.N);
  assert.deepEqual(await ids('N < 5'), ['1']);
  assert.deepEqual(await ids('(NOT N < 5)'), ['9']);
  assert.deepEqual(await ids('(NOT (N < 5 AND N IS NOT NULL))'), [null, '9']);
  assert.deepEqual(await ids('(NOT N < 5 OR N IS NULL)'), [null, '9']);
  assert.deepEqual(await ids('(N < 5 OR N IS NULL)'), ['1', null]);
});

test('zcql-mock comparisons follow declared integer, exact-decimal, and varchar types', async () => {
  const store = mockDatastore({
    T: { Count: 'int', Amount: 'decimal', Label: 'string' },
  });
  await store.datastore.insert('T', [
    { Count: '2', Amount: '2.00', Label: '2' },
    { Count: '4', Amount: '4.00', Label: '4' },
    { Count: '100', Amount: '100.00', Label: '100' },
    { Count: '101', Amount: '100.00000000000000001', Label: '100.00000000000000001' },
  ]);
  const values = async (where: string, column: string) =>
    (await store.datastore.query('T', where, 300)).map((row) => row[column]);

  assert.deepEqual(await values('Count > 100', 'Count'), ['101']);
  assert.deepEqual(await values('Count < 100', 'Count'), ['2', '4']);
  assert.deepEqual(await values('Count = 100', 'Count'), ['100']);

  assert.deepEqual(await values('Amount > 100.00', 'Amount'), ['100.00000000000000001']);
  assert.deepEqual(await values('Amount < 100.00', 'Amount'), ['2.00', '4.00']);
  assert.deepEqual(await values('Amount = 100.00', 'Amount'), ['100.00']);

  // VarChar deliberately retains lexicographic comparison: '2' is greater than
  // '100', and a longer string with the same prefix is greater too.
  assert.deepEqual(await values("Label > '100'", 'Label'), ['2', '4', '100.00000000000000001']);
  assert.deepEqual(await values("Label < '100'", 'Label'), []);
  assert.deepEqual(await values("Label = '100'", 'Label'), ['100']);
});

test('rows whose shadow is null (written before the shadow column existed) are still found', async () => {
  const { runtime, ctx } = await liveRates(['10.00', '3.00', '250.00', ''], ['10.00', '250.00']);
  const q = (c: Criteria, opts?: Parameters<typeof rateValues>[3]) => rateValues(runtime, ctx, c, opts);
  assert.deepEqual(await q({ op: '<=', field: 'Rate', value: '100' }), ['10.00', '3.00']);
  assert.deepEqual(await q({ op: '<', field: 'Rate', value: '100' }), ['10.00', '3.00']);
  assert.deepEqual(await q({ op: '>=', field: 'Rate', value: '5' }), ['10.00', '250.00']);
  assert.deepEqual(await q({ op: '>', field: 'Rate', value: '5' }), ['10.00', '250.00']);
  assert.deepEqual(await q({ op: '==', field: 'Rate', value: '10' }), ['10.00']);
  assert.deepEqual(await q({ op: 'in', field: 'Rate', value: ['10', '3'] }), ['10.00', '3.00']);
  assert.deepEqual(await q({ op: 'not', arg: { op: '!=', field: 'Rate', value: '250' } }), ['250.00']);
  // A decimal sort with a window places a null-shadow row by its exact value, not first.
  assert.deepEqual(await q({ op: 'true' }, { sort: { field: 'Rate' }, range: { from: 0, to: 1 } }), ['', '3.00']);
  assert.deepEqual(await q({ op: 'true' }, { sort: { field: 'Rate' }, range: { from: 2, to: 3 } }), ['3.00', '10.00']);
  assert.deepEqual(await q({ op: 'true' }, { sort: { field: 'Rate', dir: 'desc' }, range: { from: 0, to: 0 } }), ['250.00']);
  assert.deepEqual(await q({ op: '>', field: 'Rate', value: '1' }, { sort: { field: 'Rate', dir: 'desc' }, range: { from: 2, to: 2 } }), ['10.00']);
});

test('NOT of a relational decimal comparison keeps blanks under three-valued ZCQL', async () => {
  const { runtime, ctx } = await liveRates(['', '10.00', '3.00']);
  const not = (op: '<' | '<=' | '>' | '>=', value: string) => rateValues(runtime, ctx, { op: 'not', arg: { op, field: 'Rate', value } });
  assert.deepEqual(await not('<', '5'), ['', '10.00']);
  assert.deepEqual(await not('<=', '3'), ['', '10.00']);
  assert.deepEqual(await not('>', '5'), ['', '3.00']);
  assert.deepEqual(await not('>=', '10'), ['', '3.00']);
  // Nested: NOT (Rate < 5 AND Rate > 1) is true for a blank.
  const nested: Criteria = { op: 'not', arg: { op: 'and', args: [{ op: '<', field: 'Rate', value: '5' }, { op: '>', field: 'Rate', value: '1' }] } };
  assert.deepEqual(await rateValues(runtime, ctx, nested), ['', '10.00']);
});

test('a comparison with an empty value compiles to IS NULL / IS NOT NULL, never `= null`', () => {
  // Deluge `Form[Field == input.X]` with X empty matches the rows where Field
  // is empty; ZCQL has no `= null` (the store refuses it as a syntax error).
  assert.equal(compileCriteria({ op: '==', field: 'Email', value: null }), 'Email IS NULL');
  assert.equal(compileCriteria({ op: '!=', field: 'Email', value: undefined }), 'Email IS NOT NULL');
  assert.equal(
    compileCriteria({ op: 'and', args: [{ op: '==', field: 'Email', value: null }, { op: '==', field: 'Status', value: 'Open' }] }),
    "(Email IS NULL AND Status = 'Open')",
  );
  // A decimal column with an empty value is the same NULL test, not a shadow bound.
  const decimals = { Amount: { shadow: 'Amount_c2c_num', scale: 2 } };
  assert.equal(compileCriteria({ op: '==', field: 'Amount', value: null }, new Set(), decimals), 'Amount IS NULL');
  // A value is still a literal comparison.
  assert.equal(compileCriteria({ op: '==', field: 'Email', value: 'a@b.c' }), "Email = 'a@b.c'");
});
