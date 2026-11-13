/**
 * A report sorted on a lookup path (`Book.Genre`): the generated live list
 * read orders rows by the parent's column, resolved under the caller's
 * parent read scope, instead of leaving the sort as a counted manual step.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { mockDatastore } from '../../shims/test/zcql-mock.js';
import { buildUi } from '../src/index.js';
import { buildModel } from '../src/model.js';
import { limitValue } from '../../schema/src/limits.js';

function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body: string) {
      raw = body;
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }));
}

const STAFF = { profile: 'Staff', loginUser: 'ada@example.test' };

function field(name: string, type: string, extra = ''): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = ${type}${extra ? `\n${extra}` : ''}\n\t\t)`;
}

const sortSrc = (SORT_FIELD: string, SORT_DIR: string): string => `application "Demo"
{
\tform Book
\t{
${field('Title', 'text')}
${field('Genre', 'picklist', '\t\t\tvalues = {"Fiction","Non-Fiction","Sci-Fi","Biography"}')}
${field('Available_Copies', 'number')}
${field('Secret', 'text')}
\t}
\tform Loan
\t{
${field('Member', 'text')}
${field('Book', 'picklist', '\t\t\tvalues = Book.Title')}
${field('Fine', 'number')}
\t}
\tlist All_Books
\t{
\t\tshow all rows from Book
\t\t(
\t\t\tTitle
\t\t)
\t}
\tlist Loans_By_Genre
\t{
\t\tdisplayname = "Loans by Genre"
\t\tshow all rows from Loan
\t\t(
\t\t\tMember
\t\t\tBook
\t\t\tFine
\t\t)
\t\tsort by
\t\t{
\t\t\tBook.${SORT_FIELD} ${SORT_DIR}
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tBook
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Books = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tTitle
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tGenre
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tAvailable_Copies
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tSecret
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:false,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tLoan
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tLoans_By_Genre = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tMember
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tBook
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tFine
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

interface Built {
  dir: string;
  report: { default: (req: unknown, res: unknown) => unknown };
}

async function loadReport(source: string, reportName?: string): Promise<Built> {
  const files = buildUi(deriveIr(parse(source))).files;
  const dir = mkdtempSync(join(tmpdir(), 'c2c-agg-report-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), file.data);
  }
  const path = files
    .filter((f) => f.path.startsWith('functions/reports/') && f.path.endsWith('.mjs'))
    .find((f) => (reportName ? String(f.data).includes(`export const reportName = ${JSON.stringify(reportName)};`) : true))?.path;
  assert.ok(path);
  const report = (await import(pathToFileURL(join(dir, path)).href)) as Built['report'];
  return { dir, report };
}


async function liveRows(source: string, body: Record<string, unknown> = { op: 'query' }): Promise<{ members: string[]; raw: string; calls: number }> {
  const { dir, report } = await loadReport(source, 'Loans_By_Genre');
  const store = mockDatastore({ Book: [], Loan: [] });
  const prior = (globalThis as Record<string, unknown>).__c2cDatastore;
  try {
    writeFileSync(join(dir, 'functions/c2c-deploy.json'), JSON.stringify({ mode: 'live', appTimeZone: 'UTC' }));
    const books = await store.datastore.insert('Book', [
      { Title: 'a', Genre: 'Sci-Fi', Available_Copies: '10', Secret: 's2' },
      { Title: 'b', Genre: 'Biography', Available_Copies: '9', Secret: 's1' },
      { Title: 'c', Genre: 'Fiction', Available_Copies: '2', Secret: 's3' },
    ]);
    await store.datastore.insert('Loan', [
      { Member: 'm1', Book: books[0]!.ROWID, Fine: '0' },
      { Member: 'm2', Book: books[1]!.ROWID, Fine: '1' },
      { Member: 'm3', Book: books[2]!.ROWID, Fine: '0' },
      { Member: 'm4', Book: books[1]!.ROWID, Fine: '0' },
      { Member: 'm5', Fine: '0' },
    ]);
    (globalThis as Record<string, unknown>).__c2cDatastore = store.datastore;
    const res = await invoke(report.default, { user: STAFF, body });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = res.body.rows as Array<Record<string, unknown>>;
    return { members: rows.map((row) => String(row.Member)), raw: JSON.stringify(res.body), calls: store.calls.length };
  } finally {
    (globalThis as Record<string, unknown>).__c2cDatastore = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a related-field sort is generated, not a counted manual step', () => {
  const model = buildModel(deriveIr(parse(sortSrc('Genre', 'ascending'))));
  assert.equal(model.todos.some((t) => t.area === 'report' && /Sort by/.test(t.reason)), false);
});

test('the live list read orders rows by the parent column, blanks first, ROWID ties', async () => {
  const asc = await liveRows(sortSrc('Genre', 'ascending'));
  assert.deepEqual(asc.members, ['m5', 'm2', 'm4', 'm3', 'm1']);
  const desc = await liveRows(sortSrc('Genre', 'descending'));
  assert.deepEqual(desc.members, ['m1', 'm3', 'm2', 'm4', 'm5']);
  // A numeric parent column orders by value, not text.
  const numeric = await liveRows(sortSrc('Available_Copies', 'ascending'));
  assert.deepEqual(numeric.members, ['m5', 'm3', 'm2', 'm4', 'm1']);
  // Paging slices the ordered rows.
  const second = await liveRows(sortSrc('Genre', 'ascending'), { op: 'query', page: 1, pageSize: 2 });
  assert.deepEqual(second.members, ['m4', 'm3']);
  // The resolved parent value is not added to the returned rows.
  assert.doesNotMatch(asc.raw, /"Book\.Genre"/);
});

test('a caller sort wins, and a parent column the caller cannot read never orders the rows', async () => {
  const picked = await liveRows(sortSrc('Genre', 'ascending'), { op: 'query', sort: [{ field: 'Member', order: 'desc' }] });
  assert.deepEqual(picked.members, ['m5', 'm4', 'm3', 'm2', 'm1']);
  const hidden = await liveRows(sortSrc('Secret', 'ascending'));
  assert.deepEqual(hidden.members, ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.doesNotMatch(hidden.raw, /"s[123]"/);
});

test('a plain sort entry before the related one orders first, the related one breaks ties', async () => {
  const source = sortSrc('Genre', 'descending').replace('\t\t\tBook.Genre descending', '\t\t\tFine ascending\n\t\t\tBook.Genre descending');
  assert.equal(buildModel(deriveIr(parse(source))).todos.some((t) => t.area === 'report' && /Sort by/.test(t.reason)), false);
  // Fine 0: m1 (Sci-Fi), m3 (Fiction), m4 (Biography), m5 (blank); Fine 1: m2.
  const rows = await liveRows(source);
  assert.deepEqual(rows.members, ['m1', 'm3', 'm4', 'm5', 'm2']);
});

test('a sort entry that is neither a column nor a lookup path stays a counted manual step', () => {
  const source = sortSrc('Genre', 'ascending').replace('\t\t\tBook.Genre ascending', '\t\t\tMember.Nope ascending');
  assert.equal(buildModel(deriveIr(parse(source))).todos.some((t) => t.area === 'report' && /Sort by "Member\.Nope"/.test(t.reason)), true);
});

// A Loan form wide enough that one SELECT cannot list every report column:
// the report reads through staged queries, which keep ROWID order.
function stagedSource(): string {
  const extra = Array.from({ length: limitValue('zcql.select_columns') + 1 }, (_, index) => field(`X${String(index).padStart(3, '0')}`, 'text')).join('\n');
  return sortSrc('Genre', 'ascending').replace(`${field('Fine', 'number')}\n\t}`, `${field('Fine', 'number')}\n${extra}\n\t}`);
}

test('a related sort on a staged report read is a counted manual step, never a silent drop', () => {
  const app = deriveIr(parse(stagedSource().replace(/\t\tshow all rows from Loan\n\t\t\(\n\t\t\tMember\n\t\t\tBook\n\t\t\tFine\n\t\t\)/, '\t\tshow all rows from Loan')));
  const built = buildUi(app);
  const file = built.files.find((item) => String(item.data).includes('export const reportName = "Loans_By_Genre";'));
  assert.ok(file);
  const text = String(file!.data);
  assert.match(text, /export const zcqlStages = /);
  // The staged read does not carry the in-memory sort ...
  assert.equal(text.includes('relatedSortRead'), false);
  // ... so the sort is counted with a step that names the report and the sort.
  const todo = built.model.todos.find((t) => t.area === 'report' && t.name === 'Loans_By_Genre' && /staged/.test(t.reason));
  assert.ok(todo, JSON.stringify(built.model.todos.filter((t) => t.area === 'report')));
  assert.match(todo!.manualStep ?? '', /On report Loans_By_Genre, replace the related-field sort "Book\.Genre"/);
  assert.ok(built.files.some((item) => item.path === 'ui-manual-steps.json' && String(item.data).includes('Loans_By_Genre')));
  // The single-query read of the same report applies the sort and counts nothing.
  const plain = buildUi(deriveIr(parse(sortSrc('Genre', 'ascending'))));
  assert.equal(plain.model.todos.some((t) => t.area === 'report' && /Sort by/.test(t.reason)), false);
  assert.ok(plain.files.some((item) => String(item.data).includes('relatedSortRead')));
});

test('past the row cap the read keeps ROWID order and says so in the reply', () => {
  const plain = buildUi(deriveIr(parse(sortSrc('Genre', 'ascending'))));
  const text = String(plain.files.find((item) => String(item.data).includes('export const reportName = "Loans_By_Genre";'))!.data);
  assert.match(text, /related sort not applied: more than \$\{AGGREGATE_ROW_CAP\} matching rows/);
  assert.match(text, /\.\.\.\(sortNotice \? \{ notice: sortNotice \} : \{\}\)/);
});

test('a composite part sort orders by the part column; a part with no column is counted', () => {
  const withName = (part: string) =>
    sortSrc('Genre', 'ascending')
      .replace(`${field('Fine', 'number')}\n\t}`, `${field('Fine', 'number')}\n${field('Contact', 'name')}\n\t}`)
      .replace('\t\t\tBook.Genre ascending', `\t\t\tContact.${part} ascending`);
  const built = buildUi(deriveIr(parse(withName('prefix'))));
  assert.equal(built.model.todos.some((t) => t.area === 'report' && t.name === 'Loans_By_Genre'), false);
  const text = String(built.files.find((item) => String(item.data).includes('export const reportName = "Loans_By_Genre";'))!.data);
  assert.match(text, /const sortKeys = \[\{"field":"Contact_prefix","dir":"asc","part":"Contact"\}\]/);
  // Read access follows the composite field, not the part column.
  assert.match(text, /readableField\(key\.head \|\| key\.part \|\| key\.field, readableFields\)/);
  const missing = buildUi(deriveIr(parse(withName('nope'))));
  const todo = missing.model.todos.find((t) => t.area === 'report' && t.name === 'Loans_By_Genre');
  assert.ok(todo);
  assert.match(todo!.manualStep ?? '', /related-field sort "Contact\.nope"/);
  const missingText = String(missing.files.find((item) => String(item.data).includes('export const reportName = "Loans_By_Genre";'))!.data);
  assert.equal(missingText.includes('relatedSortRead'), false);
});
