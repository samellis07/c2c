/**
 * A `list` field whose `values` names another form is a multi lookup: the
 * client posts an array of record ids. The write schema the on-success route
 * carries must say so (`multi`), as the UI model's does; before, the array was
 * screened as a single lookup and refused 403 on any form that has a form
 * script, so the submit never saved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { authorizeWrite, RecordAccessError, type WriteField } from '../../shims/src/access.js';
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
${tab(1)}form Contract
${tab(1)}{
${tab(2)}Title
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}Products
${tab(2)}(
${tab(3)}type = list
${tab(3)}values = Product.ID
${tab(3)}displayformat = [Name]
${tab(2)})
${tab(2)}Main_Product
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = Product.ID
${tab(3)}displayformat = [Name]
${tab(2)})
${tab(1)}}
${tab(1)}workflow
${tab(1)}{
${tab(1)}form
${tab(1)}{
${tab(2)}After_Contract as "After Contract"
${tab(2)}{
${tab(3)}type = form
${tab(3)}form = Contract
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

test('a list lookup is a multi lookup in the on-success write schema; a picklist lookup is not', () => {
  const file = generate(app).files.find((item) => item.path === 'functions/aio/contract/on-success.mjs');
  assert.ok(file, 'on-success module generated');
  const fields = JSON.parse(/^export const fields = (.*);$/m.exec(file.source)![1]!) as WriteField[];
  assert.deepEqual(fields.find((field) => field.name === 'Products'), { name: 'Products', kind: 'lookup', multi: true });
  assert.deepEqual(fields.find((field) => field.name === 'Main_Product'), { name: 'Main_Product', kind: 'lookup' });

  const policy = { roles: [], profiles: { Administrator: { Contract: { write: true } } } };
  const admin = { profile: 'Administrator', loginUser: 'a@example.test' };
  const schema = { fieldNames: ['Title', 'Products', 'Main_Product'], fields };
  const ok = authorizeWrite(policy, admin, 'Contract', { Products: ['rec-1', 'rec-2'] }, schema, 'insert');
  assert.deepEqual(ok.values.Products, ['rec-1', 'rec-2']);
  // A single lookup still refuses an array.
  assert.throws(() => authorizeWrite(policy, admin, 'Contract', { Main_Product: ['rec-1'] }, schema, 'insert'), RecordAccessError);
});
