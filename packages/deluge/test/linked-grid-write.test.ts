/**
 * A grid whose `values` names another form (`values = Line.ID`) keeps its
 * rows as records of that form. The on-success route's write schema screens
 * the posted rows against the linked form's fields (a lookup column carries
 * the record id), and the rows are saved onto the linked table through its
 * foreign key to the parent ROWID. Before, the grid was screened as a lookup
 * and any row object was refused 403.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { authorizeWrite, RecordAccessError, type WriteField } from '../../shims/src/access.js';
import { subformLinksFor } from '../src/field-store.js';
import { generate } from '../src/generate.js';

const tab = (n: number) => '\t'.repeat(n);

const SOURCE = `application "Demo"
{
${tab(1)}form Product
${tab(1)}{
${tab(2)}Name
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(1)}}
${tab(1)}form Line
${tab(1)}{
${tab(2)}must have Item
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = Product.ID
${tab(3)}displayformat = [Name]
${tab(2)})
${tab(2)}Qty
${tab(2)}(
${tab(3)}type = number
${tab(2)})
${tab(1)}}
${tab(1)}form Quote
${tab(1)}{
${tab(2)}Title
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}must have Lines
${tab(2)}(
${tab(3)}type = grid
${tab(3)}values = Line.ID
${tab(2)})
${tab(1)}}
${tab(1)}workflow
${tab(1)}{
${tab(1)}form
${tab(1)}{
${tab(2)}After_Quote as "After Quote"
${tab(2)}{
${tab(3)}type = form
${tab(3)}form = Quote
${tab(3)}record event = on add
${tab(3)}on success
${tab(3)}{
${tab(4)}actions
${tab(4)}{
${tab(5)}custom deluge script
${tab(5)}(
${tab(6)}insert into Product [ Name = input.Title ];
${tab(5)})
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
${tab(1)}}
}
`;

const app = deriveIr(parse(SOURCE));

test('a linked grid is a subform link onto the linked table, with no order column', () => {
  assert.deepEqual(subformLinksFor(app, 'Quote'), [{ field: 'Lines', table: 'Line', parentColumn: 'Quote_id', linkedForm: 'Line' }]);
  assert.deepEqual(subformLinksFor(app, 'Line'), []);
});

test('the on-success route screens linked-grid rows against the linked form and saves them', () => {
  const file = generate(app).files.find((item) => item.path === 'functions/aio/quote/on-success.mjs');
  assert.ok(file, 'on-success module generated');
  assert.match(file.source, /export const subformTables = \{"Quote":\[\{"field":"Lines","table":"Line","parentColumn":"Quote_id","linkedForm":"Line"\}\]\};/);
  // Linked rows are written under the linked form's grant, checked before any store write.
  assert.match(file.source, /authorizeSubformWrites\(datastore, rowId, split\.children, \{ replace: true, authorize: linkedSubformGate\(ctx\) \}\)/);
  assert.match(file.source, /authorizeSubformWrites\(datastore, "", split\.children, \{ authorize: linkedSubformGate\(ctx\) \}\)/);
  assert.match(file.source, /authorizeDelete\(access, ctx\.principal, link\.linkedForm\)/);
  const fields = JSON.parse(/^export const fields = (.*);$/m.exec(file.source)![1]!) as WriteField[];
  const lines = fields.find((field) => field.name === 'Lines');
  assert.deepEqual(lines, { name: 'Lines', kind: 'subform', fields: [{ name: 'Item', kind: 'lookup' }, { name: 'Qty', scalar: 'number' }] });

  const policy = { roles: [], profiles: { Administrator: { Quote: { write: true, delete: true } } } };
  const admin = { profile: 'Administrator', loginUser: 'a@example.test' };
  const schema = { fieldNames: ['Title', 'Lines'], fields };
  const ok = authorizeWrite(policy, admin, 'Quote', { Title: 'q', Lines: [{ Item: '1000000000000001', Qty: 2 }] }, schema, 'insert');
  assert.deepEqual(ok.values.Lines, [{ Item: '1000000000000001', Qty: 2 }]);
  // The row is still screened: a key the linked form does not have is refused.
  assert.throws(() => authorizeWrite(policy, admin, 'Quote', { Lines: [{ Item: '1', Price: 3 }] }, schema, 'insert'), RecordAccessError);
  // A profile without the form's write grant is still refused.
  const viewer = { roles: [], profiles: { Viewer: { Quote: { write: false } } } };
  assert.throws(() => authorizeWrite(viewer, { profile: 'Viewer' }, 'Quote', { Lines: [{ Item: '1' }] }, schema, 'insert'), RecordAccessError);
});
