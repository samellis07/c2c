/**
 * Counters under concurrent writes: autonumber fields and `+n` updates of a
 * counter column. Twenty writers run at once against a fake Data Store that
 * interleaves them: every call yields a seeded number of event-loop turns
 * before it reads and again before it returns, so reads go stale and
 * read-add-write races happen. The store refuses a second `claim_key` with
 * the recorded 409 DUPLICATE_VALUE shape; in race-window mode it checks the
 * key, yields, then commits, so two claims for one key can both land (a
 * unique column that admits a duplicate under load).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '../../deluge/src/translate.js';
import { CLAIM_TABLE, CounterContention, incrementCounter, nextAutonumber, setCounter } from '../src/counters.js';
import { createRuntime, type RuntimeOptions } from '../src/runtime.js';
import { classifyStoreError } from '../src/store-errors.js';
import { mockDatastore } from './zcql-mock.js';

const WRITERS = 20;

function duplicateError(field: string): Error {
  return Object.assign(new Error(`Duplicate value for ${field}. Please give a different value`), {
    statusCode: 409,
    code: 'DUPLICATE_VALUE',
  });
}

/** Seeded PRNG (mulberry32), so an interleaving is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function interleavingStore(seed: number, opts: { raceWindow?: boolean } = {}) {
  const mock = mockDatastore({ [CLAIM_TABLE]: ['n'], Product: ['Stock'], Invoice: ['Number'] });
  const unique: Record<string, string> = { [CLAIM_TABLE]: 'claim_key' };
  const random = prng(seed);
  const turns = async () => {
    const n = Math.floor(random() * 4);
    for (let i = 0; i < n; i++) await new Promise<void>((done) => setImmediate(done));
  };
  const stats = { duplicates: 0, deletes: 0 };
  const datastore = {
    async insert(table: string, rows: Record<string, unknown>[]) {
      await turns();
      const column = unique[table];
      if (column) {
        const taken = (mock.tables.get(table) ?? []).some((row) => rows.some((r) => row[column] === String(r[column])));
        if (taken) {
          stats.duplicates++;
          throw duplicateError(column);
        }
        if (opts.raceWindow) await turns();
      }
      return mock.datastore.insert(table, rows);
    },
    async query(table: string, where: string, limit: number, offset = 0, orderBy = '') {
      await turns();
      const rows = await mock.datastore.query(table, where, limit, offset, orderBy);
      await turns();
      return rows;
    },
    async update(table: string, rows: Record<string, unknown>[]) {
      await turns();
      return mock.datastore.update(table, rows);
    },
    async delete(table: string, rowIds: readonly unknown[]) {
      await turns();
      const ids = new Set(rowIds.map(String));
      const list = mock.tables.get(table) ?? [];
      mock.tables.set(table, list.filter((row) => !ids.has(String(row.ROWID))));
      stats.deletes += ids.size;
      return rowIds;
    },
  };
  return { datastore, tables: mock.tables, stats };
}

const yieldWait = () => new Promise<void>((done) => setImmediate(done));

async function seedProduct(store: ReturnType<typeof interleavingStore>, stock: number): Promise<string> {
  const [row] = (await store.datastore.insert('Product', [{ Name: 'Widget', Stock: stock }])) as Record<string, string>[];
  return row!.ROWID!;
}

function stockOf(store: ReturnType<typeof interleavingStore>, rowId: string): string | null {
  return store.tables.get('Product')!.find((row) => row.ROWID === rowId)!.Stock ?? null;
}

test('fake store: the recorded duplicate shape classifies as DUPLICATE_VALUE', () => {
  assert.deepEqual(classifyStoreError(duplicateError('claim_key')), { code: 'DUPLICATE_VALUE', field: 'claim_key' });
});

test('fake store interleaves: a plain read-add-write loses increments', async () => {
  const store = interleavingStore(7);
  const rowId = await seedProduct(store, 100);
  await Promise.all(
    Array.from({ length: WRITERS }, async () => {
      const [row] = await store.datastore.query('Product', `ROWID = ${rowId}`, 1);
      await store.datastore.update('Product', [{ ROWID: rowId, Stock: Number(row!.Stock) + 1 }]);
    }),
  );
  assert.ok(Number(stockOf(store, rowId)) < 100 + WRITERS, 'the interleaving must expose the lost update');
});

for (const seed of [1, 2, 3]) {
  test(`20 concurrent increments are all applied (seed ${seed})`, async () => {
    const store = interleavingStore(seed);
    const rowId = await seedProduct(store, 100);
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        incrementCounter(store.datastore, 'Product', 'Stock', rowId, 1, { owner: `w${i}`, wait: yieldWait }),
      ),
    );
    assert.equal(stockOf(store, rowId), String(100 + WRITERS));
    assert.deepEqual(
      results.map(Number).sort((a, b) => a - b),
      Array.from({ length: WRITERS }, (_, i) => 101 + i),
    );
    const versions = store.tables.get(CLAIM_TABLE)!.map((row) => Number(row.n)).sort((a, b) => a - b);
    assert.deepEqual(versions, Array.from({ length: WRITERS }, (_, i) => i + 1));
  });
}

for (const raceWindow of [false, true]) {
  test(`20 concurrent autonumbers are distinct and consecutive${raceWindow ? ' when the unique check races' : ''}`, async () => {
    const store = interleavingStore(11, { raceWindow });
    const numbers = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        nextAutonumber(store.datastore, 'Invoice', 'Number', 1001, { owner: `w${i}`, wait: yieldWait }),
      ),
    );
    const sorted = numbers.map(Number).sort((a, b) => a - b);
    assert.deepEqual(sorted, Array.from({ length: WRITERS }, (_, i) => 1001 + i));
    const claims = store.tables.get(CLAIM_TABLE)!.map((row) => row.claim_key);
    assert.equal(new Set(claims).size, claims.length, 'no claim key is held twice at the end');
    assert.ok(store.stats.duplicates > 0, 'the writers collided');
    if (raceWindow) assert.ok(store.stats.deletes > 0, 'a losing duplicate claim was withdrawn');
  });
}

test('mixed increments and decrements settle on the sum', async () => {
  const store = interleavingStore(5);
  const rowId = await seedProduct(store, 50);
  const deltas = Array.from({ length: WRITERS }, (_, i) => (i % 3 === 0 ? -2 : 3));
  await Promise.all(deltas.map((d, i) => incrementCounter(store.datastore, 'Product', 'Stock', rowId, d, { owner: `w${i}`, wait: yieldWait })));
  assert.equal(stockOf(store, rowId), String(50 + deltas.reduce((a, b) => a + b, 0)));
});

test('a set is one more version: later increments start from it', async () => {
  const store = interleavingStore(9);
  const rowId = await seedProduct(store, 3);
  await incrementCounter(store.datastore, 'Product', 'Stock', rowId, 1, { wait: yieldWait });
  assert.equal(await setCounter(store.datastore, 'Product', 'Stock', rowId, '40', { wait: yieldWait }), 40n);
  assert.equal(await incrementCounter(store.datastore, 'Product', 'Stock', rowId, 2, { wait: yieldWait }), 42n);
  assert.equal(stockOf(store, rowId), '42');
});

test('a claimant that keeps losing fails closed with CounterContention', async () => {
  const store = interleavingStore(4);
  const busy = {
    ...store.datastore,
    async insert(table: string, rows: Record<string, unknown>[]) {
      if (table === CLAIM_TABLE) throw duplicateError('claim_key');
      return store.datastore.insert(table, rows);
    },
  };
  await assert.rejects(nextAutonumber(busy, 'Invoice', 'Number', 1, { maxAttempts: 3, wait: yieldWait }), (err: unknown) => {
    assert.ok(err instanceof CounterContention);
    assert.equal(err.code, 'COUNTER_CONTENTION');
    assert.equal(classifyStoreError(err), null);
    return true;
  });
});

/** Run a translated Deluge script on a live runtime over the fake store. */
async function runLive(store: ReturnType<typeof interleavingStore>, script: string, counters: unknown): Promise<void> {
  const options: Record<string, unknown> = {
    dryRun: false,
    appTimeZone: 'UTC',
    now: new Date('2026-10-10T00:00:00.000Z'),
    datastore: store.datastore,
    counters,
  };
  const runtime = createRuntime(options as RuntimeOptions);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('shim', 'ctx', translate(script).server);
  await fn(runtime.shim, runtime.context({ appTimeZone: 'UTC' }));
}

const COUNTERS = {
  columns: { Product: ['Stock'] },
  autonumber: { Invoice: { Number: { start: 1 } } },
  wait: yieldWait,
};

for (const [label, script, delta] of [
  ['Form[criteria].F = Form[criteria].F + 1', 'rec = Product[Name == "Widget"];\nrec.Stock = rec.Stock.toLong() + 1;', 1],
  ['for each record: rec.F = rec.F - 1', 'for each p in Product[Name == "Widget"]\n{\n p.Stock = p.Stock - 1;\n}', -1],
] as const) {
  test(`generated update ${label}: 20 concurrent requests lose no update`, async () => {
    const store = interleavingStore(21);
    const rowId = await seedProduct(store, 100);
    await Promise.all(Array.from({ length: WRITERS }, () => runLive(store, script, COUNTERS)));
    assert.equal(stockOf(store, rowId), String(100 + WRITERS * delta));
  });
}

test('generated update with no read is a set, not an increment', async () => {
  const store = interleavingStore(22);
  const rowId = await seedProduct(store, 100);
  await runLive(store, 'rec = Product[Name == "Widget"];\nrec.Stock = 7;', COUNTERS);
  await runLive(store, 'rec = Product[Name == "Widget"];\nrec.Stock = rec.Stock.toLong() + 1;', COUNTERS);
  assert.equal(stockOf(store, rowId), '8');
});

test('generated insert: 20 concurrent records get distinct autonumbers', async () => {
  const store = interleavingStore(23);
  await Promise.all(Array.from({ length: WRITERS }, (_, i) => runLive(store, `insert into Invoice\n[\n Title = "inv ${i}"\n];`, COUNTERS)));
  const numbers = store.tables.get('Invoice')!.map((row) => Number(row.Number)).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: WRITERS }, (_, i) => i + 1));
});

test('an insert that names the autonumber keeps its value; a form with no counters writes plainly', async () => {
  const store = interleavingStore(24);
  await runLive(store, 'insert into Invoice\n[\n Title = "x"\n Number = 77\n];', COUNTERS);
  await runLive(store, 'insert into Invoice\n[\n Title = "y"\n];', {});
  assert.deepEqual(store.tables.get('Invoice')!.map((row) => row.Number ?? null), ['77', null]);
  assert.equal(store.tables.get(CLAIM_TABLE), undefined);
});

async function seedPair(store: ReturnType<typeof interleavingStore>): Promise<[string, string]> {
  const rows = (await store.datastore.insert('Product', [
    { Name: 'Bolt', Stock: 10 },
    { Name: 'Bolt', Stock: 20 },
  ])) as Record<string, string>[];
  return [rows[0]!.ROWID!, rows[1]!.ROWID!];
}

for (const [label, script, expected] of [
  ['a read then a constant sets every match', 'q = Product[Name == "Bolt"];\nx = q.Stock;\nq.Stock = 7;', ['7', '7']],
  ['a value computed from the read is given to every match', 'q = Product[Name == "Bolt"];\nq.Stock = q.Stock.toLong() * 2;', ['20', '20']],
] as const) {
  test(`Form[criteria].F over two rows: ${label}`, async () => {
    const store = interleavingStore(25);
    const [a, b] = await seedPair(store);
    await runLive(store, script, COUNTERS);
    assert.deepEqual([stockOf(store, a), stockOf(store, b)], expected);
  });
}

test('Form[criteria].F over two rows keeps a concurrent increment of the row the script read', async () => {
  const store = interleavingStore(26);
  const [a, b] = await seedPair(store);
  // Another request adds 5 to the first row between this script's read and its write.
  const racing = {
    ...store.datastore,
    async query(table: string, where: string, limit: number, offset = 0, orderBy = '') {
      const rows = await store.datastore.query(table, where, limit, offset, orderBy);
      if (table === 'Product' && limit === 1 && !raced) {
        raced = true;
        await incrementCounter(store.datastore, 'Product', 'Stock', a, 5, { wait: yieldWait });
      }
      return rows;
    },
  };
  let raced = false;
  await runLive({ ...store, datastore: racing }, 'q = Product[Name == "Bolt"];\nq.Stock = q.Stock.toLong() + 1;', COUNTERS);
  assert.equal(raced, true);
  assert.deepEqual([stockOf(store, a), stockOf(store, b)], ['16', '11']);
});

test('a claim whose verify read fails is removed: the failed increment has no effect', async () => {
  const store = interleavingStore(27);
  const rowId = await seedProduct(store, 100);
  let fail = true;
  const flaky = {
    ...store.datastore,
    async query(table: string, where: string, limit: number, offset = 0, orderBy = '') {
      if (table === CLAIM_TABLE && where.startsWith('claim_key') && fail) {
        fail = false;
        throw Object.assign(new Error('Internal server error'), { statusCode: 500 });
      }
      return store.datastore.query(table, where, limit, offset, orderBy);
    },
  };
  await assert.rejects(incrementCounter(flaky, 'Product', 'Stock', rowId, 10, { wait: yieldWait }), /Internal server error/);
  assert.equal(stockOf(store, rowId), '100');
  assert.deepEqual(store.tables.get(CLAIM_TABLE) ?? [], []);
  assert.equal(await incrementCounter(store.datastore, 'Product', 'Stock', rowId, 1, { wait: yieldWait }), 101n);
  assert.equal(stockOf(store, rowId), '101');
});

test('counters refuse a store with no delete before any claim', async () => {
  const store = interleavingStore(28);
  const rowId = await seedProduct(store, 100);
  const { delete: _drop, ...noDelete } = store.datastore;
  await assert.rejects(incrementCounter(noDelete as never, 'Product', 'Stock', rowId, 1, { wait: yieldWait }), /no delete/);
  await assert.rejects(nextAutonumber(noDelete as never, 'Invoice', 'Number', 1, { wait: yieldWait }), /no delete/);
  assert.equal(store.tables.get(CLAIM_TABLE), undefined);
  assert.throws(
    () => createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore: noDelete, counters: COUNTERS } as RuntimeOptions),
    /no delete/,
  );
  // A runtime with no counters, or a dry run, does not need delete.
  createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore: noDelete, counters: {} } as RuntimeOptions);
  createRuntime({ dryRun: true, appTimeZone: 'UTC', datastore: noDelete, counters: COUNTERS } as RuntimeOptions);
});

test('a record that never settles on the latest claim fails the write', async () => {
  const store = interleavingStore(29);
  const rowId = await seedProduct(store, 100);
  // Every latest-claim read reports a newer value, as if writers never stop.
  let bump = 0;
  const restless = {
    ...store.datastore,
    async query(table: string, where: string, limit: number, offset = 0, orderBy = '') {
      const rows = await store.datastore.query(table, where, limit, offset, orderBy);
      if (table === CLAIM_TABLE && orderBy.startsWith('ORDER BY n DESC') && rows[0] && store.tables.get('Product')!.some((r) => r.ROWID === rowId && r.Stock !== '100')) {
        return [{ ...rows[0], value: String(200 + bump++) }];
      }
      return rows;
    },
  };
  await assert.rejects(incrementCounter(restless, 'Product', 'Stock', rowId, 1, { maxAttempts: 3, wait: yieldWait }), (err: unknown) => {
    assert.ok(err instanceof CounterContention);
    assert.match(err.message, /did not settle/);
    return true;
  });
});

test('an update whose counter claim fails closed writes no plain column', async () => {
  const store = interleavingStore(30);
  const rowId = await seedProduct(store, 100);
  const busy = {
    ...store.datastore,
    async insert(table: string, rows: Record<string, unknown>[]) {
      if (table === CLAIM_TABLE) throw duplicateError('claim_key');
      return store.datastore.insert(table, rows);
    },
  };
  await assert.rejects(
    runLive({ ...store, datastore: busy }, 'for each p in Product[Name == "Widget"]\n{\n p.Name = "Gadget";\n p.Stock = p.Stock + 1;\n}', { ...COUNTERS, maxAttempts: 2 }),
    CounterContention,
  );
  const row = store.tables.get('Product')!.find((r) => r.ROWID === rowId)!;
  assert.deepEqual([row.Name, row.Stock], ['Widget', '100']);
});
