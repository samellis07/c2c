/**
 * Store constraints decided from source data. A Creator must-have or unique
 * flag is a submit-time rule: rows written before it existed can be empty or
 * repeat a value, and the Data Store column must still accept them. With a
 * `source` the schema demotes a disproved constraint to the generated app
 * (`appMandatory` / `appUnique`) and records the decision; without it the
 * Creator flags stand as store constraints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import {
  applyConstraintDecisions,
  constraintDecisionNote,
  generateSchema,
  schemaAsJson,
  type SchemaColumn,
  type SchemaTable,
  type SourceTableData,
} from '../src/index.js';

const WAREHOUSE = `application "Inventory Management"
{
form Add_Warehouse
{
must have Warehouse_Name
(
type = text
)
must have Warehouse_Incharge
(
type = text
)
must have unique SKU
(
type = text
)
Stock
(
type = number
)
}
}
`;

function appOf(body: string): App {
  return deriveIr(parse(body));
}

function tableOf(plan: { tables: SchemaTable[] }, name: string): SchemaTable {
  const table = plan.tables.find((item) => item.name === name);
  assert.ok(table, name);
  return table;
}

function columnOf(table: SchemaTable, name: string): SchemaColumn {
  const column = table.columns.find((item) => item.name === name);
  assert.ok(column, name);
  return column;
}

function warehouseRows(values: (string | undefined)[]): SourceTableData {
  return {
    table: 'Add_Warehouse',
    complete: true,
    carried: ['Warehouse_Name', 'Warehouse_Incharge', 'SKU'],
    rows: values.map((value, index) => ({
      columns: {
        Warehouse_Name: `W${index}`,
        ...(value === undefined ? {} : { Warehouse_Incharge: value }),
        SKU: `S${index}`,
      },
    })),
  };
}

test('a must-have field empty on every source row is created not mandatory, with the count named', () => {
  const app = appOf(WAREHOUSE);
  const plan = generateSchema(app, { source: [warehouseRows([undefined, undefined, ''])] });
  const column = columnOf(tableOf(plan, 'Add_Warehouse'), 'Warehouse_Incharge');
  assert.equal(column.mandatory, false);
  assert.equal(column.appMandatory, true);
  const decision = plan.constraints?.find((item) => item.column === 'Warehouse_Incharge');
  assert.deepEqual(decision, { table: 'Add_Warehouse', column: 'Warehouse_Incharge', rule: 'mandatory', layer: 'app', violations: 3 });
  assert.equal(
    constraintDecisionNote(decision!),
    'Add_Warehouse.Warehouse_Incharge is mandatory but the source holds 3 empty value(s); the column is created not mandatory and the generated app still requires it',
  );
  assert.ok(plan.issues.some((issue) => issue.severity === 'warning' && issue.field === 'Warehouse_Incharge'));
});

test('a complete source that never carries a must-have column keeps it store-mandatory: absence proves nothing', () => {
  const app = appOf(WAREHOUSE);
  const source: SourceTableData = {
    table: 'Add_Warehouse',
    complete: true,
    carried: ['Warehouse_Name', 'SKU'],
    rows: [{ columns: { Warehouse_Name: 'A', SKU: 'S1' } }, { columns: { Warehouse_Name: 'B', SKU: 'S2' } }],
  };
  const plan = generateSchema(app, { source: [source] });
  const column = columnOf(tableOf(plan, 'Add_Warehouse'), 'Warehouse_Incharge');
  assert.equal(column.mandatory, true);
  assert.equal(column.appMandatory, undefined);
  assert.equal(plan.constraints?.find((item) => item.column === 'Warehouse_Incharge'), undefined);
});

test('a complete source that never carries a unique column keeps it store-unique', () => {
  const app = appOf(WAREHOUSE);
  const source: SourceTableData = {
    table: 'Add_Warehouse',
    complete: true,
    carried: ['Warehouse_Name', 'Warehouse_Incharge'],
    rows: [{ columns: { Warehouse_Name: 'A', Warehouse_Incharge: 'a' } }, { columns: { Warehouse_Name: 'B', Warehouse_Incharge: 'a' } }],
  };
  const plan = generateSchema(app, { source: [source] });
  const column = columnOf(tableOf(plan, 'Add_Warehouse'), 'SKU');
  assert.equal(column.unique, true);
  assert.equal(column.appUnique, undefined);
  assert.equal(plan.constraints?.find((item) => item.column === 'SKU'), undefined);
});

test('a must-have column with no empty source cell stays store-mandatory', () => {
  const app = appOf(WAREHOUSE);
  const plan = generateSchema(app, { source: [warehouseRows(['Priya', 'Arun', 'Meena'])] });
  const column = columnOf(tableOf(plan, 'Add_Warehouse'), 'Warehouse_Incharge');
  assert.equal(column.mandatory, true);
  assert.equal(column.appMandatory, undefined);
  assert.equal(plan.constraints?.some((item) => item.rule === 'mandatory') ?? false, false);
});

test('a report export that does not carry the column proves nothing: it stays store-mandatory', () => {
  const app = appOf(WAREHOUSE);
  const source: SourceTableData = {
    table: 'Add_Warehouse',
    carried: ['Warehouse_Name', 'SKU'],
    rows: [{ columns: { Warehouse_Name: 'A', SKU: 'S1' } }, { columns: { Warehouse_Name: 'B', SKU: 'S2' } }],
  };
  const plan = generateSchema(app, { source: [source] });
  assert.equal(columnOf(tableOf(plan, 'Add_Warehouse'), 'Warehouse_Incharge').mandatory, true);
  assert.equal(plan.constraints, undefined);
});

test('a unique field whose source repeats a value is created not unique, with the repeat count named', () => {
  const app = appOf(WAREHOUSE);
  const source = warehouseRows(['Priya', 'Arun']);
  source.rows[1]!.columns.SKU = 'S0';
  const plan = generateSchema(app, { source: [source] });
  const column = columnOf(tableOf(plan, 'Add_Warehouse'), 'SKU');
  assert.equal(column.unique, false);
  assert.equal(column.appUnique, true);
  const decision = plan.constraints?.find((item) => item.column === 'SKU');
  assert.deepEqual(decision, { table: 'Add_Warehouse', column: 'SKU', rule: 'unique', layer: 'app', violations: 1 });
  assert.equal(
    constraintDecisionNote(decision!),
    'Add_Warehouse.SKU is unique but 1 source row(s) repeat a value; the column is created not unique and the generated app still checks it',
  );
});

test('a unique field with no repeated source value stays store-unique', () => {
  const app = appOf(WAREHOUSE);
  const plan = generateSchema(app, { source: [warehouseRows(['Priya', 'Arun'])] });
  const column = columnOf(tableOf(plan, 'Add_Warehouse'), 'SKU');
  assert.equal(column.unique, true);
  assert.equal(column.appUnique, undefined);
});

test('a disproved unique frees its varchar slot: the next unique column stays store-level', () => {
  const three = `application "Demo"
{
form Item
{
unique Code
(
type = text
)
unique Serial
(
type = text
)
unique Tag
(
type = text
)
}
}
`;
  const app = appOf(three);
  const plain = generateSchema(app);
  const table = tableOf(plain, 'Item');
  assert.equal(columnOf(table, 'Code').unique, true);
  assert.equal(columnOf(table, 'Serial').unique, true);
  assert.equal(columnOf(table, 'Tag').appUnique, true, 'third unique varchar is already app-level');
  const source: SourceTableData = {
    table: 'Item',
    complete: true,
    carried: ['Code', 'Serial', 'Tag'],
    rows: [
      { columns: { Code: 'c1', Serial: 's1', Tag: 't1' } },
      { columns: { Code: 'c1', Serial: 's2', Tag: 't2' } },
    ],
  };
  const plan = generateSchema(app, { source: [source] });
  const checked = tableOf(plan, 'Item');
  assert.equal(columnOf(checked, 'Code').appUnique, true, 'the disproved column is demoted before the budget runs');
  assert.equal(columnOf(checked, 'Serial').unique, true);
  assert.equal(columnOf(checked, 'Tag').unique, true, 'the freed slot keeps the third column store-unique');
});

test('an uncarried unique keeps its varchar slot: the third column stays app-level', () => {
  const three = `application "Demo"
{
form Item
{
unique Code
(
type = text
)
unique Serial
(
type = text
)
unique Tag
(
type = text
)
}
}
`;
  const app = appOf(three);
  // Code is not in the source at all: absence proves nothing, so its slot is
  // not freed and Tag is not promoted into it.
  const source: SourceTableData = {
    table: 'Item',
    complete: true,
    carried: ['Serial', 'Tag'],
    rows: [
      { columns: { Serial: 's1', Tag: 't1' } },
      { columns: { Serial: 's2', Tag: 't2' } },
    ],
  };
  const plan = generateSchema(app, { source: [source] });
  const table = tableOf(plan, 'Item');
  assert.equal(columnOf(table, 'Code').unique, true);
  assert.equal(columnOf(table, 'Code').appUnique, undefined);
  assert.equal(columnOf(table, 'Serial').unique, true);
  assert.equal(columnOf(table, 'Tag').appUnique, true, 'the uncarried column still holds its slot');
  assert.equal(plan.constraints?.find((item) => item.column === 'Code'), undefined);
});

test('generated columns are never demoted: a child row missing its parent link stays a store refusal', () => {
  const withGrid = `application "Demo"
{
form Order
{
Lines
(
type = grid
must have Item
(
type = text
)
)
}
}
`;
  const app = appOf(withGrid);
  const source: SourceTableData[] = [
    {
      table: 'Order__Lines',
      complete: true,
      carried: ['Item'],
      rows: [{ columns: { Item: 'a' } }],
    },
  ];
  const plan = generateSchema(app, { source });
  const parent = columnOf(tableOf(plan, 'Order__Lines'), 'parent_id');
  assert.equal(parent.mandatory, true, 'the generated link column keeps is_mandatory');
  assert.equal(parent.appMandatory, undefined);
});

test('the decision is deterministic: two runs over the same source agree byte for byte', () => {
  const app = appOf(WAREHOUSE);
  const source = [warehouseRows([undefined, 'Priya'])];
  const first = generateSchema(app, { source });
  const second = generateSchema(app, { source });
  assert.equal(schemaAsJson(first), schemaAsJson(second));
  assert.deepEqual(second.constraints, first.constraints);
});

test('recorded decisions replay onto a fresh plan: demoted columns stay demoted', () => {
  const app = appOf(WAREHOUSE);
  const measured = generateSchema(app, { source: [warehouseRows([undefined])] });
  assert.ok(measured.constraints?.length);
  const replayed = applyConstraintDecisions(generateSchema(app), measured.constraints!);
  const table = tableOf(replayed, 'Add_Warehouse');
  assert.equal(columnOf(table, 'Warehouse_Incharge').mandatory, false);
  assert.equal(columnOf(table, 'Warehouse_Incharge').appMandatory, true);
  assert.equal(columnOf(table, 'Warehouse_Name').mandatory, true, 'a kept store constraint is untouched');
});
