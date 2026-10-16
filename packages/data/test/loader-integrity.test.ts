/**
 * Loader integrity against the Data Store quirks in catalyst-row-fake.ts.
 * Every value is refused before the POST or checked against the stored row.
 * A 400 that still wrote the row is read back by c2c_source_id and not inserted again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { emptyCheckpoint, migrateData, type FetchLike, type MigrateResponse } from '../src/migrate.js';
import type { IntegrityColumn } from '../src/integrity.js';
import { duplicateUniqueRefusals, mandatoryMissingRefusals, prepareCell, prepareColumns } from '../src/integrity.js';
import { quirkRowServer } from './catalyst-row-fake.js';
import { migrateCsv } from '../../deploy/src/csv.js';
import { migrateSeed } from '../../deploy/src/seed.js';

const SCOPE = { org: '10000000000', projectId: '10000000000000001', token: 'cli-token' };

const columns: IntegrityColumn[] = [
  { name: 'Name', dataType: 'VarChar', length: 10 },
  { name: 'When', dataType: 'Date' },
  { name: 'At', dataType: 'DateTime' },
  { name: 'Amount', dataType: 'Double', scale: 2 },
  { name: 'Note', dataType: 'Text', length: 12 },
];

const bases = {
  dc: 'in',
  creatorBase: 'https://www.zohoapis.in',
  catalystBase: 'https://api.catalyst.zoho.in',
  owner: 'owner',
  appLink: 'demo',
  tables: [{ report: 'All_Vendors', table: 'Vendor', integrityColumns: columns }],
  scope: SCOPE,
};

function creator(rows: Record<string, unknown>[]): FetchLike {
  return async (_url, init) => {
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('creator fake got a write');
    const body = JSON.stringify({ code: 3000, data: rows });
    return { status: 200, headers: { get: () => null }, text: async () => body };
  };
}

function route(page: FetchLike, store: ReturnType<typeof quirkRowServer>): FetchLike {
  return async (url, init) => ((init?.method ?? 'GET') === 'GET' ? page(url, init) : store.fetch(url, init));
}

function reportText(result: { integrity?: { refusedByRule: { rule: string; rows: { table: string; column: string; sourceId: string }[] }[] } }): string {
  return JSON.stringify(result.integrity ?? {});
}

test('the fake truncates, mangles dates, rounds, and can 400 after the write', async () => {
  const store = quirkRowServer({
    truncate: { Name: 10 },
    round: { Amount: 2 },
    mangleDates: ['When'],
    errorAfterWrite: true,
  });
  const url = 'https://api.catalyst.zoho.in/baas/v1/project/10000000000000001/table/Vendor/row';
  const response = await store.fetch(url, {
    method: 'POST',
    body: JSON.stringify([{ c2c_source_id: 's1', Name: 'abcdefghijklmnop', When: '05-10-2026', Amount: '0.105' }]),
  });
  assert.equal(response.status, 400);
  const failure = JSON.parse(await response.text()) as { data: { message: string } };
  assert.equal(failure.data.message, 'For input string: "nu"');
  const stored = store.stored.get('Vendor\0s1');
  assert.equal(stored?.Name, 'abcdefghij');
  assert.equal(stored?.When, '0011-04-18');
  assert.equal(stored?.Amount, 0.1);
  const again = quirkRowServer({ round: { Amount: 2 } });
  await again.fetch(url, { method: 'POST', body: JSON.stringify([{ c2c_source_id: 's2', Amount: '-0.015' }]) });
  assert.equal(again.stored.get('Vendor\0s2')?.Amount, -0.01);
});

test('over-long text is refused before write, with table.column and the source id', async () => {
  const store = quirkRowServer({ truncate: { Name: 10, Note: 12 } });
  const result = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'abcdefghijklmnop', Note: 'this note is too long' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(store.posts.length, 0);
  assert.equal(result.ok, false);
  const rules = result.integrity?.refusedByRule.map((group) => group.rule).sort();
  assert.deepEqual(rules, ['text-length']);
  const rows = result.integrity?.refusedByRule.flatMap((group) => group.rows) ?? [];
  assert.ok(rows.some((row) => row.table === 'Vendor' && row.column === 'Name' && row.sourceId === 's1'));
  assert.ok(rows.some((row) => row.table === 'Vendor' && row.column === 'Note' && row.sourceId === 's1'));
  assert.equal(reportText(result).includes('abcdefghijklmnop'), false);
  assert.equal(reportText(result).includes('this note is too long'), false);
});

test('extra decimal digits are refused and never rounded', async () => {
  const store = quirkRowServer({ round: { Amount: 2 } });
  const refused = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'Ada', Amount: '0.105' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(store.posts.length, 0);
  assert.equal(refused.ok, false);
  assert.equal(refused.integrity?.refusedByRule[0]?.rule, 'decimal-scale');
  assert.deepEqual(refused.integrity?.refusedByRule[0]?.rows[0], { table: 'Vendor', column: 'Amount', sourceId: 's1' });
  assert.equal(reportText(refused).includes('0.105'), false);
  assert.equal(store.stored.size, 0);

  const negative = quirkRowServer({ round: { Amount: 2 } });
  const neg = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's2', Name: 'Ada', Amount: '-0.015' }]), negative),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(negative.posts.length, 0);
  assert.equal(neg.integrity?.refusedByRule[0]?.rule, 'decimal-scale');

  const kept = quirkRowServer({ round: { Amount: 2 } });
  const ok = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's3', Name: 'Ada', Amount: '0.10' }]), kept),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(ok.ok, true);
  assert.equal(kept.posts.length, 1);
  assert.equal(kept.posts[0]?.[0]?.Amount, '0.10');
  assert.equal(kept.stored.get('Vendor\0s3')?.Amount, '0.10');
  assert.equal(ok.integrity?.written, 1);
  assert.equal(ok.integrity?.unknownThenFound, 0);
});

test('a computed decimal with extra digits is still refused on the loader path', () => {
  // The runtime rounds 112.9887 to the column scale before its write check;
  // the loader keeps the strict refusal for a CSV value with extra digits.
  const payment: IntegrityColumn[] = [{ name: 'Payment', dataType: 'VarChar', length: 64, scale: 2, exactDecimal: true }];
  const checked = prepareColumns(payment, { Payment: '112.9887' });
  assert.deepEqual(checked.refusals, [{ column: 'Payment', rule: 'decimal-scale' }]);
  const kept = prepareColumns(payment, { Payment: '112.99' });
  assert.deepEqual(kept.refusals, []);
  assert.equal(kept.cells.Payment, '112.99');
});

test('ambiguous dates are refused and Creator dd-MMM-yyyy is stored as ISO', async () => {
  const bad = quirkRowServer({ mangleDates: ['When'] });
  const refused = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'Ada', When: '05-10-2026' }]), bad),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(bad.posts.length, 0);
  assert.equal(refused.integrity?.refusedByRule[0]?.rule, 'date-format');
  assert.deepEqual(refused.integrity?.refusedByRule[0]?.rows[0], { table: 'Vendor', column: 'When', sourceId: 's1' });
  assert.equal(reportText(refused).includes('05-10-2026'), false);
  assert.equal(reportText(refused).includes('0011-04-18'), false);

  const good = quirkRowServer({ mangleDates: ['When', 'At'] });
  const result = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's2', Name: 'Ada', When: '05-Oct-2026', At: '05-Oct-2026 09:08:07' }]), good),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(result.ok, true);
  assert.equal(good.posts[0]?.[0]?.When, '2026-10-05');
  assert.equal(good.posts[0]?.[0]?.At, '2026-10-05 09:08:07');
  assert.equal(good.stored.get('Vendor\0s2')?.When, '2026-10-05');
  assert.equal(result.integrity?.written, 1);
  assert.equal(result.integrity?.refusedByRule.length, 0);
});

test('a stored value that still differs from the payload is not accepted', async () => {
  const store = quirkRowServer({ truncate: { Name: 10 } });
  const wide: IntegrityColumn[] = columns.map((column) => (column.name === 'Name' ? { ...column, length: 20 } : column));
  const result = await migrateData({
    ...bases,
    tables: [{ report: 'All_Vendors', table: 'Vendor', integrityColumns: wide }],
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'abcdefghijklmnop' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(store.posts.length, 1);
  assert.equal(store.stored.get('Vendor\0s1')?.Name, 'abcdefghij');
  assert.equal(result.ok, false);
  assert.equal(result.tables[0]?.writtenCount, 0);
  assert.equal(result.integrity?.written, 0);
  assert.equal(result.integrity?.refusedByRule[0]?.rule, 'silent-change');
  assert.deepEqual(result.integrity?.refusedByRule[0]?.rows[0], { table: 'Vendor', column: 'Name', sourceId: 's1' });
  assert.equal(reportText(result).includes('abcdefghij'), false);

  const again = await migrateData({
    ...bases,
    tables: [{ report: 'All_Vendors', table: 'Vendor', integrityColumns: wide }],
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'abcdefghijklmnop' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(store.posts.length, 1);
  assert.equal(again.ok, false);
  assert.equal(again.integrity?.written, 0);
  assert.equal(again.integrity?.refusedByRule[0]?.rule, 'silent-change');
});

test('a 400 after the write is read back and a resume does not insert it again', async () => {
  const store = quirkRowServer({ errorAfterWrite: true });
  const page = creator([{ ID: 's1', Name: 'Ada', Amount: '0.10', When: '2026-10-05' }]);
  const first = await migrateData({ ...bases, dryRun: false, fetch: route(page, store), checkpoint: emptyCheckpoint() });
  assert.equal(first.ok, true);
  assert.equal(store.posts.length, 1);
  assert.equal(first.integrity?.written, 0);
  assert.equal(first.integrity?.unknownThenFound, 1);
  assert.deepEqual(first.integrity?.unknownThenFoundIds, ['s1']);
  assert.equal(first.tables[0]?.writtenCount, 1);
  assert.equal(reportText(first).includes('Ada'), false);

  const second = await migrateData({ ...bases, dryRun: false, fetch: route(page, store), checkpoint: emptyCheckpoint() });
  assert.equal(second.ok, true);
  assert.equal(store.posts.length, 1);
  assert.equal(second.tables[0]?.writtenCount, 1);
  assert.equal(store.stored.size, 1);
});

test('a 400 that did not write the row still fails closed', async () => {
  let posts = 0;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return creator([{ ID: 's1', Name: 'Ada' }])(url, init);
    const path = new URL(url).pathname;
    if (path.endsWith('/query')) {
      const body = JSON.stringify({ status: 'success', data: [] });
      return { status: 200, headers: { get: () => null }, text: async () => body } satisfies MigrateResponse;
    }
    posts += 1;
    const body = JSON.stringify({ status: 'failure', data: { error_code: 'INVALID_INPUT', message: 'Invalid input value for Order_Date. date value expected' } });
    return { status: 400, headers: { get: () => null }, text: async () => body };
  };
  await assert.rejects(
    () => migrateData({ ...bases, dryRun: false, fetch, checkpoint: emptyCheckpoint() }),
    /catalyst write failed: 400 INVALID_INPUT: Invalid input value for Order_Date\. date value expected/,
  );
  assert.equal(posts, 1);
});

const APP = `application "Widget"
{
	form Vendor
	{
		Name
		(
			type = text
			maxchar = 10
		)
		When
		(
			type = date
		)
		Amount
		(
			type = decimal
		)
	}
}
`;

test('csv and seed paths refuse before the row post and record the rule', async () => {
  const app = deriveIr(parse(APP));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-integrity-'));
  writeFileSync(join(dir, 'Vendor.csv'), 'ID,Name,When,Amount\ns1,abcdefghijklmnop,05-Oct-2026,0.105\n');
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Vendor: 1 }));
  const store = quirkRowServer({ truncate: { Name: 10 }, round: { Amount: 2 }, mangleDates: ['When'] });
  const csv = await migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(store.posts.length, 0);
  assert.equal(csv.ok, false);
  const rules = csv.integrity?.refusedByRule.map((group) => group.rule).sort();
  assert.deepEqual(rules, ['decimal-scale', 'text-length']);
  assert.equal(JSON.stringify(csv.integrity).includes('0.105'), false);
  assert.equal(JSON.stringify(csv.integrity).includes('abcdefghijklmnop'), false);

  const seedStore = quirkRowServer({ mangleDates: ['When'] });
  const seeded = await migrateSeed({
    tables: [{ table: 'Vendor', rows: [{ id: 's9', columns: { Name: 'Ada', When: '05-10-2026' } }] }],
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch: seedStore.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
    columnsByTable: {
      Vendor: [
        { name: 'Name', dataType: 'VarChar', length: 10 },
        { name: 'When', dataType: 'Date' },
      ],
    },
  });
  assert.equal(seedStore.posts.length, 0);
  assert.equal(seeded.integrity?.refusedByRule[0]?.rule, 'date-format');
  assert.equal(seeded.integrity?.refusedByRule[0]?.rows[0]?.sourceId, 's9');
});

function rulesOf(result: { integrity?: { refusedByRule: { rule: string }[] } }): string[] {
  return (result.integrity?.refusedByRule ?? []).map((group) => group.rule);
}

test('a Double past 15 significant digits is refused before the POST', async () => {
  const store = quirkRowServer();
  const refused = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'Ada', Amount: '12345678901234567.89' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(store.posts.length, 0);
  assert.equal(store.stored.size, 0);
  assert.equal(refused.ok, false);
  assert.deepEqual(rulesOf(refused), ['significant-digits']);
  assert.deepEqual(refused.integrity?.refusedByRule[0]?.rows[0], { table: 'Vendor', column: 'Amount', sourceId: 's1' });
  assert.equal(reportText(refused).includes('12345678901234567.89'), false);

  const kept = quirkRowServer();
  const ok = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's2', Name: 'Ada', Amount: '1234567890123.89' }]), kept),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(ok.ok, true);
  assert.equal(kept.posts.length, 1);
  assert.equal(ok.integrity?.written, 1);
  assert.equal(ok.integrity?.verified, true);

  const shadow = quirkRowServer();
  const shadowColumns: IntegrityColumn[] = [
    { name: 'Name', dataType: 'VarChar', length: 10 },
    { name: 'Amount__n', dataType: 'Double', shadow: true },
  ];
  const derived = await migrateData({
    ...bases,
    tables: [{ report: 'All_Vendors', table: 'Vendor', integrityColumns: shadowColumns }],
    dryRun: false,
    fetch: route(creator([{ ID: 's3', Name: 'Ada', Amount__n: '12345678901234567.89' }]), shadow),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(derived.ok, true);
  assert.equal(shadow.posts.length, 1);
  assert.equal(rulesOf(derived).includes('significant-digits'), false);
});

test('a trailing Z on DateTime is refused and not stored with the zone dropped', async () => {
  const store = quirkRowServer();
  const refused = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'Ada', At: '2026-01-01T10:00:00Z' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(store.posts.length, 0);
  assert.equal(store.stored.size, 0);
  assert.equal(refused.integrity?.refusedByRule[0]?.rule, 'date-format');
  assert.deepEqual(refused.integrity?.refusedByRule[0]?.rows[0], { table: 'Vendor', column: 'At', sourceId: 's1' });
  assert.equal(reportText(refused).includes('2026-01-01'), false);

  const offset = quirkRowServer();
  const zoned = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's2', Name: 'Ada', At: '2026-01-01T10:00:00+05:30' }]), offset),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(offset.posts.length, 0);
  assert.equal(zoned.integrity?.refusedByRule[0]?.rule, 'date-format');

  const plain = quirkRowServer();
  const ok = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's3', Name: 'Ada', At: '2026-01-01T10:00:00' }]), plain),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(ok.ok, true);
  assert.equal(plain.posts[0]?.[0]?.At, '2026-01-01 10:00:00');
  assert.equal(ok.integrity?.written, 1);
});

test('duplicate c2c_source_id rows are refused on 200, 400-after-write, and resume', async () => {
  const page = (id: string, name = 'Ada') => creator([{ ID: id, Name: name, Amount: '0.10', When: '2026-10-05' }]);

  const inserted = quirkRowServer({ duplicateInsert: true });
  const on200 = await migrateData({ ...bases, dryRun: false, fetch: route(page('2008'), inserted), checkpoint: emptyCheckpoint() });
  assert.equal(inserted.posts.length, 1);
  assert.equal(inserted.rowsFor('Vendor', '2008').length, 2);
  assert.equal(on200.ok, false);
  assert.equal(on200.integrity?.written, 0);
  assert.deepEqual(rulesOf(on200), ['duplicate-source-id']);
  assert.deepEqual(on200.tables[0]?.duplicateIds, ['2008']);
  assert.equal(on200.tables[0]?.error?.includes('duplicate c2c_source_id'), true);
  assert.equal(reportText(on200).includes('Ada'), false);

  const after400 = quirkRowServer({ duplicateInsert: true, errorAfterWrite: true });
  const on400 = await migrateData({ ...bases, dryRun: false, fetch: route(page('2007'), after400), checkpoint: emptyCheckpoint() });
  assert.equal(after400.posts.length, 1);
  assert.equal(after400.rowsFor('Vendor', '2007').length, 2);
  assert.equal(on400.ok, false);
  assert.equal(on400.integrity?.unknownThenFound, 0);
  assert.deepEqual(rulesOf(on400), ['duplicate-source-id']);
  assert.deepEqual(on400.tables[0]?.duplicateIds, ['2007']);

  const same = quirkRowServer();
  same.addStored('Vendor', { c2c_source_id: '2009', Name: 'Ada', ROWID: '1' });
  same.addStored('Vendor', { c2c_source_id: '2009', Name: 'Ada', ROWID: '2' });
  const resume = await migrateData({ ...bases, dryRun: false, fetch: route(page('2009'), same), checkpoint: emptyCheckpoint() });
  assert.equal(same.posts.length, 0);
  assert.equal(resume.ok, false);
  assert.deepEqual(rulesOf(resume), ['duplicate-source-id']);
  assert.deepEqual(resume.tables[0]?.duplicateIds, ['2009']);

  const bobLast = quirkRowServer();
  bobLast.addStored('Vendor', { c2c_source_id: '2010', Name: 'Ada', ROWID: '1' });
  bobLast.addStored('Vendor', { c2c_source_id: '2010', Name: 'Bob', ROWID: '2' });
  const differing = await migrateData({ ...bases, dryRun: false, fetch: route(page('2010'), bobLast), checkpoint: emptyCheckpoint() });
  assert.equal(bobLast.posts.length, 0);
  assert.equal(differing.ok, false);
  assert.deepEqual(rulesOf(differing), ['duplicate-source-id']);
  assert.equal(rulesOf(differing).includes('silent-change'), false);

  const adaLast = quirkRowServer();
  adaLast.addStored('Vendor', { c2c_source_id: '2012', Name: 'Bob', ROWID: '1' });
  adaLast.addStored('Vendor', { c2c_source_id: '2012', Name: 'Ada', ROWID: '2' });
  const matchingLast = await migrateData({ ...bases, dryRun: false, fetch: route(page('2012'), adaLast), checkpoint: emptyCheckpoint() });
  assert.equal(adaLast.posts.length, 0);
  assert.equal(matchingLast.ok, false);
  assert.deepEqual(rulesOf(matchingLast), ['duplicate-source-id']);
  assert.equal(rulesOf(matchingLast).includes('silent-change'), false);
});

test('the csv path reports a duplicate source id instead of only a count mismatch', async () => {
  const app = deriveIr(parse(`application "Widget"
{
	form Vendor
	{
		Name
		(
			type = text
			maxchar = 10
		)
	}
}
`));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-dup-csv-'));
  writeFileSync(join(dir, 'Vendor.csv'), 'ID,Name\ns1,Ada\n');
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Vendor: 1 }));
  const store = quirkRowServer({ duplicateInsert: true });
  const csv = await migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(store.posts.length, 1);
  assert.equal(store.rowsFor('Vendor', 's1').length, 2);
  assert.equal(csv.ok, false);
  assert.deepEqual(rulesOf(csv), ['duplicate-source-id']);
  // The counts pass still runs after the refusal, so the report names the table.
  assert.equal(csv.counts.find((item) => item.table === 'Vendor')?.mismatch, true);
  assert.equal(JSON.stringify(csv.integrity).includes('Ada'), false);
});

test('a write with no schema is not reported as verified', async () => {
  const store = quirkRowServer();
  const result = await migrateData({
    ...bases,
    tables: [{ report: 'All_Vendors', table: 'Vendor' }],
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'abcdefghijklmnop', When: '2026-13-45', Amount: '0.105' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(store.posts.length, 1);
  assert.equal(result.integrity?.written, 0);
  assert.equal(result.integrity?.unverified, 1);
  assert.equal(result.integrity?.verified, false);
  assert.equal(JSON.stringify(result.integrity).includes('"verified":true'), false);
});

test('a required column absent from the source row is refused before the row post', async () => {
  const store = quirkRowServer();
  const required: IntegrityColumn[] = columns.map((column) =>
    column.name === 'Name' ? { ...column, required: true } : column,
  );
  const result = await migrateData({
    ...bases,
    tables: [{ report: 'All_Vendors', table: 'Vendor', integrityColumns: required }],
    dryRun: false,
    fetch: route(creator([{ ID: 's1', When: '2026-10-05' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(store.posts.length, 0);
  assert.equal(store.stored.size, 0);
  assert.equal(result.ok, false);
  assert.deepEqual(rulesOf(result), ['mandatory-missing']);
  assert.deepEqual(result.integrity?.refusedByRule[0]?.rows[0], { table: 'Vendor', column: 'Name', sourceId: 's1' });
});

test('a good load folds matching source and read-back value checksums', async () => {
  const store = quirkRowServer();
  const result = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([
      { ID: 's1', Name: 'Ada', When: '05-Oct-2026', Amount: '0.10' },
      { ID: 's2', Name: 'Bob', When: '2026-10-06', Amount: '0.20' },
    ]), store),
    checkpoint: emptyCheckpoint(),
  });
  const table = result.tables[0]!;
  assert.equal(result.ok, true);
  assert.equal(table.mismatch, false);
  assert.equal(table.sourceChecksum, table.writtenChecksum);
  assert.ok(table.sourceValueChecksum);
  assert.equal(table.sourceValueChecksum, table.writtenValueChecksum);
  assert.deepEqual(table.missingIds, []);
  assert.equal(table.differingIds, undefined);
});

test('a value the store changed after the echo flips the value checksum and names the id', async () => {
  const store = quirkRowServer({ storeDrift: { Amount: '9.99' } });
  const result = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'Ada', Amount: '0.10' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  const table = result.tables[0]!;
  assert.equal(result.ok, false);
  assert.equal(table.mismatch, true);
  assert.deepEqual(table.differingIds, ['s1']);
  assert.notEqual(table.sourceValueChecksum, table.writtenValueChecksum);
  assert.equal(reportText(result).includes('9.99'), false);
});

test('a row the post echoed but never stored is missing on read-back', async () => {
  const store = quirkRowServer({ dropInsert: true });
  const result = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'Ada' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  const table = result.tables[0]!;
  assert.equal(result.ok, false);
  assert.equal(table.mismatch, true);
  assert.deepEqual(table.missingIds, ['s1']);
});

test('a 19-digit source id survives the load as a string end to end', async () => {
  const store = quirkRowServer();
  const big = '1234567890123456789';
  const result = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: big, Name: 'Ada' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(result.ok, true);
  assert.equal(store.posts[0]?.[0]?.c2c_source_id, big);
  assert.equal(store.stored.get(`Vendor\0${big}`)?.c2c_source_id, big);
  assert.equal(result.tables[0]?.mismatch, false);
});

test('mandatoryMissingRefusals names every source row missing a required cell, and nothing else', () => {
  const columns: Record<string, IntegrityColumn[]> = {
    Book: [
      { name: 'Title', dataType: 'VarChar', required: true },
      { name: 'Note', dataType: 'VarChar' },
    ],
    Free: [{ name: 'Anything', dataType: 'VarChar' }],
  };
  const refusals = mandatoryMissingRefusals(
    [
      { table: 'Book', rows: [{ id: 'b1', columns: { Title: 'Kept' } }, { id: 'b2', columns: { Title: '', Note: 'x' } }, { id: 'b3', columns: {} }] },
      { table: 'Free', rows: [{ id: 'f1', columns: {} }] },
      { table: 'Unknown', rows: [{ id: 'u1', columns: {} }] },
    ],
    columns,
  );
  assert.deepEqual(refusals, [
    { table: 'Book', column: 'Title', sourceId: 'b2', rule: 'mandatory-missing' },
    { table: 'Book', column: 'Title', sourceId: 'b3', rule: 'mandatory-missing' },
  ]);
});

test('duplicateUniqueRefusals refuses each repeat of a unique value but not repeated empty cells', () => {
  const refusals = duplicateUniqueRefusals(
    [
      {
        table: 'Customer',
        rows: [
          { id: 'c1', columns: { Email: 'a@example.com', Code: '' } },
          { id: 'c2', columns: { Email: 'b@example.com', Code: '' } },
          { id: 'c3', columns: { Email: 'a@example.com' } },
          { id: 'c4', columns: { Email: 'a@example.com' } },
        ],
      },
    ],
    { Customer: ['Email', 'Code'] },
  );
  assert.deepEqual(refusals, [
    { table: 'Customer', column: 'Email', sourceId: 'c3', rule: 'duplicate-unique' },
    { table: 'Customer', column: 'Email', sourceId: 'c4', rule: 'duplicate-unique' },
  ]);
});

test('prepareCell returns only the rule for a refused cell, and the canonical value otherwise', () => {
  const column: IntegrityColumn = { name: 'Code', dataType: 'VarChar', length: 3 };
  assert.deepEqual(prepareCell(column, 'toolong'), { rule: 'text-length' });
  assert.deepEqual(prepareCell(column, 'ok'), { value: 'ok' });
  const date: IntegrityColumn = { name: 'Due', dataType: 'Date' };
  assert.deepEqual(prepareCell(date, '31-Jan-2024'), { value: '2024-01-31' });
  assert.deepEqual(prepareCell(date, 'soon'), { rule: 'date-format' });
});

test('migrateData normalises Added_User/Modified_User to the invited mailbox', async () => {
  const store = quirkRowServer({});
  const result = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'Ada', Added_User: 'Owner+Tag@Example.com', Modified_User: 'Owner.Name+Ops@' + 'Gmail.com' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(result.ok, true);
  const stored = store.stored.get('Vendor\0s1');
  assert.equal(stored?.Added_User, 'owner@example.com');
  assert.equal(stored?.Modified_User, 'ownername@' + 'gmail.com');
});

test('a Creator username that is not an email is stored unchanged (MUST-NOT-REWRITE)', async () => {
  const store = quirkRowServer({});
  const result = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'Ada', Added_User: 'crazy+citizen' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(result.ok, true);
  assert.equal(store.stored.get('Vendor\0s1')?.Added_User, 'crazy+citizen');
});

test('a stored pre-remap alias is corrected by ROWID update, not refused', async () => {
  const store = quirkRowServer({});
  // A previous run stored the raw alias; this run's payload carries the canonical form.
  store.addStored('Vendor', { c2c_source_id: 's1', ROWID: '10000000000000012', Name: 'Ada', Added_User: 'owner+tag@example.com' });
  const result = await migrateData({
    ...bases,
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'Ada', Added_User: 'owner+tag@example.com' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(result.ok, true);
  assert.equal(store.puts.length > 0, true, 'the correction is a ROWID update');
  assert.equal(store.stored.get('Vendor\0s1')?.Added_User, 'owner@example.com');
});

test('Users-field cells remap Creator ZUID to the invited Catalyst user id', async () => {
  const store = quirkRowServer({});
  const userColumns = ['Assignee'];
  const withUsers = {
    ...bases,
    userIds: new Map([['9001', '10000000000000007']]),
    tables: [{ report: 'All_Vendors', table: 'Vendor', integrityColumns: [...columns, { name: 'Assignee', dataType: 'BigInt' as const }], userColumns }],
  };
  const result = await migrateData({
    ...withUsers,
    dryRun: false,
    fetch: route(creator([{ ID: 's1', Name: 'Ada', Assignee: '9001' }, { ID: 's2', Name: 'Bob', Assignee: '9002' }]), store),
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(result.ok, true);
  assert.equal(store.stored.get('Vendor\0s1')?.Assignee, '10000000000000007');
  // An unmapped ZUID loads as the source wrote it — never invented.
  assert.equal(store.stored.get('Vendor\0s2')?.Assignee, '9002');
});
