/**
 * Golden: ids past 2^53 stay exact end to end.
 * CREATOR is a 19-digit Creator record id; the fake SDK hands out 17-digit
 * Catalyst ROWIDs (10000000000000001…). Number() rounds both.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { emptyCheckpoint, type FetchLike, type MigrateResponse } from '../../data/src/migrate.js';
import { translate } from '../../deluge/src/translate.js';
import { toLong, toMap } from '../../shims/src/convert.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { send, type ZohoConnectionsConfig } from '../../shims/src/zoho-adapters.js';
import { migrateCsv as migrateCsvReal } from '../src/index.js';
import { rowEndpoint } from '../../data/test/catalyst-row-fake.js';

const migrateCsv: typeof migrateCsvReal = (opts) => migrateCsvReal({ ...opts, fetch: rowEndpoint(opts.fetch) });
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
const CREATOR = '1000000000000000001';
const CREATOR_2 = '1000000000000000002';
const ROWID_17 = '10000000000315013';

test('the ids used here are rounded by Number()', () => {
  assert.notEqual(String(Number(CREATOR)), CREATOR);
  assert.equal(Number(CREATOR), Number(CREATOR_2));
  assert.notEqual(String(Number(ROWID_17)), ROWID_17);
});

interface FakeSdk {
  initialize(req: unknown, opts: { scope: string }): unknown;
  state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
}

async function liveRuntime() {
  const req = createRequire(import.meta.url);
  const sdk = req(fake) as FakeSdk;
  const { createSdkDatastore } = (await import(pathToFileURL(join(root, 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href)) as {
    createSdkDatastore(app: unknown, opts?: { columns?: (form: string) => string[] }): NonNullable<Parameters<typeof createRuntime>[0]>['datastore'];
  };
  const app = sdk.initialize({}, { scope: 'admin' });
  const columns = (form: string): string[] => Object.keys(sdk.state().tables[form]?.[0] ?? { ROWID: '0' });
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'Asia/Kolkata', datastore: createSdkDatastore(app, { columns }) });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = async (script: string, record: Record<string, unknown> = {}): Promise<unknown> => {
    const translated = translate(script);
    const fn = new AsyncFunction('shim', 'ctx', `${translated.server}\nreturn typeof golden === 'undefined' ? undefined : golden;`);
    return fn(runtime.shim, runtime.context({ record }));
  };
  return { sdk, run };
}

/** A fresh table holding three rows whose Author ids were written as text (exact on every build). */
async function seeded(table: string) {
  const live = await liveRuntime();
  await live.run(`insert into ${table} [ Title = "a" Author = input.A ];`, { A: CREATOR });
  await live.run(`insert into ${table} [ Title = "b" Author = input.A ];`, { A: CREATOR_2 });
  await live.run(`insert into ${table} [ Title = "c" Author = input.A ];`, { A: CREATOR });
  const rows = () => live.sdk.state().tables[table] ?? [];
  return { ...live, rows, rowids: rows().map((row) => String(row.ROWID)) };
}

test('insert: a 19-digit literal id is stored exactly', async () => {
  const { sdk, run } = await liveRuntime();
  await run(`insert into BigInsLit [ Title = "lit" Author = ${CREATOR} ];`);
  assert.deepEqual((sdk.state().tables.BigInsLit ?? []).map((row) => row.Author), [CREATOR]);
});

test('insert: a toLong id (bigint) is stored exactly and does not break the SDK JSON body', async () => {
  const { sdk, run } = await liveRuntime();
  await run('insert into BigInsLong [ Title = "long" Author = input.A.toLong() ];', { A: CREATOR_2 });
  assert.deepEqual((sdk.state().tables.BigInsLong ?? []).map((row) => row.Author), [CREATOR_2]);
});

test('fetch and single lookup by a 19-digit id (literal, toLong, text) and by a 17-digit ROWID', async () => {
  const { run, rowids } = await seeded('BigFetch');
  assert.match(rowids[1]!, /^\d{17}$/);
  assert.deepEqual(await run('golden = BigFetch[Author == input.A].Title.getAll();', { A: CREATOR_2 }), ['b']);
  assert.deepEqual(await run('golden = BigFetch[ROWID == input.R].Title.getAll();', { R: rowids[1] }), ['b']);
  assert.equal(await run('r = BigFetch[Title == "b"];\ngolden = r.Author;'), CREATOR_2);
  assert.equal(await run('r = BigFetch[Title == "b"];\ngolden = r.ROWID;'), rowids[1]);
  assert.deepEqual(await run('golden = BigFetch[Author == input.A.toLong()].Title.getAll();', { A: CREATOR_2 }), ['b']);
  assert.deepEqual(await run(`golden = BigFetch[Author == ${CREATOR}].Title.getAll();`), ['a', 'c']);
});

test('multi lookup: Author in a list of 19-digit ids', async () => {
  const { run } = await seeded('BigMulti');
  assert.deepEqual(await run('golden = BigMulti[Author in input.L].Title.getAll();', { L: [CREATOR_2] }), ['b']);
  assert.deepEqual(await run(`golden = BigMulti[Author in {${CREATOR_2}, 1}].Title.getAll();`), ['b']);
});

test('update by ROWID text and by a 19-digit literal id', async () => {
  const { run, rows, rowids } = await seeded('BigUpd');
  await run('r = BigUpd[ROWID == input.R];\nr.Title = "b2";', { R: rowids[1] });
  assert.deepEqual(rows().map((row) => row.Title), ['a', 'b2', 'c']);
  await run(`r = BigUpd[Author == ${CREATOR_2}];\nr.Title = "b3";`);
  assert.deepEqual(rows().map((row) => row.Title), ['a', 'b3', 'c']);
});

test('delete by ROWID text and by a 19-digit literal id', async () => {
  const { run, rows, rowids } = await seeded('BigDel');
  await run('delete from BigDel[ROWID == input.R];', { R: rowids[0] });
  assert.deepEqual(rows().map((row) => row.Title), ['b', 'c']);
  await run(`delete from BigDel[Author == ${CREATOR_2}];`);
  assert.deepEqual(rows().map((row) => row.Title), ['c']);
});

test('compare ==, != and in-a-list are exact across text, toLong and literal ids', async () => {
  const { run } = await liveRuntime();
  const record = { A: CREATOR, B: CREATOR_2 };
  assert.equal(await run(`golden = input.A.toLong() == ${CREATOR};`, record), true);
  assert.equal(await run(`golden = input.A.toLong() == ${CREATOR_2};`, record), false);
  assert.equal(await run(`golden = input.A == ${CREATOR_2};`, record), false);
  assert.equal(await run('golden = input.A.toLong() != input.B.toLong();', record), true);
  assert.equal(await run('golden = input.A.toLong() == input.A;', record), true);
  assert.equal(await run(`ids = {"${CREATOR}"};\ngolden = input.A.toLong() in ids;`, record), true);
  assert.equal(await run(`ids = {"${CREATOR}"};\ngolden = input.B.toLong() in ids;`, record), false);
  assert.equal(await run(`ids = {${CREATOR}};\ngolden = ids.contains(input.A);`, record), true);
  assert.equal(await run(`ids = {${CREATOR}};\ngolden = ids.contains(input.B);`, record), false);
});

test('a map keyed by id round-trips, and toMap keeps ids in JSON and Deluge map text', async () => {
  const { run } = await liveRuntime();
  const got = (await run(
    'm = Map();\nm.put(input.A, "x");\nm.put(input.B.toLong(), "y");\ngolden = {"a": m.get(input.A.toLong()), "b": m.get(input.B), "keys": m.keys()};',
    { A: CREATOR, B: CREATOR_2 },
  )) as Record<string, unknown>;
  assert.deepEqual(got, { a: 'x', b: 'y', keys: [CREATOR, CREATOR_2] });
  assert.equal(String(toMap(`{"ID": ${CREATOR}, "n": 2}`).ID), CREATOR);
  assert.equal(toMap(`{"ID": ${CREATOR}, "n": 2}`).n, 2);
  assert.equal(String(toMap(`{ID: ${CREATOR}}`).ID), CREATOR);
});

test('toLong on an id is exact (Deluge NUMBER is a 64-bit long)', () => {
  assert.equal(String(toLong(CREATOR)), CREATOR);
  assert.equal(String(toLong(ROWID_17)), ROWID_17);
  assert.equal(String(toLong(`-${CREATOR}`)), `-${CREATOR}`);
  assert.equal(toLong('42'), 42);
  assert.throws(() => toLong(Number(CREATOR)), /2\^53/);
});

test('a Zoho REST reply (zoho.creator.*) keeps a bare 19-digit ID', async () => {
  const raw = `{"code":3000,"data":{"ID":${CREATOR},"Lookup":{"ID":${CREATOR_2},"display_value":"x"},"Qty":2,"Rate":1.5}}`;
  const config: ZohoConnectionsConfig = { fetch: (async () => ({ status: 200, text: async () => raw })) as unknown as ZohoConnectionsConfig['fetch'] };
  const reply = await send(config, { method: 'POST', url: 'https://www.zohoapis.in/creator/v2.1/data/o/a/form/F', headers: {} }, 'tok');
  const body = reply.body as { code: number; data: { ID: unknown; Lookup: { ID: unknown }; Qty: unknown; Rate: unknown } };
  assert.equal(String(body.data.ID), CREATOR);
  assert.equal(String(body.data.Lookup.ID), CREATOR_2);
  assert.equal(body.code, 3000);
  assert.equal(body.data.Qty, 2);
  assert.equal(body.data.Rate, 1.5);
});

test('the c2c_api entry reads a bare 19-digit id in a request body exactly', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-bigint-fn-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const dir = join(out, 'fn');
  const req = createRequire(import.meta.url);
  const sdk = req(fake) as { setSession(token: string, user: unknown): void };
  sdk.setSession('t1', { user_id: '1', role_details: { role_name: 'App Administrator' } });
  const { cpSync } = await import('node:fs');
  cpSync(join(root, 'packages/deploy/fn'), dir, { recursive: true });
  writeFileSync(join(dir, 'catalyst-config.json'), JSON.stringify({ deployment: { name: 'c2c_api' } }));
  writeFileSync(join(dir, 'routes.json'), JSON.stringify({ 'POST /echo': 'echo.mjs' }));
  writeFileSync(join(dir, 'c2c-columns.json'), '{}');
  writeFileSync(join(dir, 'principal-map.json'), JSON.stringify({ roles: { 'App Administrator': 'Administrator' } }));
  writeFileSync(join(dir, 'access-policy.json'), JSON.stringify({ profiles: { Administrator: {} } }));
  writeFileSync(join(dir, 'c2c-principal.mjs'), 'export async function resolvePrincipal() { return { profile: "Administrator", userId: "1" }; }\n');
  writeFileSync(join(dir, 'c2c-store.mjs'), 'export async function runWithDatastore(_d, fn) { return fn(); }\n');
  writeFileSync(
    join(dir, 'echo.mjs'),
    'export default (call, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: call.body.id, type: typeof call.body.id })); };\n',
  );
  const entry = req(join(dir, 'index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
  const server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=t1' },
      body: `{"id": ${CREATOR}}`,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), `{"id":"${CREATOR}","type":"string"}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    moduleAny._resolveFilename = original;
    rmSync(out, { recursive: true, force: true });
  }
});

const DS = `application "BigIds"
{
	form Author
	{
		Name
		(
			type = text
		)
	}
	form Book
	{
		Title
		(
			type = text
		)
		must have Author
		(
			type = picklist
			values = Author.Name
		)
		Co_Authors
		(
			type = list
			values = Author.ID
		)
	}
}
`;

function rawResponse(raw: string, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => raw };
}

test('CSV round-trip: 19-digit source ids stay exact and every FK is rewritten to its 17-digit ROWID', async () => {
  const app = deriveIr(parse(DS));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-bigint-csv-'));
  writeFileSync(join(dir, 'Author.csv'), `ID,Name\n${CREATOR},Ada\n${CREATOR_2},Lin\n`);
  writeFileSync(join(dir, 'Book.csv'), `ID,Title,Author,Co_Authors\n1000000000000000000,B1,${CREATOR_2},"${CREATOR},${CREATOR_2}"\n`);
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Author: 2, Book: 1 }));
  // Stored rows by table → source id → { rowid, columns }. ROWIDs are 17 digits and
  // every reply writes them as bare JSON numbers, the shape that rounds under JSON.parse.
  const stored = new Map<string, Map<string, { rowid: string; columns: Record<string, string> }>>();
  let next = BigInt(ROWID_17);
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if ((init?.method ?? 'GET') === 'GET') throw new Error('csv migrate called Creator');
    if (path.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
      const rows = stored.get(table) ?? new Map();
      if (/COUNT\(/i.test(sql)) return rawResponse(`{"data":[{"COUNT(ROWID)":${rows.size}}]}`);
      const items = [...rows].map(([source, row]) => {
        if (/^SELECT ROWID, c2c_source_id FROM /i.test(sql)) return `{"c2c_source_id":"${source}","ROWID":${row.rowid}}`;
        const cols = Object.entries(row.columns)
          .filter(([key]) => key !== 'c2c_source_id')
          .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
          .join(',');
        return `{"c2c_source_id":"${source}",${cols}}`;
      });
      return rawResponse(`{"data":[${items.join(',')}]}`);
    }
    const table = decodeURIComponent(path.split('/').at(-2) ?? '');
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, string> }[] };
    const bucket = stored.get(table) ?? new Map();
    for (const row of body.rows) {
      next += 1n;
      bucket.set(row.columns.c2c_source_id, { rowid: String(next), columns: { ...row.columns } });
    }
    stored.set(table, bucket);
    return rawResponse(`{"ids":[${body.rows.map((row) => `"${row.id}"`).join(',')}]}`);
  };
  try {
    const result = await migrateCsv({
      app,
      dir,
      dc: 'in',
      catalystBase: 'https://api.catalyst.zoho.in',
      fetch,
      checkpoint: emptyCheckpoint(),
      scope: { org: '10000000000', projectId: '1001', token: 'test-cli-token' },
    });
    assert.equal(result.ok, true, JSON.stringify(result.counts));
    const authors = stored.get('Author')!;
    assert.deepEqual([...authors.keys()], [CREATOR, CREATOR_2]);
    const book = [...stored.get('Book')!.values()][0]!;
    assert.equal(book.columns.c2c_source_id, '1000000000000000000');
    assert.equal(book.columns.Author, authors.get(CREATOR_2)!.rowid);
    const links = [...stored.get('Book__Co_Authors')!.values()].map((row) => row.columns.Co_Authors).sort();
    assert.deepEqual(links, [authors.get(CREATOR)!.rowid, authors.get(CREATOR_2)!.rowid].sort());
    for (const id of [book.columns.Author, ...links]) assert.match(String(id), /^10000000000315\d{3}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('insert: a bigint nested in a map or list is stored as digits and the SDK JSON body does not throw', async () => {
  const { sdk, run } = await liveRuntime();
  await run('insert into BigInsNested [ Title = "n" Meta = {"id": input.A.toLong(), "ids": {input.B.toLong()}} ];', { A: CREATOR, B: CREATOR_2 });
  const rows = sdk.state().tables.BigInsNested ?? [];
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(String(rows[0]!.Meta)), { id: CREATOR, ids: [CREATOR_2] });
});

test('the SDK adapter (storedRow) writes a nested bigint as digits on insert and update', async () => {
  const sdk = createRequire(import.meta.url)(fake) as FakeSdk;
  const { createSdkDatastore } = (await import(pathToFileURL(join(root, 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href)) as {
    createSdkDatastore(app: unknown): {
      insert(form: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
      update(form: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
    };
  };
  const ds = createSdkDatastore(sdk.initialize({}, { scope: 'admin' }));
  const [row] = await ds.insert('BigAdapterNested', [{ Meta: { id: BigInt(CREATOR) }, Ids: [BigInt(CREATOR_2)] }]);
  await ds.update('BigAdapterNested', [{ ROWID: BigInt(String(row!.ROWID)), Sub: [{ Author: BigInt(CREATOR_2) }] }]);
  const stored = sdk.state().tables.BigAdapterNested ?? [];
  assert.deepEqual(JSON.parse(String(stored[0]!.Meta)), { id: CREATOR });
  assert.deepEqual(JSON.parse(String(stored[0]!.Ids)), [CREATOR_2]);
  assert.deepEqual(JSON.parse(String(stored[0]!.Sub)), [{ Author: CREATOR_2 }]);
});

test('update: a bigint nested in a map is stored as digits', async () => {
  const { run, rows, rowids } = await seeded('BigUpdNested');
  await run('r = BigUpdNested[ROWID == input.R];\nr.Meta = {"id": input.A.toLong()};', { R: rowids[1], A: CREATOR_2 });
  assert.deepEqual(JSON.parse(String(rows()[1]!.Meta)), { id: CREATOR_2 });
});

const SUBMIT_DS = `application "BigSubmit"
{
	time zone = "Asia/Kolkata"
	share_settings
	{
		"Administrator"
		{
			name = "Administrator"
			type = Users_Permissions
			description = "This profile will have all the permissions."
		}
	}
	forms
	{
		form Book
		{
			Title
			(
				type = text
			)
			Author_Ref
			(
				type = text
			)
			Author_Long
			(
				type = text
			)
			Copy_Long
			(
				type = text
			)
		}
	}
	workflow
	{
		form
		{
			Book_Validate as "Book Validate"
			{
				type = form
				form = Book
				record event = on add
				on validate
				{
					actions
					{
						custom deluge script
						(
							input.Author_Long = input.Author_Ref.toLong();
						)
					}
				}
			}
			Book_Success as "Book Success"
			{
				type = form
				form = Book
				record event = on add
				on success
				{
					actions
					{
						custom deluge script
						(
							input.Copy_Long = input.Author_Ref.toLong();
						)
					}
				}
			}
		}
	}
}
`;

test('a generated on-success handler whose scripts set input.X = input.A.toLong() replies 200 with digit text after the live write', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-bigint-submit-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const app = deriveIr(parse(SUBMIT_DS));
  const fixtureRegistry: ProjectRegistry = { org: '10000000000', env: 'Development', projects: {}, dc: 'in' };
  const guard: GuardOk = { org: '10000000000', projectId: '1001', environment: ALLOWED_ENV, projectName: catalystProjectName(app.name || 'app'), dc: 'in', registry: fixtureRegistry };
  writeDeployTree(out, deployFiles(app, guard, false, { mode: 'live' }).files);
  const req = createRequire(import.meta.url);
  const sdk = req(fake) as FakeSdk & { setSession(token: string, user: unknown): void };
  sdk.setSession('t1', { user_id: '1', role_details: { role_name: 'App Administrator' } });
  const entry = req(join(out, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
  const server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api/forms/Book/success`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=t1' },
      body: JSON.stringify({ record: { Title: 'b', Author_Ref: CREATOR } }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    assert.deepEqual((sdk.state().tables.Book ?? []).map((row) => row.Author_Long), [CREATOR], 'the row was written');
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text) as { wrote: boolean; values: Record<string, unknown> };
    assert.equal(body.wrote, true);
    assert.equal(body.values.Author_Long, CREATOR);
    assert.equal(body.values.Copy_Long, CREATOR);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    moduleAny._resolveFilename = original;
    rmSync(out, { recursive: true, force: true });
  }
});

test('every generated res.end serialises with the shims jsonReplacer', () => {
  for (const file of ['packages/deluge/src/generate.ts', 'packages/ui/src/generate.ts']) {
    const source = readFileSync(join(root, file), 'utf8');
    const ends = source.match(/res\.end\(JSON\.stringify\([^\n]*/g) ?? [];
    assert.ok(ends.length > 0, file);
    for (const line of ends) assert.match(line, /, jsonReplacer\)\);/, `${file}: ${line}`);
  }
});
