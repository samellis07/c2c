/**
 * A source-measured plan demotes a disproved unique to the app layer. The
 * delete handler's runtime must embed the same `appUniqueColumns` the submit
 * handler carries, or an on-delete or on-success module's write skips the
 * app-unique check the measured plan requires.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateSchema, type SourceTableData } from '../../schema/src/generator.js';
import { generateUi } from '../src/generate.js';

const APP = `application "Inventory"
{
form Add_Warehouse
{
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
    carried: ['SKU'],
    rows: [{ columns: { SKU: 'SKU-1' } }, { columns: { SKU: 'SKU-1' } }],
  },
];

test('the delete stub embeds the measured plan app-unique columns like submit', () => {
  const app = deriveIr(parse(APP));
  const schema = generateSchema(app, { source: SOURCE });
  const bundle = generateUi(app, { schema });
  const submit = bundle.files.find((file) => file.path === 'functions/aio/add-warehouse/submit.mjs');
  const del = bundle.files.find((file) => file.path === 'functions/aio/add-warehouse/delete.mjs');
  assert.ok(submit, 'missing submit stub');
  assert.ok(del, 'missing delete stub');
  const line = /appUniqueColumns: \{"Add_Warehouse":\["SKU"\]\}/;
  assert.match(String(submit.data), line);
  assert.match(String(del.data), line, 'the delete runtime must check the same demoted uniques');
});
