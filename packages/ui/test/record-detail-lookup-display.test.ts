/**
 * A report's record detail shows the declared detail view fields in the form's
 * own words: a lookup reads as the parent display text (never the stored
 * ROWID), an inline subform row list rides along, a hidden field stays out,
 * and a field the detail view does not declare is not drawn. The display text
 * resolves under the caller's grant on the parent form: a reader who cannot
 * read the parent row gets a blank, not the ROWID and not the text.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';
import { invoke, liveDatastore, loadTree } from './page-endpoint.js';

const tab = (n: number) => '\t'.repeat(n);

const SOURCE = `application "Demo"
{
${tab(1)}form Product
${tab(1)}{
${tab(2)}Title
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(1)}}
${tab(1)}form Item
${tab(1)}{
${tab(2)}Name
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}Serial_Number
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}Secret
${tab(2)}(
${tab(3)}type = text
${tab(3)}visibility = false
${tab(2)})
${tab(2)}Product
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = Product.ID
${tab(3)}displayformat = [Title]
${tab(2)})
${tab(2)}Lines
${tab(2)}(
${tab(3)}type = grid
${tab(3)}Qty
${tab(3)}(
${tab(4)}type = text
${tab(3)})
${tab(2)})
${tab(1)}}
${tab(1)}list Product_All
${tab(1)}{
${tab(2)}show all rows from Product
${tab(2)}(
${tab(3)}Title
${tab(2)})
${tab(1)}}
${tab(1)}list Item_Detail
${tab(1)}{
${tab(2)}show all rows from Item
${tab(2)}(
${tab(3)}Name
${tab(3)}Product
${tab(2)})
${tab(1)}}
${tab(1)}web
${tab(1)}{
${tab(2)}reports
${tab(2)}{
${tab(3)}report Item_Detail
${tab(3)}{
${tab(4)}detailview
${tab(4)}(
${tab(5)}layout
${tab(5)}(
${tab(6)}datablock1
${tab(6)}(
${tab(7)}title = "Main"
${tab(7)}fields
${tab(7)}(
${tab(8)}Name
${tab(8)}Product
${tab(8)}Secret
${tab(7)})
${tab(6)})
${tab(6)}datablock2
${tab(6)}(
${tab(7)}title = "Lines"
${tab(7)}related field = Lines
${tab(7)}fields
${tab(7)}(
${tab(8)}Qty
${tab(7)})
${tab(6)})
${tab(5)})
${tab(4)})
${tab(3)}}
${tab(2)}}
${tab(1)}}
${tab(1)}share_settings
${tab(1)}{
${tab(2)}"Staff"
${tab(2)}{
${tab(3)}name = "Staff"
${tab(3)}type = Users_Permissions
${tab(3)}ModulePermissions
${tab(3)}{
${tab(4)}Item
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Item_Detail = {"View"}
${tab(5)}}
${tab(5)}FieldPermissions
${tab(5)}{
${tab(6)}Name
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(6)}Product
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(6)}Lines
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(5)}}
${tab(4)}}
${tab(4)}Product
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Product_All = {"View"}
${tab(5)}}
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(2)}"Reader"
${tab(2)}{
${tab(3)}name = "Reader"
${tab(3)}type = Users_Permissions
${tab(3)}ModulePermissions
${tab(3)}{
${tab(4)}Item
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Item_Detail = {"View"}
${tab(5)}}
${tab(5)}FieldPermissions
${tab(5)}{
${tab(6)}Name
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(6)}Product
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(5)}}
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
}
`;

const RECORD = 'functions/aio/item/record.mjs';

async function seed() {
  const { files } = generateUi(deriveIr(parse(SOURCE)));
  // The child table of the inline subform carries its own grant.
  const policy = files.find((file) => file.path === 'functions/access-policy.json')!;
  const parsed = JSON.parse(String(policy.data)) as { profiles: Record<string, Record<string, unknown>> };
  parsed.profiles.Staff!.Item__Lines = {};
  policy.data = JSON.stringify(parsed);
  const dir = loadTree(files);
  const live = liveDatastore();
  await live.datastore.insert('Product', [{ Title: 'Widget' }]);
  const product = String((await live.datastore.query('Product', 'true', 10))[0]!.ROWID);
  await live.datastore.insert('Item', [{ Name: 'own', Serial_Number: 'SN-7', Secret: 'hush', Product: product }]);
  const item = String((await live.datastore.query('Item', 'true', 10))[0]!.ROWID);
  await live.datastore.insert('Item__Lines', [{ parent_id: item, row_order: '0', Qty: '3' }]);
  return { dir, live, product, item };
}

test('the record detail shows the parent display text for a lookup, the subform rows, and no hidden field', async () => {
  const run = await seed();
  try {
    const got = await invoke(run.dir, RECORD, { profile: 'Staff', loginUser: 'ada@example.test', userId: 'u3' }, { ROWID: run.item, REPORT: 'Item_Detail' });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const record = got.body.record as Record<string, unknown>;
    assert.equal(record.Name, 'own');
    assert.equal(record.Product, 'Widget', `lookup shows its ROWID: ${JSON.stringify(record)}`);
    assert.ok(!('Secret' in record), `hidden field returned: ${JSON.stringify(record)}`);
    assert.ok(Array.isArray(record.Lines) && (record.Lines as { Qty: string }[])[0]?.Qty === '3', `subform rows missing: ${JSON.stringify(record)}`);
    // The edit read (no REPORT) keeps the ROWID: the key the edit form submits.
    const edit = await invoke(run.dir, RECORD, { profile: 'Staff', loginUser: 'ada@example.test', userId: 'u3' }, { ROWID: run.item });
    assert.equal((edit.body.record as Record<string, unknown>).Product, run.product);
  } finally {
    run.live.restore();
  }
});

test('a reader without a grant on the parent form sees a blank lookup: neither the ROWID nor the display text', async () => {
  const run = await seed();
  try {
    const got = await invoke(run.dir, RECORD, { profile: 'Reader', loginUser: 'rae@example.test', userId: 'u4' }, { ROWID: run.item, REPORT: 'Item_Detail' });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const record = got.body.record as Record<string, unknown>;
    assert.equal(record.Name, 'own');
    assert.ok(record.Product === '' || record.Product == null, `unreadable parent leaked: ${JSON.stringify(record)}`);
    assert.ok(!JSON.stringify(record).includes('Widget'));
  } finally {
    run.live.restore();
  }
});
