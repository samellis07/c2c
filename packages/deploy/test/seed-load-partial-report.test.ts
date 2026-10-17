import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { emptyCheckpoint, type FetchLike, type MigrateResponse } from '../../data/src/migrate.js';
import { migrateLoaded, migrateSeed, readSourceCsv } from '../src/index.js';
import { updateDeferredForeignKeys } from '../src/remap.js';

const SCOPE = { org: '10000000000', projectId: '1001', token: 'test-cli-token' };
const BASE = 'https://api.catalyst.zoho.in';

function response(body: unknown, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

interface Stored {
  rowid: string;
  columns: Record<string, string>;
}

interface Faults {
  /** Table whose ROWID read-back query answers 500. */
  readBackFails?: string;
  /** Table whose row insert answers 500. */
  failInserts?: string;
  /** 1-based deferred-update PUT numbers that answer 500. */
  failPuts?: readonly number[];
}

/** A Data Store fake that keeps rows across runs; faults are switched per run. */
function store() {
  const stored = new Map<string, Map<string, Stored>>();
  const inserts: string[] = [];
  const putCalls: { table: string; rows: number }[] = [];
  let puts = 0;
  let seq = 10000000000000001n;
  let faults: Faults = {};
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    if (method === 'GET') throw new Error('the load called Creator');
    if (path.endsWith('/query')) {
      const sql = String((JSON.parse(String(init?.body ?? '{}')) as { query: string }).query);
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
      if (/^SELECT ROWID, c2c_source_id /.test(sql) && table === faults.readBackFails) {
        return response({ status: 'failure', data: { message: 'query failed' } }, 500);
      }
      const all = stored.get(table) ?? new Map<string, Stored>();
      const inColumn = /WHERE\s+([A-Za-z_][A-Za-z0-9_]*)\s+IN/.exec(sql)?.[1];
      const list = /IN \((.*)\)/.exec(sql)?.[1];
      const wanted = list ? new Set(list.split(', ').map((item) => item.slice(1, -1).replace(/''/g, "'"))) : undefined;
      const rows = [...all].filter(([source, row]) => !wanted || wanted.has(inColumn === 'ROWID' ? row.rowid : source));
      if (/COUNT\(/i.test(sql)) return response({ data: [{ 'COUNT(ROWID)': String(rows.length) }] });
      return response({ data: rows.map(([source, row]) => ({ ...row.columns, c2c_source_id: source, ROWID: row.rowid })) });
    }
    const table = decodeURIComponent(path.split('/').at(-2) ?? '');
    const records = JSON.parse(String(init?.body ?? '[]')) as Array<Record<string, unknown>>;
    if (method === 'PUT') {
      const deferredUpdate = records.every((record) => Object.keys(record).length > 1 && 'Manager' in record);
      if (deferredUpdate) {
        puts += 1;
        if (faults.failPuts?.includes(puts)) return response({ status: 'failure', data: { message: 'update failed' } }, 500);
      }
      putCalls.push({ table, rows: records.length });
      const bucket = stored.get(table) ?? new Map<string, Stored>();
      for (const record of records) {
        const row = [...bucket.values()].find((item) => item.rowid === String(record.ROWID));
        if (!row) return response({ status: 'failure', data: { message: 'no such row' } }, 400);
        for (const [key, value] of Object.entries(record)) if (key !== 'ROWID' && typeof value === 'string') row.columns[key] = value;
      }
      return response({ status: 'success', data: records });
    }
    if (table === faults.failInserts) return response({ status: 'failure', data: { message: 'write failed' } }, 500);
    inserts.push(table);
    const bucket = stored.get(table) ?? new Map<string, Stored>();
    const echoed: Array<Record<string, unknown>> = [];
    for (const record of records) {
      const columns: Record<string, string> = {};
      for (const [key, value] of Object.entries(record)) if (typeof value === 'string') columns[key] = value;
      const row = { rowid: String(seq++), columns };
      bucket.set(columns.c2c_source_id!, row);
      echoed.push({ ...columns, ROWID: row.rowid });
    }
    stored.set(table, bucket);
    return response({ status: 'success', data: echoed });
  };
  return {
    fetch,
    stored,
    inserts,
    putCalls,
    setFaults(next: Faults) {
      faults = next;
      puts = 0;
      inserts.length = 0;
      putCalls.length = 0;
    },
  };
}

const EMPLOYEES = 250;
const employees = Array.from({ length: EMPLOYEES }, (_, i) => ({
  id: `e${i + 1}`,
  columns: { Name: `N${i + 1}`, ...(i ? { Manager: `e${i}` } : {}) },
}));

function sortedRowIds(rows: Map<string, Stored>): string[] {
  return [...rows.values()].map((row) => row.rowid).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

test('updateDeferredForeignKeys continues past a failed PUT batch and reports updated and not-updated ROWID ranges', async () => {
  const ids = Array.from({ length: 450 }, (_, i) => String(10000000000000001n + BigInt(i)));
  const rowIds = new Map([['Employee', new Map(ids.map((rowid, i) => [`e${i + 1}`, rowid]))]]);
  const rows = ids.map((_, i): { id: string; columns: Record<string, string> } => ({ id: `e${i + 1}`, columns: i ? { Manager: `e${i}` } : {} }));
  let put = 0;
  const fetch: FetchLike = async (url, init) => {
    if (new URL(url).pathname.endsWith('/query')) return response({ data: [] });
    assert.equal(init?.method, 'PUT');
    put += 1;
    return put === 2 ? response({ status: 'failure' }, 500) : response({ status: 'success' });
  };
  const reports = await updateDeferredForeignKeys(
    { dc: 'in', catalystBase: BASE, fetch, scope: SCOPE },
    [{ table: 'Employee', rows }],
    [{ table: 'Employee', column: 'Manager', parent: 'Employee' }],
    new Set(['Employee\0Manager']),
    rowIds,
  );
  assert.equal(put, 3, 'every batch is attempted');
  assert.deepEqual(reports, [{
    table: 'Employee',
    columns: ['Manager'],
    rows: 449,
    updated: 249,
    notUpdated: 200,
    updatedRanges: [`${ids[1]}..${ids[200]}`, `${ids[401]}..${ids[449]}`],
    notUpdatedRanges: [`${ids[201]}..${ids[400]}`],
    error: 'catalyst row update failed: 500',
  }]);
  assert.doesNotMatch(JSON.stringify(reports), /"e\d/, 'the report carries no source values');
});

test('updateDeferredForeignKeys reports an unresolvable deferred lookup and writes nothing for that table', async () => {
  const fetch: FetchLike = async () => assert.fail('no update is sent for a table with an unresolved row');
  const reports = await updateDeferredForeignKeys(
    { dc: 'in', catalystBase: BASE, fetch, scope: SCOPE },
    [{ table: 'Employee', rows: [{ id: 'e1', columns: {} }, { id: 'e2', columns: { Manager: 'e9' } }] }],
    [{ table: 'Employee', column: 'Manager', parent: 'Employee' }],
    new Set(['Employee\0Manager']),
    new Map([['Employee', new Map([['e1', '101'], ['e2', '102']])]]),
  );
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.updated, 0);
  assert.equal(reports[0]!.notUpdated, 1);
  assert.deepEqual(reports[0]!.notUpdatedRanges, ['102']);
  assert.match(reports[0]!.error ?? '', /source id e9 is not in Employee/);
});

test('seed: a failed deferred PUT batch returns the report without throwing, and a re-run finishes the rows without inserting again', async () => {
  const fake = store();
  const run = () => migrateSeed({
    tables: [{ table: 'Employee', rows: employees }, { table: 'Third', rows: [{ id: 't1', columns: { Name: 'T' } }] }],
    foreignKeys: [{ table: 'Employee', column: 'Manager', parent: 'Employee' }],
    dc: 'in',
    catalystBase: BASE,
    dryRun: false,
    fetch: fake.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  fake.setFaults({ failPuts: [2] });
  const first = await run();
  assert.equal(first.ok, false);
  const ids = sortedRowIds(fake.stored.get('Employee')!);
  const managed = ids.slice(1);
  assert.deepEqual(first.deferredUpdates, [{
    table: 'Employee',
    columns: ['Manager'],
    rows: EMPLOYEES - 1,
    updated: 200,
    notUpdated: EMPLOYEES - 201,
    updatedRanges: [`${managed[0]}..${managed[199]}`],
    notUpdatedRanges: [`${managed[200]}..${managed.at(-1)}`],
    error: 'catalyst row update failed: 500',
  }]);
  const employee = first.tables.find((table) => table.table === 'Employee');
  assert.equal(employee?.mismatch, true);
  assert.match(employee?.error ?? '', /deferred lookup update \(Manager\): 200 of 249 row\(s\) updated .*49 not updated .*re-run the load/);
  assert.match(employee?.error ?? '', /row updates only, nothing is inserted again/);
  assert.equal(first.tables.find((table) => table.table === 'Third')?.mismatch, false, 'the independent table is reported loaded');
  assert.equal(fake.stored.get('Third')?.size, 1);
  const unset = [...fake.stored.get('Employee')!.values()].filter((row) => row.columns.c2c_source_id !== 'e1' && !row.columns.Manager);
  assert.equal(unset.length, 49);

  fake.setFaults({});
  const second = await run();
  assert.equal(second.ok, true, JSON.stringify(second.tables.map((table) => table.error)));
  assert.deepEqual(fake.inserts, [], 'the re-run inserts nothing');
  assert.deepEqual(fake.putCalls.map((call) => call.rows), [49], 'the re-run PUTs only the rows still unset');
  assert.equal(fake.stored.get('Employee')!.size, EMPLOYEES);
  const byId = fake.stored.get('Employee')!;
  for (let i = 2; i <= EMPLOYEES; i++) assert.equal(byId.get(`e${i}`)!.columns.Manager, byId.get(`e${i - 1}`)!.rowid);
});

function seedRun(fake: ReturnType<typeof store>) {
  return migrateSeed({
    tables: [
      { table: 'Region', rows: [{ id: 'r1', columns: { Name: 'R' } }] },
      { table: 'Office', rows: [{ id: 'o1', columns: { Name: 'O', Region: 'r1' } }] },
      { table: 'Employee', rows: employees },
    ],
    foreignKeys: [
      { table: 'Office', column: 'Region', parent: 'Region' },
      { table: 'Employee', column: 'Manager', parent: 'Employee' },
    ],
    dc: 'in',
    catalystBase: BASE,
    dryRun: false,
    fetch: fake.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
}

function assertManagersSet(rows: Map<string, Stored>, idOf: (i: number) => string): void {
  for (let i = 2; i <= EMPLOYEES; i++) assert.equal(rows.get(idOf(i))!.columns.Manager, rows.get(idOf(i - 1))!.rowid, idOf(i));
}

test('seed: a failure in an unrelated table still sets the self-lookup table\'s deferred lookups', async () => {
  const fake = store();
  fake.setFaults({ readBackFails: 'Region' });
  const result = await seedRun(fake);
  assert.equal(result.ok, false);
  const byTable = new Map(result.tables.map((table) => [table.table, table]));
  assert.match(byTable.get('Region')?.error ?? '', /ROWID read-back failed/);
  assert.match(byTable.get('Office')?.error ?? '', /skipped: parent Region not loaded/);
  assert.equal(byTable.get('Employee')?.mismatch, false);
  assert.equal(result.deferredUpdates?.length, 1);
  assert.equal(result.deferredUpdates![0]!.updated, EMPLOYEES - 1);
  assert.equal(result.deferredUpdates![0]!.notUpdated, 0);
  assertManagersSet(fake.stored.get('Employee')!, (i) => `e${i}`);
});

test('seed: a self-lookup table whose ROWID read-back fails reports its deferred lookups as not set', async () => {
  const fake = store();
  fake.setFaults({ readBackFails: 'Employee' });
  const result = await seedRun(fake);
  assert.equal(result.ok, false);
  const employee = result.tables.find((table) => table.table === 'Employee');
  assert.equal(employee?.mismatch, true);
  assert.match(employee?.error ?? '', /deferred lookup update \(Manager\): 0 of 249 row\(s\) updated; 249 not updated: skipped: Employee not loaded/);
  assert.equal(result.deferredUpdates?.length, 1);
  assert.deepEqual(
    { ...result.deferredUpdates![0]!, notUpdatedRanges: [] },
    { table: 'Employee', columns: ['Manager'], rows: EMPLOYEES - 1, updated: 0, notUpdated: EMPLOYEES - 1, updatedRanges: [], notUpdatedRanges: [], error: 'skipped: Employee not loaded' },
  );
  assert.equal(result.tables.find((table) => table.table === 'Office')?.mismatch, false, 'the other tables still load');

  fake.setFaults({});
  const second = await seedRun(fake);
  assert.equal(second.ok, true, JSON.stringify(second.tables.map((table) => table.error)));
  assert.deepEqual(fake.inserts, [], 'the re-run inserts nothing');
  assertManagersSet(fake.stored.get('Employee')!, (i) => `e${i}`);
});

test('seed: a self-lookup table whose insert failed is reported as re-inserted on re-run, and the re-run inserts it', async () => {
  const fake = store();
  fake.setFaults({ failInserts: 'Employee' });
  const result = await seedRun(fake);
  assert.equal(result.ok, false);
  const employee = result.tables.find((table) => table.table === 'Employee');
  assert.equal(employee?.mismatch, true);
  assert.match(employee?.error ?? '', /deferred lookup update \(Manager\): 0 of 249 row\(s\) updated; 249 not updated: skipped: Employee not loaded/);
  assert.match(employee?.error ?? '', /re-run the load: it inserts the missing Employee rows and then applies these updates/);
  assert.doesNotMatch(employee?.error ?? '', /nothing is inserted again/);
  assert.deepEqual(result.deferredUpdates?.[0]?.reRunInserts, ['Employee']);

  fake.setFaults({});
  const second = await seedRun(fake);
  assert.equal(second.ok, true, JSON.stringify(second.tables.map((table) => table.error)));
  assert.ok(fake.inserts.includes('Employee'), 'the re-run inserts the missing rows');
  assertManagersSet(fake.stored.get('Employee')!, (i) => `e${i}`);
});

test('updateDeferredForeignKeys does not PUT a row whose lookup already holds the target value', async () => {
  const sent: NonNullable<Parameters<FetchLike>[1]>[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (new URL(url).pathname.endsWith('/query')) {
      return response({ data: [{ ROWID: '302', Mentor: '301' }] });
    }
    if (init) sent.push(init);
    return response({ status: 'success' });
  };
  const reports = await updateDeferredForeignKeys(
    { dc: 'in', catalystBase: BASE, fetch, scope: SCOPE },
    [{ table: 'Person', rows: [{ id: 'p1', columns: {} }, { id: 'p2', columns: { Mentor: 'p1' } }, { id: 'p9', columns: { Mentor: 'p1' } }] }],
    [{ table: 'Person', column: 'Mentor', parent: 'Person' }],
    new Set(['Person\0Mentor']),
    new Map([['Person', new Map([['p1', '301'], ['p2', '302'], ['p9', '309']])]]),
  );
  assert.equal(sent.length, 1, 'only the row still holding the wrong value is updated');
  assert.deepEqual(JSON.parse(String(sent[0]!.body)), [{ ROWID: '309', Mentor: '301' }]);
  assert.equal(reports[0]!.updated, 2);
  assert.equal(reports[0]!.notUpdated, 0);
});

test('updateDeferredForeignKeys skips and reports a table whose deferred parent did not load, and still updates the others', async () => {
  const sent: string[] = [];
  const fetch: FetchLike = async (url) => {
    const path = new URL(url).pathname;
    if (!path.endsWith('/query')) sent.push(decodeURIComponent(path.split('/').at(-2) ?? ''));
    return response({ status: 'success' });
  };
  const reports = await updateDeferredForeignKeys(
    { dc: 'in', catalystBase: BASE, fetch, scope: SCOPE },
    [
      { table: 'Dept', rows: [{ id: 'd1', columns: { Head: 'p1' } }] },
      { table: 'Person', rows: [{ id: 'p1', columns: { Dept: 'd1' } }, { id: 'p2', columns: { Mentor: 'p1' } }] },
    ],
    [
      { table: 'Dept', column: 'Head', parent: 'Person' },
      { table: 'Person', column: 'Dept', parent: 'Dept' },
      { table: 'Person', column: 'Mentor', parent: 'Person' },
      { table: 'Mentor', column: 'Of', parent: 'Person' },
    ],
    new Set(['Dept\0Head', 'Person\0Dept', 'Person\0Mentor']),
    new Map([['Dept', new Map([['d1', '201']])], ['Person', new Map([['p1', '301'], ['p2', '302']])]]),
    new Set(['Dept']),
  );
  assert.deepEqual(sent, [], 'no update reaches a table tied to one that did not load');
  assert.deepEqual(reports.map((report) => [report.table, report.columns, report.notUpdated, report.error]), [
    ['Dept', ['Head'], 1, 'skipped: Dept not loaded'],
    ['Person', ['Dept', 'Mentor'], 2, 'skipped: parent Dept not loaded (lookup Dept)'],
  ]);
  const self = await updateDeferredForeignKeys(
    { dc: 'in', catalystBase: BASE, fetch, scope: SCOPE },
    [{ table: 'Person', rows: [{ id: 'p1', columns: {} }, { id: 'p2', columns: { Mentor: 'p1' } }] }],
    [{ table: 'Person', column: 'Mentor', parent: 'Person' }],
    new Set(['Person\0Mentor']),
    new Map([['Person', new Map([['p1', '301'], ['p2', '302']])]]),
    new Set(['Dept']),
  );
  assert.deepEqual(sent, ['Person'], 'a table not tied to the failed one is updated');
  assert.equal(self[0]!.updated, 1);
});

test('updateDeferredForeignKeys names the table a re-run inserts when its insert failed, and only then', async () => {
  const fetch: FetchLike = async () => assert.fail('a skipped table is not read or written');
  const args: Parameters<typeof updateDeferredForeignKeys>[1] = [
    { table: 'Dept', rows: [{ id: 'd1', columns: { Head: 'p1' } }] },
    { table: 'Person', rows: [{ id: 'p1', columns: { Dept: 'd1' } }] },
  ];
  const keys = [
    { table: 'Dept', column: 'Head', parent: 'Person' },
    { table: 'Person', column: 'Dept', parent: 'Dept' },
  ];
  const deferred = new Set(['Dept\0Head', 'Person\0Dept']);
  const rowIds = new Map([['Person', new Map([['p1', '301']])]]);
  // The Dept insert failed: its rows are absent, so a re-run writes them first.
  const inserted = await updateDeferredForeignKeys(
    { dc: 'in', catalystBase: BASE, fetch, scope: SCOPE },
    args, keys, deferred, rowIds, new Set(['Dept']), new Set(['Dept']),
  );
  assert.deepEqual(inserted.map((report) => report.reRunInserts), [['Dept'], ['Dept']]);
  // A ROWID read-back failure leaves the rows behind: a re-run only updates.
  const mapped = await updateDeferredForeignKeys(
    { dc: 'in', catalystBase: BASE, fetch, scope: SCOPE },
    args, keys, deferred, rowIds, new Set(['Dept']),
  );
  assert.deepEqual(mapped.map((report) => report.reRunInserts), [undefined, undefined]);
});

const DS = `application "Shop"
{
	form Author
	{
		Name
		(
			type = text
		)
	}
	form Tag
	{
		Label
		(
			type = text
		)
	}
	form Book
	{
		Title
		(
			type = text
		)
		Writer
		(
			type = picklist
			values = Author.ID
		)
	}
	form Employee
	{
		Name
		(
			type = text
		)
		Manager
		(
			type = picklist
			values = Employee.ID
		)
	}
}
`;

function dataset(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-partial-'));
  writeFileSync(join(dir, 'Author.csv'), 'ID,Name\n11,Ada\n12,Lin\n');
  writeFileSync(join(dir, 'Tag.csv'), 'ID,Label\n20,alpha\n');
  writeFileSync(join(dir, 'Book.csv'), 'ID,Title,Writer\n30,One,11\n31,Two,12\n');
  const lines = Array.from({ length: EMPLOYEES }, (_, i) => `${1000 + i},N${i},${i ? 1000 + i - 1 : ''}`);
  writeFileSync(join(dir, 'Employee.csv'), `ID,Name,Manager\n${lines.join('\n')}\n`);
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Author: 2, Tag: 1, Book: 2, Employee: EMPLOYEES }));
  return dir;
}

function csvRun(fake: ReturnType<typeof store>, loaded: ReturnType<typeof readSourceCsv>) {
  return migrateLoaded({
    app: deriveIr(parse(DS)),
    loaded,
    dc: 'in',
    catalystBase: BASE,
    fetch: fake.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
}

test('csv: a failed ROWID read-back reports the parent, skips its lookup children, loads independent tables, and a re-run completes', async () => {
  const app = deriveIr(parse(DS));
  const loaded = readSourceCsv(dataset(), app);
  const fake = store();
  fake.setFaults({ readBackFails: 'Author' });
  const first = await csvRun(fake, loaded);
  assert.equal(first.ok, false);
  const byTable = new Map(first.tables.map((table) => [table.table, table]));
  assert.match(byTable.get('Author')?.error ?? '', /ROWID read-back failed/);
  assert.equal(byTable.get('Author')?.mismatch, true);
  assert.match(byTable.get('Book')?.error ?? '', /skipped: parent Author not loaded \(lookup Writer\)/);
  assert.equal(byTable.get('Book')?.writtenCount, 0);
  assert.ok(!fake.inserts.includes('Book'), 'a child of an unmapped parent is never written');
  assert.equal(byTable.get('Tag')?.mismatch, false);
  assert.equal(fake.stored.get('Tag')?.size, 1, 'an independent table loads');
  assert.equal(fake.stored.get('Employee')?.size, EMPLOYEES, 'an independent table loads');
  assert.equal(byTable.get('Employee')?.mismatch, false);
  assert.equal(first.deferredUpdates?.[0]?.updated, EMPLOYEES - 1, 'the self-lookup table still gets its deferred lookups');
  assertManagersSet(fake.stored.get('Employee')!, (i) => String(1000 + i - 1));

  fake.setFaults({});
  const second = await csvRun(fake, loaded);
  assert.equal(second.ok, true, JSON.stringify(second.tables.map((table) => table.error)));
  assert.ok(!fake.inserts.includes('Author') && !fake.inserts.includes('Tag'), 'rows that landed are not inserted again');
  const authors = fake.stored.get('Author')!;
  assert.equal(fake.stored.get('Book')!.get('30')!.columns.Writer, authors.get('11')!.rowid);
});

test('csv: an unresolvable lookup reports the table and its reason, skips its write, and still loads the rest', async () => {
  const app = deriveIr(parse(DS));
  const loaded = readSourceCsv(dataset(), app);
  const book = loaded.tables.find((table) => table.table === 'Book')!;
  book.rows[1] = { id: book.rows[1]!.id, columns: { ...book.rows[1]!.columns, Writer: '99' } };
  const fake = store();
  const result = await csvRun(fake, loaded);
  assert.equal(result.ok, false);
  const byTable = new Map(result.tables.map((table) => [table.table, table]));
  assert.match(byTable.get('Book')?.error ?? '', /skipped: lookup Writer row 31 source id 99 is not in Author/);
  assert.ok(!fake.inserts.includes('Book'), 'no row of the table is written');
  assert.equal(byTable.get('Author')?.mismatch, false);
  assert.equal(fake.stored.get('Tag')?.size, 1);
  assert.equal(fake.stored.get('Employee')?.size, EMPLOYEES);
});

test('csv: a failed deferred PUT batch reports the rows updated and not updated, and a re-run finishes them without inserting again', async () => {
  const app = deriveIr(parse(DS));
  const loaded = readSourceCsv(dataset(), app);
  const fake = store();
  fake.setFaults({ failPuts: [2] });
  const first = await csvRun(fake, loaded);
  assert.equal(first.ok, false);
  const managed = sortedRowIds(fake.stored.get('Employee')!).slice(1);
  assert.deepEqual(first.deferredUpdates, [{
    table: 'Employee',
    columns: ['Manager'],
    rows: EMPLOYEES - 1,
    updated: 200,
    notUpdated: EMPLOYEES - 201,
    updatedRanges: [`${managed[0]}..${managed[199]}`],
    notUpdatedRanges: [`${managed[200]}..${managed.at(-1)}`],
    error: 'catalyst row update failed: 500',
  }]);
  assert.match(first.tables.find((table) => table.table === 'Employee')?.error ?? '', /200 of 249 row\(s\) updated/);
  for (const table of ['Author', 'Tag', 'Book']) assert.equal(first.tables.find((item) => item.table === table)?.mismatch, false, table);

  fake.setFaults({});
  const second = await csvRun(fake, loaded);
  assert.equal(second.ok, true, JSON.stringify(second.tables.map((table) => table.error)));
  assert.deepEqual(fake.inserts, [], 'the re-run inserts nothing');
  assert.deepEqual(fake.putCalls.map((call) => call.rows), [49], 'the re-run PUTs only the rows still unset');
  const byId = fake.stored.get('Employee')!;
  for (let i = 1; i < EMPLOYEES; i++) assert.equal(byId.get(String(1000 + i))!.columns.Manager, byId.get(String(1000 + i - 1))!.rowid);
});

test('csv: a self-lookup table whose ROWID read-back fails is reported with its deferred lookups not set', async () => {
  const app = deriveIr(parse(DS));
  const loaded = readSourceCsv(dataset(), app);
  const fake = store();
  fake.setFaults({ readBackFails: 'Employee' });
  const first = await csvRun(fake, loaded);
  assert.equal(first.ok, false);
  const employee = first.tables.find((table) => table.table === 'Employee');
  assert.equal(employee?.mismatch, true);
  assert.match(employee?.error ?? '', /249 not updated: skipped: Employee not loaded/);
  assert.equal(first.deferredUpdates?.[0]?.notUpdated, EMPLOYEES - 1);
  for (const table of ['Author', 'Tag', 'Book']) assert.equal(first.tables.find((item) => item.table === table)?.mismatch, false, table);

  fake.setFaults({});
  const second = await csvRun(fake, loaded);
  assert.equal(second.ok, true, JSON.stringify(second.tables.map((table) => table.error)));
  assert.deepEqual(fake.inserts, [], 'the re-run inserts nothing');
  assertManagersSet(fake.stored.get('Employee')!, (i) => String(1000 + i - 1));
});
