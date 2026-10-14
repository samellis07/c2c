import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse } from '../../core/src/index.js';
import { canonicalSeedJson, generateSeed, seedCompositeMap } from '../../data/src/seed.js';
import { columnRenamesOf, generateSchema } from '../../schema/src/generator.js';
import { parseSeed, seedStoreColumns } from '../src/seed.js';

const DS = `application "Roster"
{
\tform Person
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
\t\t)
\t}
}
`;

test('the seed loader splits a name and an address into part columns', () => {
  const app = deriveIr(parse(DS));
  const plan = generateSchema(app);
  const [person] = seedStoreColumns(
    [{
      table: 'Person',
      rows: [{
        id: 'p1',
        columns: {
          Name: 'Ada Lovelace',
          Home: '10 Oak, Unit 2, Austin, TX, 78701, US',
        },
      }],
    }],
    columnRenamesOf(plan),
    seedCompositeMap(app, plan),
  );
  const columns = person!.rows[0]!.columns;
  assert.equal(columns.Name, undefined);
  assert.equal(columns.Home, undefined);
  assert.equal(columns.Name_first_name, 'Ada');
  assert.equal(columns.Name_last_name, 'Lovelace');
  assert.equal(columns.Home_address_line_1, '10 Oak');
  assert.equal(columns.Home_address_line_2, 'Unit 2');
  assert.equal(columns.Home_district_city, 'Austin');
  assert.equal(columns.Home_state_province, 'TX');
  assert.equal(columns.Home_postal_Code, '78701');
  assert.equal(columns.Home_country, 'US');
  assert.throws(
    () => seedStoreColumns(
      [{ table: 'Person', rows: [{ id: 'p2', columns: { Name: 'Ada Lovelace', Name_first_name: 'Ada' } }] }],
      columnRenamesOf(plan),
      seedCompositeMap(app, plan),
    ),
    /sets Name_first_name twice/,
  );
});

test('generated part columns pass through the seed loader unchanged', () => {
  const app = deriveIr(parse(DS));
  const plan = generateSchema(app);
  const seed = generateSeed(app, { n: 2, seed: 'roster' });
  const stored = seedStoreColumns(parseSeed(canonicalSeedJson(seed.tables)), columnRenamesOf(plan), seedCompositeMap(app, plan));
  const person = stored.find((table) => table.table === 'Person')!;
  assert.equal(person.rows.length, 2);
  for (const row of person.rows) {
    assert.equal(row.columns.Name, undefined);
    assert.ok(row.columns.Name_first_name);
    assert.ok(row.columns.Name_last_name);
    assert.ok(row.columns.Home_address_line_1);
    assert.ok(row.columns.Home_postal_Code);
  }
});
