/**
 * Re-runs are idempotent. A stored row is compared to the source value
 * canonically: a DateTime reads equal with or without the :SSS suffix or a
 * T/Z form, a decimal reads equal at any scale spelling, a boolean reads equal
 * as JSON or text, and a stored NULL equals a sent empty. An identical value
 * is never a silent change.
 *
 * A stored NULL in a column the source now supplies is a fill, not a refusal —
 * but only for the system timestamps (Added_Time, Modified_Time) and columns
 * the load marks as adding a value. The fill updates the stored row by ROWID.
 * Every other stored difference stays a silent-change refusal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCheckpoint, migrateData, type FetchLike } from '../src/migrate.js';
import { changedColumns, type IntegrityColumn } from '../src/integrity.js';
import { quantizeDecimal } from '../../shims/src/decimal.js';
import { catalystFailure, quirkRowServer, textResponse, type QuirkHandle } from './catalyst-row-fake.js';

const SCOPE = { org: '10000000000', projectId: '10000000000000001', token: 'cli-token' };

const columns: IntegrityColumn[] = [
  { name: 'Name', dataType: 'VarChar', length: 50 },
  { name: 'When', dataType: 'Date' },
  { name: 'At', dataType: 'DateTime' },
  { name: 'Amount', dataType: 'Double', scale: 2 },
  { name: 'Flag', dataType: 'Boolean' },
  { name: 'Note', dataType: 'Text' },
  { name: 'Added_Time', dataType: 'DateTime' },
  { name: 'Modified_Time', dataType: 'DateTime' },
];

const bases = {
  dc: 'in',
  creatorBase: 'https://www.zohoapis.in',
  catalystBase: 'https://api.catalyst.zoho.in',
  owner: 'owner',
  appLink: 'demo',
  scope: SCOPE,
};

function creator(rows: Record<string, unknown>[]): FetchLike {
  return async (_url, init) => {
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('creator fake got a write');
    const body = JSON.stringify({ code: 3000, data: rows });
    return { status: 200, headers: { get: () => null }, text: async () => body };
  };
}

function route(page: FetchLike, store: QuirkHandle, wrap: (next: FetchLike) => FetchLike = (next) => next): FetchLike {
  const inner = wrap(store.fetch);
  return async (url, init) => ((init?.method ?? 'GET') === 'GET' ? page(url, init) : inner(url, init));
}

function run(page: FetchLike, store: QuirkHandle, extra: Record<string, unknown> = {}, wrap?: (next: FetchLike) => FetchLike) {
  return migrateData({ ...bases, tables: tables(extra), dryRun: false, fetch: route(page, store, wrap), checkpoint: emptyCheckpoint() });
}

function tables(extra: Record<string, unknown> = {}) {
  return [{ report: 'All_Vendors', table: 'Vendor', integrityColumns: columns, ...extra }];
}

function refusalRules(result: { integrity?: { refusedByRule: { rule: string }[] } }): string[] {
  return (result.integrity?.refusedByRule ?? []).map((group) => group.rule);
}

test('an identical re-run writes nothing: :SSS datetime, T/Z forms, decimals and booleans compare canonically', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', {
    c2c_source_id: 's1',
    ROWID: '10000000000013003',
    Name: 'Ada',
    When: '2026-10-05',
    At: '2026-10-05 09:08:07:000',
    Amount: 0.1,
    Flag: true,
    Added_Time: '2026-10-05T09:08:07Z',
    Modified_Time: '2026-10-05 09:08:07:000',
  });
  const page = creator([
    {
      ID: 's1',
      Name: 'Ada',
      When: '2026-10-05',
      At: '2026-10-05 09:08:07',
      Amount: '0.10',
      Flag: 'true',
      Added_Time: '2026-10-05 09:08:07',
      Modified_Time: '2026-10-05 09:08:07',
    },
  ]);
  const result = await migrateData({
    ...bases,
    tables: tables(),
    dryRun: false,
    fetch: route(page, store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(result.ok, true);
  assert.equal(store.posts.length, 0);
  assert.equal(store.puts.length, 0);
  assert.equal(refusalRules(result).length, 0);
  assert.equal(result.tables[0]?.writtenCount, 1);
});

test('a stored NULL the source supplies for a system timestamp is filled by ROWID, then never again', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', {
    c2c_source_id: 's1',
    ROWID: '10000000000013004',
    Name: 'Ada',
    Added_Time: null,
    Modified_Time: null,
  });
  const page = creator([
    { ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07', Modified_Time: '2026-10-05 10:00:00' },
  ]);
  const first = await migrateData({
    ...bases,
    tables: tables(),
    dryRun: false,
    fetch: route(page, store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(first.ok, true);
  assert.equal(store.posts.length, 0);
  assert.equal(store.puts.length, 1);
  const update = store.puts[0]?.[0];
  assert.equal(update?.ROWID, '10000000000013004');
  assert.equal(update?.Added_Time, '2026-10-05 09:08:07');
  assert.equal(update?.Modified_Time, '2026-10-05 10:00:00');
  assert.equal(update?.c2c_source_id, undefined);
  assert.equal(refusalRules(first).length, 0);
  assert.equal(first.tables[0]?.filledNulls, 2);
  assert.equal(first.integrity?.filledNulls, 2);
  const kept = store.stored.get('Vendor\0s1');
  assert.equal(kept?.Added_Time, '2026-10-05 09:08:07');
  assert.equal(kept?.Modified_Time, '2026-10-05 10:00:00');

  const second = await migrateData({
    ...bases,
    tables: tables(),
    dryRun: false,
    fetch: route(page, store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(second.ok, true);
  assert.equal(store.posts.length, 0);
  assert.equal(store.puts.length, 1);
  assert.equal(second.tables[0]?.filledNulls ?? 0, 0);
  assert.equal(second.integrity?.filledNulls, 0);
});

test('a column the load marks as adding a value is filled; an unmarked NULL stays a refusal', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013005', Name: 'Ada', Note: null });
  const page = creator([{ ID: 's1', Name: 'Ada', Note: 'restocked' }]);
  const marked = await migrateData({
    ...bases,
    tables: tables({ fillNullColumns: ['Note'] }),
    dryRun: false,
    fetch: route(page, store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(marked.ok, true);
  assert.equal(store.puts.length, 1);
  assert.equal(store.puts[0]?.[0]?.Note, 'restocked');
  assert.equal(marked.tables[0]?.filledNulls, 1);

  const plain = quirkRowServer();
  plain.addStored('Vendor', { c2c_source_id: 's2', ROWID: '10000000000013007', Name: 'Ada', Note: null });
  const refused = await migrateData({
    ...bases,
    tables: tables(),
    dryRun: false,
    fetch: route(creator([{ ID: 's2', Name: 'Ada', Note: 'restocked' }]), plain),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(refused.ok, false);
  assert.equal(plain.puts.length, 0);
  assert.equal(plain.posts.length, 0);
  assert.deepEqual(refusalRules(refused), ['silent-change']);
  assert.deepEqual(refused.integrity?.refusedByRule[0]?.rows[0], { table: 'Vendor', column: 'Note', sourceId: 's2' });
});

test('a changed business value is still a silent-change refusal', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', {
    c2c_source_id: 's1',
    ROWID: '10000000000013008',
    Name: 'Ada',
    At: '2026-10-05 09:08:07:500',
  });
  const page = creator([{ ID: 's1', Name: 'Grace', At: '2026-10-05 09:08:07' }]);
  const result = await migrateData({
    ...bases,
    tables: tables(),
    dryRun: false,
    fetch: route(page, store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(result.ok, false);
  assert.equal(store.posts.length, 0);
  assert.equal(store.puts.length, 0);
  assert.deepEqual(refusalRules(result), ['silent-change']);
  const refused = result.integrity?.refusedByRule[0]?.rows.map((row) => row.column).sort();
  assert.deepEqual(refused, ['At', 'Name']);
});

test('a stored NULL equals a sent empty; a stored value against a sent empty is refused', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013009', Name: 'Ada', Note: null });
  const empty = await migrateData({
    ...bases,
    tables: tables(),
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'Ada', Note: '' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(empty.ok, true);
  assert.equal(store.puts.length, 0);
  assert.equal(refusalRules(empty).length, 0);

  const full = quirkRowServer();
  full.addStored('Vendor', { c2c_source_id: 's2', ROWID: '10000000000013011', Name: 'Ada', Note: 'kept' });
  const cleared = await migrateData({
    ...bases,
    tables: tables(),
    dryRun: false,
    fetch: route(creator([{ ID: 's2', Name: 'Ada', Note: '' }]), full),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(cleared.ok, false);
  assert.deepEqual(refusalRules(cleared), ['silent-change']);
  assert.deepEqual(cleared.integrity?.refusedByRule[0]?.rows[0], { table: 'Vendor', column: 'Note', sourceId: 's2' });
});

/** Refusals as `rule:sourceId.column` so the exact cell is pinned, not just the rule. */
function refusalCells(result: { integrity?: { refusedByRule: { rule: string; rows: { column: string; sourceId: string }[] }[] } }): string[] {
  return (result.integrity?.refusedByRule ?? []).map((group) => `${group.rule}:${group.rows.map((row) => `${row.sourceId}.${row.column}`).join(',')}`);
}

const col = (dataType: string, extra: Partial<IntegrityColumn> = {}): IntegrityColumn => ({ name: 'c', dataType, ...extra });

test('canonical compare: DateTime spellings, a Date with a stored time, and Boolean text', () => {
  const cases: [label: string, column: IntegrityColumn, sent: unknown, stored: unknown, same: boolean][] = [
    ['DateTime :SSS fraction', col('DateTime'), '2026-10-05 09:08:07', '2026-10-05 09:08:07:000', true],
    ['DateTime +1ms', col('DateTime'), '2026-10-05 09:08:07', '2026-10-05 09:08:07:001', false],
    ['DateTime .5 fraction', col('DateTime'), '2026-10-05 09:08:07', '2026-10-05 09:08:07.5', false],
    ['DateTime micro fraction', col('DateTime'), '2026-10-05 09:08:07', '2026-10-05 09:08:07.000123', false],
    ['DateTime T/Z spelling', col('DateTime'), '2026-10-05 09:08:07', '2026-10-05T09:08:07Z', true],
    ['DateTime +05:30 offset', col('DateTime'), '2026-10-05 09:08:07', '2026-10-05 09:08:07+05:30', false],
    ['DateTime +00:00 offset', col('DateTime'), '2026-10-05 09:08:07', '2026-10-05 09:08:07+00:00', false],
    ['DateTime one second later', col('DateTime'), '2026-10-05 09:08:07', '2026-10-05 09:08:08', false],
    ['DateTime another day', col('DateTime'), '2026-10-05 09:08:07', '2026-10-06 09:08:07', false],
    ['DateTime dd-MMM-yyyy spelling', col('DateTime'), '2026-10-05 09:08:07', '05-Oct-2026 09:08:07', true],
    ['DateTime column, date-only sent', col('DateTime'), '2026-10-05', '2026-10-05 00:00:00', false],
    ['DateTime column, date-only stored', col('DateTime'), '2026-10-05 00:00:00', '2026-10-05', false],
    ['Date vs stored midnight', col('Date'), '2026-10-05', '2026-10-05 00:00:00', true],
    ['Date vs 00:00:01', col('Date'), '2026-10-05', '2026-10-05 00:00:01', false],
    ['Date vs :001 fraction', col('Date'), '2026-10-05', '2026-10-05 00:00:00:001', false],
    ['Date another day', col('Date'), '2026-10-05', '2026-10-06', false],
    ['Date dd-MMM-yyyy spelling', col('Date'), '2026-10-05', '05-Oct-2026', true],
    ['Boolean text false vs false', col('Boolean'), 'false', false, true],
    ['Boolean FALSE vs false', col('Boolean'), 'FALSE', false, true],
    ['Boolean text false vs true', col('Boolean'), 'false', true, false],
    ['Boolean 0 vs false', col('Boolean'), '0', false, false],
    ['Boolean empty vs false', col('Boolean'), '', false, false],
    ['Boolean empty vs NULL', col('Boolean'), '', null, true],
    ['Boolean false vs NULL', col('Boolean'), false, null, false],
    ['Boolean true vs 1', col('Boolean'), 'true', '1', false],
  ];
  for (const [label, column, sent, stored, expectSame] of cases) {
    const same = changedColumns({ c: sent }, { c: stored }, [column]).length === 0;
    assert.equal(same, expectSame, label);
  }
});

test('two stored rows for one source id refuse the re-run and block every write', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013101', Name: 'Ada', Added_Time: null });
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013200', Name: 'Ada', Added_Time: null });
  const result = await run(creator([{ ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' }]), store);
  assert.equal(result.ok, false);
  assert.equal(store.puts.length, 0);
  assert.equal(store.posts.length, 0);
  assert.deepEqual(refusalRules(result), ['duplicate-source-id']);
});

test('a changed business column blocks the NULL timestamp fill on the same row', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013101', Name: 'Ada', Added_Time: null });
  const result = await run(creator([{ ID: 's1', Name: 'Grace', Added_Time: '2026-10-05 09:08:07' }]), store);
  assert.equal(result.ok, false);
  assert.equal(store.puts.length, 0);
  assert.equal(store.stored.get('Vendor\0s1')?.Added_Time, null);
  assert.deepEqual(refusalCells(result), ['silent-change:s1.Name']);
});

test('a stored non-NULL timestamp that differs is refused, never overwritten', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013101', Name: 'Ada', Added_Time: '2026-01-01 00:00:00' });
  const result = await run(creator([{ ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' }]), store);
  assert.equal(result.ok, false);
  assert.equal(store.puts.length, 0);
  assert.equal(store.stored.get('Vendor\0s1')?.Added_Time, '2026-01-01 00:00:00');
  assert.deepEqual(refusalCells(result), ['silent-change:s1.Added_Time']);
});

test('the fill PUT body holds only ROWID and the filled columns', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', {
    c2c_source_id: 's1',
    ROWID: '10000000000013101',
    Name: 'Ada',
    Note: 'x',
    Added_Time: null,
    Modified_Time: '2026-10-05 10:00:00',
  });
  const result = await run(
    creator([{ ID: 's1', Name: 'Ada', Note: 'x', Added_Time: '2026-10-05 09:08:07', Modified_Time: '2026-10-05 10:00:00' }]),
    store,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(store.puts, [[{ ROWID: '10000000000013101', Added_Time: '2026-10-05 09:08:07' }]]);
});

test('a 17-digit ROWID is kept exact in the fill PUT', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000315013', Name: 'Ada', Added_Time: null });
  const result = await run(creator([{ ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' }]), store);
  assert.equal(result.ok, true);
  assert.equal(store.puts[0]?.[0]?.ROWID, '10000000000315013');
});

test('a stored row without a ROWID refuses the fill: nothing is written', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: null, Name: 'Ada', Added_Time: null });
  const result = await run(creator([{ ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' }]), store);
  assert.equal(result.ok, false);
  assert.equal(store.puts.length, 0);
  assert.equal(store.stored.get('Vendor\0s1')?.Added_Time, null);
  assert.deepEqual(refusalCells(result), ['silent-change:s1.Added_Time']);
});

test('a fill the store drops is a silent-change refusal after the read-back', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013101', Name: 'Ada', Added_Time: null });
  // The store answers 200 but drops the value.
  const drop = (next: FetchLike): FetchLike =>
    async (url, init) => (init?.method === 'PUT' ? textResponse(JSON.stringify({ status: 'success', data: [] })) : next(url, init));
  const result = await run(creator([{ ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' }]), store, {}, drop);
  assert.equal(result.ok, false);
  assert.equal(result.integrity?.filledNulls, 0);
  assert.deepEqual(refusalCells(result), ['silent-change:s1.Added_Time']);
});

test('a fill the store keeps as a different instant is a silent-change refusal', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013101', Name: 'Ada', Added_Time: null });
  const skew = (next: FetchLike): FetchLike =>
    async (url, init) => (init?.method === 'PUT' ? next(url, { ...init, body: init.body?.replace('09:08:07', '09:08:08') }) : next(url, init));
  const result = await run(creator([{ ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' }]), store, {}, skew);
  assert.equal(result.ok, false);
  assert.equal(result.integrity?.filledNulls, 0);
  assert.deepEqual(refusalCells(result), ['silent-change:s1.Added_Time']);
});

test('one changed row in a slice blocks every fill in it', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013101', Name: 'Ada', Added_Time: null });
  store.addStored('Vendor', { c2c_source_id: 's2', ROWID: '10000000000013200', Name: 'Bob', Added_Time: '2026-10-05 09:08:07' });
  const result = await run(
    creator([
      { ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' },
      { ID: 's2', Name: 'Bobby', Added_Time: '2026-10-05 09:08:07' },
    ]),
    store,
  );
  assert.equal(result.ok, false);
  assert.equal(store.puts.length, 0);
  assert.equal(store.posts.length, 0);
  assert.equal(store.stored.get('Vendor\0s1')?.Added_Time, null);
  assert.deepEqual(refusalCells(result), ['silent-change:s2.Name']);
});

test('one pre-write refusal in a slice blocks every fill in it', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013101', Name: 'Ada', Added_Time: null });
  store.addStored('Vendor', { c2c_source_id: 's2', ROWID: '10000000000013200', Name: 'Bob' });
  const result = await run(
    creator([
      { ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' },
      { ID: 's2', Name: 'x'.repeat(60) },
    ]),
    store,
  );
  assert.equal(result.ok, false);
  assert.equal(store.puts.length, 0);
  assert.equal(store.stored.get('Vendor\0s1')?.Added_Time, null);
  assert.deepEqual(refusalRules(result), ['text-length']);
});

test('a fill update that fails after the store applied it throws; the re-run converges', async () => {
  const store = quirkRowServer({ errorAfterWrite: true });
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013101', Name: 'Ada', Added_Time: null });
  const page = creator([{ ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' }]);
  const failed = await run(page, store);
  assert.equal(failed.ok, false);
  assert.match(failed.tables[0].error ?? '', /catalyst row update failed: 400 INVALID_INPUT/);
  assert.equal(store.puts.length, 1);
  assert.equal(store.stored.get('Vendor\0s1')?.Added_Time, '2026-10-05 09:08:07');
  const second = await run(page, store);
  assert.equal(second.ok, true);
  assert.equal(store.puts.length, 1);
  assert.equal(second.integrity?.filledNulls, 0);
});

test('a failed update batch keeps the count of fills already sent; the re-run fills the rest', async () => {
  const store = quirkRowServer();
  const source: Record<string, unknown>[] = [];
  for (let k = 0; k < 201; k += 1) {
    const id = `s${String(k).padStart(3, '0')}`;
    store.addStored('Vendor', { c2c_source_id: id, ROWID: String(10000000000315012n + BigInt(k)), Name: 'Ada', Added_Time: null });
    source.push({ ID: id, Name: 'Ada', Added_Time: '2026-10-05 09:08:07' });
  }
  let putCalls = 0;
  const failSecond = (next: FetchLike): FetchLike =>
    async (url, init) => {
      if (init?.method === 'PUT' && (putCalls += 1) === 2) return catalystFailure(500, 'INTERNAL_SERVER_ERROR', 'Internal Server Error');
      return next(url, init);
    };
  const page = creator(source);
  const failed = await run(page, store, {}, failSecond);
  assert.equal(failed.ok, false);
  assert.match(failed.tables[0].error ?? '', /catalyst row update failed: 500.*200 stored cell update/);
  const filledAfterThrow = [...store.stored.values()].filter((row) => row.Added_Time).length;
  assert.equal(filledAfterThrow, 200);
  const second = await run(page, store);
  assert.equal(second.ok, true);
  assert.equal([...store.stored.values()].filter((row) => row.Added_Time).length, 201);
  assert.equal(second.integrity?.filledNulls, 1);
  const third = await run(page, store);
  assert.equal(third.ok, true);
  assert.equal(third.integrity?.filledNulls, 0);
});

test('a dry run never writes a fill', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013101', Name: 'Ada', Added_Time: null });
  await migrateData({
    ...bases,
    tables: tables(),
    dryRun: true,
    fetch: route(creator([{ ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(store.puts.length, 0);
});

test('the fill update and its read-back address only the table being loaded', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013101', Name: 'Ada', Added_Time: null });
  const urls: string[] = [];
  const spy = (next: FetchLike): FetchLike =>
    async (url, init) => {
      urls.push(`${init?.method} ${new URL(url).pathname}`);
      return next(url, init);
    };
  const result = await run(creator([{ ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' }]), store, {}, spy);
  assert.equal(result.ok, true);
  const puts = urls.filter((line) => line.startsWith('PUT'));
  assert.ok(puts.length > 0);
  assert.ok(puts.every((line) => line.includes('/table/Vendor/row')));
});

test('a fill ROWID that only exists on another table is refused by the store', async () => {
  const store = quirkRowServer();
  store.addStored('Other', { c2c_source_id: 'x1', ROWID: '10000000000315014', Name: 'Elsewhere' });
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000013101', Name: 'Ada', Added_Time: null });
  // The stored-row read for Vendor echoes a row addressed by a ROWID that only
  // exists on table Other. The update must not reach the other table's row.
  const forge = (next: FetchLike): FetchLike =>
    async (url, init) => {
      if (init?.method === 'POST' && url.endsWith('/query')) {
        const query = String((JSON.parse(init.body ?? '{}') as { query?: string }).query ?? '');
        if (/\bFROM\s+Vendor\b/.test(query) && /\bROWID\b/.test(query)) {
          return textResponse(
            JSON.stringify({
              status: 'success',
              data: [{ c2c_source_id: 's1', ROWID: '10000000000315014', Name: 'Ada', Added_Time: null }],
            }),
          );
        }
      }
      return next(url, init);
    };
  const forged = await run(creator([{ ID: 's1', Name: 'Ada', Added_Time: '2026-10-05 09:08:07' }]), store, {}, forge);
  assert.equal(forged.ok, false);
  assert.match(forged.tables[0].error ?? '', /catalyst row update failed: 400/);
  assert.equal(store.stored.get('Other\0x1')?.Added_Time, undefined);
});

const fkColumns: IntegrityColumn[] = [...columns, { name: 'Author', dataType: 'Foreign Key' }];
const AUTHOR_ROWID = '45759510000278003';
const OTHER_ROWID = '10000000008009043';

test('a re-run corrects a lookup cell still holding a raw source id: ROWID update, read-back, counted', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', {
    c2c_source_id: 's1',
    ROWID: '10000000000013200',
    Name: 'Ada',
    // The raw Creator record id the pre-remap loader stored in the lookup cell.
    Author: 'author-src-9',
  });
  const rerun = {
    integrityColumns: fkColumns,
    lookupSourceIds: { Author: new Map([['author-src-9', AUTHOR_ROWID]]) },
  };
  const page = creator([{ ID: 's1', Name: 'Ada', Author: AUTHOR_ROWID }]);
  const result = await run(page, store, rerun);
  assert.equal(result.ok, true, JSON.stringify(result.integrity?.refusedByRule));
  assert.equal(result.integrity?.correctedLookups, 1);
  assert.equal(result.tables[0]?.correctedLookups, 1);
  // One PUT, addressed by ROWID, carrying only the corrected cell.
  assert.deepEqual(store.puts, [[{ ROWID: '10000000000013200', Author: AUTHOR_ROWID }]]);
  assert.equal(store.stored.get('Vendor\0s1')?.Author, AUTHOR_ROWID);
  assert.equal(refusalRules(result).length, 0);
  const again = await run(page, store, rerun);
  assert.equal(again.ok, true);
  assert.equal(again.integrity?.correctedLookups ?? 0, 0);
  assert.equal(store.puts.length, 1);
});

test('a stored lookup value that is not the known source id stays a silent-change refusal', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000315015', Name: 'Ada', Author: OTHER_ROWID });
  const result = await run(creator([{ ID: 's1', Name: 'Ada', Author: AUTHOR_ROWID }]), store, {
    integrityColumns: fkColumns,
    lookupSourceIds: { Author: new Map([['author-src-9', AUTHOR_ROWID]]) },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(refusalRules(result), ['silent-change']);
  assert.equal(store.puts.length, 0);
  assert.equal(store.stored.get('Vendor\0s1')?.Author, OTHER_ROWID);
});

test('a raw source id in a column with no remap stays a silent-change refusal', async () => {
  const store = quirkRowServer();
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000315016', Name: 'Ada', Author: 'author-src-9' });
  const result = await run(creator([{ ID: 's1', Name: 'Ada', Author: AUTHOR_ROWID }]), store, {
    integrityColumns: fkColumns,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(refusalRules(result), ['silent-change']);
  assert.equal(store.puts.length, 0);
});

test('a value rounded to the column scale reads equal to its stored spelling on a re-run, and the read-back agrees', async () => {
  const priced: IntegrityColumn[] = [
    { name: 'Name', dataType: 'VarChar', length: 50 },
    { name: 'Price', dataType: 'VarChar', length: 64, scale: 2, exactDecimal: true },
    { name: 'Rate', dataType: 'Double', scale: 2 },
    { name: 'At', dataType: 'DateTime' },
  ];
  const price = quantizeDecimal('12.345', 2);
  const rate = quantizeDecimal('0.1', 2);
  assert.equal(price, '12.35');
  const store = quirkRowServer();
  store.addStored('Vendor', {
    c2c_source_id: 's1',
    ROWID: '10000000000000012',
    Name: 'Ada',
    Price: '12.350',
    Rate: 0.1,
    At: '2026-10-05 09:08:07:000',
  });
  const page = creator([{ ID: 's1', Name: 'Ada', Price: price, Rate: rate, At: '2026-10-05 09:08:07' }]);
  const result = await migrateData({
    ...bases,
    tables: [{ report: 'All_Vendors', table: 'Vendor', integrityColumns: priced }],
    dryRun: false,
    fetch: route(page, store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(result.ok, true);
  assert.equal(store.posts.length, 0);
  assert.equal(store.puts.length, 0);
  assert.equal(refusalRules(result).length, 0);
  const table = result.tables[0]!;
  assert.equal(table.mismatch, false);
  assert.equal(table.differingIds, undefined);
  assert.equal(table.writtenValueChecksum, table.sourceValueChecksum);
});
