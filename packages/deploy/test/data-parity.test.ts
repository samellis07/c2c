/**
 * `dataParity` (Q6): a loaded Creator export vs the stored Data Store rows,
 * counts plus a per-record canonical hash keyed by c2c_source_id. The store
 * side is a plain map — the fake store these tests build stands in for the
 * ZCQL read (readStoreRows live, parseStoreRows for a dump). Ids only, never
 * values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import { parseFile } from '../../core/src/index.js';
import type { App } from '../../core/src/ir.js';
import { fileColumnsOf, generateSchema } from '../../schema/src/generator.js';
import { migratedObjectKey } from '../../shims/src/files.js';
import { dataParity, formatParity, readSourceJson, verifyCli, type CsvLoad, type Io } from '../src/index.js';

const APP = `application "Widget"
{
form Vendor
{
must have unique Vendor_Name
(
type = text
displayname = "Vendor Name"
)
Price
(
type = decimal
displayname = "Price"
)
Opened
(
type = date
displayname = "Opened"
)
}
form Purchase_Order
{
must have PO_Title
(
type = text
displayname = "PO Title"
)
Vendor
(
type = picklist
values = Vendor.ID
displayformat = [Vendor_Name]
)
}
list All_Vendors
{
show all rows from Vendor
(
Vendor_Name as "Vendor Name"
Price as "Price"
Opened as "Opened"
)
}
list All_Purchase_Orders
{
show all rows from Purchase_Order
(
PO_Title as "PO Title"
Vendor as "Vendor"
)
}
}
`;

function appOf(ds: string): App {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-parity-ds-'));
  const file = join(dir, 'app.ds');
  writeFileSync(file, ds);
  const parsed = parseFile(file);
  rmSync(dir, { recursive: true, force: true });
  return parsed.ir;
}

function writeJsonExport(app: App, tables: Record<string, Record<string, unknown>[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-parity-src-'));
  for (const [report, rows] of Object.entries(tables)) {
    writeFileSync(join(dir, `${report}.json`), JSON.stringify({ [report]: rows }));
  }
  return dir;
}

/**
 * What a faithful load leaves in the store: every loaded row plus ROWID and
 * c2c_source_id, lookup cells remapped to the parent's ROWID, file cells as
 * their migrated object key.
 */
function fakeStore(app: App, loaded: CsvLoad, opts?: { rawFileCells?: boolean }): Map<string, Record<string, unknown>[]> {
  const rowidOf = new Map<string, Map<string, string>>();
  let next = 10000000000000001n;
  for (const table of loaded.tables) {
    const map = new Map<string, string>();
    for (const row of table.rows) map.set(row.id, String(next++));
    rowidOf.set(table.table, map);
  }
  const files = fileColumnsOf(generateSchema(app));
  const out = new Map<string, Record<string, unknown>[]>();
  for (const table of loaded.tables) {
    const keys = loaded.foreignKeys.filter((key) => key.table === table.table);
    const fileSet = new Set(files[table.table]?.columns ?? []);
    out.set(
      table.table,
      table.rows.map((row) => {
        const stored: Record<string, unknown> = { ROWID: rowidOf.get(table.table)!.get(row.id), c2c_source_id: row.id };
        for (const [column, value] of Object.entries(row.columns)) {
          const key = keys.find((item) => item.column === column);
          if (key && value !== undefined && value !== null && value !== '') {
            stored[column] = rowidOf.get(key.parent)?.get(String(value)) ?? value;
            continue;
          }
          if (fileSet.has(column) && value !== undefined && value !== null && value !== '') {
            stored[column] = opts?.rawFileCells
              ? value
              : migratedObjectKey(files[table.table]!.form, column, row.id, value);
            continue;
          }
          stored[column] = value;
        }
        return stored;
      }),
    );
  }
  return out;
}

test('identical store passes; a changed cell, a missing row and an extra row are each reported', () => {
  const app = appOf(APP);
  const dir = writeJsonExport(app, {
    All_Vendors: [
      { ID: '101', 'Vendor Name': 'Acme', Price: '2.50', Opened: '05-Oct-2026' },
      { ID: '102', 'Vendor Name': 'Bolt', Price: '4.0', Opened: '2026-10-06' },
    ],
    All_Purchase_Orders: [{ ID: '201', 'PO Title': 'PO-1', Vendor: { ID: '101' } }],
  });
  const loaded = readSourceJson(dir, app);
  const stored = fakeStore(app, loaded);

  const clean = dataParity({ app, loaded, stored });
  assert.equal(clean.ok, true, JSON.stringify(clean.tables, null, 2));
  assert.equal(clean.tables.length, 2);
  for (const table of clean.tables) {
    assert.equal(table.mismatch, false);
    assert.equal(table.sourceChecksum, table.storedChecksum);
  }

  // One changed cell: the row's id is reported, never the value.
  const changed = new Map<string, Record<string, unknown>[]>(
    [...stored].map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]),
  );
  const po = changed.get('Purchase_Order')![0]!;
  po.PO_Title = 'PO-changed';
  const drift = dataParity({ app, loaded, stored: changed });
  assert.equal(drift.ok, false);
  const poTable = drift.tables.find((table) => table.table === 'Purchase_Order')!;
  assert.deepEqual(poTable.changedIds, ['201']);
  assert.match(JSON.stringify(poTable), /201/);
  assert.doesNotMatch(JSON.stringify(poTable), /PO-changed/);
  assert.ok(poTable.reasons.includes('Q6_CHECKSUM_MISMATCH'));
  assert.ok(drift.reasons.includes('Q6_CHECKSUM_MISMATCH'));

  // One missing row.
  const short = new Map<string, Record<string, unknown>[]>([...stored].map(([t, rows]) => [t, [...rows]]));
  short.set('Vendor', short.get('Vendor')!.slice(1));
  const missing = dataParity({ app, loaded, stored: short });
  const vendor = missing.tables.find((table) => table.table === 'Vendor')!;
  assert.equal(missing.ok, false);
  assert.deepEqual(vendor.missingIds.sort(), ['101']);
  assert.equal(vendor.storedCount, 1);
  assert.ok(vendor.reasons.includes('Q6_COUNT_MISMATCH'));
  assert.ok(missing.reasons.includes('Q6_COUNT_MISMATCH'));

  // One extra row.
  const wide = new Map<string, Record<string, unknown>[]>([...stored].map(([t, rows]) => [t, [...rows]]));
  wide.get('Vendor')!.push({ ROWID: '12345678901234567', c2c_source_id: '999', Vendor_Name: 'Ghost' });
  const extra = dataParity({ app, loaded, stored: wide });
  const extraVendor = extra.tables.find((table) => table.table === 'Vendor')!;
  assert.equal(extra.ok, false);
  assert.deepEqual(extraVendor.extraIds, ['999']);
  assert.ok(extraVendor.reasons.includes('Q6_COUNT_MISMATCH'));
  assert.ok(extra.reasons.includes('Q6_COUNT_MISMATCH'));

  rmSync(dir, { recursive: true, force: true });
});

test('a stored cell the source left empty is compared, not skipped', () => {
  const app = appOf(APP);
  const dir = writeJsonExport(app, {
    // Price omitted from the export row: the payload never carries it.
    All_Vendors: [{ ID: '101', 'Vendor Name': 'Acme', Opened: '2026-10-05' }],
    All_Purchase_Orders: [],
  });
  const loaded = readSourceJson(dir, app, true);
  const stored = fakeStore(app, loaded);

  // Source cell empty (absent), stored cell non-empty: a real mismatch.
  stored.get('Vendor')![0]!.Price = '99.99';
  const drift = dataParity({ app, loaded, stored });
  const vendor = drift.tables.find((table) => table.table === 'Vendor')!;
  assert.equal(drift.ok, false);
  assert.deepEqual(vendor.changedIds, ['101']);
  assert.ok(vendor.reasons.includes('Q6_CHECKSUM_MISMATCH'));
  assert.notEqual(vendor.sourceChecksum, vendor.storedChecksum);

  // Source cell empty, stored cell empty (explicit NULL or ''): parity holds.
  for (const empty of [null, '']) {
    const silent = fakeStore(app, loaded);
    silent.get('Vendor')![0]!.Price = empty;
    const report = dataParity({ app, loaded, stored: silent });
    const row = report.tables.find((table) => table.table === 'Vendor')!;
    assert.equal(row.mismatch, false, `stored ${JSON.stringify(empty)} must equal an absent source cell`);
    assert.equal(row.sourceChecksum, row.storedChecksum);
  }

  // A stored column the schema never sent at all is still compared.
  const wide = fakeStore(app, loaded);
  wide.get('Vendor')![0]!.Notes = 'unsent column';
  const unsent = dataParity({ app, loaded, stored: wide });
  assert.deepEqual(unsent.tables.find((table) => table.table === 'Vendor')!.changedIds, ['101']);
  assert.equal(unsent.ok, false);

  rmSync(dir, { recursive: true, force: true });
});

test('a stored duplicate source id and an unattributed row are mismatches', () => {
  const app = appOf(APP);
  const dir = writeJsonExport(app, {
    All_Vendors: [{ ID: '101', 'Vendor Name': 'Acme', Price: '2.50', Opened: '2026-10-05' }],
    All_Purchase_Orders: [],
  });
  const loaded = readSourceJson(dir, app, true);
  const stored = fakeStore(app, loaded);
  stored.get('Vendor')!.push({ ...stored.get('Vendor')![0]! });
  stored.get('Vendor')!.push({ ROWID: '12345678901234567', Vendor_Name: 'NoId' });
  const report = dataParity({ app, loaded, stored });
  const vendor = report.tables.find((table) => table.table === 'Vendor')!;
  assert.equal(report.ok, false);
  assert.deepEqual(vendor.duplicateIds, ['101']);
  assert.equal(vendor.unattributed, 1);
  assert.ok(vendor.reasons.includes('Q6_CHECKSUM_MISMATCH'));
  assert.ok(report.reasons.includes('Q6_CHECKSUM_MISMATCH'));
  rmSync(dir, { recursive: true, force: true });
});

test('stored checksum includes the cells of duplicate records', () => {
  const app = appOf(APP);
  const dir = writeJsonExport(app, { All_Vendors: [{ ID: '101', 'Vendor Name': 'Acme', Price: '2.50', Opened: '2026-10-05' }], All_Purchase_Orders: [] });
  const loaded = readSourceJson(dir, app, true);
  const first = fakeStore(app, loaded);
  first.get('Vendor')!.push({ ...first.get('Vendor')![0]!, Vendor_Name: 'Different A' });
  const second = fakeStore(app, loaded);
  second.get('Vendor')!.push({ ...second.get('Vendor')![0]!, Vendor_Name: 'Different B' });
  const checksumA = dataParity({ app, loaded, stored: first }).tables.find((table) => table.table === 'Vendor')!.storedChecksum;
  const checksumB = dataParity({ app, loaded, stored: second }).tables.find((table) => table.table === 'Vendor')!.storedChecksum;
  assert.notEqual(checksumA, checksumB);
  rmSync(dir, { recursive: true, force: true });
});

test('write-rule refusals are mismatches and never disclose rejected values', () => {
  const app = appOf(APP);
  const dir = writeJsonExport(app, { All_Vendors: [{ ID: '101', 'Vendor Name': 'Acme', Price: '2.50', Opened: '05-10-2026' }], All_Purchase_Orders: [] });
  const loaded = readSourceJson(dir, app, true);
  const report = dataParity({ app, loaded, stored: fakeStore(app, loaded) });
  const vendor = report.tables.find((table) => table.table === 'Vendor')!;
  assert.equal(vendor.mismatch, true);
  assert.equal(report.ok, false);
  assert.equal(vendor.refusals[0]?.rule, 'date-format');
  assert.ok(vendor.reasons.includes('Q6_REFUSED_WRITE'));
  assert.ok(report.reasons.includes('Q6_REFUSED_WRITE'));
  assert.doesNotMatch(JSON.stringify(report), /05-10-2026/);
  rmSync(dir, { recursive: true, force: true });
});

test('unsupported tables are reported as skipped and prevent empty success', () => {
  const app = appOf(APP);
  const loaded = readSourceJson(writeJsonExport(app, { All_Vendors: [], All_Purchase_Orders: [] }), app, true);
  loaded.skipped = [{ form: 'Vendor', table: 'Vendor', detail: 'unsupported in this test' }];
  const report = dataParity({ app, loaded, stored: new Map() });
  assert.equal(report.ok, false);
  assert.deepEqual(report.skipped, loaded.skipped);
  assert.ok(report.reasons.includes('Q6_SKIPPED_TABLE'));
  assert.match(formatParity(report), /Vendor: SKIPPED/);
});

test('empty-only inputs fail with Q6_EMPTY_ONLY and zero loaded tables have a reason', () => {
  const app = appOf(APP);
  const dir = writeJsonExport(app, { All_Vendors: [], All_Purchase_Orders: [] });
  const loaded = readSourceJson(dir, app, true);
  const report = dataParity({ app, loaded, stored: new Map() });
  assert.equal(report.ok, false);
  assert.ok(report.reasons.includes('Q6_EMPTY_ONLY'));
  assert.match(formatParity(report), /Q6_EMPTY_ONLY/);
  const noTables: CsvLoad = { ...loaded, tables: [], columns: [], skipped: [] };
  const noTableReport = dataParity({ app, loaded: noTables, stored: new Map() });
  assert.equal(noTableReport.ok, false);
  assert.ok(noTableReport.reasons.includes('Q6_NO_TABLES'));
  rmSync(dir, { recursive: true, force: true });
});

test('raw JSON report count is compared independently of materialized rows', () => {
  const app = appOf(APP);
  const dir = writeJsonExport(app, { All_Vendors: [
    { ID: '101', 'Vendor Name': 'Acme', Price: '2.50', Opened: '2026-10-05' },
    { ID: '101', 'Vendor Name': 'Acme', Price: '2.50', Opened: '2026-10-05' },
  ], All_Purchase_Orders: [] });
  const loaded = readSourceJson(dir, app, true);
  assert.equal(loaded.tables.find((table) => table.table === 'Vendor')?.rows.length, 1);
  assert.equal(loaded.columns.find((column) => column.table === 'Vendor')?.rawCount, 2);
  const report = dataParity({ app, loaded, stored: fakeStore(app, loaded) });
  assert.equal(report.ok, false);
  assert.equal(report.tables.find((table) => table.table === 'Vendor')?.sourceCount, 1);
  assert.equal(report.tables.find((table) => table.table === 'Vendor')?.mismatch, true);
  assert.equal(report.tables.find((table) => table.table === 'Vendor')?.sourceChecksum,
    report.tables.find((table) => table.table === 'Vendor')?.storedChecksum);
  assert.ok(report.tables.find((table) => table.table === 'Vendor')?.reasons.includes('Q6_COUNT_MISMATCH'));
  assert.ok(report.reasons.includes('Q6_COUNT_MISMATCH'));
  rmSync(dir, { recursive: true, force: true });
});

test('a source/target row count difference reports Q6_COUNT_MISMATCH', () => {
  const app = appOf(APP);
  const dir = writeJsonExport(app, {
    All_Vendors: [
      { ID: '101', 'Vendor Name': 'Acme', Price: '2.50', Opened: '2026-10-05' },
      { ID: '102', 'Vendor Name': 'Bolt', Price: '4.00', Opened: '2026-10-06' },
    ],
    All_Purchase_Orders: [],
  });
  const loaded = readSourceJson(dir, app, true);
  const stored = fakeStore(app, loaded);
  // Source has 2 rows; target store has 1 row (missing row 102) -> row count difference
  stored.set('Vendor', stored.get('Vendor')!.slice(0, 1));

  const report = dataParity({ app, loaded, stored });
  const vendor = report.tables.find((table) => table.table === 'Vendor')!;

  assert.equal(report.ok, false);
  assert.equal(vendor.mismatch, true);
  assert.equal(vendor.sourceCount, 2);
  assert.equal(vendor.storedCount, 1);
  assert.deepEqual(vendor.missingIds, ['102']);
  assert.deepEqual(vendor.reasons, ['Q6_COUNT_MISMATCH']);
  assert.deepEqual(report.reasons, ['Q6_COUNT_MISMATCH']);
  assert.match(formatParity(report), /Q6_COUNT_MISMATCH/);

  rmSync(dir, { recursive: true, force: true });
});

test('equal counts with one cell changed reports Q6_CHECKSUM_MISMATCH', () => {
  const app = appOf(APP);
  const dir = writeJsonExport(app, {
    All_Vendors: [{ ID: '101', 'Vendor Name': 'Acme', Price: '2.50', Opened: '2026-10-05' }],
    All_Purchase_Orders: [],
  });
  const loaded = readSourceJson(dir, app, true);
  const stored = fakeStore(app, loaded);
  // Equal counts (1 row each), but one cell changed
  stored.get('Vendor')![0]!['Vendor_Name'] = 'Acme Corp';

  const report = dataParity({ app, loaded, stored });
  const vendor = report.tables.find((table) => table.table === 'Vendor')!;

  assert.equal(report.ok, false);
  assert.equal(vendor.mismatch, true);
  assert.equal(vendor.sourceCount, 1);
  assert.equal(vendor.storedCount, 1);
  assert.deepEqual(vendor.missingIds, []);
  assert.deepEqual(vendor.extraIds, []);
  assert.deepEqual(vendor.changedIds, ['101']);
  assert.deepEqual(vendor.reasons, ['Q6_CHECKSUM_MISMATCH']);
  assert.deepEqual(report.reasons, ['Q6_CHECKSUM_MISMATCH']);
  assert.match(formatParity(report), /Q6_CHECKSUM_MISMATCH/);

  rmSync(dir, { recursive: true, force: true });
});

/** C2C_FIXTURES_DIR, then the c2c-fixtures-local checkouts near the repo (same convention as tests/golden). */
function fixturesDir(): string | undefined {
  if (process.env.C2C_FIXTURES_DIR) return process.env.C2C_FIXTURES_DIR;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // dist/deploy/test → repo root
  for (const candidate of ['c2c-fixtures-local', '../c2c-fixtures-local', '../../../c2c-fixtures-local']) {
    const dir = join(root, candidate);
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return dir;
  }
  return undefined;
}
const FIXTURES = fixturesDir();
const BOM_DS = FIXTURES ? join(FIXTURES, 'gallery', 'bill-of-materials', 'Bill_Of_Materials.ds') : '';
const BOM_EXPORT = FIXTURES ? join(FIXTURES, 'creator-exports', 'bill-of-materials') : '';
const bomSkip = !FIXTURES || !existsSync(BOM_DS) || !existsSync(BOM_EXPORT) ? 'C2C_FIXTURES_DIR bill-of-materials fixture not available' : false;

test('recorded bill-of-materials export vs a faithful fake store: parity holds outside the refused mandatory column', { skip: bomSkip }, () => {
  const app = parseFile(BOM_DS).ir;
  const loaded = readSourceJson(BOM_EXPORT, app, true);
  assert.ok(loaded.tables.length > 0);
  const stored = fakeStore(app, loaded);
  const clean = dataParity({ app, loaded, stored });
  // The export carries no Created_Date or subform Unit_Price, so the schema's
  // `must have` rules refuse those rows before compare — Q6_REFUSED_WRITE, not
  // a clean pass. Create_BOM's raw report also holds more records than the
  // materialized rows (Q6_COUNT_MISMATCH). Every other table must match.
  const byName = new Map(clean.tables.map((t) => [t.table, t]));
  const bom = byName.get('Create_BOM')!;
  assert.deepEqual(bom.reasons, ['Q6_COUNT_MISMATCH', 'Q6_REFUSED_WRITE']);
  assert.ok(bom.refusals.every((r) => r.column === 'Created_Date' && r.rule === 'mandatory-missing'));
  const sub = byName.get('Create_BOM__List_Of_Subassemblies')!;
  assert.deepEqual(sub.reasons, ['Q6_REFUSED_WRITE']);
  assert.ok(sub.refusals.every((r) => r.column === 'Unit_Price' && r.rule === 'mandatory-missing'));
  for (const table of clean.tables.filter((t) => t !== bom && t !== sub)) {
    assert.equal(table.mismatch, false, JSON.stringify(table, null, 2));
    assert.equal(table.sourceChecksum, table.storedChecksum);
  }
  assert.equal(clean.ok, false);
  assert.deepEqual(clean.reasons, ['Q6_COUNT_MISMATCH', 'Q6_REFUSED_WRITE']);

  // One changed cell on the first row of the first table.
  const first = loaded.tables[0]!;
  const changed = new Map<string, Record<string, unknown>[]>([...stored].map(([t, rows]) => [t, rows.map((row) => ({ ...row }))]));
  const row = changed.get(first.table)![0]!;
  const column = Object.keys(row).find((key) => !['ROWID', 'c2c_source_id'].includes(key))!;
  row[column] = '__drifted__';
  const drift = dataParity({ app, loaded, stored: changed });
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.tables.find((t) => t.table === first.table)!.changedIds, [first.rows[0]!.id]);

  // One missing and one extra row on the second table when it has two tables.
  if (loaded.tables.length > 1) {
    const second = loaded.tables[1]!;
    const short = new Map<string, Record<string, unknown>[]>([...stored].map(([t, rows]) => [t, [...rows]]));
    short.set(second.table, short.get(second.table)!.slice(1));
    short.get(second.table)!.push({ ROWID: '12345678901234567', c2c_source_id: '424242' });
    const report = dataParity({ app, loaded, stored: short });
    const entry = report.tables.find((t) => t.table === second.table)!;
    assert.equal(report.ok, false);
    assert.deepEqual(entry.missingIds, [second.rows[0]!.id]);
    assert.deepEqual(entry.extraIds, ['424242']);
  }
});

test('a file cell passes as its migrated key and as the raw export text', { skip: bomSkip }, () => {
  const app = parseFile(BOM_DS).ir;
  const loaded = readSourceJson(BOM_EXPORT, app, true);
  const files = fileColumnsOf(generateSchema(app));
  const fileTable = loaded.tables.find((table) => files[table.table]?.columns.length);
  if (!fileTable) return; // fixture carries no file field — nothing to prove
  const column = files[fileTable.table]!.columns[0]!;
  const row = fileTable.rows.find((entry) => entry.columns[column] !== undefined && entry.columns[column] !== '');
  const target = row ?? fileTable.rows[0]!;
  if (!row) target.columns = { ...target.columns, [column]: 'https://creator.zoho.in/file/img.png' };

  const keyed = dataParity({ app, loaded, stored: fakeStore(app, loaded) });
  assert.equal(keyed.tables.find((t) => t.table === fileTable.table)!.mismatch, false, 'migrated-key spelling must pass');
  const raw = dataParity({ app, loaded, stored: fakeStore(app, loaded, { rawFileCells: true }) });
  assert.equal(raw.tables.find((t) => t.table === fileTable.table)!.mismatch, false, 'raw export spelling must pass');
});

test('verify --data-parity cli: exit 0 on parity, 1 on mismatch, 2 on usage', () => {
  const app = appOf(APP);
  const dir = writeJsonExport(app, {
    All_Vendors: [{ ID: '101', 'Vendor Name': 'Acme', Price: '2.50', Opened: '2026-10-05' }],
    All_Purchase_Orders: [],
  });
  const dsDir = mkdtempSync(join(tmpdir(), 'c2c-parity-app-'));
  const dsPath = join(dsDir, 'app.ds');
  writeFileSync(dsPath, APP);
  const loaded = readSourceJson(dir, app, true);
  const rows = mkdtempSync(join(tmpdir(), 'c2c-parity-rows-'));
  for (const [table, list] of fakeStore(app, loaded)) {
    writeFileSync(join(rows, `${table}.json`), JSON.stringify(list));
  }
  const cap = () => {
    let out = '';
    let err = '';
    const io: Io = {
      stdout: (t: string) => void (out += t),
      stderr: (t: string) => void (err += t),
      env: {},
      spawn: (() => Promise.reject(new Error('no spawn'))) as Io['spawn'],
      fetch: (() => Promise.reject(new Error('no fetch'))) as Io['fetch'],
    };
    return { io, out: () => out, err: () => err };
  };
  const ok = cap();
  assert.equal(verifyCli(['--data-parity', '--ds', dsPath, '--source-json', dir, '--rows', rows, '--allow-empty'], ok.io), 0, ok.err());
  assert.match(ok.out(), /parity: ok/);

  // A drifted row flips the exit code.
  writeFileSync(join(rows, 'Vendor.json'), JSON.stringify([{ ROWID: '1', c2c_source_id: '101', Vendor_Name: 'Drifted', Price: '2.5', Opened: '2026-10-05' }]));
  const bad = cap();
  assert.equal(verifyCli(['--data-parity', '--ds', dsPath, '--source-json', dir, '--rows', rows, '--allow-empty'], bad.io), 1);
  assert.match(bad.out(), /changed: 101/);

  const usage = cap();
  assert.equal(verifyCli([], usage.io), 2);
  assert.equal(verifyCli(['--data-parity'], cap().io), 2);

  rmSync(dir, { recursive: true, force: true });
  rmSync(dsDir, { recursive: true, force: true });
  rmSync(rows, { recursive: true, force: true });
});
