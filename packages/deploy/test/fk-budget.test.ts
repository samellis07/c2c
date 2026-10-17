/**
 * Lookups past the per-table foreign-key limit: the schema keeps the limit's worth
 * as store foreign keys and stores the rest as plain bigint ROWID ids. None is
 * dropped: each still remaps, and the plan budget, migration issue and precheck
 * name every one. A table that still carries more store foreign keys fails the plan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateSchema } from '../../schema/src/generator.js';
import { limitValue } from '../../schema/src/limits.js';
import { precheck } from '../../cli/src/precheck.js';
import { buildBudgets, buildOfflinePlan } from '../src/offline-plan.js';
import { foreignKeysForApp } from '../src/remap.js';
import { tableCreatePlan } from '../src/tables.js';

const MAX = limitValue('datastore.fk_columns');

/** Form Plan with `count` lookups to Ref; the last `required` are mandatory (so column order alone would demote them). */
function source(count: number, required = 0): string {
  const lookups = Array.from({ length: count }, (_, index) => {
    const must = index >= count - required ? 'must have ' : '';
    return `\t\t${must}Pick${index}\n\t\t(\n\t\t\ttype = picklist\n\t\t\tvalues = Ref.Name\n\t\t)`;
  }).join('\n');
  return `application "Demo"\n{\n\tform Ref\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n\tform Plan\n\t{\n${lookups}\n\t}\n}\n`;
}

const app = (text: string) => deriveIr(parse(text));
const planTable = (text: string) => generateSchema(app(text)).tables.find((table) => table.name === 'Plan')!;

test('lookups past the limit become plain bigint ids; mandatory ones stay foreign keys', () => {
  const text = source(MAX + 3, 2);
  const schema = generateSchema(app(text));
  const table = schema.tables.find((item) => item.name === 'Plan')!;
  const lookups = table.columns.filter((column) => column.name.startsWith('Pick'));
  assert.equal(lookups.length, MAX + 3, 'no lookup is dropped');
  const keys = lookups.filter((column) => column.dataType === 'Foreign Key');
  const plain = lookups.filter((column) => column.plainLookup);
  assert.equal(keys.length, MAX);
  assert.deepEqual(
    plain.map((column) => [column.name, column.dataType, column.relation?.table]),
    [`Pick${MAX - 2}`, `Pick${MAX - 1}`, `Pick${MAX}`].map((name) => [name, 'BigInt', 'Ref']),
  );
  for (const name of [`Pick${MAX + 1}`, `Pick${MAX + 2}`]) {
    const column = keys.find((item) => item.name === name);
    assert.ok(column?.mandatory, `mandatory ${name} at the tail stays a foreign key`);
    assert.equal(column.relation?.onDelete, 'ON-DELETE-CASCADE');
  }
  const issue = schema.issues.find((item) => item.form === 'Plan' && item.message.includes('plain bigint ROWID'));
  assert.ok(issue, 'migration report names the demoted lookups');
  for (const column of plain) assert.match(issue.message, new RegExp(`${column.name} -> Ref`));
  assert.match(issue.message, /Manual step:/);
  assert.match(issue.message, /foreign keys per table \(unverified\)/);
});

test('plain ids still remap and are created as bigint columns', () => {
  const ir = app(source(MAX + 2));
  const remapped = foreignKeysForApp(ir).filter((key) => key.table === 'Plan').map((key) => key.column);
  assert.equal(remapped.length, MAX + 2);
  const types = tableCreatePlan(generateSchema(ir))
    .filter((step) => step.table === 'Plan')
    .flatMap((step) => step.columns)
    .filter((column) => column.column_name.startsWith('Pick'))
    .map((column) => column.data_type);
  assert.equal(types.filter((type) => type === 'foreign key').length, MAX);
  assert.equal(types.filter((type) => type === 'bigint').length, 2);
});

test('the offline plan warns with a guided step instead of failing', () => {
  const { plan } = buildOfflinePlan(app(source(MAX + 2)), { dc: 'in', dcSource: '--dc', mail: false });
  const row = plan.budgets.find((budget) => budget.id === 'fk' && budget.table === 'Plan')!;
  assert.equal(row.status, 'warn');
  assert.match(row.detail, new RegExp(`${MAX}/${MAX} foreign keys; 2 more lookup`));
  assert.match(row.detail, new RegExp(`the ${MAX}-foreign-key limit is unverified`));
  assert.ok(row.fix);
  assert.equal(plan.budgetsOk, true);
});

test('precheck counts the demotion as a guided warning', () => {
  const text = source(MAX + 1);
  const hits = precheck(app(text), text).findings.filter((finding) => finding.check === 'datastore.fk_columns');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.severity, 'warning');
  assert.match(hits[0]!.message, new RegExp(`Pick${MAX} -> Ref`));
  assert.ok(hits[0]!.fix);
});

test('at the limit nothing is demoted', () => {
  const table = planTable(source(MAX));
  assert.equal(table.columns.filter((column) => column.plainLookup).length, 0);
  assert.equal(buildBudgets([table]).budgets.find((budget) => budget.id === 'fk')!.status, 'pass');
});

test('must fail: a table that still carries more store foreign keys fails the plan', () => {
  const table = planTable(source(MAX + 1));
  for (const column of table.columns) {
    if (!column.plainLookup) continue;
    column.plainLookup = undefined;
    column.dataType = 'Foreign Key';
  }
  const { budgets, ok } = buildBudgets([table]);
  const row = budgets.find((budget) => budget.id === 'fk')!;
  assert.equal(row.status, 'fail');
  assert.match(row.detail, new RegExp(`${MAX + 1}/${MAX} foreign keys`));
  assert.equal(ok, false);
});
