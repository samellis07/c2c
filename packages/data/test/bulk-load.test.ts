import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bulkLoad,
  BulkLoadError,
  chunkCsv,
  emptyBulkCheckpoint,
  type BulkCheckpoint,
  type BulkRow,
  type BulkSourceTable,
} from '../src/bulk-load.js';
import { runOrDefer, runWorkSlice, type WorkStatus } from '../../shims/src/long-work.js';
import { FakeBulkStore, parseCsv } from './bulk-fake-store.js';

const noWait = async (): Promise<void> => {};

/** A lazy source that counts how many rows it has handed out. */
function source(table: string, count: number, make: (i: number) => BulkRow): BulkSourceTable & { produced: number } {
  const out = {
    table,
    produced: 0,
    rows: function* () {
      for (let i = 0; i < count; i++) {
        out.produced += 1;
        yield make(i);
      }
    },
  };
  return out;
}

const customer = (i: number): BulkRow => ({ id: `C${i}`, columns: { Name: `Customer ${i}`, Credit: `${i % 100}.25` } });
const order = (customers: number) => (i: number): BulkRow => ({
  id: `O${i}`,
  columns: { Customer: `C${i % customers}`, Total: `${i}.50`, Note: i % 7 === 0 ? 'has, a comma and "quotes"' : 'plain' },
});

function assertExactlyOnce(store: FakeBulkStore, table: string, count: number, prefix: string): void {
  const ids = store.sourceIds(table);
  assert.equal(ids.length, count, `${table} row count`);
  const unique = new Set(ids);
  assert.equal(unique.size, count, `${table} has no repeated source id`);
  for (let i = 0; i < count; i++) assert.ok(unique.has(`${prefix}${i}`), `${table} holds ${prefix}${i}`);
}

function assertLookups(store: FakeBulkStore, customers: number): void {
  const parents = store.table('Customer');
  for (const row of store.table('Orders').rows.values()) {
    const i = Number(row.c2c_source_id!.slice(1));
    assert.equal(row.Customer, parents.bySource.get(`C${i % customers}`), `Orders ${row.c2c_source_id} points at its parent ROWID`);
  }
}

test('dry run is the default and never touches the store', async () => {
  const store = new FakeBulkStore();
  const result = await bulkLoad({ tables: [source('Customer', 50, customer)], bucket: 'b', prefix: 'load', store });
  assert.equal(result.dryRun, true);
  assert.equal(result.ok, true);
  assert.equal(result.tables[0]!.source, 50);
  assert.equal(store.calls, 0);
});

test('10k rows load in chunks with lookups remapped per chunk; no table-wide id map', async () => {
  const store = new FakeBulkStore();
  const customers = source('Customer', 1000, customer);
  const orders = source('Orders', 10_000, order(1000));
  const result = await bulkLoad({
    tables: [orders, customers],
    foreignKeys: [{ table: 'Orders', column: 'Customer', parent: 'Customer' }],
    bucket: 'c2c-load',
    prefix: 'run-1',
    dryRun: false,
    store,
    chunkRows: 2000,
    wait: noWait,
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.tables.map((t) => [t.table, t.source, t.loaded]), [['Customer', 1000, 1000], ['Orders', 10_000, 10_000]]);
  assert.deepEqual(result.tables[1]!.fk, [{ column: 'Customer', parent: 'Customer', via: 'remap' }]);
  assertExactlyOnce(store, 'Customer', 1000, 'C');
  assertExactlyOnce(store, 'Orders', 10_000, 'O');
  assertLookups(store, 1000);
  assert.ok(store.maxInIds <= 300, 'every ZCQL IN read stays within 300 ids');
  assert.ok(Math.max(...store.objectRows) <= 2000, 'no CSV object is larger than a chunk');
  const note = [...store.table('Orders').rows.values()].find((row) => row.c2c_source_id === 'O7');
  assert.equal(note?.Note, 'has, a comma and "quotes"', 'CSV quoting round-trips');
});

test('50k rows with fk_mapping and a self lookup: no loss, bounded memory', async () => {
  const store = new FakeBulkStore({ 'Orders.Customer': 'Customer' });
  store.table('Customer').unique.add('Code');
  const customers = source('Customer', 500, (i) => ({ id: `C${i}`, columns: { Code: `C${i}`, Name: `n${i}` } }));
  const orders = source('Orders', 50_000, (i) => ({
    id: `O${i}`,
    columns: { Customer: `C${i % 500}`, ...(i > 0 ? { Previous: `O${i - 1}` } : {}) },
  }));
  let worst = 0;
  store.beforePut = () => {
    // Rows the source has handed out but the store has not been sent yet.
    const sent = store.objectRows.reduce((n, rows) => n + rows, 0);
    worst = Math.max(worst, customers.produced + orders.produced - sent);
  };
  const result = await bulkLoad({
    tables: [customers, orders],
    foreignKeys: [
      { table: 'Orders', column: 'Customer', parent: 'Customer' },
      { table: 'Orders', column: 'Previous', parent: 'Orders' },
    ],
    uniqueReference: { Customer: 'Code' },
    bucket: 'c2c-load',
    prefix: 'run-50k',
    dryRun: false,
    store,
    chunkRows: 5000,
    wait: noWait,
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.tables[1]!.fk.map((edge) => edge.via), ['fk_mapping', 'deferred']);
  assertExactlyOnce(store, 'Orders', 50_000, 'O');
  assertLookups(store, 500);
  const orderRows = store.table('Orders');
  for (const row of orderRows.rows.values()) {
    const i = Number(row.c2c_source_id!.slice(1));
    if (i === 0) assert.equal(row.Previous, undefined);
    else assert.equal(row.Previous, orderRows.bySource.get(`O${i - 1}`), 'self lookup resolved to the ROWID');
  }
  assert.ok(worst <= 5000, `at most one chunk is buffered (worst ${worst})`);
  assert.ok(store.objectRows.length >= 10, 'the 50k rows went out as separate chunk jobs');
});

test('fk_mapping on a reference column that is not unique fails the chunk with the store message, and nothing is lost', async () => {
  const store = new FakeBulkStore({ 'Orders.Customer': 'Customer' });
  const result = bulkLoad({
    tables: [source('Customer', 10, customer), source('Orders', 10, order(10))],
    foreignKeys: [{ table: 'Orders', column: 'Customer', parent: 'Customer' }],
    uniqueReference: { Customer: 'c2c_source_id' },
    bucket: 'b',
    prefix: 'p',
    dryRun: false,
    store,
    wait: noWait,
  });
  await assert.rejects(result, (err: unknown) => {
    assert.ok(err instanceof BulkLoadError);
    assert.match(err.message, /The reference_column 'c2c_source_id' in fk_mapping of table Orders is not a unique column/);
    return true;
  });
  assert.equal(store.sourceIds('Orders').length, 0);
});

test('a mid-load failure resumes from the saved checkpoint without a duplicate row', async () => {
  const store = new FakeBulkStore();
  let saved: BulkCheckpoint = emptyBulkCheckpoint();
  const save = (checkpoint: BulkCheckpoint): void => {
    saved = JSON.parse(JSON.stringify(checkpoint)) as BulkCheckpoint;
  };
  const opts = () => ({
    tables: [source('Customer', 300, customer), source('Orders', 12_000, order(300))],
    foreignKeys: [{ table: 'Orders', column: 'Customer', parent: 'Customer' }],
    bucket: 'b',
    prefix: 'p',
    dryRun: false,
    store,
    chunkRows: 2500,
    wait: noWait,
    saveCheckpoint: save,
  });
  // Job 3 is accepted and its rows land, but the reply is lost before the checkpoint records it.
  store.afterCreate = (job) => {
    if (job === 3) throw new Error('socket hang up');
  };
  await assert.rejects(bulkLoad({ ...opts(), checkpoint: saved }), /socket hang up/);
  const landedBefore = store.sourceIds('Orders').length;
  assert.ok(landedBefore > 0 && landedBefore < 12_000);
  // A second crash, this time before the upload of a later chunk.
  store.afterCreate = undefined;
  let puts = 0;
  store.beforePut = () => {
    if (++puts === 2) throw new Error('upload reset');
  };
  await assert.rejects(bulkLoad({ ...opts(), checkpoint: JSON.parse(JSON.stringify(saved)) as BulkCheckpoint }), /upload reset/);
  store.beforePut = undefined;
  const result = await bulkLoad({ ...opts(), checkpoint: JSON.parse(JSON.stringify(saved)) as BulkCheckpoint });
  assert.equal(result.ok, true, result.error);
  assertExactlyOnce(store, 'Customer', 300, 'C');
  assertExactlyOnce(store, 'Orders', 12_000, 'O');
  assertLookups(store, 300);
  assert.equal(result.tables[1]!.loaded, 12_000);
  // Running again is a no-op.
  const calls = store.calls;
  const again = await bulkLoad({ ...opts(), checkpoint: JSON.parse(JSON.stringify(saved)) as BulkCheckpoint });
  assert.equal(again.ok, true);
  assert.equal(store.calls, calls, 'a finished checkpoint sends nothing');
});

test('a deadline stops between chunks; the next slice resumes', async () => {
  const store = new FakeBulkStore();
  const checkpoint = emptyBulkCheckpoint();
  let clock = 0;
  const run = () =>
    bulkLoad({
      tables: [source('Customer', 10_000, customer)],
      bucket: 'b',
      prefix: 'p',
      dryRun: false,
      store,
      chunkRows: 1000,
      wait: noWait,
      checkpoint,
      now: () => (clock += 1),
      deadline: clock + 7,
    });
  let slices = 1;
  let result = await run();
  assert.equal(result.complete, false, 'the first slice stops at its deadline');
  assert.equal(result.ok, false);
  while (!result.complete) {
    slices += 1;
    assert.ok(slices < 20, 'slices make progress');
    result = await run();
  }
  assert.ok(slices >= 2, 'the load needed more than one slice');
  assert.equal(result.ok, true);
  assertExactlyOnce(store, 'Customer', 10_000, 'C');
});

test('writes the store would alter are refused before the write; roundScale rounds half up', async () => {
  const columns = {
    Item: [
      { name: 'Code', dataType: 'VarChar', length: 5 },
      { name: 'Price', dataType: 'Double', scale: 2 },
      { name: 'Due', dataType: 'Date' },
    ],
  };
  const rows: BulkRow[] = [
    { id: 'I1', columns: { Code: 'ok', Price: '0.105', Due: '2026-10-05' } },
    { id: 'I2', columns: { Code: 'toolong', Price: '1.5', Due: '2026-10-05' } },
    { id: 'I3', columns: { Code: 'ok', Price: '-0.015', Due: '05-10-2026' } },
    { id: 'I4', columns: { Code: 'ok', Price: '2.345', Due: '05-Oct-2026' } },
  ];
  const strict = await bulkLoad({ tables: [{ table: 'Item', rows: () => rows }], columnsByTable: columns, bucket: 'b', prefix: 'p' });
  assert.equal(strict.ok, false);
  assert.deepEqual(
    strict.refusals.map((item) => [item.id, item.column, item.rule]),
    [['I1', 'Price', 'decimal-scale'], ['I2', 'Code', 'text-length'], ['I3', 'Price', 'decimal-scale'], ['I3', 'Due', 'date-format'], ['I4', 'Price', 'decimal-scale']],
  );
  const store = new FakeBulkStore();
  const rounded = await bulkLoad({
    tables: [{ table: 'Item', rows: () => rows.filter((row) => row.id !== 'I2' && row.id !== 'I3') }],
    columnsByTable: columns,
    roundScale: true,
    bucket: 'b',
    prefix: 'p',
    dryRun: false,
    store,
    wait: noWait,
  });
  assert.equal(rounded.ok, true, rounded.error);
  const stored = Object.fromEntries([...store.table('Item').rows.values()].map((row) => [row.c2c_source_id, [row.Price, row.Due]]));
  assert.deepEqual(stored, { I1: ['0.11', '2026-10-05'], I4: ['2.35', '2026-10-05'] });
  const negative = await bulkLoad({
    tables: [{ table: 'Item', rows: () => [{ id: 'I5', columns: { Price: '-0.015' } }] }],
    columnsByTable: columns,
    roundScale: true,
    bucket: 'b',
    prefix: 'p',
    dryRun: false,
    store,
    wait: noWait,
  });
  assert.equal(negative.ok, true);
  assert.equal([...store.table('Item').rows.values()].find((row) => row.c2c_source_id === 'I5')?.Price, '-0.02', 'half up rounds away from zero');
});

test('a lookup to a parent that is not stored is refused and named', async () => {
  const store = new FakeBulkStore();
  const result = await bulkLoad({
    tables: [source('Customer', 2, customer), { table: 'Orders', rows: () => [{ id: 'O1', columns: { Customer: 'C9' } }, { id: 'O2', columns: { Customer: 'C1' } }] }],
    foreignKeys: [{ table: 'Orders', column: 'Customer', parent: 'Customer' }],
    bucket: 'b',
    prefix: 'p',
    dryRun: false,
    store,
    wait: noWait,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.refusals, [{ table: 'Orders', id: 'O1', column: 'Customer', rule: 'unknown-reference' }]);
  assert.deepEqual(store.sourceIds('Orders'), ['O2']);
});

test('chunkCsv puts c2c_source_id first and quotes what needs it', () => {
  const csv = chunkCsv([{ id: '1', columns: { B: 'x,y', A: 'line\nbreak' } }, { id: '2', columns: { A: 'a' } }]);
  assert.deepEqual(parseCsv(csv), [['c2c_source_id', 'A', 'B'], ['1', 'line\nbreak', 'x,y'], ['2', 'a', '']]);
});

test('a refused row inside a done chunk is retried on resume, and the result stays not-ok while it remains', async () => {
  const store = new FakeBulkStore();
  const columns = { Item: [{ name: 'Code', dataType: 'VarChar', length: 4 }] };
  const checkpoint = emptyBulkCheckpoint();
  const rows = (fix: boolean) => () => [
    { id: 'I1', columns: { Code: 'ok1' } },
    { id: 'I2', columns: { Code: fix ? 'ok2' : 'toolong' } },
    { id: 'I3', columns: { Code: 'ok3' } },
  ];
  const run = (fix: boolean) =>
    bulkLoad({ tables: [{ table: 'Item', rows: rows(fix) }], columnsByTable: columns, bucket: 'b', prefix: 'p', dryRun: false, store, chunkRows: 10, wait: noWait, checkpoint });
  const first = await run(false);
  assert.equal(first.ok, false);
  assert.equal(first.tables[0]!.refused, 1);
  assert.deepEqual([...store.table('Item').bySource.keys()].sort(), ['I1', 'I3']);
  // Resume with the source unchanged: the refused row is re-checked and the run is still not ok.
  const again = await run(false);
  assert.equal(again.ok, false, 'a refused row that remains means the run is not ok');
  assert.equal(again.tables[0]!.refused, 1);
  assert.deepEqual([...store.table('Item').bySource.keys()].sort(), ['I1', 'I3']);
  // Fix the source and resume: the refused row is sent and the chunk goes clean.
  const fixed = await run(true);
  assert.equal(fixed.ok, true, fixed.error);
  assert.equal(fixed.tables[0]!.loaded, 3);
  assert.deepEqual([...store.table('Item').bySource.keys()].sort(), ['I1', 'I2', 'I3']);
  // A finished checkpoint still sends nothing.
  const calls = store.calls;
  const noop = await run(true);
  assert.equal(noop.ok, true);
  assert.equal(store.calls, calls);
});

test('a lookup to a parent table outside the load resolves against the store, or refuses', async () => {
  const store = new FakeBulkStore();
  // Customer was loaded by an earlier run; only Orders is in this load.
  const parentRowid = store.insert('Customer', { c2c_source_id: 'C1', Name: 'Customer 1' });
  const result = await bulkLoad({
    tables: [{ table: 'Orders', rows: () => [{ id: 'O1', columns: { Customer: 'C1' } }, { id: 'O2', columns: { Customer: 'C9' } }] }],
    foreignKeys: [{ table: 'Orders', column: 'Customer', parent: 'Customer' }],
    bucket: 'b',
    prefix: 'p',
    dryRun: false,
    store,
    wait: noWait,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.refusals, [{ table: 'Orders', id: 'O2', column: 'Customer', rule: 'unknown-reference' }]);
  assert.deepEqual(store.sourceIds('Orders'), ['O1']);
  const stored = store.table('Orders').rows.get(store.table('Orders').bySource.get('O1')!)!;
  assert.equal(stored.Customer, parentRowid, 'the lookup holds the parent ROWID, not the raw source id');
});

test('a subset-load lookup uses fk_mapping when the parent has a unique reference column', async () => {
  const store = new FakeBulkStore({ 'Orders.Customer': 'Customer' });
  store.table('Customer').unique.add('Code');
  store.insert('Customer', { c2c_source_id: 'C1', Code: 'C1', Name: 'Customer 1' });
  const result = await bulkLoad({
    tables: [{ table: 'Orders', rows: () => [{ id: 'O1', columns: { Customer: 'C1' } }] }],
    foreignKeys: [{ table: 'Orders', column: 'Customer', parent: 'Customer' }],
    uniqueReference: { Customer: 'Code' },
    bucket: 'b',
    prefix: 'p',
    dryRun: false,
    store,
    wait: noWait,
  });
  assert.equal(result.ok, true, result.error);
  const rowid = store.table('Orders').bySource.get('O1')!;
  assert.equal(store.table('Orders').rows.get(rowid)!.Customer, store.table('Customer').bySource.get('C1'));
});

test('a source that repeats an id is refused before the write, in one chunk or across chunks', async () => {
  const store = new FakeBulkStore();
  const rows = () => [
    { id: 'I1', columns: { Name: 'a' } },
    { id: 'I2', columns: { Name: 'b' } },
    { id: 'I1', columns: { Name: 'a-dup' } },
  ];
  const sameChunk = await bulkLoad({ tables: [{ table: 'Item', rows }], bucket: 'b', prefix: 'p', dryRun: false, store, chunkRows: 10, wait: noWait });
  assert.equal(sameChunk.ok, false);
  assert.deepEqual(sameChunk.refusals, [{ table: 'Item', id: 'I1', column: 'c2c_source_id', rule: 'duplicate-source-id' }]);
  assert.deepEqual(store.sourceIds('Item').sort(), ['I1', 'I2']);
  const store2 = new FakeBulkStore();
  const acrossChunks = await bulkLoad({ tables: [{ table: 'Item', rows }], bucket: 'b', prefix: 'p', dryRun: false, store: store2, chunkRows: 2, wait: noWait });
  assert.equal(acrossChunks.ok, false, 'a repeat in a later chunk is refused, not silently dropped by the read-back');
  assert.deepEqual(store2.sourceIds('Item').sort(), ['I1', 'I2']);
});

test('a row refused on two columns counts as one refused row', async () => {
  const columns = { Item: [{ name: 'Code', dataType: 'VarChar', length: 4 }, { name: 'Due', dataType: 'Date' }] };
  const result = await bulkLoad({
    tables: [{ table: 'Item', rows: () => [{ id: 'I1', columns: { Code: 'toolong', Due: '05-10-2026' } }, { id: 'I2', columns: { Code: 'ok', Due: '2026-10-05' } }] }],
    columnsByTable: columns,
    bucket: 'b',
    prefix: 'p',
  });
  assert.equal(result.ok, false);
  assert.equal(result.tables[0]!.refused, 1, 'refused counts rows, not refused cells');
  assert.match(result.error ?? '', /refused 1 row\(s\)/);
});

test('a Completed job that silently dropped an unmapped parent is refused once, not resent forever', async () => {
  const store = new FakeBulkStore({ 'Orders.Customer': 'Customer' });
  store.table('Customer').unique.add('Code');
  store.insert('Customer', { c2c_source_id: 'C1', Code: 'C1' });
  const checkpoint = emptyBulkCheckpoint();
  const opts = () => ({
    tables: [{ table: 'Orders', rows: () => [{ id: 'O1', columns: { Customer: 'C1' } }, { id: 'O2', columns: { Customer: 'C9' } }] }],
    foreignKeys: [{ table: 'Orders', column: 'Customer', parent: 'Customer' }],
    uniqueReference: { Customer: 'Code' },
    bucket: 'b',
    prefix: 'p',
    dryRun: false as const,
    store,
    wait: noWait,
    checkpoint,
  });
  const result = await bulkLoad(opts());
  assert.equal(result.ok, false);
  assert.deepEqual(result.refusals, [{ table: 'Orders', id: 'O2', column: 'Customer', rule: 'unknown-reference' }]);
  assert.deepEqual(store.sourceIds('Orders'), ['O1']);
  // Resume: only the refused row is resent, and it is refused again rather than throwing.
  const again = await bulkLoad(opts());
  assert.equal(again.ok, false);
  assert.equal(again.tables[0]!.refused, 1);
  const lastCsv = [...store.objects.values()].at(-1)!;
  assert.deepEqual(parseCsv(lastCsv).map((line) => line[0]), ['c2c_source_id', 'O2'], 'the resume resends only the refused row');
});

test('a deadline stops waiting on a job: the slice ends complete:false and the next slice waits the job out', async () => {
  const store = new FakeBulkStore();
  store.polls = 10_000; // the job stays In-Progress far past the deadline
  const checkpoint = emptyBulkCheckpoint();
  let clock = 0;
  const opts = (deadline: number) => ({
    tables: [source('Customer', 10, customer)],
    bucket: 'b',
    prefix: 'p',
    dryRun: false as const,
    store,
    chunkRows: 5,
    checkpoint,
    wait: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    deadline,
    maxPolls: 10_000,
  });
  const result = await bulkLoad(opts(60_000));
  assert.equal(result.complete, false, 'the slice stops at its deadline instead of polling past it');
  assert.equal(result.ok, false);
  assert.equal(checkpoint.tables['Customer']!.chunks['0']!.state, 'submitted', 'the job id is kept for the next slice');
  store.polls = 0;
  store.jobs.get('1')!.polls = 0; // the job lands while the slice is away
  const resumed = await bulkLoad(opts(clock + 60_000));
  assert.equal(resumed.ok, true, resumed.error);
  assertExactlyOnce(store, 'Customer', 10, 'C');
});

test('the deadline is checked between deferred-update chunks, not only between tables', async () => {
  const store = new FakeBulkStore();
  const rows = 250; // more than the 200-row update batch: two deferred chunks
  const node = (i: number): BulkRow => ({ id: `N${i}`, columns: { Prev: i > 0 ? `N${i - 1}` : '' } });
  const checkpoint = emptyBulkCheckpoint();
  let clock = 0;
  const real = store.updateRows.bind(store);
  store.updateRows = async (table, batch) => {
    const out = await real(table, batch);
    clock += 2000;
    return out;
  };
  const run = (deadline: number) =>
    bulkLoad({
      tables: [source('Node', rows, node)],
      foreignKeys: [{ table: 'Node', column: 'Prev', parent: 'Node' }],
      bucket: 'b',
      prefix: 'p',
      dryRun: false,
      store,
      wait: noWait,
      checkpoint,
      now: () => clock,
      deadline,
    });
  const first = await run(1000);
  assert.equal(first.complete, false, 'the deferred pass stops at the deadline inside the table');
  const done = await run(clock + 10_000);
  assert.equal(done.ok, true, done.error);
  const nodes = store.table('Node');
  for (const row of nodes.rows.values()) {
    const i = Number(row.c2c_source_id!.slice(1));
    if (i === 0) assert.equal(row.Prev, undefined);
    else assert.equal(row.Prev, nodes.bySource.get(`N${i - 1}`), `N${i} points at N${i - 1}`);
  }
});

test('a refused deferred lookup stays refused on resume instead of going green', async () => {
  const store = new FakeBulkStore();
  const checkpoint = emptyBulkCheckpoint();
  const rows = (fix: boolean) => () => [
    { id: 'N1', columns: { Prev: fix ? 'N2' : 'N9' } },
    { id: 'N2', columns: { Prev: 'N1' } },
  ];
  const run = (fix: boolean) =>
    bulkLoad({
      tables: [{ table: 'Node', rows: rows(fix) }],
      foreignKeys: [{ table: 'Node', column: 'Prev', parent: 'Node' }],
      bucket: 'b',
      prefix: 'p',
      dryRun: false,
      store,
      wait: noWait,
      checkpoint,
    });
  const first = await run(false);
  assert.equal(first.ok, false);
  assert.deepEqual(first.refusals, [{ table: 'Node', id: 'N1', column: 'Prev', rule: 'unknown-reference' }]);
  const again = await run(false);
  assert.equal(again.ok, false, 'a deferred refusal still standing keeps the run not-ok');
  assert.equal(again.tables[0]!.refused, 1);
  const fixed = await run(true);
  assert.equal(fixed.ok, true, fixed.error);
  const nodes = store.table('Node');
  assert.equal(nodes.rows.get(nodes.bySource.get('N1')!)!.Prev, nodes.bySource.get('N2'));
});

test('a 20k-row load past the request cut runs as Job slices: 202, poll, resume from the checkpoint cursor', async () => {
  const store = new FakeBulkStore();
  const rows = new Map<string, WorkStatus>();
  const statuses = { get: async (id: string) => rows.get(id) && (JSON.parse(JSON.stringify(rows.get(id))) as WorkStatus), put: async (id: string, s: WorkStatus) => void rows.set(id, JSON.parse(JSON.stringify(s)) as WorkStatus) };
  const submitted: string[] = [];
  const jobs = { submit: async (job: { params: Record<string, string> }) => (submitted.push(job.params.work_id!), { jobId: String(submitted.length) }) };
  const reply = await runOrDefer({ workId: 'load-1', estimate: 20_000, runInline: async () => 'inline', jobName: 'c2c_jobs', jobs, statuses });
  assert.equal(reply.status, 202);
  let clock = 0;
  const step = async (cursor: string | undefined, deadline: number) => {
    const checkpoint = cursor ? (JSON.parse(cursor) as BulkCheckpoint) : emptyBulkCheckpoint();
    const result = await bulkLoad({
      tables: [source('Customer', 20_000, customer)],
      bucket: 'b',
      prefix: 'load-1',
      dryRun: false,
      store,
      chunkRows: 1000,
      wait: noWait,
      checkpoint,
      deadline,
      now: () => (clock += 100),
    });
    const done = result.tables[0]!.loaded;
    return result.complete ? { done, result: { ok: result.ok, loaded: done } } : { done, cursor: JSON.stringify(checkpoint) };
  };
  let status: WorkStatus;
  do status = await runWorkSlice({ workId: 'load-1', statuses, step, jobName: 'c2c_jobs', jobs, sliceMs: 600, now: () => clock });
  while (status.state !== 'done' && submitted.length < 100);
  assert.equal(status.state, 'done');
  assert.deepEqual(status.result, { ok: true, loaded: 20_000 });
  assert.ok(submitted.length > 2, 'the load spanned several Jobs');
  assertExactlyOnce(store, 'Customer', 20_000, 'C');
});

test('a job still running after maxPolls with no deadline fails loudly and keeps its id; the resume does not resend', async () => {
  const store = new FakeBulkStore();
  store.polls = 10_000;
  const checkpoint = emptyBulkCheckpoint();
  const opts = {
    tables: [source('Customer', 5, customer)],
    bucket: 'b',
    prefix: 'p',
    dryRun: false as const,
    store,
    chunkRows: 5,
    checkpoint,
    wait: noWait,
    maxPolls: 3,
  };
  await assert.rejects(() => bulkLoad(opts), (err: unknown) => err instanceof BulkLoadError && /job 1 for Customer chunk 0 is still running after 3 status reads; resume/.test((err as Error).message));
  assert.equal(checkpoint.tables['Customer']!.chunks['0']!.state, 'submitted');
  await assert.rejects(() => bulkLoad(opts), (err: unknown) => err instanceof BulkLoadError && /job 1 for Customer chunk 0 is still running after 3 status reads/.test((err as Error).message));
  assert.equal(store.jobs.size, 1, 'the resume waits on the submitted job instead of sending the chunk again');
  store.jobs.get('1')!.polls = 0;
  const resumed = await bulkLoad(opts);
  assert.equal(resumed.ok, true, resumed.error);
  assert.equal(store.jobs.size, 1);
  assertExactlyOnce(store, 'Customer', 5, 'C');
});
