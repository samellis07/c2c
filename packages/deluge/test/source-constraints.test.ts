/**
 * The generated app keeps enforcing a Creator must-have or unique field the
 * source data disproved: the demoted column is provisioned without the store
 * constraint, but `writeRules` and `appUniqueColumns` embedded in the handler
 * are built from the same measured schema, so a create or edit that violates
 * the rule is still refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse } from '../../core/src/index.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { WriteRuleError } from '../../shims/src/write-rules.js';
import { generateSchema, type SourceTableData } from '../../schema/src/generator.js';
import { appUniqueColumnsOf, writeRulesOf } from '../src/generate.js';

const APP = `application "Inventory Management"
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

const SOURCE: SourceTableData[] = [
  {
    table: 'Add_Warehouse',
    complete: true,
    carried: ['Warehouse_Name', 'Warehouse_Incharge', 'SKU'],
    rows: [
      { columns: { Warehouse_Name: 'North', Warehouse_Incharge: '', SKU: 'SKU-1' } },
      { columns: { Warehouse_Name: 'South', Warehouse_Incharge: '', SKU: 'SKU-1' } },
    ],
  },
];

test('a source-demoted must-have column is still refused empty on create and edit', async () => {
  const app = deriveIr(parse(APP));
  const schema = generateSchema(app, { source: SOURCE });
  const rules = writeRulesOf(app, schema);
  assert.equal(rules.Add_Warehouse?.find((column) => column.name === 'Warehouse_Incharge')?.required, true);
  // Without the measured plan the same Creator flag also generates the rule —
  // the source decides the store column, never the app-layer check.
  assert.equal(writeRulesOf(app).Add_Warehouse?.find((column) => column.name === 'Warehouse_Incharge')?.required, true);

  const calls: string[] = [];
  const stored = [{ ROWID: '1', Warehouse_Name: 'North', Warehouse_Incharge: '', SKU: 'SKU-1' }];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    writeRules: rules,
    datastore: {
      async insert(form, rows) {
        calls.push(`insert:${form}`);
        return rows;
      },
      async update(form, rows) {
        calls.push(`update:${form}`);
        return { updated: rows.length };
      },
      async query() {
        return stored;
      },
    },
  });
  const ctx = runtime.context({});
  const create = await runtime.shim.datastore
    .insert(ctx, 'Add_Warehouse', { Warehouse_Name: 'East', SKU: 'SKU-3' })
    .then(() => null, (err: unknown) => err);
  assert.ok(create instanceof WriteRuleError);
  assert.equal(create.code, 'MANDATORY_MISSING');
  assert.equal(create.field, 'Warehouse_Incharge');
  const blank = await runtime.shim.datastore
    .update(ctx, 'Add_Warehouse', { op: '==', field: 'ROWID', value: '1' }, { Warehouse_Incharge: '' })
    .then(() => null, (err: unknown) => err);
  assert.ok(blank instanceof WriteRuleError);
  assert.equal((blank as WriteRuleError).code, 'MANDATORY_MISSING');
  await runtime.shim.datastore.update(ctx, 'Add_Warehouse', { op: '==', field: 'ROWID', value: '1' }, { Stock: '4' });
  assert.deepEqual(calls, ['update:Add_Warehouse'], 'only the untouched-column edit writes');
});

test('a source-demoted unique column is checked by the handler, not the store', async () => {
  const app = deriveIr(parse(APP));
  const schema = generateSchema(app, { source: SOURCE });
  const appUnique = appUniqueColumnsOf(app, schema);
  assert.deepEqual(appUnique.Add_Warehouse, ['SKU']);
  // Without the measured plan the column stays store-unique: no handler check.
  assert.deepEqual(appUniqueColumnsOf(app).Add_Warehouse ?? [], []);

  const stored = [{ ROWID: '7001', SKU: 'SKU-1' }];
  const inserted: unknown[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    appUniqueColumns: appUnique,
    datastore: {
      async query(_form, zcql: string) {
        const match = /SKU = '([^']*)'/.exec(zcql);
        if (match) return stored.filter((row) => row.SKU === match[1]);
        return stored;
      },
      async insert(_form, rows) {
        inserted.push(...rows);
        return rows;
      },
      async update(_form, rows) {
        return { updated: rows.length };
      },
    },
  });
  const ctx = runtime.context({});
  await assert.rejects(
    () => runtime.shim.datastore.insert(ctx, 'Add_Warehouse', { Warehouse_Name: 'East', Warehouse_Incharge: 'Rao', SKU: 'SKU-1' }),
    (err: Error & { code?: string }) => err.code === 'DUPLICATE_VALUE',
  );
  assert.equal(inserted.length, 0);
  await runtime.shim.datastore.insert(ctx, 'Add_Warehouse', { Warehouse_Name: 'East', Warehouse_Incharge: 'Rao', SKU: 'SKU-4' });
  assert.equal(inserted.length, 1);
});
