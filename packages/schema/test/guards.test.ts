import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import {
  EXTENSION_KEY,
  ZcqlLimitError,
  addHits,
  columnRenamesOf,
  emptyHits,
  generateSchema,
  loadCorpusApps,
  logicalColumns,
  measureApp,
  payloadFields,
  planFullRowRead,
  planZcql,
  schemaAsReport,
  selectListOf,
  splitTable,
  type SchemaColumn,
  type SchemaTable,
} from '../src/index.js';
import { loadSyntheticApps, measureFixtures } from '../src/measure.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = ''): string {
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${name}\n\t\t(\n${lines}\n\t\t)`;
}

function form(name: string, fields: string): string {
  return `\tform ${name}\n\t{\n${fields}\n\t}`;
}

function column(name: string): SchemaColumn {
  return { name, creatorType: 'text', matrixId: 'text', status: 'supported', dataType: 'VarChar', mandatory: false, unique: false };
}

function tableOf(names: readonly string[]): SchemaTable {
  return { name: 'Item', form: 'Item', role: 'form', nosql: false, columns: names.map(column) };
}

function limitError(limitId: string, message: RegExp) {
  return (err: unknown) => {
    assert.ok(err instanceof ZcqlLimitError);
    assert.equal(err.limitId, limitId);
    assert.equal(err.verified, false);
    assert.match(err.message, message);
    return true;
  };
}

test('planZcql rejects a column or table name that is not a bare identifier', () => {
  assert.throws(
    () => planZcql({ from: 'Item', columns: [{ table: 'Item', column: 'Name FROM Secrets --' }] }),
    limitError('zcql.select_columns', /identifier rejected: Name FROM Secrets --/),
  );
  assert.throws(() => planZcql({ from: 'Item x', columns: [{ table: 'Item x', column: 'Name' }] }), limitError('zcql.select_columns', /identifier rejected: Item x/));
  assert.throws(() => planZcql({ from: 'Item', columns: [{ table: 'Item', column: '1Name' }] }), /identifier rejected/);
  for (const bad of ["Name'", '"Name"', 'Na`me', 'Nаme', 'Name/*x*/', 'Name--']) {
    assert.throws(() => planZcql({ from: 'Item', columns: [{ table: 'Item', column: bad }] }), /identifier rejected/, `column ${bad}`);
    assert.throws(() => planZcql({ from: bad, columns: [{ table: bad, column: 'Name' }] }), /identifier rejected/, `from ${bad}`);
  }
});

test('planZcql refuses a semicolon in WHERE or ORDER BY and drops a literal true predicate', () => {
  const columns = [{ table: 'Item', column: 'Name' }];
  assert.throws(() => planZcql({ from: 'Item', columns, where: "Name = 'a'; DELETE FROM Item" }), limitError('zcql.select_columns', /WHERE must not contain a semicolon/));
  assert.throws(() => planZcql({ from: 'Item', columns, orderBy: 'ORDER BY Name; DELETE FROM Item' }), limitError('zcql.select_columns', /ORDER BY must not contain a semicolon/));
  assert.deepEqual(planZcql({ from: 'Item', columns, where: ' TRUE ' }).queries, ['SELECT Name FROM Item']);
  assert.deepEqual(planZcql({ from: 'Item', columns: [] }).queries, ['SELECT ROWID FROM Item']);
});

test('an unkeyed join cannot be kept once the read has to be staged', () => {
  const join = { table: 'Owner', on: 'Item.Owner = Owner.ROWID' };
  const wide = Array.from({ length: 31 }, (_, index) => ({ table: 'Item', column: `C${index}` }));
  assert.throws(() => planZcql({ from: 'Item', columns: wide, joins: [join] }), limitError('zcql.joins', /1 join\(s\) have no stage key/));
  assert.throws(
    () => planZcql({ from: 'Item', columns: [{ table: 'Item', column: 'Name' }, { table: 'Owner', column: 'Email' }], joins: [join] }),
    limitError('zcql.joins', /No columns or predicates were dropped/),
  );
});

test('a staged read binds other tables on the join bind column and never emits a JOIN', () => {
  const plan = planZcql({
    from: 'Item',
    columns: [{ table: 'Item', column: 'Name' }, { table: 'Owner', column: 'Email' }],
    joins: [{ table: 'Owner', on: 'Item.Owner = Owner.ROWID', stageKey: 'ROWID', bindColumn: 'Owner' }],
  });
  assert.equal(plan.staged, true);
  assert.deepEqual(plan.queries, ['SELECT ROWID, Name FROM Item', 'SELECT ROWID, Email FROM Owner WHERE ROWID IN (:Item_Owner)']);
  for (const sql of plan.queries) assert.equal(sql.includes(' JOIN '), false);
});

test('splitTable blocks instead of splitting when the identity columns alone exceed the cap', () => {
  const table = tableOf(['parent_id', 'Added_User', 'Added_Time', 'A']);
  const anchors = new Set(['parent_id', 'Added_User', 'Added_Time']);
  const result = splitTable(table, 2, (col) => (anchors.has(col.name) ? '__anchor' : col.name), (base) => base);
  assert.equal(result.split, undefined);
  assert.equal(result.tables.length, 1);
  assert.deepEqual(result.tables[0]!.columns.map((col) => col.name), ['parent_id', 'Added_User', 'Added_Time', 'A']);
  assert.equal(result.blocker?.field, null);
  assert.match(result.blocker?.message ?? '', /identity columns \(3\) exceed the Data Store column cap 2/);
  assert.match(result.blocker?.message ?? '', /The form was not split/);
});

test('splitTable blocks when the cap leaves no room for a payload column beside parent_rowid', () => {
  const result = splitTable(tableOf(['A', 'B']), 1, (col) => col.name, (base) => base);
  assert.equal(result.split, undefined);
  assert.equal(result.tables.length, 1);
  assert.match(result.blocker?.message ?? '', new RegExp(`cannot reserve ${EXTENSION_KEY} under the column cap 1`));
});

test('reserved column names are renamed past claimed names and reported for translation', () => {
  const plan = generateSchema(appOf(form('Item', [field('Order', 'text'), field('Order_col', 'text'), field('Table', 'text'), field('Name', 'text')].join('\n'))));
  const item = plan.tables.find((table) => table.name === 'Item')!;
  const byName = new Map(item.columns.map((col) => [col.name, col]));
  // Order_col is another field's own name, so the renamed Order must not land on it.
  assert.equal(byName.get('Order_col_2')?.field, 'Order');
  assert.equal(byName.get('Order_col')?.field, undefined);
  assert.equal(byName.get('Table_col')?.field, 'Table');
  assert.equal(byName.get('Name')?.field, undefined);
  assert.equal(byName.has('Order'), false);
  assert.equal(byName.has('Table'), false);
  assert.deepEqual(columnRenamesOf(plan), { Item: { Order: 'Order_col_2', Table: 'Table_col' } });
  assert.deepEqual(plan.renames?.map((r) => `${r.field}->${r.column}`), ['Order->Order_col_2', 'Table->Table_col']);
  assert.ok(plan.issues.some((issue) => issue.severity === 'warning' && issue.field === 'Order' && /reserved Data Store column name/.test(issue.message)));
  const report = schemaAsReport(plan);
  assert.match(report, /## Renamed columns/);
  assert.match(report, /- Item\.Order → Item\.Order_col_2/);
  assert.deepEqual(columnRenamesOf(generateSchema(appOf(form('Item', field('Name', 'text'))))), {});
});

test('defaults: Text columns do not take a store default, exact decimals are canonicalised', () => {
  const plan = generateSchema(
    appOf(
      form(
        'Item',
        [field('Notes', 'textarea', '\t\t\tinitial value = "hi"'), field('Amt', 'decimal', '\t\t\tinitial value = 5'), field('Count', 'number', '\t\t\tinitial value = 3')].join('\n'),
      ),
    ),
  );
  const cols = new Map(plan.tables[0]!.columns.map((col) => [col.name, col]));
  assert.equal(cols.get('Notes')?.dataType, 'Text');
  assert.equal(cols.get('Notes')?.defaultValue, undefined);
  assert.ok(plan.issues.some((issue) => issue.field === 'Notes' && /Default is not set on Text column Notes/.test(issue.message)));
  assert.equal(cols.get('Amt')?.defaultValue, '5.00');
  assert.equal(cols.get('Count')?.defaultValue, '3');
});

test('an unknown Creator field type is unsupported, reported, and stores no column', () => {
  const plan = generateSchema(appOf(form('Item', [field('Name', 'text'), field('W', 'wibble')].join('\n'))));
  const outcome = plan.fields.find((item) => item.field === 'W');
  assert.equal(outcome?.status, 'unsupported');
  assert.equal(outcome?.matrixId, 'unmapped');
  assert.ok(plan.issues.some((issue) => issue.severity === 'unsupported' && issue.field === 'W' && /No mapping for Creator field type "wibble"/.test(issue.message)));
  assert.equal(plan.tables[0]!.columns.some((col) => col.name === 'W'), false);
});

test('measureApp counts a wide form, wide and join-heavy criteria, and a report that cannot be planned', () => {
  const wide = Array.from({ length: 251 }, (_, index) => field(`F${index}`, 'text')).join('\n');
  const plan = generateSchema(appOf(`${form('Wide', wide)}\n${form('Small', field('Name', 'text'))}`));
  assert.ok((plan.splits?.length ?? 0) > 0);
  // The full logical row includes the extension columns but never parent_rowid.
  const payload = payloadFields(plan, 'Wide');
  assert.equal(payload.length, 251);
  assert.equal(payload.includes(EXTENSION_KEY), false);
  const base = plan.tables.find((table) => table.form === 'Wide' && table.role === 'form')!;
  const ext = plan.tables.find((table) => table.form === 'Wide' && table.role === 'extension')!;
  const logical = logicalColumns(plan, base).map((col) => col.name);
  assert.equal(logical.includes(EXTENSION_KEY), false);
  assert.equal(new Set(logical).size, logical.length);
  for (let index = 0; index < 251; index++) assert.equal(logical.includes(`F${index}`), true, `F${index}`);
  assert.equal(ext.columns[0]!.name, EXTENSION_KEY);
  assert.deepEqual(logicalColumns(plan, ext).map((col) => col.name), ext.columns.slice(1).map((col) => col.name));
  const read = planFullRowRead(plan, 'Wide');
  assert.equal(read.staged, true);
  const selected = new Set(read.queries.flatMap(selectListOf));
  for (const name of payload) assert.equal(selected.has(name), true, name);

  const hit = measureApp(plan, [
    { form: 'Wide', criteria: 'F0 == "x"', columns: [] },
    { form: 'Small', criteria: 'A.x == 1 && B.x == 1 && C.x == 1 && D.x == 1 && E.x == 1 && input.y == 2', columns: [{ field: 'Name' }] },
    { form: 'Small', columns: [{ field: 'Bad Name' }], filters: [{ criteria: '  ' }, { criteria: 'Name == "a"' }] },
  ]);
  assert.deepEqual(hit.wideForms, ['Wide']);
  assert.equal(hit.counts.forms, 2);
  assert.equal(hit.counts.formsOverColumnCap, 1);
  assert.equal(hit.counts.formsOverTextColumns, 1);
  assert.equal(hit.counts.reportSelect, 1);
  assert.equal(hit.counts.criteria, 3);
  assert.equal(hit.counts.criteriaSelect, 1);
  assert.equal(hit.counts.criteriaJoins, 1);
  // The unplannable report (bad identifier) is counted, not thrown.
  assert.equal(hit.counts.reportJoins, 1);
  assert.equal(hit.counts.reports, 3);

  const total = emptyHits();
  addHits(total, hit.counts);
  addHits(total, hit.counts);
  assert.equal(total.formsOverColumnCap, 2);
  assert.equal(total.criteria, 6);
});

test('corpus loaders keep apps only and skip dot entries, scratch dirs, sidecars and exports', () => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-schema-guards-'));
  try {
    const app = 'application "Demo"\n{\n\tform Item\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n}\n';
    const gallery = join(root, 'gallery');
    mkdirSync(join(gallery, 'One'), { recursive: true });
    mkdirSync(join(gallery, 'Empty'), { recursive: true });
    mkdirSync(join(gallery, '.hidden'), { recursive: true });
    writeFileSync(join(gallery, 'One', 'app.ds'), app);
    writeFileSync(join(gallery, 'Empty', 'notes.txt'), 'x');
    writeFileSync(join(gallery, '.hidden', 'app.ds'), app);
    writeFileSync(join(gallery, 'Loose.DS'), app);
    writeFileSync(join(gallery, 'readme.md'), 'x');
    assert.deepEqual(loadCorpusApps(gallery).map((item) => item.link), ['Loose', 'One']);

    mkdirSync(join(root, 'public-corpus', 'ds'), { recursive: true });
    writeFileSync(join(root, 'public-corpus', 'ds', 'Pub.ds'), app);
    const synthetic = join(root, 'synthetic');
    for (const dir of ['s1', '_run', 'sidecars', '.git']) mkdirSync(join(synthetic, dir), { recursive: true });
    writeFileSync(join(synthetic, 's1', 'scenario.ds'), app);
    writeFileSync(join(synthetic, 's1', 'scenario-exported.ds'), app);
    writeFileSync(join(synthetic, '_run', 'scratch.ds'), app);
    writeFileSync(join(synthetic, 'sidecars', 'side.ds'), app);
    writeFileSync(join(synthetic, '.git', 'x.ds'), app);
    writeFileSync(join(synthetic, 'top.ds'), app);
    assert.deepEqual(loadSyntheticApps(root).map((item) => item.link), [join('s1', 'scenario.ds'), 'top.ds']);

    const report = measureFixtures(root);
    assert.deepEqual(report.corpora.map((corpus) => [corpus.name, corpus.apps, corpus.failed.length]), [
      ['gallery', 2, 0],
      ['public-corpus', 1, 0],
      ['synthetic', 2, 0],
    ]);
    assert.equal(report.total.forms, 5);
    assert.equal(report.total.tables, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
