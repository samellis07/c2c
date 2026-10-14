import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveIr, parse, type App, type Field } from '../../core/src/index.js';
import { fieldTypeRow, normalizeType } from '../../schema/src/mapping.js';
import { generateSchema } from '../../schema/src/generator.js';
import { assertSeedColumns, assertSeedTables } from '../../deploy/src/remap.js';
import { generateSeed, type SeedResult } from '../src/seed.js';

function appOf(body: string, name = 'Roster'): App {
  return deriveIr(parse(`application "${name}"\n{\n${body}\n}\n`));
}

const APP = appOf(
  `\tform Person
\t{
\t\tmust have Name
\t\t(
\t\t\ttype = name
\t\t\tprefix
\t\t\t(
\t\t\t\ttype = prefix
\t\t\t\tvalue = {"Mr.","Mrs.","Ms."}
\t\t\t)
\t\t\tfirst_name
\t\t\t(
\t\t\t\ttype = first_name
\t\t\t)
\t\t\tlast_name
\t\t\t(
\t\t\t\ttype = last_name
\t\t\t)
\t\t\tsuffix
\t\t\t(
\t\t\t\ttype = suffix
\t\t\t)
\t\t)
\t\tHome
\t\t(
\t\t\ttype = address
\t\t\taddress_line_1
\t\t\t(
\t\t\t\ttype = address_line_1
\t\t\t)
\t\t\taddress_line_2
\t\t\t(
\t\t\t\ttype = address_line_2
\t\t\t)
\t\t\tdistrict_city
\t\t\t(
\t\t\t\ttype = district_city
\t\t\t)
\t\t\tstate_province
\t\t\t(
\t\t\t\ttype = state_province
\t\t\t)
\t\t\tpostal_Code
\t\t\t(
\t\t\t\ttype = postal_Code
\t\t\t)
\t\t\tcountry
\t\t\t(
\t\t\t\ttype = country
\t\t\t)
\t\t\tlatitude
\t\t\t(
\t\t\t\ttype = latitude
\t\t\t)
\t\t\tlongitude
\t\t\t(
\t\t\t\ttype = longitude
\t\t\t)
\t\t)
\t\tNotes
\t\t(
\t\t\ttype = grid
\t\t\tChannel
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tvalues = {"Phone","Mail"}
\t\t\t)
\t\t\tMail
\t\t\t(
\t\t\t\ttype = email
\t\t\t)
\t\t\tPhone
\t\t\t(
\t\t\t\ttype = phonenumber
\t\t\t)
\t\t\tQty
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t\tAmount
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t)
\t\t\tWhen
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tAt
\t\t\t(
\t\t\t\ttype = datetime
\t\t\t)
\t\t\tLink
\t\t\t(
\t\t\t\ttype = url
\t\t\t)
\t\t\tDone
\t\t\t(
\t\t\t\ttype = checkbox
\t\t\t)
\t\t\tLabel
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t)
\t}
\tform Badge
\t{
\t\tCode
\t\t(
\t\t\ttype = text
\t\t)
\t\tIssued
\t\t(
\t\t\ttype = grid
\t\t\tvalues = Person.Name
\t\t\tbidirectional = Person_link
\t\t)
\t}`,
);

function table(seed: SeedResult, form: string) {
  const found = seed.tables.find((item) => item.form === form);
  assert.ok(found, `missing seed table ${form}`);
  return found;
}

test('inline subform rows carry the parent id and every child field', () => {
  const seed = generateSeed(APP, { n: 4, seed: 'roster' });
  const again = generateSeed(APP, { n: 4, seed: 'roster' });
  assert.deepEqual(again, seed);
  const person = table(seed, 'Person');
  const notes = table(seed, 'Person__Notes');
  assert.equal(person.rows.length, 4);
  assert.ok(notes.rows.length >= 4 && notes.rows.length <= 12);
  const parentIds = person.rows.map((row) => row.id);
  const perParent = new Map<string, string[]>();
  for (const row of notes.rows) {
    const parent = row.columns.parent_id;
    assert.ok(parentIds.includes(parent), parent);
    const list = perParent.get(parent) ?? [];
    list.push(row.columns.row_order ?? '');
    perParent.set(parent, list);
  }
  assert.equal(perParent.size, 4);
  for (const orders of perParent.values()) {
    assert.ok(orders.length >= 1 && orders.length <= 3);
    assert.deepEqual(orders, orders.map((_, index) => String(index)));
  }
  for (const row of notes.rows) {
    assert.ok(row.columns.Channel === 'Phone' || row.columns.Channel === 'Mail');
    assert.match(row.columns.Mail ?? '', /@example\.com$/);
    assert.match(row.columns.Phone ?? '', /^9\d{9}$/);
    assert.match(row.columns.Qty ?? '', /^\d+$/);
    assert.match(row.columns.Amount ?? '', /^\d+\.\d{2}$/);
    assert.match(row.columns.When ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.match(row.columns.At ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.match(row.columns.Link ?? '', /^https:\/\/example\.com\//);
    assert.ok(row.columns.Done === 'true' || row.columns.Done === 'false');
    assert.ok((row.columns.Label ?? '').length > 0);
  }
  const back = generateSchema(APP).tables.find((item) => item.form === 'Person' && item.role === 'form')!.columns.find((column) => column.matrixId === 'subform' && column.relation);
  assert.ok(back, 'back-reference column');
  const badgeIds = new Set(table(seed, 'Badge').rows.map((row) => row.id));
  for (const row of person.rows) assert.ok(badgeIds.has(row.columns[back.name]), `${back.name}=${row.columns[back.name]}`);
});

test('name and address parts are separate non-empty columns', () => {
  const seed = generateSeed(APP, { n: 3, seed: 'roster' });
  const person = table(seed, 'Person');
  const parts = [
    'Name_prefix', 'Name_first_name', 'Name_last_name', 'Name_suffix',
    'Home_address_line_1', 'Home_address_line_2', 'Home_district_city', 'Home_state_province',
    'Home_postal_Code', 'Home_country', 'Home_latitude', 'Home_longitude',
  ];
  const prefixes = new Set(['Mr.', 'Mrs.', 'Ms.']);
  for (const row of person.rows) {
    assert.equal(row.columns.Name, undefined);
    assert.equal(row.columns.Home, undefined);
    for (const column of parts) assert.ok(row.columns[column], column);
    assert.ok(prefixes.has(row.columns.Name_prefix ?? ''));
    assert.match(row.columns.Name_first_name ?? '', /^[A-Za-z]+$/);
    assert.match(row.columns.Name_last_name ?? '', /^[A-Za-z]+$/);
    assert.match(row.columns.Home_latitude ?? '', /^-?\d+\.\d+$/);
    assert.match(row.columns.Home_longitude ?? '', /^-?\d+\.\d+$/);
    assert.match(row.columns.Home_postal_Code ?? '', /^\d{5}$/);
  }
  const plan = generateSchema(APP);
  const columns = new Set(plan.tables.find((item) => item.form === 'Person' && item.role === 'form')!.columns.map((column) => column.name));
  for (const column of parts) assert.ok(columns.has(column), column);
});

test('a multi-lookup inside a subform emits a junction the schema plans', () => {
  const app = appOf(
    `\tform Tag
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Member
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tNotes
\t\t(
\t\t\ttype = grid
\t\t\tLine
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tTags
\t\t\t(
\t\t\t\ttype = checkbox
\t\t\t\tvalues = Tag.Name
\t\t\t)
\t\t)
\t}`,
  );
  const plan = generateSchema(app);
  const schemaTables = new Set(plan.tables.map((item) => item.name));
  const junction = plan.tables.find((item) => item.role === 'junction' && item.name === 'Member__Notes__Tags');
  assert.ok(junction, 'schema plans the child-table junction');
  assert.equal(junction.columns[0]?.name, 'parent_id');
  assert.equal(junction.columns[0]?.relation?.table, 'Member__Notes');
  const seed = generateSeed(app, { n: 3, seed: 'sub-multi' });
  for (const item of seed.tables) {
    assert.ok(schemaTables.has(item.form), `seed table ${item.form} is not in the schema`);
  }
  const links = table(seed, 'Member__Notes__Tags');
  const childIds = new Set(table(seed, 'Member__Notes').rows.map((row) => row.id));
  const tagIds = new Set(table(seed, 'Tag').rows.map((row) => row.id));
  assert.ok(links.rows.length > 0, 'junction table has rows');
  for (const row of links.rows) {
    assert.ok(childIds.has(row.columns.parent_id), row.columns.parent_id);
    assert.ok(tagIds.has(row.columns.Tags), row.columns.Tags);
  }
  const child = table(seed, 'Member__Notes');
  for (const row of child.rows) {
    assert.equal(row.columns.Tags, undefined, 'multi-lookup is not written to the child column');
  }
});

test('dollar and non-ASCII multi-lookup names seed the tables the schema plans', () => {
  const app = appOf(
    `\tform Tag
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Member
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tTag$List
\t\t(
\t\t\ttype = checkbox
\t\t\tvalues = Tag.Name
\t\t)
\t\tNotes
\t\t(
\t\t\ttype = grid
\t\t\tLine
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tÉtiquettes
\t\t\t(
\t\t\t\ttype = checkbox
\t\t\t\tvalues = Tag.Name
\t\t\t)
\t\t\tTag$List
\t\t\t(
\t\t\t\ttype = checkbox
\t\t\t\tvalues = Tag.Name
\t\t\t)
\t\t)
\t}`,
  );
  const plan = generateSchema(app);
  const known = plan.tables.map((item) => item.name);
  const seed = generateSeed(app, { n: 2, seed: 'idents' });
  const remap = seed.tables.map((item) => ({ table: item.form, rows: item.rows }));
  assertSeedTables(remap, known);
  const columnsByTable: Record<string, { name: string }[]> = {};
  for (const item of plan.tables) columnsByTable[item.name] = item.columns;
  assertSeedColumns(remap, columnsByTable);
  for (const name of ['Member__Tag_List', 'Member__Notes__Tag_List', 'Member__Notes___tiquettes']) {
    assert.ok(known.includes(name), `schema plans ${name}`);
    const rows = table(seed, name).rows;
    assert.ok(rows.length > 0, name);
  }
  assert.ok(table(seed, 'Member__Tag_List').rows.every((row) => row.columns.Tag_List && row.columns.Tag$List === undefined));
  assert.ok(table(seed, 'Member__Notes__Tag_List').rows.every((row) => row.columns.Tag_List && row.columns['Tag$List'] === undefined));
  assert.ok(table(seed, 'Member__Notes___tiquettes').rows.every((row) => row.columns._tiquettes && row.columns['Étiquettes'] === undefined));
});

test('an over-long nested junction name is a table-name-length-unverified blocker in the schema and the seed', () => {
  const form = 'F'.repeat(61);
  const sub = 'S'.repeat(61);
  const field = 'L'.repeat(61);
  const junction = `${form}__${sub}__${field}`;
  assert.equal(junction.length, 187);
  const app = appOf(
    `\tform Tag
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform ${form}
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\t${sub}
\t\t(
\t\t\ttype = grid
\t\t\tLine
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\t${field}
\t\t\t(
\t\t\t\ttype = checkbox
\t\t\t\tvalues = Tag.Name
\t\t\t)
\t\t)
\t}`,
  );
  const plan = generateSchema(app);
  const seed = generateSeed(app, { n: 1, seed: 'long-name' });
  const schemaHit = plan.limitBlockers?.find((item) => item.table === junction && item.limitId === 'table-name-length-unverified');
  const seedBlockers = (seed as { limitBlockers?: { table: string; limitId: string; message: string; form: string; fix: string; field: string | null }[] }).limitBlockers;
  const seedHit = seedBlockers?.find((item) => item.table === junction && item.limitId === 'table-name-length-unverified');
  const failures: string[] = [];
  if (!schemaHit) failures.push(`schema missing table-name-length-unverified for ${junction.length}-char ${junction.slice(0, 24)}…`);
  if (!seedHit) failures.push('seed missing table-name-length-unverified for the same junction');
  if (schemaHit && seedHit && (schemaHit.limitId !== seedHit.limitId || schemaHit.message !== seedHit.message || schemaHit.table !== seedHit.table)) {
    failures.push('schema and seed blockers differ');
  }
  assert.deepEqual(failures, []);
  const known = new Set(plan.tables.map((item) => item.name));
  for (const item of seed.tables) assert.ok(known.has(item.form), item.form);
});

const GALLERY = process.env.C2C_FIXTURES_DIR ? join(process.env.C2C_FIXTURES_DIR, 'gallery') : '';

function dsOf(slug: string): string {
  const dir = join(GALLERY, slug);
  const file = readdirSync(dir).filter((name) => name.endsWith('.ds')).sort()[0];
  assert.ok(file, slug);
  return join(dir, file);
}

function partsOf(field: Field): string[] {
  if (field.subfields.length) return field.subfields.map((sub) => sub.name);
  const row = fieldTypeRow(field.type);
  if (row?.id === 'address') return ['address_line_1', 'address_line_2', 'district_city', 'state_province', 'postal_code', 'country', 'latitude', 'longitude'];
  return ['prefix', 'first_name', 'last_name', 'suffix'];
}

test('contacts, construction-management, and CRM fixtures seed child rows and composite parts', { skip: GALLERY && existsSync(GALLERY) ? false : 'set C2C_FIXTURES_DIR to check the gallery fixtures' }, () => {
  const slugs = ['contacts', 'construction-management', 'customer-relationship-manager'] as const;
  for (const slug of slugs) {
    const app = deriveIr(parse(readFileSync(dsOf(slug), 'utf8')));
    const plan = generateSchema(app);
    const seed = generateSeed(app, { n: 2, seed: 'gallery' });
    const byForm = new Map(seed.tables.map((item) => [item.form, item]));
    for (const child of plan.tables.filter((item) => item.role === 'child' && item.subform)) {
      const rows = byForm.get(child.name);
      assert.ok(rows && rows.rows.length > 0, `${slug} ${child.name}`);
      const parent = byForm.get(child.subform!.form);
      assert.ok(parent && parent.rows.length > 0, child.subform!.form);
      const ids = new Set(parent.rows.map((row) => row.id));
      const seen = new Set<string>();
      for (const row of rows.rows) {
        const parentId = row.columns[child.subform!.parentColumn];
        assert.ok(ids.has(parentId), `${child.name} ${parentId}`);
        seen.add(parentId);
      }
      assert.equal(seen.size, parent.rows.length, child.name);
      assert.ok(rows.rows.length <= parent.rows.length * 3);
    }
    for (const formTable of plan.tables.filter((item) => item.role === 'form')) {
      const rows = byForm.get(formTable.form);
      assert.ok(rows, formTable.form);
      for (const column of formTable.columns) {
        if (column.matrixId !== 'subform' || !column.relation) continue;
        const parentName = plan.tables.find((item) => item.name === column.relation!.table && item.role === 'form')?.form;
        const parentIds = new Set(byForm.get(parentName ?? '')?.rows.map((row) => row.id));
        for (const row of rows.rows) {
          const value = row.columns[column.name];
          assert.ok(value && parentIds.has(value), `${slug} ${formTable.form}.${column.name}`);
        }
      }
    }
    const checkParts = (formName: string, field: Field) => {
      if (fieldTypeRow(field.type)?.kind !== 'composite') return;
      const rows = byForm.get(formName);
      assert.ok(rows && rows.rows.length > 0, `${slug} ${formName}`);
      for (const part of partsOf(field)) {
        const column = `${field.name}_${part}`;
        for (const row of rows.rows) assert.ok(row.columns[column], `${slug} ${formName}.${column}`);
      }
    };
    for (const form of app.forms) {
      for (const field of form.fields) {
        checkParts(form.name, field);
        if (normalizeType(field.type) === 'grid' || normalizeType(field.type) === 'subform' || normalizeType(field.type) === 'inline subform') {
          const child = plan.tables.find((item) => item.role === 'child' && item.subform?.form === form.name && item.subform.field === field.name);
          if (!child) continue;
          for (const sub of field.subfields) checkParts(child.name, sub);
        }
      }
    }
  }
});
