import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { emptyCheckpoint, type FetchLike, type MigrateResponse } from '../../data/src/migrate.js';
import { migrateCsv as migrateCsvReal, readSourceCsv, resolveForeignKeys, assertSeedReferences } from '../src/index.js';
import { rowEndpoint } from '../../data/test/catalyst-row-fake.js';
import { updateDeferredForeignKeys } from '../src/remap.js';

const migrateCsv: typeof migrateCsvReal = (opts) => migrateCsvReal({ ...opts, fetch: rowEndpoint(opts.fetch) });

const SCOPE = { org: '10000000000', projectId: '1001', token: 'test-cli-token' };

const DS = `application "Widget"
{
	form Author
	{
		Name
		(
			type = text
		)
	}
	form Tag
	{
		Label
		(
			type = text
		)
	}
	form Book
	{
		must have Author
		(
			type = picklist
			values = Author.Name
		)
		Tags
		(
			type = list
			values = Tag.ID
		)
		Colors
		(
			type = list
			values = {"red","blue"}
		)
	}
	form Order
	{
		Title
		(
			type = text
		)
		Lines
		(
			type = grid
			Book
			(
				type = picklist
				values = Book.ID
			)
			Qty
			(
				type = number
			)
		)
	}
}
`;

interface StoredRow {
  rowid: string;
  columns: Record<string, string>;
}

function response(body: unknown, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function writeDataset(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-remap-'));
  writeFileSync(join(dir, 'Author.csv'), 'ID,Name\n10000000008009043,Ada\n11,Lin\n');
  writeFileSync(join(dir, 'Tag.csv'), 'ID,Label\n20,alpha\n21,beta\n');
  writeFileSync(join(dir, 'Book.csv'), 'ID,Author,Tags,Colors\n30,10000000008009043,"20,21","red, blue"\n31,11,20,red\n');
  writeFileSync(join(dir, 'Order.csv'), 'ID,Title\n40,Batch\n');
  writeFileSync(join(dir, 'Order__Lines.csv'), 'ID,Parent_ID,Book,Qty\n50,40,30,2\n51,40,31,1\n');
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Author: 2, Tag: 2, Book: 2, Order: 1 }));
  return dir;
}

function storeFetch(opts: { drop: ReadonlySet<string> }): {
  fetch: FetchLike;
  stored: Map<string, Map<string, StoredRow>>;
} {
  const stored = new Map<string, Map<string, StoredRow>>();
  let seq = 1;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('csv migrate called Creator');
    const path = new URL(url).pathname;
    assert.match(path, /\/baas\/v1\/project\/1001\//);
    assert.equal(init?.headers?.['CATALYST-ORG'], SCOPE.org);
    assert.equal(init?.headers?.Authorization, `Bearer ${SCOPE.token}`);
    if (path.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
      const rows = stored.get(table) ?? new Map<string, StoredRow>();
      if (/COUNT\(/i.test(sql)) return response({ data: [{ 'COUNT(ROWID)': String(rows.size) }] });
      if (/^SELECT ROWID, c2c_source_id FROM /i.test(sql)) {
        return response({ data: [...rows].map(([source, row]) => ({ c2c_source_id: source, ROWID: row.rowid })) });
      }
      return response({ data: [...rows].map(([source, row]) => ({ ...row.columns, c2c_source_id: source, ROWID: row.rowid })) });
    }
    const table = decodeURIComponent(path.split('/').at(-2) ?? '');
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, string> }[] };
    if (!opts.drop.has(table)) {
      const bucket = stored.get(table) ?? new Map<string, StoredRow>();
      for (const row of body.rows) {
        bucket.set(row.columns.c2c_source_id, { rowid: `r${seq++}`, columns: { ...row.columns } });
      }
      stored.set(table, bucket);
    }
    return response({ ids: body.rows.map((row) => row.id) });
  };
  return { fetch, stored };
}

test('lookup, subform, and multi-select references are new ROWIDs and a dropped child or junction fails', async () => {
  const app = deriveIr(parse(DS));
  const dir = writeDataset();
  const loaded = readSourceCsv(dir, app);
  const keys = loaded.foreignKeys;
  const kept = storeFetch({ drop: new Set() });
  const migrated = await migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: kept.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(migrated.ok, true);
  const rowids = new Map<string, Set<string>>();
  for (const [table, rows] of kept.stored) {
    rowids.set(table, new Set([...rows.values()].map((row) => row.rowid)));
  }
  const sourceIds = new Set<string>();
  for (const table of loaded.tables) for (const row of table.rows) sourceIds.add(row.id);
  for (const key of keys) {
    const rows = kept.stored.get(key.table);
    assert.ok(rows, key.table);
    for (const row of rows!.values()) {
      const value = row.columns[key.column];
      if (!value) continue;
      assert.equal(sourceIds.has(value), false, `${key.table}.${key.column} still holds source id ${value}`);
      assert.ok(rowids.get(key.parent)?.has(value), `${key.table}.${key.column} ${value} is not a ROWID in ${key.parent}`);
    }
  }
  const book = [...kept.stored.get('Book')!.values()].find((row) => row.columns.c2c_source_id === '30');
  assert.equal(book?.columns.Colors, '["red","blue"]');
  assert.equal(book?.columns.Author, kept.stored.get('Author')!.get('10000000008009043')!.rowid);
  const links = [...kept.stored.get('Book__Tags')!.values()].filter((row) => row.columns.parent_id === book!.rowid);
  assert.deepEqual(
    links.map((row) => row.columns.Tags).sort(),
    [kept.stored.get('Tag')!.get('20')!.rowid, kept.stored.get('Tag')!.get('21')!.rowid].sort(),
  );
  const line = kept.stored.get('Order__Lines')!.get('50')!;
  assert.equal(line.columns.parent_id, kept.stored.get('Order')!.get('40')!.rowid);
  assert.equal(line.columns.Book, book!.rowid);
  assert.equal([...rowids.get('Author')!].some((id) => id === '10000000008009043'), false);

  const dropped = storeFetch({ drop: new Set(['Order__Lines', 'Book__Tags']) });
  const lost = await migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: dropped.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(lost.ok, false);
  for (const table of ['Order__Lines', 'Book__Tags']) {
    const count = lost.counts.find((item) => item.table === table);
    assert.ok(count, table);
    assert.equal(count?.catalyst, 0, table);
    assert.equal(count?.mismatch, true, table);
  }
  assert.equal(lost.counts.find((item) => item.form === 'Book')?.mismatch, false);
});

// A filtered multi lookup carried as a plain column holds a JSON list of
// source ids: every element resolves to a parent ROWID, and one that does
// not resolve refuses the write.
test('a multi lookup stored as a JSON id list remaps every element', () => {
  const keys = [{ table: 'Add_User', column: 'Owned_Vehicles', parent: 'Add_Vehicle' }];
  const seed = [
    { table: 'Add_Vehicle', rows: [{ id: 'v1', columns: {} }, { id: 'v2', columns: {} }] },
    { table: 'Add_User', rows: [{ id: 'u1', columns: { Owned_Vehicles: '["v1","v2"]' } }] },
  ];
  assertSeedReferences(seed, keys);
  const rowIds = new Map([['Add_Vehicle', new Map([['v1', '9000001'], ['v2', '9000002']])]]);
  const resolved = resolveForeignKeys(seed[1]!, keys, rowIds);
  assert.equal(resolved.rows[0]!.columns.Owned_Vehicles, '["9000001","9000002"]');
  const bad = [{ table: 'Add_User', rows: [{ id: 'u1', columns: { Owned_Vehicles: '["v1","v9"]' } }] }];
  assert.throws(
    () => assertSeedReferences([seed[0]!, ...bad], keys),
    /lookup Add_User\.Owned_Vehicles row u1 source id v9 is not in Add_Vehicle/,
  );
  assert.throws(
    () => resolveForeignKeys(bad[0]!, keys, rowIds),
    /lookup Owned_Vehicles row u1 source id v9 is not in Add_Vehicle/,
  );
});

test('deferred lookup reruns fail closed when comparison reads throw or are partial', async () => {
  const table = { table: 'Book', rows: [{ id: 'book-1', columns: { Author: 'author-1' } }, { id: 'book-2', columns: { Author: 'author-1' } }] };
  const keys = [{ table: 'Book', column: 'Author', parent: 'Author' }];
  const run = async (queryBody: unknown, putBodies: unknown[] = [], throwRead = false) => updateDeferredForeignKeys(
    { dc: 'us', catalystBase: 'https://catalyst.zoho.com', scope: SCOPE, fetch: async (_url, init) => {
      if (init?.method === 'PUT') { putBodies.push(JSON.parse(String(init.body))); return response({}, 200); }
      if (throwRead) throw new Error('read unavailable');
      return response(queryBody);
    } },
    [table], keys, new Set(['Book\0Author']),
    new Map([['Book', new Map([['book-1', '101'], ['book-2', '102']])], ['Author', new Map([['author-1', '201']])]]),
  );
  const thrown = await run([], [], true);
  assert.equal(thrown[0]?.error, 'not re-run: could not read current values (read unavailable); next step: re-run when the read works');
  const partialPuts: unknown[] = [];
  const partial = await run([{ ROWID: '101', Author: '201' }], partialPuts);
  assert.match(partial[0]?.error ?? '', /not re-run: could not read current values/);
  assert.deepEqual(partialPuts, []);
  const puts: unknown[] = [];
  const complete = await run([{ ROWID: '101', Author: '201' }, { ROWID: '102', Author: '999' }], puts);
  assert.equal(complete[0]?.updated, 2);
  assert.deepEqual(puts, [[{ ROWID: '102', Author: '201' }]]);
});
