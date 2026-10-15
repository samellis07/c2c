import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import {
  ANCHOR_GROUP,
  CATALYST_LIMITS,
  EXTENSION_KEY,
  LONGEST_KEPT_TABLE_NAME,
  ZcqlLimitError,
  generateSchema,
  limitValue,
  tableNameLengthBlocker,
  planZcql,
  schemaAsIac,
  schemaAsJson,
  schemaAsReport,
  selectListOf,
  splitTable,
  type SchemaColumn,
  type SchemaTable,
} from '../src/index.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function textField(name: string): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = text\n\t\t)`;
}

function column(name: string): SchemaColumn {
  return {
    name,
    creatorType: 'text',
    matrixId: 'text',
    status: 'supported',
    dataType: 'VarChar',
    mandatory: false,
    unique: false,
  };
}

function tableOf(names: readonly string[]): SchemaTable {
  return {
    name: 'Item',
    form: 'Item',
    role: 'form',
    nosql: false,
    columns: names.map(column),
  };
}

test('a table under the cap is not split and keeps its column order', () => {
  const groups = new Map<string, string>([
    ['parent_id', ANCHOR_GROUP],
    ['A', 'A'],
    ['Added_User', ANCHOR_GROUP],
  ]);
  const table = tableOf(['parent_id', 'A', 'Added_User']);
  const alloc = (base: string) => base;
  const result = splitTable(table, 5, (col) => groups.get(col.name) ?? col.name, alloc);
  assert.equal(result.tables.length, 1);
  assert.equal(result.split, undefined);
  assert.equal(result.blocker, undefined);
  assert.deepEqual(result.tables[0]!.columns.map((col) => col.name), ['parent_id', 'A', 'Added_User']);
  assert.equal(result.tables[0]!.extensionOf, undefined);
});

test('a wide table splits onto a 1:1 extension keyed by parent_rowid', () => {
  const order = ['parent_id', 'A', 'B', 'C', 'Added_User', 'c2c_source_id'];
  const groups = new Map<string, string>([
    ['parent_id', ANCHOR_GROUP],
    ['A', 'A'],
    ['B', 'B'],
    ['C', 'C'],
    ['Added_User', ANCHOR_GROUP],
    ['c2c_source_id', ANCHOR_GROUP],
  ]);
  const table = tableOf(order);
  const names: string[] = [];
  const result = splitTable(table, 4, (col) => groups.get(col.name) ?? col.name, (base) => {
    const name = names.includes(base) ? `${base}_2` : base;
    names.push(name);
    return name;
  });
  assert.equal(result.blocker, undefined);
  assert.equal(result.tables.length, 2);
  const [base, ext] = result.tables;
  assert.deepEqual(base!.columns.map((col) => col.name), ['parent_id', 'A', 'Added_User', 'c2c_source_id']);
  assert.equal(ext!.role, 'extension');
  assert.equal(ext!.extensionOf, 'Item');
  assert.equal(ext!.columns[0]!.name, EXTENSION_KEY);
  assert.equal(ext!.columns[0]!.unique, true);
  assert.equal(ext!.columns[0]!.relation?.table, 'Item');
  assert.equal(ext!.columns[0]!.relation?.column, 'ROWID');
  assert.equal(ext!.columns.some((col) => col.matrixId === 'c2c-system-field' || col.name === 'c2c_source_id'), false);
  assert.deepEqual(ext!.columns.slice(1).map((col) => col.name), ['B', 'C']);
  assert.equal(result.split?.verified, false);
  assert.equal(result.split?.limitId, 'datastore.columns_per_table');
});

test('a field group that cannot fit an empty extension is a blocker and the table stays whole', () => {
  const names = ['G0', 'G1', 'G2', 'G3', 'G4'];
  const groups = new Map(names.map((name) => [name, 'Wide']));
  const table = tableOf(names);
  const before = table.columns.map((col) => col.name);
  const result = splitTable(table, 4, (col) => groups.get(col.name) ?? col.name, (base) => base);
  assert.equal(result.split, undefined);
  assert.equal(result.tables.length, 1);
  assert.deepEqual(result.tables[0]!.columns.map((col) => col.name), before);
  assert.equal(result.tables[0]!.extensionOf, undefined);
  assert.equal(result.blocker?.limitId, 'datastore.columns_per_table');
  assert.match(result.blocker?.message ?? '', /verified: false/);
  assert.match(result.blocker?.message ?? '', /left the table unsplit/);
});

test('planZcql stages a 31-column select and does not drop a column', () => {
  const columns = Array.from({ length: 31 }, (_, index) => ({ table: 'Item', column: `C${index}` }));
  const plan = planZcql({ from: 'Item', columns });
  assert.equal(plan.staged, true);
  assert.equal(plan.exceeded.select, true);
  assert.ok(plan.queries.length >= 2);
  for (const sql of plan.queries) {
    const selected = selectListOf(sql);
    assert.ok(selected.length <= limitValue('zcql.select_columns'), sql);
    assert.ok(selected.includes('ROWID'), sql);
    assert.equal(sql.includes(' JOIN '), false);
  }
  const got = new Set(plan.queries.flatMap(selectListOf));
  for (const column of columns) assert.equal(got.has(column.column), true, column.column);
});

test('a full base select plus one other table still returns ROWID for the stitch', () => {
  const columns = [
    ...Array.from({ length: 30 }, (_, index) => ({ table: 'Item', column: `C${index}` })),
    { table: 'Child', column: 'Extra' },
  ];
  const plan = planZcql({
    from: 'Item',
    columns,
    joins: [{ table: 'Child', on: 'Item.Child = Child.ROWID', stageKey: 'ROWID' }],
    orderBy: 'ORDER BY ROWID',
  });
  assert.equal(plan.staged, true);
  const base = plan.queries.filter((sql) => sql.includes(' FROM Item'));
  assert.ok(base.length >= 2);
  for (const sql of plan.queries) {
    assert.ok(selectListOf(sql).length <= limitValue('zcql.select_columns'), sql);
    assert.equal(sql.includes(' JOIN '), false, sql);
  }
  assert.match(base[0] ?? '', /^SELECT ROWID, /);
  assert.match(base[0] ?? '', /ORDER BY ROWID$/);
  const selected = new Set(base.flatMap(selectListOf));
  for (let index = 0; index < 30; index++) assert.equal(selected.has(`C${index}`), true, `C${index}`);
  assert.match(plan.queries.find((sql) => sql.includes(' FROM Child')) ?? '', /WHERE ROWID IN \(:Item_ROWID\)/);
});

test('five stageable joins become single-table statements', () => {
  const joins = [0, 1, 2, 3, 4].map((index) => ({
    table: `T${index}`,
    on: `Item.L${index} = T${index}.ROWID`,
    stageKey: 'ROWID',
  }));
  const plan = planZcql({
    from: 'Item',
    columns: [{ table: 'Item', column: 'Name' }, ...joins.map((join) => ({ table: join.table, column: 'Title' }))],
    joins,
  });
  assert.equal(plan.staged, true);
  assert.equal(plan.exceeded.joins, true);
  assert.ok(plan.queries.length >= 6);
  for (const sql of plan.queries) assert.equal(sql.includes(' JOIN '), false, sql);
  assert.match(plan.queries[1] ?? '', /WHERE ROWID IN \(:Item_ROWID\)/);
});

test('five joins with no stage key fail generation and drop nothing', () => {
  assert.throws(
    () =>
      planZcql({
        from: 'Item',
        columns: [{ table: 'Item', column: 'Name' }],
        joins: [0, 1, 2, 3, 4].map((index) => ({ table: `T${index}`, on: `Item.L${index} = T${index}.ROWID` })),
      }),
    (err: unknown) => {
      assert.ok(err instanceof ZcqlLimitError);
      assert.match(err.message, /zcql\.joins/);
      assert.match(err.message, /verified: false/);
      assert.match(err.message, /No columns or predicates were dropped/);
      return true;
    },
  );
});

test('an under-cap form is not split and its schema JSON has no extension keys', () => {
  const fields = Array.from({ length: 3 }, (_, index) => textField(`F${index}`)).join('\n');
  const plan = generateSchema(appOf(`\tform Item\n\t{\n${fields}\n\t}`));
  assert.equal(plan.splits, undefined);
  assert.equal(plan.limitBlockers, undefined);
  assert.equal(plan.tables.some((table) => table.role === 'extension'), false);
  const json = schemaAsJson(plan);
  assert.equal(json.includes('extensionOf'), false);
  assert.equal(json.includes('"splits"'), false);
  assert.equal(json.includes('limitBlockers'), false);
  assert.equal(schemaAsIac(plan).includes('__ext'), false);
  assert.equal(schemaAsJson(plan), schemaAsJson(generateSchema(appOf(`\tform Item\n\t{\n${fields}\n\t}`))));
  const report = schemaAsReport(plan);
  assert.match(report, /## Catalyst limits/);
  assert.match(report, /verified: false/);
  assert.match(report, /## Throttles/);
  // Limit rows carry only the public fields: no internal reference fields.
  const allowed = new Set(['id', 'label', 'value', 'unit', 'verified', 'action', 'whenExceeded']);
  for (const row of CATALYST_LIMITS) {
    assert.deepEqual(Object.keys(row).filter((key) => !allowed.has(key)), [], row.id);
    assert.ok(row.label.trim().length > 0, row.id);
  }
});

test('the schema generator splits a form past the column cap and blocks an unsplittable group', () => {
  const cap = limitValue('datastore.columns_per_table');
  const wideCount = cap - 4;
  const wide = Array.from({ length: wideCount }, (_, index) => textField(`F${String(index).padStart(3, '0')}`)).join('\n');
  const split = generateSchema(appOf(`\tform Item\n\t{\n${wide}\n\t}`));
  assert.ok(split.splits && split.splits.length === 1, `expected one split, tables=${split.tables.length}`);
  const ext = split.tables.find((table) => table.role === 'extension');
  assert.ok(ext);
  assert.equal(ext!.columns[0]!.name, EXTENSION_KEY);
  assert.equal(ext!.columns.some((col) => col.matrixId === 'c2c-system-field' || col.name === 'c2c_source_id'), false);
  assert.equal(split.tables.find((table) => table.role === 'form')!.columns.length <= cap, true);
  assert.match(schemaAsReport(split), /1:1 on parent_rowid/);
  assert.match(schemaAsReport(split), /verified: false/);

  const fit = Array.from({ length: wideCount - 1 }, (_, index) => textField(`F${String(index).padStart(3, '0')}`)).join('\n');
  const under = generateSchema(appOf(`\tform Item\n\t{\n${fit}\n\t}`));
  assert.equal(under.splits, undefined);

  const parts = Array.from({ length: cap }, (_, index) => `P${index}`);
  const blocked = generateSchema(appOf(nameForm('Item', parts)));
  assert.equal(blocked.splits, undefined);
  assert.equal(blocked.limitBlockers?.length, 1);
  assert.equal(blocked.tables.some((table) => table.role === 'extension'), false);
  assert.match(blocked.limitBlockers?.[0]?.message ?? '', /verified: false/);
});

test('a table name longer than the longest kept name is table-name-length-unverified', () => {
  assert.equal(tableNameLengthBlocker('Item', LONGEST_KEPT_TABLE_NAME), undefined);
  const over = tableNameLengthBlocker('Item', `${LONGEST_KEPT_TABLE_NAME}X`);
  assert.equal(over?.limitId, 'table-name-length-unverified');
  assert.match(over?.message ?? '', /verified: false/);
  assert.equal(over?.table.length, LONGEST_KEPT_TABLE_NAME.length + 1);
  const row = CATALYST_LIMITS.find((item) => item.id === 'table-name-length-unverified');
  assert.equal(row?.value, null);
  assert.equal(row?.verified, false);
});

test('the table-name gate passes at 34 characters and blocks at 35', () => {
  assert.equal(LONGEST_KEPT_TABLE_NAME.length, 34);
  assert.equal(tableNameLengthBlocker('Item', 'Details__Asset_Information'), undefined);
  assert.equal(tableNameLengthBlocker('Item', 'Add_Vendor__Current_Contracts'), undefined);
  assert.equal(tableNameLengthBlocker('Item', 'D'.repeat(34)), undefined);
  const over = tableNameLengthBlocker('Item', 'D'.repeat(35));
  assert.equal(over?.limitId, 'table-name-length-unverified');
});

function nameForm(formName: string, parts: readonly string[]): string {
  const inner = parts.map((part) => `\t\t\t${part}\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)`).join('\n');
  return `\tform ${formName}\n\t{\n\t\tWho\n\t\t(\n\t\t\ttype = name\n${inner}\n\t\t)\n\t}`;
}

