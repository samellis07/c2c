import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { convertSyntheticSeed } from '../src/seed-synthetic.js';
import { generateSeed } from '../src/seed.js';

function appOf(body: string, name = 'Demo'): App {
  return deriveIr(parse(`application "${name}"\n{\n${body}\n}\n`));
}

const APP = appOf(
  `\tform Author
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Book
\t{
\t\tmust have Title
\t\t(
\t\t\ttype = text
\t\t)
\t\tAuthor
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Author.Name
\t\t)
\t}`,
);

test('generateSeed emits canonical rows whose lookups hold the parent stable source id', () => {
  const seed = generateSeed(APP, { n: 3, seed: 'library' });
  assert.deepEqual(
    seed.tables.map((table) => table.form),
    ['Author', 'Book'],
  );
  const author = seed.tables[0];
  const book = seed.tables[1];
  assert.equal(author.rows.length, 3);
  assert.equal(book.rows.length, 3);
  const ids = new Set(author.rows.map((row) => row.id));
  assert.equal(ids.size, 3);
  for (const row of author.rows) assert.match(row.id, /^Author#[0-9a-f]+#\d+$/);
  const parentIds = new Set(author.rows.map((row) => row.id));
  for (const row of book.rows) {
    assert.ok(parentIds.has(row.columns.Author), `Book.Author ${row.columns.Author} is not an Author source id`);
  }
  // Stable: the same inputs give the same ids, so a re-run reconciles.
  const again = generateSeed(APP, { n: 3, seed: 'library' });
  assert.deepEqual(
    again.tables.map((table) => table.rows.map((row) => row.id)),
    seed.tables.map((table) => table.rows.map((row) => row.id)),
  );
  // A different seed value scopes different ids, so new data is not skipped as already loaded.
  const other = generateSeed(APP, { n: 3, seed: 'other-app' });
  assert.notDeepEqual(
    other.tables.map((table) => table.rows.map((row) => row.id)),
    seed.tables.map((table) => table.rows.map((row) => row.id)),
  );
});

const SYNTHETIC = {
  app_name: 'tiny',
  forms: {
    Author: [{ Name: 'Ada' }, { Name: 'Lin' }],
    Book: [
      { Title: 'T1', Author: { $ref: 'Author', key: 'Name', index: 0 }, Published: '$today+1' },
      { Title: 'T2', Author: { $ref: 'Author', key: 'Name', index: 1 }, Published: '$today+3' },
    ],
  },
};

test('convertSyntheticSeed resolves $ref to the parent stable source id and $today against the pinned day', () => {
  const converted = convertSyntheticSeed(SYNTHETIC, { today: '2026-01-15' });
  assert.deepEqual(Object.keys(converted), ['Author', 'Book']);
  assert.deepEqual(
    converted.Author.map((row) => row.c2c_source_id),
    ['Author#1', 'Author#2'],
  );
  assert.equal(converted.Book[0].Author, 'Author#1');
  assert.equal(converted.Book[1].Author, 'Author#2');
  assert.equal(converted.Book[0].Published, '2026-01-16');
  assert.equal(converted.Book[1].Published, '2026-01-18');
});

test('convertSyntheticSeed flattens grids to Form__Field child tables with parent linkage', () => {
  const converted = convertSyntheticSeed(
    {
      app_name: 'tiny',
      forms: {
        Product: [{ SKU: 'P01' }, { SKU: 'P02' }],
        Order: [
          {
            Title: 'O1',
            Lines: [
              { Product: { $ref: 'Product', key: 'SKU', index: 0 }, Qty: 2 },
              { Product: { $ref: 'Product', key: 'SKU', index: 1 }, Qty: 1 },
            ],
          },
        ],
      },
    },
    { today: '2026-01-15' },
  );
  assert.deepEqual(converted.Order, [{ c2c_source_id: 'Order#1', Title: 'O1' }]);
  assert.deepEqual(converted.Order__Lines, [
    { c2c_source_id: 'Order__Lines#1#1', parent_id: 'Order#1', row_order: '0', Product: 'Product#1', Qty: 2 },
    { c2c_source_id: 'Order__Lines#1#2', parent_id: 'Order#1', row_order: '1', Product: 'Product#2', Qty: 1 },
  ]);
});

test('convertSyntheticSeed flattens nested subforms and resolves their lookups to large-form targets', () => {
  const converted = convertSyntheticSeed({
    app_name: 'nested',
    forms: {
      Catalog: Array.from({ length: 1200 }, (_, index) => ({ SKU: `S${index}` })),
      Order: [{ Lines: [
        { Product: { $ref: 'Catalog', key: 'SKU', index: 1199 }, Adjustments: [{ Amount: 3 }, { Amount: 1 }] },
        { Product: { $ref: 'Catalog', key: 'SKU', index: 0 }, Adjustments: [{ Amount: -2 }] },
      ] }, { Lines: [{ Product: { $ref: 'Catalog', key: 'SKU', index: 5 }, Adjustments: [] }] }],
    },
  }, { today: '2026-01-15', now: '2026-01-15 00:00:00' });
  assert.equal(converted.Order__Lines?.[0]?.Product, 'Catalog#1200');
  assert.deepEqual(converted.Order__Lines?.map((row) => row.row_order), ['0', '1', '0']);
  assert.deepEqual(converted.Order__Lines__Adjustments?.map((row) => [row.parent_id, row.row_order, row.Amount]), [
    ['Order__Lines#1#1', '0', 3],
    ['Order__Lines#1#1', '1', 1],
    ['Order__Lines#1#2', '0', -2],
  ]);
  assert.equal(converted.Order__Lines?.[2]?.parent_id, 'Order#2');
  const reduced = convertSyntheticSeed({ app_name: 'nested', forms: {
    Catalog: [{ SKU: 'S0' }],
    Order: [{ Lines: [{ Product: { $ref: 'Catalog', key: 'SKU', index: 0 }, Adjustments: [{ Amount: 1 }] }] }],
  } }, { today: '2026-01-15' });
  assert.equal(reduced.Order__Lines?.length, 1, 'removed parent subform row is absent on regeneration');
  assert.deepEqual(reduced.Order__Lines__Adjustments?.map((row) => [row.parent_id, row.row_order]), [['Order__Lines#1#1', '0']]);
});

test('convertSyntheticSeed identifies orphan references with the exact source row id', () => {
  assert.throws(
    () => convertSyntheticSeed({ app_name: 'orphan', forms: {
      Parent: [{ Name: 'exists' }],
      Order: [{ Lines: [{ Parent: { $ref: 'Parent', key: 'Name', index: 4 } }] }],
    } }, { today: '2026-01-15' }),
    /Order\.Lines\.Parent row Order__Lines#1#1 index 4 is out of range/,
  );
});

test('convertSyntheticSeed refuses flattened-table collisions instead of merging rows', () => {
  assert.throws(
    () => convertSyntheticSeed({ app_name: 'collision', forms: {
      Order: [{ Lines: [{ Qty: 1 }] }],
      Order__Lines: [{ Qty: 99 }],
    } }, { today: '2026-01-15' }),
    /Order__Lines.*collides with another table/,
  );
});

test('convertSyntheticSeed explodes multi-lookup arrays to Form__Field junction rows', () => {
  const converted = convertSyntheticSeed(
    {
      app_name: 'tiny',
      forms: {
        Candidate: [{ Candidate_Email: 'a@example.com' }, { Candidate_Email: 'b@example.com' }],
        Job_Opening: [
          {
            Title: 'J1',
            Shortlisted: [
              { $ref: 'Candidate', key: 'Candidate_Email', index: 0 },
              { $ref: 'Candidate', key: 'Candidate_Email', index: 1 },
            ],
          },
        ],
      },
    },
    { today: '2026-01-15' },
  );
  assert.deepEqual(converted.Job_Opening, [{ c2c_source_id: 'Job_Opening#1', Title: 'J1' }]);
  assert.deepEqual(converted.Job_Opening__Shortlisted, [
    { c2c_source_id: 'Job_Opening__Shortlisted#1#1', parent_id: 'Job_Opening#1', row_order: '0', Shortlisted: 'Candidate#1' },
    { c2c_source_id: 'Job_Opening__Shortlisted#1#2', parent_id: 'Job_Opening#1', row_order: '1', Shortlisted: 'Candidate#2' },
  ]);
});

test('convertSyntheticSeed refuses unknown forms, out-of-range indexes, and $user without a login user', () => {
  assert.throws(
    () =>
      convertSyntheticSeed({ app_name: 'tiny', forms: { Book: [{ Author: { $ref: 'Nope', key: 'Name', index: 0 } }] } }, {
        today: '2026-01-15',
      }),
    /unknown form Nope/,
  );
  assert.throws(
    () => convertSyntheticSeed(SYNTHETIC, { today: '2026-01-15' }) && convertSyntheticSeed({
      app_name: 'tiny',
      forms: { Author: [{ Name: 'Ada' }], Book: [{ Author: { $ref: 'Author', key: 'Name', index: 7 } }] },
    }, { today: '2026-01-15' }),
    /out of range/,
  );
  assert.throws(
    () =>
      convertSyntheticSeed({ app_name: 'tiny', forms: { T: [{ Owner: '$user:login' }] } }, { today: '2026-01-15' }),
    /\$user:login/,
  );
  const withUser = convertSyntheticSeed({ app_name: 'tiny', forms: { T: [{ Owner: '$user:login' }] } }, {
    today: '2026-01-15',
    loginUser: 'tester@example.com',
  });
  assert.equal(withUser.T[0].Owner, 'tester@example.com');
});
