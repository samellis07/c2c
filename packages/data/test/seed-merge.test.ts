import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { generateSchema } from '../../schema/src/generator.js';
import { generateSeed } from '../src/index.js';

function appOf(body: string, name = 'Merge'): App {
  return deriveIr(parse(`application "${name}"\n{\n${body}\n}\n`));
}

// One app exercising the merged features together: a composite name field, an
// inline subform, a file upload field, and a multi-select lookup.
const APP = appOf(
  `\tform Tag
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Member
\t{
\t\tmust have FullName
\t\t(
\t\t\ttype = name
\t\t\tfirst_name
\t\t\t(
\t\t\t\ttype = first_name
\t\t\t)
\t\t\tlast_name
\t\t\t(
\t\t\t\ttype = last_name
\t\t\t)
\t\t)
\t\tPhoto
\t\t(
\t\t\ttype = image
\t\t)
\t\tDocument
\t\t(
\t\t\ttype = file upload
\t\t)
\t\tTags
\t\t(
\t\t\ttype = checkbox
\t\t\tvalues = Tag.Name
\t\t)
\t\tNotes
\t\t(
\t\t\ttype = grid
\t\t\tLabel
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tQty
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t)
\t}`,
);

test('subform, file field, and multi-lookup seed together, uniquely and deterministically', () => {
  const n = 20;
  const once = generateSeed(APP, { n, seed: 'merge' });
  const twice = generateSeed(APP, { n, seed: 'merge' });
  assert.deepEqual(once, twice, 'two runs are identical');

  const plan = generateSchema(APP);
  const memberTable = plan.tables.find((item) => item.role === 'form' && item.form === 'Member');
  assert.ok(memberTable);
  const childTable = plan.tables.find((item) => item.role === 'child' && item.subform?.form === 'Member');
  assert.ok(childTable, 'schema plans a child table for the inline subform');

  const table = (form: string) => {
    const found = once.tables.find((item) => item.form === form);
    assert.ok(found, `missing seed table ${form}`);
    return found;
  };
  const tag = table('Tag');
  const member = table('Member');
  const child = table(childTable.name);
  const junction = table('Member__Tags');

  // Parent rows and composite part cells.
  assert.equal(member.rows.length, n);
  for (const row of member.rows) {
    assert.ok(row.columns.FullName_first_name, 'name first part is filled');
    assert.ok(row.columns.FullName_last_name, 'name last part is filled');
    assert.ok(row.columns.Photo.endsWith('.png'), 'image cell holds a fixture name');
    assert.ok(row.columns.Document.endsWith('.pdf'), 'file cell holds a fixture name');
    assert.equal(row.columns.Tags, undefined, 'multi-lookup is not written to the parent column');
  }

  // Child rows link back to real parents with 0-based row_order.
  assert.ok(child.rows.length > n, 'at least one child row per parent on average');
  const parentIds = new Set(member.rows.map((row) => row.id));
  const parentCol = childTable.subform!.parentColumn;
  const orderCol = childTable.subform!.orderColumn;
  for (const row of child.rows) {
    assert.ok(parentIds.has(row.columns[parentCol]!), 'child parent_id is a real parent source id');
    assert.match(row.columns[orderCol]!, /^\d+$/, 'row_order is a position');
  }
  const perParent = new Map<string, number>();
  for (const row of child.rows) perParent.set(row.columns[parentCol]!, (perParent.get(row.columns[parentCol]!) ?? 0) + 1);
  assert.equal(perParent.size, member.rows.length, 'every parent has child rows');
  for (const [id, count] of perParent) {
    const orders = child.rows.filter((row) => row.columns[parentCol] === id).map((row) => Number(row.columns[orderCol]));
    assert.deepEqual([...orders].sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i), 'row_order is 0-based contiguous');
  }

  // Fixture files exist for the image and file cells and dedupe by name.
  const names = new Set(once.fixtureFiles.map((item) => item.name));
  assert.equal(names.size, once.fixtureFiles.length, 'fixture file names are unique');
  for (const row of member.rows) {
    assert.ok(names.has(row.columns.Photo!), `fixture for ${row.columns.Photo}`);
    assert.ok(names.has(row.columns.Document!), `fixture for ${row.columns.Document}`);
  }

  // Junction rows: unique (parent_id, Tags) pairs pointing at real tag ids.
  const tagIds = new Set(tag.rows.map((row) => row.id));
  assert.ok(junction.rows.length > 0, 'junction rows exist');
  const pairs = new Set<string>();
  for (const row of junction.rows) {
    const pair = `${row.columns.parent_id}|${row.columns.Tags}`;
    assert.equal(pairs.has(pair), false, `duplicate junction pair ${pair}`);
    pairs.add(pair);
    assert.ok(parentIds.has(row.columns.parent_id!), 'junction parent is a real member id');
    assert.ok(tagIds.has(row.columns.Tags!), 'junction target is a real tag id');
  }
});
