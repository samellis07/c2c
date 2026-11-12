/**
 * A text value longer than its column is never stored cut short. Data Store
 * varchar stores a longer value truncated without an error, so the
 * schema sends long text to a text column and the loader refuses an over-length
 * varchar value before the first write, naming table, column and source id only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { emptyCheckpoint } from '../../data/src/migrate.js';
import { integrityColumns, overLengthRefusals } from '../../data/src/integrity.js';
import { quirkRowServer } from '../../data/test/catalyst-row-fake.js';
import { generateSchema, UNIQUE_VARCHAR_MAX_PER_TABLE } from '../../schema/src/index.js';
import { formatCsvPlan, migrateCsv, readSourceCsv, sourceCsvCli, type Io } from '../src/index.js';

const SCOPE = { org: '10000000000', projectId: '1001', token: 'test-cli-token' };
const GUARD = { projectName: 'c2c-widget', projectId: '1001', org: '10000000000', environment: 'Development', dc: 'in' as const };

const APP = `application "Widget"
{
form Vendor
{
Vendor_Name
(
type = text
displayname = "Vendor Name"
)
}
form Ticket
{
Title
(
type = text
displayname = "Title"
)
Notes
(
type = textarea
displayname = "Notes"
)
Summary
(
type = text
displayname = "Summary"
maxchar = 400
)
unique Code_A
(
type = text
displayname = "Code A"
)
unique Code_B
(
type = text
displayname = "Code B"
)
unique Code_C
(
type = text
displayname = "Code C"
)
}
list All_Vendors
{
show all rows from Vendor
(
Vendor_Name as "Vendor Name"
)
}
list All_Tickets
{
show all rows from Ticket
(
Title as "Title"
Notes as "Notes"
Summary as "Summary"
Code_A as "Code A"
Code_B as "Code B"
Code_C as "Code C"
)
}
}
`;

const dirs: string[] = [];
function dirOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-over-length-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const app = deriveIr(parse(APP));
const AT_LIMIT = 'a'.repeat(255);
const OVER = 'b'.repeat(256);
const LONG_NOTE = 'n'.repeat(5000);

function exportDir(title2: string): string {
  return dirOf({
    'All_Vendors.csv': 'ID,Vendor Name\n101,Acme\n',
    'All_Tickets.csv':
      'ID,Title,Notes,Summary,Code A,Code B,Code C\n' +
      `201,${AT_LIMIT},${LONG_NOTE},${'s'.repeat(400)},A1,B1,C1\n` +
      `202,${title2},short,short,A2,B2,C2\n`,
  });
}

test('multi line and single line over 255 map to text; unknown single line stays varchar 255', () => {
  const ticket = generateSchema(app).tables.find((table) => table.name === 'Ticket')!;
  const col = (name: string) => ticket.columns.find((column) => column.name === name)!;
  assert.equal(col('Notes').dataType, 'Text');
  assert.equal(col('Summary').dataType, 'Text');
  assert.equal(col('Title').dataType, 'VarChar');
  assert.equal(col('Title').length, 255);
});

test('unique varchar columns stay within the per-table budget', () => {
  const ticket = generateSchema(app).tables.find((table) => table.name === 'Ticket')!;
  const storeUnique = ticket.columns.filter((column) => column.unique && column.dataType === 'VarChar');
  assert.equal(UNIQUE_VARCHAR_MAX_PER_TABLE, 2);
  assert.deepEqual(storeUnique.map((column) => column.name), ['Code_A', 'Code_B']);
  const third = ticket.columns.find((column) => column.name === 'Code_C')!;
  assert.equal(third.unique, false);
  assert.equal(third.appUnique, true);
});

test('255 characters pass and 256 are refused, by table, column and source id', () => {
  const table = generateSchema(app).tables.find((item) => item.name === 'Ticket')!;
  const columns = { Ticket: integrityColumns(table, undefined, 'store') };
  const rows = (title: string) => [{ table: 'Ticket', rows: [{ id: '9', columns: { Title: title, Notes: LONG_NOTE } }] }];
  assert.deepEqual(overLengthRefusals(rows(AT_LIMIT), columns), []);
  assert.deepEqual(overLengthRefusals(rows(OVER), columns), [{ table: 'Ticket', column: 'Title', sourceId: '9', rule: 'text-length' }]);
  // A text column holds the long value: no refusal for Notes.
  assert.deepEqual(overLengthRefusals(rows('ok'), columns), []);
});

test('the plan lists an over-length value without printing it', () => {
  const loaded = readSourceCsv(exportDir(OVER), app);
  assert.deepEqual(loaded.overLength, [{ table: 'Ticket', column: 'Title', sourceId: '202', rule: 'text-length' }]);
  const plan = formatCsvPlan(loaded, GUARD);
  assert.match(plan, /over length: 1 value\(s\) \(confirm will refuse before any write; the store would cut the value\):\n- Ticket\.Title row 202\n/);
  assert.ok(!plan.includes(OVER), 'the plan must not print the value');
  assert.ok(!plan.includes(AT_LIMIT));
});

test('a plan at the limit lists nothing', () => {
  const loaded = readSourceCsv(exportDir(AT_LIMIT), app);
  assert.deepEqual(loaded.overLength, []);
  assert.doesNotMatch(formatCsvPlan(loaded, GUARD), /over length/);
});

test('a confirmed load refuses an over-length value before any write and reports it', async () => {
  const store = quirkRowServer();
  const result = await migrateCsv({
    app,
    dir: exportDir(OVER),
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /refused 1 value\(s\) the store would alter \(1 over length\) before any write: Ticket\.Title — the value is longer than the column/);
  assert.equal(store.stored.size, 0, 'no table is written, not even the valid Vendor rows');
  assert.deepEqual(result.integrity?.refusedByRule, [{ rule: 'text-length', count: 1, rows: [{ table: 'Ticket', column: 'Title', sourceId: '202' }] }]);
  assert.ok(!JSON.stringify(result).includes(OVER), 'the report must not carry the value');
});

test('a confirmed load at the limit writes every row', async () => {
  const store = quirkRowServer();
  const result = await migrateCsv({
    app,
    dir: exportDir(AT_LIMIT),
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true, JSON.stringify(result.error ?? result.tables));
  assert.equal(result.tables.find((table) => table.table === 'Ticket')?.writtenCount, 2);
});

function planIo(): { io: Io; out: () => string; err: () => string; calls: () => number } {
  let out = '';
  let err = '';
  let calls = 0;
  const io: Io = {
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
    env: {},
    cliDc: () => undefined,
    spawn: async () => { calls += 1; return { code: 0, stdout: '', stderr: '' }; },
    rest: async () => { calls += 1; return { status: 404, body: {} }; },
    fetch: async () => { calls += 1; throw new Error('network refused in this test'); },
    accessToken: async () => { calls += 1; return 'unused'; },
  };
  return { io, out: () => out, err: () => err, calls: () => calls };
}

function projectsFile(): string {
  const projects = join(dirOf({}), 'projects.json');
  writeFileSync(projects, JSON.stringify({ org: '10000000000', dc: 'in', env: 'Development', projects: { 'c2c-widget': '1001' } }));
  return projects;
}

async function planRun(title2: string) {
  const ds = join(dirOf({}), 'widget.ds');
  writeFileSync(ds, APP);
  const run = planIo();
  const code = await sourceCsvCli(
    ['--source-csv', exportDir(title2), '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile()],
    run.io,
  );
  return { code, ...run };
}

test('the plan command exits 1 on an over-length value and 0 at the limit, offline', async () => {
  const over = await planRun(OVER);
  assert.equal(over.code, 1);
  assert.equal(over.calls(), 0);
  assert.match(over.out(), /- Ticket\.Title row 202/);
  assert.match(over.err(), /1 value\(s\) longer than their column; a confirmed run would refuse before any write/);
  assert.ok(!over.out().includes(OVER) && !over.err().includes(OVER));
  const ok = await planRun(AT_LIMIT);
  assert.equal(ok.code, 0, ok.err());
  assert.equal(ok.calls(), 0);
});
