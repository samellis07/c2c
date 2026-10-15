/**
 * The deployable functions/c2c_api tree, its zcatalyst-sdk datastore adapter (mock SDK),
 * the principal model, and the Advanced I/O entry loaded as Catalyst loads it.
 * Offline: the SDK is tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs or an inline mock.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse, parseProject, type App } from '../../core/src/index.js';
import { generateUi } from '../../ui/src/generate.js';
import { decimal } from '../../shims/src/decimal.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';
import { deployFiles, writeDeployTree, type DeployFile } from '../src/plan.js';
import { appOrigins, FUNCTION_DEPENDENCIES, computeShimModules, functionDir, injectSelectColumnCap, rewriteShimsImport, routeTable, vendoredShims } from '../src/function-dir.js';
import { CATALYST_LIMITS, limitValue } from '../../schema/src/limits.js';
import { bundleDigest, DEPLOY_REPORT, deployCli, functionBaseFrom, STATE_FILE, type Io, type SpawnResult } from '../src/cli.js';

const root = repoRoot();
const fnAssets = join(root, 'packages/deploy/fn');

interface Adapter {
  insert(form: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
  update(form: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
  delete(form: string, ids: unknown[]): Promise<unknown[]>;
  query(form: string, where: string, limit: number, offset?: number, orderBy?: string, columns?: string | string[]): Promise<Record<string, unknown>[]>;
}
interface AdapterModule {
  createSdkDatastore(app: unknown, opts?: Record<string, unknown>): Adapter;
  zcqlSelect(form: string, where: string, limit: number, offset: number, orderBy?: string, columns?: string | string[], after?: string): string;
  withBackoff<T>(fn: () => Promise<T>, opts?: Record<string, unknown>): Promise<T>;
  retryAfterMs(err: unknown, nowMs?: number): number;
  RETRY: { maxRetries: number; baseDelayMs: number; maxDelayMs: number; maxWaitMs: number };
}

async function adapterModule(): Promise<AdapterModule> {
  return (await import(pathToFileURL(join(fnAssets, 'c2c-sdk-datastore.mjs')).href)) as AdapterModule;
}

test('the emitted datastore adapter takes its select cap from zcql.select_columns', () => {
  const cap = limitValue('zcql.select_columns');
  const files = functionDir([], { mode: 'dry-run' });
  const adapter = files.find((file) => file.path === 'functions/c2c_api/c2c-sdk-datastore.mjs');
  assert.ok(adapter, 'the function tree has no datastore adapter');
  const source = String(adapter.data);
  assert.ok(source.includes(`selectColumns: ${cap}`), 'emitted adapter does not carry the schema select cap');
  const literals = [...source.matchAll(/selectColumns: (\d+)/g)].map((match) => match[1]);
  assert.deepEqual(literals, [String(cap)], 'the adapter keeps a divergent select-cap literal');
});

test('every emitted select cap follows zcql.select_columns when the canonical value moves', () => {
  const row = CATALYST_LIMITS.find((limit) => limit.id === 'zcql.select_columns');
  assert.ok(row?.value !== null && row?.value !== undefined, 'zcql.select_columns has no value');
  const original = row.value;
  (row as { value: number }).value = original + 1;
  try {
    const files = functionDir([], { mode: 'dry-run' });
    const adapter = files.find((file) => file.path === 'functions/c2c_api/c2c-sdk-datastore.mjs');
    assert.ok(adapter);
    assert.ok(String(adapter.data).includes(`selectColumns: ${original + 1}`), 'the emitted adapter did not follow the canonical select cap');
  } finally {
    (row as { value: number }).value = original;
  }
});

test('injectSelectColumnCap refuses a source with no selectColumns entry', () => {
  assert.throws(() => injectSelectColumnCap('export const LIMITS = {};'), /no selectColumns entry/);
});

function mockSdk() {
  const calls: [string, string, unknown][] = [];
  let id = 100;
  const app = {
    datastore: () => ({
      table: (name: string) => ({
        insertRows: async (rows: Record<string, unknown>[]) => {
          calls.push(['insertRows', name, rows]);
          return rows.map((row) => ({ ...row, ROWID: String(++id) }));
        },
        updateRows: async (rows: Record<string, unknown>[]) => {
          calls.push(['updateRows', name, rows]);
          return rows;
        },
        deleteRows: async (ids: string[]) => {
          calls.push(['deleteRows', name, ids]);
          return ids.map((rowid) => ({ ROWID: rowid }));
        },
      }),
    }),
    zcql: () => ({
      executeZCQLQuery: async (sql: string) => {
        calls.push(['zcql', 'Item', sql]);
        return [{ Item: { ROWID: '7', Name: 'Ada' } }, { Item: { ROWID: '8', Name: 'Bea' } }];
      },
    }),
  };
  return { app, calls };
}

test('adapter inserts, updates, and deletes in chunks of 200 and keeps ROWIDs', async () => {
  const { createSdkDatastore } = await adapterModule();
  const { app, calls } = mockSdk();
  const ds = createSdkDatastore(app);
  const rows = Array.from({ length: 450 }, (_, i) => ({ Name: `n${i}` }));
  const inserted = await ds.insert('Item', rows);
  assert.deepEqual(calls.map((c) => [c[0], (c[2] as unknown[]).length]), [['insertRows', 200], ['insertRows', 200], ['insertRows', 50]]);
  assert.equal(inserted.length, 450);
  assert.equal(inserted[0]?.ROWID, '101');
  calls.length = 0;
  await ds.update('Item', Array.from({ length: 201 }, (_, i) => ({ ROWID: String(i + 1), Name: 'x' })));
  assert.deepEqual(calls.map((c) => [c[0], (c[2] as unknown[]).length]), [['updateRows', 200], ['updateRows', 1]]);
  await assert.rejects(ds.update('Item', [{ Name: 'no id' }]), /needs a ROWID/);
  calls.length = 0;
  await ds.delete('Item', [1, 2, 3]);
  assert.deepEqual(calls, [['deleteRows', 'Item', ['1', '2', '3']]]);
});

test('adapter writes ISO local datetimes in the Data Store datetime format', async () => {
  const { createSdkDatastore } = await adapterModule();
  const { app, calls } = mockSdk();
  await createSdkDatastore(app).insert('Item', [{ Added_Time: '2026-10-06T15:50:58', Note: '2026-10-06T15:50:58Z', D: '2026-10-06' }]);
  assert.deepEqual(calls[0]?.[2], [{ Added_Time: '2026-10-06 15:50:58', Note: '2026-10-06T15:50:58Z', D: '2026-10-06' }]);
});

test('adapter ZCQL select projects columns, has no WHERE true, clamps to 300 rows, and unwraps rows', async () => {
  const { createSdkDatastore, zcqlSelect } = await adapterModule();
  assert.equal(zcqlSelect('Item', '', 300, 0, '', ['Name']), 'SELECT ROWID, Name FROM Item ORDER BY ROWID LIMIT 1, 300');
  assert.equal(zcqlSelect('Item', 'true', 300, 0, '', 'Name'), 'SELECT ROWID, Name FROM Item ORDER BY ROWID LIMIT 1, 300');
  assert.equal(zcqlSelect('Item', 'TRUE', 300, 0, '', 'Name'), 'SELECT ROWID, Name FROM Item ORDER BY ROWID LIMIT 1, 300');
  assert.equal(zcqlSelect('Item', "Name = 'a'", 999, 600, 'ORDER BY Name DESC, ROWID', 'Name'), "SELECT ROWID, Name FROM Item WHERE Name = 'a' ORDER BY Name DESC, ROWID LIMIT 601, 300");
  assert.equal(zcqlSelect('Item', '', 300, 0, '', 'Name', '42'), 'SELECT ROWID, Name FROM Item WHERE ROWID > 42 ORDER BY ROWID LIMIT 1, 300');
  assert.equal(zcqlSelect('Item', '', 300, 0, 'ORDER BY ROWID DESC', 'Name', '42'), 'SELECT ROWID, Name FROM Item WHERE ROWID < 42 ORDER BY ROWID DESC LIMIT 1, 300');
  assert.throws(() => zcqlSelect('Item', '', 1, 0), /column list/);
  assert.throws(() => zcqlSelect('Item', '', 1, 0, '', ''), /column list/);
  assert.throws(() => zcqlSelect('Item; DROP', '', 1, 0, '', 'Name'), /not a ZCQL table identifier/);
  assert.throws(() => zcqlSelect('Item', '', 1, 0, 'ORDER BY 1; x', 'Name'), /unsupported/);
  const { app, calls } = mockSdk();
  const ds = createSdkDatastore(app);
  assert.deepEqual(await ds.query('Item', 'true', 10, 0, '', ['Name']), [{ ROWID: '7', Name: 'Ada' }, { ROWID: '8', Name: 'Bea' }]);
  assert.equal(calls[0]?.[2], 'SELECT ROWID, Name FROM Item ORDER BY ROWID LIMIT 1, 10');
  assert.deepEqual(await ds.query('Item', 'false', 10, 0), []);
  assert.deepEqual(await ds.query('Item', 'FALSE', 10, 0), []);
  assert.equal(calls.length, 1);
});

test('adapter keyset paging returns all 650 rows exactly once, honoring offset and limit', async () => {
  const req = createRequire(import.meta.url);
  const sdk = req(join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs')) as {
    initialize(req: unknown, opts: { scope: string }): unknown;
    state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
  };
  const app = sdk.initialize({}, { scope: 'admin' });
  const { createSdkDatastore } = await adapterModule();
  const ds = createSdkDatastore(app, { columns: { Item: ['ROWID', 'Name'] } });
  for (let i = 0; i < 650; i += 200) {
    await ds.insert('Item', Array.from({ length: Math.min(200, 650 - i) }, (_, k) => ({ Name: `n${i + k}` })));
  }
  const stored = (sdk.state().tables.Item ?? []).map((row) => String(row.ROWID));
  assert.equal(stored.length, 650);

  const calls = () => sdk.state().calls.filter((call) => call[0] === 'zcql').map((call) => String(call[1]));
  const all = await ds.query('Item', '', 650, 0, 'ORDER BY ROWID');
  assert.equal(all.length, 650);
  assert.equal(new Set(all.map((row) => String(row.ROWID))).size, 650);
  assert.deepEqual(all.map((row) => String(row.ROWID)), stored);
  const sql = calls();
  assert.equal(sql[0], 'SELECT ROWID, Name FROM Item ORDER BY ROWID LIMIT 1, 300');
  assert.equal(sql[1], `SELECT ROWID, Name FROM Item WHERE ROWID > ${stored[299]} ORDER BY ROWID LIMIT 1, 300`);
  assert.equal(sql[2], `SELECT ROWID, Name FROM Item WHERE ROWID > ${stored[599]} ORDER BY ROWID LIMIT 1, 50`);

  const middle = await ds.query('Item', '', 100, 500, '');
  assert.deepEqual(middle.map((row) => String(row.ROWID)), stored.slice(500, 600));

  const desc = await ds.query('Item', '', 100, 0, 'ORDER BY ROWID DESC');
  assert.deepEqual(desc.map((row) => String(row.ROWID)), [...stored].reverse().slice(0, 100));

  const sorted = await ds.query('Item', '', 5, 10, 'ORDER BY Name DESC, ROWID');
  assert.equal(sorted.length, 5);
  const last = calls()[calls().length - 1];
  assert.match(last!, /LIMIT 11, 5$/);

  const filtered = await ds.query('Item', "Name LIKE 'n64*'", 650, 0, '');
  assert.deepEqual(filtered.map((row) => String(row.Name)), ['n64', ...Array.from({ length: 10 }, (_, k) => `n${640 + k}`)]);
});

const LIMITS_ROWS = 300;

test('adapter keyset paging keeps the WHERE clause on every page, filtered and access-scoped', async () => {
  const { zcqlSelect } = await adapterModule();
  // The keyset clause keeps the (parenthesized) predicate and appends the ROWID bound.
  assert.equal(
    zcqlSelect('Item', "Bucket != 'Z'", 300, 0, 'ORDER BY ROWID', 'Name', '42'),
    "SELECT ROWID, Name FROM Item WHERE (Bucket != 'Z') AND ROWID > 42 ORDER BY ROWID LIMIT 1, 300",
  );
  assert.equal(
    zcqlSelect('Item', "Bucket != 'Z'", 300, 0, 'ORDER BY ROWID DESC', 'Name', '42'),
    "SELECT ROWID, Name FROM Item WHERE (Bucket != 'Z') AND ROWID < 42 ORDER BY ROWID DESC LIMIT 1, 300",
  );
  // A raw caller predicate is wrapped so `OR` cannot rebind the keyset bound.
  assert.equal(
    zcqlSelect('Item', "A = '1' OR B = '2'", 300, 0, '', 'Name', '42'),
    "SELECT ROWID, Name FROM Item WHERE (A = '1' OR B = '2') AND ROWID > 42 ORDER BY ROWID LIMIT 1, 300",
  );

  const req = createRequire(import.meta.url);
  const sdk = req(join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs')) as {
    initialize(req: unknown, opts: { scope: string }): unknown;
    state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
  };
  const app = sdk.initialize({}, { scope: 'admin' });
  const { createSdkDatastore } = await adapterModule();
  const ds = createSdkDatastore(app, { columns: { Part: ['ROWID', 'Name', 'Owner', 'Bucket'] } });
  for (let i = 0; i < 650; i += 200) {
    await ds.insert(
      'Part',
      Array.from({ length: Math.min(200, 650 - i) }, (_, k) => {
        const n = i + k;
        return { Name: `n${n}`, Owner: n % 5 === 0 ? 'bob' : 'ada', Bucket: n % 13 === 0 ? 'Z' : 'A' };
      }),
    );
  }
  const stored = sdk.state().tables.Part ?? [];
  assert.equal(stored.length, 650);
  const sqlCalls = () => sdk.state().calls.filter((call) => call[0] === 'zcql').map((call) => String(call[1]));

  const cases: { where: string; fragments: string[]; match: (row: Record<string, unknown>) => boolean }[] = [
    { where: "Bucket != 'Z'", fragments: ["Bucket != 'Z'"], match: (row) => row.Bucket !== 'Z' },
    {
      where: "(Bucket != 'Z') AND (Owner = 'ada')",
      fragments: ["Bucket != 'Z'", "Owner = 'ada'"],
      match: (row) => row.Bucket !== 'Z' && row.Owner === 'ada',
    },
  ];
  for (const { where, fragments, match } of cases) {
    const matching = stored.filter(match);
    assert.ok(matching.length > LIMITS_ROWS, `case needs more than one page: ${matching.length}`);
    for (const order of ['ORDER BY ROWID', 'ORDER BY ROWID DESC']) {
      const ordered = order.endsWith('DESC') ? [...matching].reverse() : matching;
      for (const limit of [299, 300, 301, 650, 1000]) {
        const before = sqlCalls().length;
        const rows = await ds.query('Part', where, limit, 0, order);
        const expected = ordered.slice(0, Math.min(limit, ordered.length));
        assert.deepEqual(
          rows.map((row) => String(row.ROWID)),
          expected.map((row) => String(row.ROWID)),
          `${where} ${order} limit ${limit}`,
        );
        // Every page keeps the predicate: no `FROM <table> AND ROWID …` (WHERE lost).
        for (const sql of sqlCalls().slice(before)) {
          assert.match(sql, / FROM Part WHERE /, sql);
          for (const fragment of fragments) assert.ok(sql.includes(fragment), sql);
          assert.ok(!/ FROM Part AND /.test(sql), sql);
        }
      }
    }
  }
});

test('a projection missing a schema column fails the function at load, naming the column', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-columns-'));
  try {
    const app = await sampleApp();
    const { files } = deployFiles(app, guardFor(app), false, { mode: 'live' });
    writeDeployTree(out, files);
    // c2c-columns.json is the type map. The name list the load check compares
    // to c2c-schema.json is c2c-projections.json.
    const mapPath = join(out, 'functions/c2c_api/c2c-projections.json');
    const original = readFileSync(mapPath, 'utf8');
    const map = JSON.parse(original) as Record<string, string[]>;
    const table = 'Sample_Item';
    const dropped = map[table]!.find((name) => name !== 'ROWID')!;
    map[table] = map[table]!.filter((name) => name !== dropped);
    writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
    const req = createRequire(import.meta.url);
    assert.throws(() => req(join(out, 'functions/c2c_api/index.js')), new RegExp(`${table}\\.${dropped}`));
    writeFileSync(mapPath, original);
    assert.doesNotThrow(() => req(join(out, 'functions/c2c_api/index.js')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('adapter retries 429 no sooner than Retry-After, backs off exponentially, and gives up', async () => {
  const { withBackoff, retryAfterMs, RETRY } = await adapterModule();
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
  };
  let n = 0;
  const value = await withBackoff(async () => {
    n += 1;
    if (n === 1) throw Object.assign(new Error('Too Many Requests'), { statusCode: 429, headers: { 'Retry-After': '2' } });
    if (n === 2) throw Object.assign(new Error('rate'), { status: 429 });
    return 'ok';
  }, { sleep });
  assert.equal(value, 'ok');
  assert.deepEqual(slept, [2000, RETRY.baseDelayMs * 2]);
  slept.length = 0;
  await assert.rejects(
    withBackoff(async () => {
      throw Object.assign(new Error('429'), { statusCode: 429, headers: { 'retry-after': '600' } });
    }, { sleep }),
    /429/,
  );
  // Retry-After longer than maxWaitMs fails at once with a clear error; it never retries sooner.
  assert.equal(RETRY.maxWaitMs, 60000);
  let calls = 0;
  await assert.rejects(
    withBackoff(async () => {
      calls += 1;
      throw Object.assign(new Error('429'), { statusCode: 429, headers: { 'retry-after': '600' } });
    }, { sleep }),
    (err: Error & { statusCode?: number; cause?: unknown }) =>
      /Retry-After asks for 600s, more than the 60s max wait/.test(err.message) && err.statusCode === 429 && err.cause instanceof Error,
  );
  assert.equal(calls, 1);
  assert.deepEqual(slept, []);
  // A Retry-After above the no-header cap but within max wait is honoured in full, maxRetries times.
  calls = 0;
  await assert.rejects(
    withBackoff(async () => {
      calls += 1;
      throw Object.assign(new Error('429'), { statusCode: 429, headers: { 'Retry-After': '30' } });
    }, { sleep }),
    { message: '429' },
  );
  assert.equal(calls, RETRY.maxRetries + 1);
  assert.deepEqual(slept, Array(RETRY.maxRetries).fill(30000));
  slept.length = 0;
  // An HTTP-date Retry-After is a floor too.
  const at = new Date(Date.now() + 20000).toUTCString();
  n = 0;
  await withBackoff(async () => {
    n += 1;
    if (n === 1) throw Object.assign(new Error('429'), { statusCode: 429, headers: { 'retry-after': at } });
    return 'ok';
  }, { sleep });
  assert.equal(slept.length, 1);
  assert.ok(slept[0]! > RETRY.maxDelayMs && slept[0]! <= 20000, `slept ${slept[0]}`);
  slept.length = 0;
  // The no-header backoff alone is capped.
  await assert.rejects(
    withBackoff(async () => Promise.reject(Object.assign(new Error('rate'), { status: 429 })), { sleep, baseDelayMs: 5000 }),
    /rate/,
  );
  assert.deepEqual(slept, [5000, 8000, 8000, 8000]);
  slept.length = 0;
  await assert.rejects(
    withBackoff(async () => {
      throw Object.assign(new Error('429'), { statusCode: 429, headers: { 'retry-after': '90' } });
    }, { sleep, maxWaitMs: 120000, maxRetries: 1 }),
    { message: '429' },
  );
  assert.deepEqual(slept, [90000]);
  slept.length = 0;
  await assert.rejects(withBackoff(async () => Promise.reject(Object.assign(new Error('bad'), { statusCode: 400 })), { sleep }), /bad/);
  assert.deepEqual(slept, []);
  assert.equal(retryAfterMs({ headers: { 'retry-after': 'Tue, 06 Oct 2026 10:00:05 GMT' } }, Date.parse('Tue, 06 Oct 2026 10:00:00 GMT')), 5000);
  assert.equal(retryAfterMs({}), -1);
});

async function sampleApp(): Promise<App> {
  return deriveIr(parse(await sampleSourceText()));
}

const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

function guardFor(app: App): GuardOk {
  return {
    org: FIXTURE_ORG,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: FIXTURE_REGISTRY,
  };
}

function text(files: readonly DeployFile[], path: string): string {
  const file = files.find((item) => item.path === path);
  assert.ok(file, `missing ${path}`);
  return typeof file.data === 'string' ? file.data : file.data.toString('utf8');
}

test('deploy writes a Catalyst Advanced I/O function folder with pinned deps and vendored shims', async () => {
  const app = await sampleApp();
  const { files } = deployFiles(app, guardFor(app), false, { mode: 'live' });
  const fn = files.filter((file) => file.path.startsWith('functions/'));
  assert.ok(fn.every((file) => file.path.startsWith('functions/c2c_api/')), 'every function file is inside the function folder');
  const config = JSON.parse(text(files, 'functions/c2c_api/catalyst-config.json'));
  assert.deepEqual(config, {
    deployment: { name: 'c2c_api', stack: 'node20', type: 'advancedio', env_variables: { C2C_DEPLOY_MODE: 'live' } },
    execution: { main: 'index.js' },
  });
  const pkg = JSON.parse(text(files, 'functions/c2c_api/package.json'));
  assert.deepEqual(pkg.dependencies, { ...FUNCTION_DEPENDENCIES });
  for (const version of Object.values(pkg.dependencies as Record<string, string>)) assert.match(version, /^\d+\.\d+\.\d+$/, 'exact pin');
  assert.equal(pkg.main, 'index.js');
  assert.deepEqual(JSON.parse(text(files, 'functions/c2c_api/vendor/shims/package.json')), { type: 'module', private: true });
  assert.equal(JSON.parse(text(files, 'functions/c2c_api/c2c-deploy.json')).mode, 'live');
  for (const file of fn) {
    if (typeof file.data !== 'string') continue;
    assert.equal(file.data.includes('creator-to-catalyst/shims'), false, file.path);
    assert.equal(file.data.includes('sourceMappingURL'), false, file.path);
  }
  const routes = JSON.parse(text(files, 'functions/c2c_api/routes.json')) as Record<string, string>;
  assert.equal(routes['POST /forms/Sample_Item/submit'], './aio/sample-item/submit.mjs');
  assert.equal(routes['POST /reports/All_Sample_Items'], './reports/all-sample-items.mjs');
  const catalyst = JSON.parse(text(files, 'catalyst.json'));
  assert.deepEqual(catalyst.functions, { targets: ['c2c_api'], ignore: [], source: 'functions' });
  assert.match(text(files, 'slate/c2c-config.js'), /C2C_API_BASE = "\/server\/c2c_api"/);
  assert.match(text(files, 'slate/c2c-config.js'), /__catalyst\/sdk\/init\.js/);
  assert.match(text(files, 'slate/index.html'), /<script src="\.\/c2c-config\.js"><\/script>/);
  const report = text(files, 'functions/c2c_api/reports/all-sample-items.mjs');
  assert.equal(/WHERE \$\{where\}/.test(report), false, 'the report never emits WHERE <predicate> unconditionally');
  const dry = deployFiles(app, guardFor(app), false);
  assert.equal(JSON.parse(text(dry.files, 'functions/c2c_api/c2c-deploy.json')).mode, 'dry-run');
});

test('the emitted function bundle logs no err.stack and ships a lockfile', async () => {
  // Hygiene gate: no console call in the bundle may log
  // err.stack, and the function ships package-lock.json so transitive
  // dependencies stop floating at deploy.
  const app = await sampleApp();
  const { files } = deployFiles(app, guardFor(app), false, { mode: 'live' });
  const fn = files.filter((file) => file.path.startsWith('functions/c2c_api/'));
  assert.ok(fn.length > 0, 'the deploy tree has no function folder');
  const offenders = fn
    .filter((file) => typeof file.data === 'string' && file.data.includes('err.stack'))
    .map((file) => file.path);
  assert.deepEqual(offenders, [], 'no console call in the bundle may log err.stack');
  const pkg = JSON.parse(text(files, 'functions/c2c_api/package.json'));
  const lock = fn.find((file) => file.path === 'functions/c2c_api/package-lock.json');
  assert.ok(lock, 'the function bundle ships package-lock.json');
  const parsed = JSON.parse(typeof lock.data === 'string' ? lock.data : lock.data.toString('utf8')) as {
    name: string;
    version: string;
    packages: Record<string, { version?: string; dependencies?: Record<string, string>; integrity?: string }>;
  };
  assert.equal(parsed.name, pkg.name, 'the lockfile root names the function package');
  assert.equal(parsed.version, pkg.version, 'the lockfile root versions the function package');
  assert.deepEqual(parsed.packages['']?.dependencies, pkg.dependencies, 'the lockfile root pins the function dependencies');
  const locked = parsed.packages['node_modules/zcatalyst-sdk-node'];
  assert.equal(locked?.version, FUNCTION_DEPENDENCIES['zcatalyst-sdk-node'], 'the lockfile pins zcatalyst-sdk-node');
  assert.ok(typeof locked?.integrity === 'string' && locked.integrity.length > 0, 'the locked SDK carries an integrity hash');
});

test('the function tree is byte-identical across runs and across processes', async () => {
  const app = await sampleApp();
  const first = deployFiles(app, guardFor(app), false, { mode: 'live' }).files;
  const second = deployFiles(app, guardFor(app), false, { mode: 'live' }).files;
  assert.deepEqual(second.map((f) => f.path), first.map((f) => f.path));
  assert.equal(bundleDigest(second), bundleDigest(first));
  const script = `
    const { deployFiles } = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/deploy/src/plan.js')).href)});
    const { bundleDigest } = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/deploy/src/cli.js')).href)});
    const { deriveIr, parse } = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/core/src/index.js')).href)});
    const app = deriveIr(parse(process.env.C2C_SRC));
    process.stdout.write(bundleDigest(deployFiles(app, JSON.parse(process.env.C2C_GUARD), false, { mode: 'live' }).files));`;
  const src = await sampleSourceText();
  const digests = [0, 1].map(() => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, C2C_SRC: src, C2C_GUARD: JSON.stringify(guardFor(app)) },
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  });
  assert.equal(digests[0], digests[1]);
  assert.equal(digests[0], bundleDigest(first));
});

/** The synthetic sample app from fixtures/sample-app/sample-app.mjs (no fixture files). */
async function sampleSourceText(): Promise<string> {
  const gen = (await import(pathToFileURL(join(root, 'fixtures/sample-app/sample-app.mjs')).href)) as {
    sampleItemForm(): string[];
    sampleItemReport(): string[];
    sampleWorkflow(): string[];
  };
  return [
    'application "sample-app"', '{', '\ttime zone = "Asia/Kolkata"', '\tshare_settings', '\t{', '\t\t"Administrator"', '\t\t{',
    '\t\t\tname = "Administrator"', '\t\t\ttype = Users_Permissions', '\t\t\tdescription = "This profile will have all the permissions."',
    '\t\t}', '\t}', '\tforms', '\t{', ...gen.sampleItemForm(), '\t}', '\treports', '\t{', ...gen.sampleItemReport(), '\t}',
    ...gen.sampleWorkflow(), '}', '',
  ].join('\n');
}

test('shim imports are rewritten relative to each file and parameterised routes keep their patterns', () => {
  assert.equal(rewriteShimsImport('import { a } from "creator-to-catalyst/shims";', 'aio/x/submit.mjs'), 'import { a } from "../../vendor/shims/index.js";');
  assert.equal(rewriteShimsImport("import { a } from 'creator-to-catalyst/shims';", 'c2c-store.mjs'), 'import { a } from "./vendor/shims/index.js";');
  // The lookup (and upload) endpoints are parameterised, and the entry
  // matches those patterns. Dropping them leaves every lookup select empty.
  const routes = routeTable([
    { path: 'b.mjs', data: 'export const endpoint = { type: "advancedio", method: "POST", path: "/forms/A/submit" };\n' },
    { path: 'lookups/lookup.mjs', data: 'export const endpoint = { type: "advancedio", method: "GET", path: "/lookups/:form/:field" };\n' },
    { path: 'uploads/stratus-upload.mjs', data: 'export const endpoint = { type: "advancedio", method: "POST", path: "/uploads/:form/:field" };\n' },
  ]);
  assert.deepEqual(routes, {
    'POST /forms/A/submit': './b.mjs',
    'GET /lookups/:form/:field': './lookups/lookup.mjs',
    'POST /uploads/:form/:field': './uploads/stratus-upload.mjs',
  });
  // Two modules emitting the same route must be refused: keeping the first
  // would silently never run the second (same form event, several scripts).
  assert.throws(
    () =>
      routeTable([
        { path: 'a.mjs', data: 'export const endpoint = { type: "advancedio", method: "POST", path: "/forms/A/success" };\n' },
        { path: 'b.mjs', data: 'export const endpoint = { type: "advancedio", method: "POST", path: "/forms/A/success" };\n' },
      ]),
    /duplicate route POST \/forms\/A\/success/,
  );
});

test('principal: the Catalyst role picks the Creator profile and an unmapped role or no user is refused', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-principal-'));
  try {
    const app = await sampleApp();
    writeDeployTree(out, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const mod = (await import(pathToFileURL(join(out, 'functions/c2c_api/c2c-principal.mjs')).href)) as {
      principalFromUser(user: unknown): Record<string, string> | null;
      resolvePrincipal(sdk: unknown, req: unknown): Promise<Record<string, string> | null>;
    };
    assert.deepEqual(mod.principalFromUser({ user_id: 9, email_id: 'a@example.test', role_details: { role_name: 'App Administrator' } }), {
      profile: 'Administrator',
      // zoho.loginuserid is the email; the numeric Catalyst id is the fallback.
      userId: 'a@example.test',
      loginUser: 'a@example.test',
    });
    // This app has no User profile, so the mapped App User has nothing to grant.
    assert.equal(mod.principalFromUser({ user_id: 9, role_details: { role_name: 'App User' } }), null);
    // Only principal-map.json maps roles. The apply plan creates a Catalyst
    // role named Administrator for the Administrator profile, so it resolves;
    // an unplanned name that merely looks like a profile is still refused.
    assert.deepEqual(mod.principalFromUser({ user_id: 9, role_details: { role_name: 'Administrator' } }), {
      profile: 'Administrator',
      userId: '9',
    });
    assert.equal(mod.principalFromUser({ user_id: 9, role_details: { role_name: 'User' } }), null);
    assert.equal(mod.principalFromUser({ user_id: 9, role_details: { role_name: 'constructor' } }), null);
    assert.equal(mod.principalFromUser({ user_id: 9, role_details: { role_name: 'Auditor' } }), null);
    assert.equal(mod.principalFromUser(null), null);
    const throwing = { initialize: () => ({ userManagement: () => ({ getCurrentUser: async () => Promise.reject(new Error('no session')) }) }) };
    assert.equal(await mod.resolvePrincipal(throwing, {}), null);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the Advanced I/O entry serves the generated handlers with a consistent error shape across route families', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-fn-'));
  const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const previousMode = process.env.C2C_DEPLOY_MODE;
  const app = await sampleApp();
  writeDeployTree(out, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
  const functionDir = join(out, 'functions/c2c_api');
  const routes = JSON.parse(readFileSync(join(functionDir, 'routes.json'), 'utf8')) as Record<string, string>;
  routes['POST /unsafe-error'] = 'unsafe-error.mjs';
  routes['POST /committed-error'] = 'committed-error.mjs';
  writeFileSync(join(functionDir, 'routes.json'), JSON.stringify(routes));
  writeFileSync(
    join(functionDir, 'unsafe-error.mjs'),
    `export default async function unsafeError(call, res) {\n  res.writeHead(500, { 'content-type': 'application/json' });\n  res.end(JSON.stringify({ message: 'Unable to cast SECRET_TOKEN_91', error: 'stack trace /private/app/index.js:12', stack: 'Error\\n at handler', query: 'SELECT * FROM ZCQL_SECRET' }));\n}\n`,
  );
  writeFileSync(
    join(functionDir, 'committed-error.mjs'),
    `export default async function committedError(call, res) {\n  const { createRequire } = await import('node:module');\n  const sdk = createRequire(import.meta.url)('zcatalyst-sdk-node');\n  await sdk.initialize(call).datastore().table('Sample_Item').insertRows([{ Item_Name: 'Committed Once' }]);\n  res.writeHead(500, { 'content-type': 'application/json' });\n  res.end(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Internal server error', wrote: true, error: 'SECRET' }));\n}\n`,
  );

  const req = createRequire(import.meta.url);
  const sdk = req(fake) as { setSession(token: string, user: unknown): void; state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] } };
  sdk.setSession('t1', { user_id: '1', email_id: 'operator@example.test', role_details: { role_name: 'App Administrator' } });
  sdk.setSession('t2', { user_id: '2', role_details: { role_name: 'App User' } });
  const entry = req(join(out, 'functions/c2c_api/index.js')) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const post = async (path: string, body: unknown, session?: string, method = 'POST') => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(session ? { cookie: `c2c-harness-session=${session}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const assertErrorShape = (result: { status: number; body: Record<string, unknown> }) => {
    assert.equal(typeof result.body.code, 'string', JSON.stringify(result.body));
    assert.equal(typeof result.body.message, 'string', JSON.stringify(result.body));
    assert.equal(Object.hasOwn(result.body, 'error'), false, JSON.stringify(result.body));
    assert.doesNotMatch(JSON.stringify(result.body), /stack|node_modules|\/home\//i);
  };
  try {
    const submit = '/server/c2c_api/forms/Sample_Item/submit';
    const unauth = await post(submit, { record: { Item_Name: 'x' } });
    assert.equal(unauth.status, 401);
    assertErrorShape(unauth);
    assert.equal((await post(submit, { record: { Item_Name: 'x' }, user: { profile: 'Administrator' } })).status, 401, 'a body principal is ignored');
    assert.equal((await post(submit, { record: { Item_Name: 'x' } }, 't2')).status, 401, 'App User maps to User, which this app does not define');
    const refused = await post(submit, { record: { Item_Name: 'Zero', Quantity: 0, Unit_Price: 5 } }, 't1');
    assert.equal(refused.status, 422);
    assert.equal(refused.body.message, 'Quantity must be greater than zero');
    assertErrorShape(refused);
    const badJson = await fetch(`http://127.0.0.1:${port}${submit}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=t1' },
      body: '{not json}',
    }).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }));
    assert.equal(badJson.status, 400);
    assertErrorShape(badJson);
    const invalidField = await post(submit, { record: { Item_Name: 'typed', Quantity: 'not a quantity' } }, 't1');
    assert.equal(invalidField.status, 400);
    assert.match(String(invalidField.body.message), /Quantity is "not a quantity", not a valid number value/);
    assertErrorShape(invalidField);
    const saved = await post('/server/c2c_api/execute/forms/Sample_Item/submit', { record: { Item_Name: 'Widget Alpha', Quantity: 10, Unit_Price: 25.5 } }, 't1');
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.wrote, true);
    const rows = sdk.state().tables.Sample_Item ?? [];
    assert.deepEqual(rows.map((row) => [row.Item_Name, row.Status]), [['Widget Alpha', 'Submitted']]);
    // Total_Amount is a decimal field: an exact decimal string (shim.decimal.mul keeps the
    // operands' scale, so 10 * 25.5 is "255.0"), with its Double shadow beside it.
    assert.equal(decimal.cmp(String(rows[0]?.Total_Amount), '255', '=='), true);
    assert.equal(Number(rows[0]?.Total_Amount__n), 255);
    assert.match(String(rows[0]?.Added_Time), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const report = await post('/server/c2c_api/reports/All_Sample_Items', { op: 'query' }, 't1');
    assert.equal(report.status, 200);
    assert.deepEqual((report.body.rows as Record<string, unknown>[]).map((row) => row.Item_Name), ['Widget Alpha']);
    const zcql = sdk.state().calls.filter((call) => call[0] === 'zcql').map((call) => call[1] as string);
    assert.ok(zcql.length > 0 && zcql.every((sql) => !/WHERE true/i.test(sql)), zcql.join('\n'));
    const missing = await post('/server/c2c_api/nope', {}, 't1');
    assert.equal(missing.status, 404);
    assertErrorShape(missing);
    const wrongMethod = await post(submit, {}, 't1', 'GET');
    assert.equal(wrongMethod.status, 405);
    assertErrorShape(wrongMethod);
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => logged.push(parts.map(String).join(' '));
    let unsafe: { status: number; body: Record<string, unknown> };
    try {
      unsafe = await post('/server/c2c_api/unsafe-error', {}, 't1');
    } finally {
      console.error = originalError;
    }
    assert.equal(unsafe!.status, 500);
    assert.equal(unsafe!.body.wrote, undefined, 'no write signal is added unless true');
    const committed = await post('/server/c2c_api/committed-error', {}, 't1');
    assert.equal(committed.status, 500);
    assert.equal(committed.body.wrote, true, 'a committed write must survive 5xx sanitization');
    assert.deepEqual(Object.keys(committed.body).sort(), ['code', 'correlationId', 'message', 'wrote']);
    assert.equal((sdk.state().tables.Sample_Item ?? []).filter((row) => row.Item_Name === 'Committed Once').length, 1);
    assert.deepEqual(Object.keys(unsafe!.body).sort(), ['code', 'correlationId', 'message']);
    assert.equal(unsafe!.body.code, 'INTERNAL_ERROR');
    assert.equal(unsafe!.body.message, 'Internal server error');
    assert.match(String(unsafe!.body.correlationId), /^[0-9a-f-]{36}$/i);
    assert.doesNotMatch(JSON.stringify(unsafe!.body), /SECRET_TOKEN|stack trace|ZCQL_SECRET|SELECT/);
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /SECRET_TOKEN_91/);
    assert.match(logged[0]!, /ZCQL_SECRET/);
    assert.ok(logged[0]!.includes(String(unsafe!.body.correlationId)), 'server details carry the response correlation id');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    moduleAny._resolveFilename = original;
    if (previousMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = previousMode;
    rmSync(out, { recursive: true, force: true });
  }
});

test('loading the entry imports no handler module: cold start is the router only', async () => {
  // Entry dispatch is ~5 ms because index.js only reads its JSON configs at
  // load; every aio/custom/reports handler arrives later through a dynamic
  // import on first use. A static require here would reintroduce the up to
  // ~274 ms import-everything cost measured on hotel-management.
  const out = mkdtempSync(join(tmpdir(), 'c2c-fn-cold-'));
  const counterKey = '__c2cHandlerEvaluations';
  const globalAny = globalThis as typeof globalThis & Record<string, unknown>;
  const previousCount = globalAny[counterKey];
  try {
    const app = await sampleApp();
    writeDeployTree(out, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const dir = join(out, 'functions/c2c_api');
    const routes = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8')) as Record<string, string>;
    // Give every routed handler the same top-level sentinel. Unlike observing
    // Module._load, this sees both CommonJS require and ESM dynamic import.
    const specs = new Set(Object.values(routes));
    for (const spec of specs) {
      const handlerPath = join(dir, spec);
      const source = readFileSync(handlerPath, 'utf8');
      writeFileSync(handlerPath, `globalThis.${counterKey} = (globalThis.${counterKey} ?? 0) + 1;\n${source}`);
    }
    delete globalAny[counterKey];
    const req = createRequire(import.meta.url);
    req(join(dir, 'index.js'));
    // Dynamic imports are asynchronous; let load-time import().catch(...) work
    // finish so eager ESM loads are observable too.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(globalAny[counterKey] ?? 0, 0, 'loading index.js evaluated a routed handler module');
  } finally {
    if (previousCount === undefined) delete globalAny[counterKey];
    else globalAny[counterKey] = previousCount;
    rmSync(out, { recursive: true, force: true });
  }
});

test('a route resolves to its handler on first use and reuses the cached module', async () => {
  // The entry's dynamic import is cached by the module loader, so the same
  // module instance serves every request for the route. The counter below
  // proves it: a fresh evaluation per request would answer 1 every time.
  const out = mkdtempSync(join(tmpdir(), 'c2c-fn-cache-'));
  const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  try {
    const app = await sampleApp();
    writeDeployTree(out, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const dir = join(out, 'functions/c2c_api');
    writeFileSync(
      join(dir, 'counted.mjs'),
      'let calls = 0;\nexport default async function counted(call, res) {\n  calls += 1;\n  res.writeHead(200, { \'content-type\': \'application/json\' });\n  res.end(JSON.stringify({ calls }));\n}\n',
    );
    const routes = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8')) as Record<string, string>;
    routes['POST /counted'] = './counted.mjs';
    writeFileSync(join(dir, 'routes.json'), JSON.stringify(routes));
    const req = createRequire(import.meta.url);
    const sdk = req(fake) as { setSession(token: string, user: unknown): void };
    sdk.setSession('cache-t1', { user_id: '1', email_id: 'operator@example.test', role_details: { role_name: 'App Administrator' } });
    const entry = req(join(dir, 'index.js')) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    const server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const post = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=cache-t1' },
          body: '{}',
          signal: AbortSignal.timeout(10_000),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const first = await post('/server/c2c_api/counted');
      assert.equal(first.status, 200);
      assert.equal(first.body.calls, 1);
      const second = await post('/server/c2c_api/counted');
      assert.equal(second.status, 200);
      assert.equal(second.body.calls, 2, 'the second request reused the cached handler module');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    moduleAny._resolveFilename = original;
    rmSync(out, { recursive: true, force: true });
  }
});

test('a handler that throws after headers are sent still ends the response and logs', async () => {
  // send() used to return silently when res.headersSent, leaving the request
  // open until the gateway timed out. It must end the response and log. The
  // log carries only the error class and code: the message, the stack, and
  // the body stay out of the logs.
  const out = mkdtempSync(join(tmpdir(), 'c2c-fn-late-'));
  const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => logged.push(parts.map(String).join(' '));
  const app = await sampleApp();
  writeDeployTree(out, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
  const dir = join(out, 'functions/c2c_api');
  const routes = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8')) as Record<string, string>;
  routes['POST /late'] = 'late.mjs';
  writeFileSync(join(dir, 'routes.json'), JSON.stringify(routes));
  writeFileSync(
    join(dir, 'late.mjs'),
    `export default async function late(call, res) {\n  res.writeHead(200, { 'content-type': 'application/json' });\n  res.write('{"part"');\n  throw new Error('late boom');\n}\n`,
  );
  const req = createRequire(import.meta.url);
  const sdk = req(fake) as { setSession(token: string, user: unknown): void };
  sdk.setSession('t1', { user_id: '1', email_id: 'operator@example.test', role_details: { role_name: 'App Administrator' } });
  const entry = req(join(dir, 'index.js')) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api/late`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=t1' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"part"');
    assert.ok(
      logged.some((line) => /headers|sent/i.test(line) && /name=Error/.test(line)),
      `expected the error class to be logged, saw: ${logged.join(' | ')}`,
    );
    assert.equal(
      logged.some((line) => line.includes('late boom')),
      false,
      `the headersSent log must not carry the error message, saw: ${logged.join(' | ')}`,
    );
    assert.doesNotMatch(await fetch(`http://127.0.0.1:${port}/server/c2c_api/late`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=t1' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.text()), /late boom/, 'server error details stay out of the client body');
  } finally {
    console.error = originalError;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    moduleAny._resolveFilename = original;
    rmSync(out, { recursive: true, force: true });
  }
});

/** A schedule, an approval, and a `thisapp` call between two custom functions. */
function thisappAppSource(): string {
  return `application "c2c-test-thisapp"
{
	time zone = "Asia/Kolkata"
	share_settings
	{
		"Administrator"
		{
			name = "Administrator"
			type = Users_Permissions
			description = "Admin"
		}
	}
	forms
	{
		form Request
		{
			Request_Name
			(
				type = text
			)
			Status
			(
				type = text
			)
		}
		form Jobs_Log
		{
			Note
			(
				type = text
			)
			Run_At
			(
				type = datetime
			)
		}
	}
	workflow
	{
		schedule
		{
			Nightly_Log as "Nightly Log"
			{
				type = schedule
				form = Jobs_Log
				start = Run_At
				on start
				{
					actions
					{
						on load
						(
							r = insert into Jobs_Log[Note = "ran"];
						)
					}
				}
			}
		}
		approval
		{
			Request_Approval as "Request Approval"
			{
				type = approval
				form = Request
				on level 1
				{
					approvers
					(
						profile = "Administrator"
					)
					on approve
					{
						actions
						{
							on load
							(
								input.Request_Name = "approved";
							)
						}
					}
				}
			}
		}
	}
	functions
	{
		Deluge
		{
			int Helpers.twice(int n)
			{
				return n * 2;
			}
			int Helpers.twicePlus(int n)
			{
				return thisapp.Helpers.twice(n) + 1;
			}
		}
	}
}
`;
}

test('jobs, flows, and custom functions run live through the deploy tree; thisapp dispatches in-process', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-live-'));
  const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const previousMode = process.env.C2C_DEPLOY_MODE;
  try {
    const app = deriveIr(parse(thisappAppSource()));
    const { files } = deployFiles(app, guardFor(app), false, { mode: 'live' });
    writeDeployTree(out, files);
    const base = join(out, 'functions/c2c_api');
    // The flow endpoints are routed from the exported machine object.
    const routes = JSON.parse(readFileSync(join(base, 'routes.json'), 'utf8')) as Record<string, string>;
    assert.equal(routes['POST /flows/request-approval/approve'], './flow/request-approval.mjs');
    assert.equal(routes['POST /flows/request-approval/reject'], './flow/request-approval.mjs');
    // Custom functions are not HTTP routes: no api block publishes them, so
    // the modules are deployed only for the thisapp registry's lazy imports.
    assert.equal(routes['POST /functions/helpers-twice'], undefined);
    assert.equal(routes['POST /functions/helpers-twiceplus'], undefined);
    assert.ok(Object.keys(routes).every((key) => !key.startsWith('POST /functions/')));
    // The generated registry dispatches through lazy in-process imports; no stale dryRun literals.
    const registry = text(files, 'functions/c2c_api/thisapp.mjs');
    assert.match(registry, /"Helpers\.twice": \{ call: async \(\.\.\.a\) => \(await import\("\.\/custom\/helpers-twice\.mjs"\)\)\.Helpers_twice\(\.\.\.a\), params: \["n"\] \}/);
    for (const rel of ['job/nightly-log.mjs', 'flow/request-approval.mjs']) {
      const source = readFileSync(join(base, rel), 'utf8');
      assert.equal(/createRuntime\(\{\s*dryRun: true/.test(source), false, `${rel} must not hard-code dryRun`);
      assert.match(source, /dryRun: !live/);
    }
    // A custom function module creates no runtime at all: it is dispatched
    // on the caller's context, in-process.
    const customSource = readFileSync(join(base, 'custom/helpers-twice.mjs'), 'utf8');
    assert.doesNotMatch(customSource, /createRuntime|export const endpoint/);
    const req = createRequire(import.meta.url);
    const sdk = req(fake) as {
      initialize(req: unknown, opts?: Record<string, unknown>): unknown;
      state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
    };
    const { createSdkDatastore } = (await import(pathToFileURL(join(base, 'c2c-sdk-datastore.mjs')).href)) as AdapterModule;
    const jobDatastore = createSdkDatastore(sdk.initialize({}), { columns: {} });
    (globalThis as Record<string, unknown>).__c2cDatastore = jobDatastore;
    // A job is not an HTTP route: Catalyst invokes the module's default export.
    const job = (await import(pathToFileURL(join(base, 'job/nightly-log.mjs')).href)) as {
      default(jobRequest: unknown): Promise<Record<string, unknown>>;
    };
    const jobResult = await job.default({});
    assert.equal(jobResult.dryRun, false, JSON.stringify(jobResult));
    const logRows = sdk.state().tables.Jobs_Log ?? [];
    assert.equal(logRows.length, 1, 'the job body inserted a row through the SDK');
    assert.equal(logRows[0]?.Note, 'ran');
    // A live transition loads the stored row, applies the new status, and
    // persists the fields the on-approve actions changed. The form declares its
    // own `Status` field, so the machine stage lives on the collision-safe
    // `Flow_Status` column and the user's `Status` is untouched.
    const seeded = await jobDatastore.insert('Request', [{ Request_Name: 'petition', Status: 'Pending', Flow_Status: 'Pending' }]);
    const rowId = String(seeded[0]?.ROWID);
    const flow = (await import(pathToFileURL(join(base, 'flow/request-approval.mjs')).href)) as {
      approve(req: unknown, res: unknown): Promise<void>;
    };
    const res = {
      status: 0,
      body: '',
      writeHead(code: number, _headers: unknown) {
        this.status = code;
      },
      end(body: string) {
        this.body = body;
      },
    };
    await flow.approve(
      { url: '/flows/request-approval/approve', body: { status: 'Approved', ROWID: rowId }, catalyst: { user: { profile: 'Administrator', loginUser: 'a@t', userId: '1' } } },
      res,
    );
    assert.equal(res.status, 200, res.body);
    const flowBody = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(flowBody.dryRun, false);
    assert.equal(flowBody.wrote, true);
    const stored = (sdk.state().tables.Request ?? [])[0];
    assert.equal(stored?.Flow_Status, 'Approved');
    assert.equal(stored?.Status, 'Pending', 'the machine writes its own column, not the user field');
    assert.equal(stored?.Request_Name, 'approved', 'on-approve field writes persist');
    // A custom function is invoked in-process through the thisapp registry —
    // HTTP is not an entry point: the module's default handler refuses.
    const custom = (await import(pathToFileURL(join(base, 'custom/helpers-twiceplus.mjs')).href)) as {
      default(req: unknown, res: unknown): Promise<void>;
    };
    const res2 = { status: 0, body: '', writeHead(code: number) { this.status = code; }, end(body: string) { this.body = body; } };
    await custom.default(
      { url: '/functions/helpers-twiceplus', body: { args: [2] }, catalyst: { user: { profile: 'Administrator', loginUser: 'a@t', userId: '1' } } },
      res2,
    );
    assert.equal(res2.status, 404);
    const shims = (await import(pathToFileURL(join(base, 'vendor/shims/index.js')).href)) as {
      createRuntime(opts: Record<string, unknown>): {
        context(init: Record<string, unknown>): { shim: { thisapp: { call(ctx: unknown, path: string[], args: unknown[]): Promise<unknown> } } };
        transcript: { op?: string; performed?: boolean }[];
      };
    };
    const registryMod = (await import(pathToFileURL(join(base, 'thisapp.mjs')).href)) as { functions: Record<string, unknown> };
    const runtime = shims.createRuntime({ dryRun: false, settingsTimeZone: 'Asia/Kolkata', functions: registryMod.functions });
    const ctx = runtime.context({ record: {}, old: {}, principal: { profile: 'Administrator', loginUser: 'a@t', userId: '1' } });
    const called = await ctx.shim.thisapp.call(ctx, ['Helpers', 'twicePlus'], [2]);
    assert.equal(called, 5, 'thisapp.Helpers.twice(2) + 1');
    assert.ok(runtime.transcript.some((entry) => entry.op === 'thisapp' && entry.performed === true));
    // A dry run keeps the transcript-only behavior and performs nothing.
    process.env.C2C_DEPLOY_MODE = 'dry-run';
    const dryResult = await job.default({});
    assert.equal(dryResult.dryRun, true);
    assert.equal(sdk.state().tables.Jobs_Log?.length, 1, 'dry run wrote nothing new');
  } finally {
    moduleAny._resolveFilename = original;
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    if (previousMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = previousMode;
    rmSync(out, { recursive: true, force: true });
  }
});


test('the Advanced I/O entry forwards the lookup query string to paging', async () => {
  // The deployed entry used to hand the handler the bare pathname, so
  // ?page=&pageSize= never reached paging(): every page read LIMIT 0, 300
  // and malformed values stayed 200. This goes through fn/index.js over HTTP.
  const shop = (profile: string) =>
    ['application "LookupEntry"', '{', '\ttime zone = "Asia/Kolkata"', '\tsection Main', '\t{', '\t\tform Vendor', '\t\t{', '\t\t\tName', '\t\t\t(', '\t\t\t\ttype = text', '\t\t\t)', '\t\t}', '\t\tform Order', '\t\t{', '\t\t\tTitle', '\t\t\t(', '\t\t\t\ttype = text', '\t\t\t)', '\t\t\tVendor', '\t\t\t(', '\t\t\t\ttype = picklist', '\t\t\t\tvalues = Vendor.Name', '\t\t\t)', '\t\t}', '\t\tlist All_Vendors', '\t\t{', '\t\t\tshow all rows from Vendor', '\t\t\t(', '\t\t\t\tName', '\t\t\t)', '\t\t}', '\t}', '\tshare_settings', '\t{', `\t\t"${profile}"`, '\t\t{', `\t\t\tname = "${profile}"`, '\t\t\ttype = Users_Permissions', '\t\t\tdescription = "This profile will have all the permissions."', '\t\t}', '\t}', '}', ''].join('\n');
  const app = deriveIr(parse(shop('Administrator')));
  const out = mkdtempSync(join(tmpdir(), 'c2c-lookup-entry-'));
  const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const previousMode = process.env.C2C_DEPLOY_MODE;
  writeDeployTree(out, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
  const req = createRequire(import.meta.url);
  const sdk = req(fake) as { setSession(token: string, user: unknown): void; state(): { calls: unknown[][] } };
  sdk.setSession('lookup-entry', { user_id: '1', role_details: { role_name: 'App Administrator' } });
  const entry = req(join(out, 'functions/c2c_api/index.js')) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const get = async (path: string, body?: unknown) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const rq = httpRequest(
        { host: '127.0.0.1', port, path, method: 'GET', headers: { cookie: 'c2c-harness-session=lookup-entry', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } },
        (rs) => {
          const chunks: Buffer[] = [];
          rs.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          rs.on('end', () => {
            try {
              resolve({ status: rs.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      rq.on('error', reject);
      if (payload) rq.write(payload);
      rq.end();
    });
  const zcql = () => sdk.state().calls.filter((call) => call[0] === 'zcql').map((call) => call[1] as string);
  try {
    const paged = await get('/server/c2c_api/lookups/Vendor/Name?page=2&pageSize=1');
    assert.equal(paged.status, 200, JSON.stringify(paged.body));
    assert.equal(paged.body.page, 2);
    assert.equal(paged.body.pageSize, 1);
    assert.ok(zcql().some((sql) => sql.includes('LIMIT 3, 1')), zcql().join('\n'));
    // A GET body page is ignored: the query string wins.
    const bodied = await get('/server/c2c_api/lookups/Vendor/Name?page=1&pageSize=2', { page: 99, pageSize: 1 });
    assert.equal(bodied.status, 200, JSON.stringify(bodied.body));
    assert.equal(bodied.body.page, 1);
    assert.equal(bodied.body.pageSize, 2);
    assert.ok(zcql().some((sql) => sql.includes('LIMIT 3, 2')), zcql().join('\n'));
    // Malformed spellings are 400 and never reach ZCQL.
    for (const bad of ['1e3', '%205', '-1', '1.5', 'x', '9007199254740993']) {
      const before = zcql().length;
      const refused = await get(`/server/c2c_api/lookups/Vendor/Name?pageSize=${bad}`);
      assert.equal(refused.status, 400, `${bad}: ${JSON.stringify(refused.body)}`);
      assert.equal(zcql().length, before, `${bad} queried: ${zcql().slice(before).join('\n')}`);
    }
    const before = zcql().length;
    const over = await get('/server/c2c_api/lookups/Vendor/Name?page=100001&pageSize=1');
    assert.equal(over.status, 400, JSON.stringify(over.body));
    assert.equal(zcql().length, before, `offset overrun queried: ${zcql().slice(before).join('\n')}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    moduleAny._resolveFilename = original;
    if (previousMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = previousMode;
    rmSync(out, { recursive: true, force: true });
  }
});

test('lookup paging serves every parent exactly once across pages (1-based LIMIT)', async () => {
  // Live ZCQL LIMIT offsets are 1-based and 0 clamps to 1: page p of size n
  // must read LIMIT p*n+1, n. A 0-based offset overlaps page boundaries (row
  // 300 served twice, row 600 skipped) and ?page=2&pageSize=1 would return the
  // second row instead of the third. Through the generated c2c_api entry.
  const shop = (profile: string) =>
    ['application "LookupPages"', '{', '\ttime zone = "Asia/Kolkata"', '\tsection Main', '\t{', '\t\tform PParent', '\t\t{', '\t\t\tTitle', '\t\t\t(', '\t\t\t\ttype = text', '\t\t\t)', '\t\t}', '\t\tform PChild', '\t\t{', '\t\t\tTitle', '\t\t\t(', '\t\t\t\ttype = text', '\t\t\t)', '\t\t\tParent', '\t\t\t(', '\t\t\t\ttype = picklist', '\t\t\t\tvalues = PParent.Title', '\t\t\t)', '\t\t}', '\t\tlist All_PParents', '\t\t{', '\t\t\tshow all rows from PParent', '\t\t\t(', '\t\t\t\tTitle', '\t\t\t)', '\t\t}', '\t}', '\tshare_settings', '\t{', `\t\t"${profile}"`, '\t\t{', `\t\t\tname = "${profile}"`, '\t\t\ttype = Users_Permissions', '\t\t\tdescription = "This profile will have all the permissions."', '\t\t}', '\t}', '}', ''].join('\n');
  const app = deriveIr(parse(shop('Administrator')));
  const out = mkdtempSync(join(tmpdir(), 'c2c-lookup-pages-'));
  const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const previousMode = process.env.C2C_DEPLOY_MODE;
  writeDeployTree(out, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
  const req = createRequire(import.meta.url);
  const sdk = req(fake) as {
    setSession(token: string, user: unknown): void;
    state(): { calls: unknown[][] };
    initialize(req: unknown, opts: unknown): { datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> } } };
  };
  sdk.setSession('lookup-pages', { user_id: '1', role_details: { role_name: 'App Administrator' } });
  const names = Array.from({ length: 650 }, (_, i) => `p${String(i).padStart(3, '0')}`);
  await sdk.initialize(null, { scope: 'admin' }).datastore().table('PParent').insertRows(names.map((Title) => ({ Title })));
  const entry = req(join(out, 'functions/c2c_api/index.js')) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const get = async (path: string) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const rq = httpRequest(
        { host: '127.0.0.1', port, path, method: 'GET', headers: { cookie: 'c2c-harness-session=lookup-pages' } },
        (rs) => {
          const chunks: Buffer[] = [];
          rs.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          rs.on('end', () => {
            try {
              resolve({ status: rs.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      rq.on('error', reject);
      rq.end();
    });
  const zcql = () => sdk.state().calls.filter((call) => call[0] === 'zcql').map((call) => call[1] as string);
  const titles = (body: Record<string, unknown>) => (body.rows as Record<string, unknown>[]).map((row) => String(row.Title));
  try {
    const pages: string[][] = [];
    for (const page of [0, 1, 2]) {
      const res = await get(`/server/c2c_api/lookups/PParent/Title?page=${page}&pageSize=300`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      pages.push(titles(res.body));
    }
    assert.deepEqual(pages.map((page) => page.length), [300, 300, 50]);
    assert.deepEqual(pages.flat(), names);
    assert.ok(zcql().some((sql) => sql.includes('LIMIT 1, 300')), zcql().join('\n'));
    assert.ok(zcql().some((sql) => sql.includes('LIMIT 301, 300')), zcql().join('\n'));
    assert.ok(zcql().some((sql) => sql.includes('LIMIT 601, 300')), zcql().join('\n'));
    const third = await get('/server/c2c_api/lookups/PParent/Title?page=2&pageSize=1');
    assert.equal(third.status, 200, JSON.stringify(third.body));
    assert.deepEqual(titles(third.body), ['p002']);
    assert.ok(zcql().some((sql) => sql.includes('LIMIT 3, 1')), zcql().join('\n'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    moduleAny._resolveFilename = original;
    if (previousMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = previousMode;
    rmSync(out, { recursive: true, force: true });
  }
});


test('the fake SDK rejects WHERE true like ZCQL does', () => {
  const req = createRequire(import.meta.url);
  const sdk = req(join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs')) as { executeZCQLQuery(sql: string): unknown };
  assert.throws(() => sdk.executeZCQLQuery('SELECT * FROM Item WHERE true ORDER BY ROWID LIMIT 300'), /syntax error/);
});

test('functionBaseFrom reads the function URL from catalyst deploy output', () => {
  assert.equal(
    functionBaseFrom('✔ functions(c2c_api)\n  URL: https://c2c-sample-app-10000000000.development.catalystserverless.in/server/c2c_api/\n'),
    'https://c2c-sample-app-10000000000.development.catalystserverless.in/server/c2c_api',
  );
  assert.equal(functionBaseFrom('nothing here'), undefined);
});

const SECRET = '/tmp/cred-DO-NOT-PRINT';
// cli-table3 output of zcatalyst-cli project:list (see deploy.test.ts).
const PROJECT_LIST = `
┌───────────────────────────┬────────────┐
│       Project Name        │ Project ID │
├───────────────────────────┼────────────┤
│ c2c-sample-app (active)   │ 1001       │
└───────────────────────────┴────────────┘`;

function resumeIo(failOn: string | undefined) {
  const spawned: { command: string; args: string[]; cwd: string }[] = [];
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    env: { X_ZC_CREDENTIAL_PATH: SECRET, PATH: process.env.PATH },
    cliDc: () => undefined,
    spawn: async (command, args, opts): Promise<SpawnResult> => {
      spawned.push({ command, args, cwd: opts.cwd });
      if (args.includes('project:list')) return { code: 0, stdout: PROJECT_LIST, stderr: '' };
      if (failOn && args.includes(failOn)) return { code: 3, stdout: '', stderr: 'HTTP Error: 400 refreshing the access token' };
      if (args.includes('--only')) return { code: 0, stdout: 'URL: https://c2c-sample-app-1.development.catalystserverless.in/server/c2c_api/\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    fetch: async () => {
      throw new Error('no fetch');
    },
    rest: async (call) => {
      if (call.method === 'GET' && call.path === '/baas/v1/project/1001') return { status: 200, body: { data: { id: '1001', project_name: 'c2c-sample-app', org_id: FIXTURE_ORG } } };
      if (call.method === 'GET') return { status: 200, body: { data: [] } };
      return { status: 200, body: { data: { table_id: '1', table_name: 'x' } } };
    },
  };
  return { io, spawned, out: () => stdout, err: () => stderr };
}

test('deploy runs install, functions, slate in order and --resume skips finished steps', async (t) => {
  const dsDir = mkdtempSync(join(tmpdir(), 'c2c-resume-ds-'));
  const out = mkdtempSync(join(tmpdir(), 'c2c-resume-out-'));
  const ds = join(dsDir, 'app.ds');
  writeFileSync(ds, await sampleSourceText());
  const projects = join(dsDir, 'projects.json');
  writeFileSync(projects, JSON.stringify({ org: FIXTURE_ORG, dc: 'in', env: 'Development', projects: { 'c2c-sample-app': '1001' } }));
  // This test covers the vanilla deploy path, so it pins the fallback explicitly.
  const args = [ds, '--project', '1001', '--org', FIXTURE_ORG, '--projects', projects, '--out', out, '--confirm', '--function-env', 'new', '--ui', 'vanilla'];
  try {
    const first = resumeIo('slate:link');
    const code = await deployCli(args, first.io);
    if (code === 2) {
      t.skip(`guard refused: ${first.err()}`);
      return;
    }
    assert.equal(code, 3, first.err() + first.out().slice(-800));
    assert.deepEqual(
      first.spawned.map((s) => (s.command === 'npm' ? 'npm install' : s.args.find((a) => a === 'project:list' || a === 'slate:link' || a === 'deploy'))),
      ['project:list', 'npm install', 'deploy', 'slate:link'],
    );
    assert.ok(first.spawned[1]?.cwd.endsWith(join('functions', 'c2c_api')));
    assert.ok(first.spawned[2]?.args.includes('functions:c2c_api'));
    const state = JSON.parse(readFileSync(join(out, STATE_FILE), 'utf8')) as { done: string[]; apiBase: string; touched: string[] };
    assert.deepEqual(state.done, ['install', 'functions']);
    assert.deepEqual(state.touched, ['Data Store', 'Functions', 'Authentication']);
    // The failed run still reports its console steps, ending with the resume step.
    const failed = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { exitCode: number; postDeploySteps: { kind: string }[]; functions?: { apiBase?: string } };
    assert.equal(failed.exitCode, 3);
    // The function base the deploy learned is in the report (the owner-session smoke URL).
    assert.equal(failed.functions?.apiBase, 'https://c2c-sample-app-1.development.catalystserverless.in/server/c2c_api');
    assert.equal(failed.postDeploySteps.at(-1)?.kind, 'resume');
    assert.equal(state.apiBase, 'https://c2c-sample-app-1.development.catalystserverless.in/server/c2c_api');
    assert.match(readFileSync(join(out, 'slate/c2c-config.js'), 'utf8'), /catalystserverless\.in\/server\/c2c_api"/);
    // The rewritten config keeps the smoke plan and the project, so the deployed #/admin/smoke page can run and stamp its block.
    assert.match(readFileSync(join(out, 'slate/c2c-config.js'), 'utf8'), /globalThis\.C2C_SMOKE_PLAN = \[/);
    assert.match(readFileSync(join(out, 'slate/c2c-config.js'), 'utf8'), /globalThis\.C2C_SMOKE_PROJECT = "1001";/);
    const second = resumeIo(undefined);
    assert.equal(await deployCli([...args, '--resume'], second.io), 0, second.err());
    // The first run learned apiBase only after the function deployed, so the
    // resumed bundle stamps allowedOrigins into c2c-deploy.json — a changed
    // bundle, and every command runs again, redeploying the function with them.
    assert.match(second.out(), /the generated bundle changed since the last run/);
    assert.deepEqual(
      second.spawned.map((s) => (s.command === 'npm' ? 'npm install' : s.args.find((a) => a === 'project:list' || a === 'slate:link' || a === 'deploy'))),
      ['project:list', 'npm install', 'deploy', 'slate:link', 'deploy'],
    );
    assert.match(second.out(), /post-deploy \(console\)/);
    const redeployed = JSON.parse(readFileSync(join(out, 'functions/c2c_api/c2c-deploy.json'), 'utf8')) as { allowedOrigins?: string[] };
    assert.deepEqual(redeployed.allowedOrigins, ['https://c2c-sample-app-1.development.catalystserverless.in']);
    // The re-run confirmed Slate started (slate:link and slate deploy
    // succeeded), so the end-of-run checklist drops the Slate start item:
    // no part of the output names it.
    assert.equal(second.out().includes('Start Exploring'), false);
    const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as {
      exitCode: number;
      skipped: string[];
      postDeploySteps: { kind: string; services: string[]; text: string }[];
    };
    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.skipped, []);
    assert.equal(report.postDeploySteps[0]?.kind, 'configure');
    // Three built-in configures plus one per auth op that needed the console (no --slate-domain/--admin flags here).
    assert.ok(
      report.postDeploySteps.every((step) => step.kind === 'configure'),
      JSON.stringify(report.postDeploySteps.map((step) => step.kind)),
    );
    assert.ok(report.postDeploySteps.length >= 4);
    assert.equal(second.out().includes(SECRET), false);
    assert.deepEqual((JSON.parse(readFileSync(join(out, STATE_FILE), 'utf8')) as { done: string[] }).done, ['install', 'functions', 'slate-link', 'slate']);
    assert.match(readFileSync(join(out, 'functions/c2c_api/c2c-deploy.json'), 'utf8'), /"mode": "live"/);
    const third = resumeIo(undefined);
    assert.equal(await deployCli([...args, '--resume', '--api-base', 'http://insecure.example'], third.io), 1);
    assert.match(third.err(), /--api-base must be/);
  } finally {
    rmSync(dsDir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('an htmlpage endpoint pins parse5 and ships no jsdom', () => {
  // The generated page endpoints re-parse their HTML through parse5, so a
  // function tree with htmlpages/ handlers pins the parser. The client-side
  // DOM library stays a generation-time tool only: it is neither a pinned
  // dependency nor present in any shipped file.
  const admin = { name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } };
  const zml = `<zml><layout><row><column width='100%'><dsp id='hp1'><![CDATA[htmlpage hp1()\ncontent\n<p><%= input.value %></p>]]></dsp></column></row></layout></zml>`;
  const app: App = deriveIr(
    parse(`application "Demo"\n{\n\tform Orders\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tContent=${JSON.stringify(zml)}\n\t\t}\n\t}\n}\n`),
  );
  app.profiles.push(admin);
  const { files, model } = generateUi(app);
  assert.deepEqual(model.todos, []);
  const generated = files.filter((file) => file.path.startsWith('functions/'));
  assert.ok(generated.some((file) => file.path.startsWith('functions/htmlpages/')), 'the app has no htmlpage endpoint');
  const tree = functionDir(generated, { mode: 'live' });
  const pkg = JSON.parse(text(tree, 'functions/c2c_api/package.json')) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies.parse5, '7.3.0');
  assert.equal('jsdom' in pkg.dependencies, false);
  for (const file of tree) {
    if (typeof file.data !== 'string') continue;
    assert.equal(file.data.includes('jsdom'), false, file.path);
  }
});

test('subset shims: an app with no criteria/regex gets the subset and its handlers load', async () => {
  const handlerSource = `import { jsonReplacer } from "creator-to-catalyst/shims";
export const endpoint = { type: "advancedio", method: "POST", path: "/items/submit" };
export default async function handler(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, id: 9007199254740993n }, jsonReplacer));
}
`;
  const generated: DeployFile[] = [
    { path: 'functions/aio/items/submit.mjs', data: handlerSource },
  ];
  const files = functionDir(generated, { mode: 'dry-run', subsetShims: true });
  const shimFiles = files.filter((f) => f.path.startsWith('functions/c2c_api/vendor/shims/'));
  const shimPaths = shimFiles.map((f) => f.path);

  // Criteria and java-regex (and runtime / zoho-adapters) are omitted
  assert.equal(shimPaths.some((p) => p.endsWith('/criteria.js')), false, 'criteria.js should not be vendored');
  assert.equal(shimPaths.some((p) => p.endsWith('/java-regex.js')), false, 'java-regex.js should not be vendored');
  assert.equal(shimPaths.some((p) => p.endsWith('/runtime.js')), false, 'runtime.js should not be vendored');
  assert.equal(shimPaths.some((p) => p.endsWith('/zoho-adapters.js')), false, 'zoho-adapters.js should not be vendored');

  // ids.js, index.js, and package.json are present
  assert.ok(shimPaths.some((p) => p.endsWith('/ids.js')), 'ids.js must be vendored');
  assert.ok(shimPaths.some((p) => p.endsWith('/store-errors.js')), 'store-errors.js must always be vendored');
  assert.ok(shimPaths.some((p) => p.endsWith('/index.js')), 'index.js must be vendored');
  assert.ok(shimPaths.some((p) => p.endsWith('/package.json')), 'package.json must be vendored');

  // Handlers load cleanly in Node without throwing ERR_MODULE_NOT_FOUND
  const out = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'c2c-subset-shims-'));
  try {
    writeDeployTree(out, files);
    const handlerUrl = pathToFileURL(join(out, 'functions/c2c_api/aio/items/submit.mjs')).href;
    const mod = (await import(handlerUrl)) as { default: (req: unknown, res: { writeHead: (code: number) => void; end: (t: string) => void }) => Promise<void> };
    assert.equal(typeof mod.default, 'function');

    let responseData = '';
    const fakeRes = {
      writeHead: (_code: number) => {},
      end: (data: string) => {
        responseData = data;
      },
    };
    await mod.default({}, fakeRes);
    assert.equal(responseData, '{"ok":true,"id":"9007199254740993"}');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('subset shims: an app with a dynamic import gets the full set', () => {
  const handlerSource = `import { jsonReplacer } from "creator-to-catalyst/shims";
export const endpoint = { type: "advancedio", method: "POST", path: "/dynamic" };
export default async function handler(req, res) {
  const dyn = await import("creator-to-catalyst/shims");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }, jsonReplacer));
}
`;
  const generated: DeployFile[] = [
    { path: 'functions/aio/items/submit.mjs', data: handlerSource },
  ];
  const files = functionDir(generated, { mode: 'dry-run', subsetShims: true });
  const shimFiles = files.filter((f) => f.path.startsWith('functions/c2c_api/vendor/shims/'));
  const allShims = vendoredShims();

  // Failed closed: all shims are present
  assert.equal(shimFiles.length, allShims.length, 'all shims must be included when a dynamic import exists');
  const shimPaths = shimFiles.map((f) => f.path);
  assert.ok(shimPaths.some((p) => p.endsWith('/criteria.js')));
  assert.ok(shimPaths.some((p) => p.endsWith('/java-regex.js')));
  assert.ok(shimPaths.some((p) => p.endsWith('/runtime.js')));
  assert.ok(shimPaths.some((p) => p.endsWith('/zoho-adapters.js')));
});

test('subset shims: named import after an unrelated import is parsed independently', async () => {
  const generated: DeployFile[] = [
    { path: 'functions/c2c-mail.mjs', data: 'export const sendMail = () => {};' },
    {
      path: 'functions/aio/items/submit.mjs',
      data: `import { sendMail } from "../../c2c-mail.mjs";\nimport { compileCriteria } from "creator-to-catalyst/shims";\nexport { sendMail, compileCriteria };\n`,
    },
  ];
  const files = functionDir(generated, { mode: 'dry-run', subsetShims: true });
  const shimFiles = files.filter((f) => f.path.startsWith('functions/c2c_api/vendor/shims/'));
  assert.ok(shimFiles.some((f) => f.path.endsWith('/criteria.js')));

  const out = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'c2c-subset-shims-import-'));
  try {
    writeDeployTree(out, files);
    const handlerUrl = pathToFileURL(join(out, 'functions/c2c_api/aio/items/submit.mjs')).href;
    const mod = (await import(handlerUrl)) as { compileCriteria: unknown; sendMail: unknown };
    assert.equal(typeof mod.compileCriteria, 'function');
    assert.equal(typeof mod.sendMail, 'function');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('subset shims: every import form of an individual shim keeps the module', () => {
  const references = [
    'import "../../c2c_api/vendor/shims/criteria.js";',
    'import "../../c2c_api/vendor/shims/criteria";',
    'import compileCriteria from "../../c2c_api/vendor/shims/criteria.js";',
    'import * as criteria from "../../c2c_api/vendor/shims/criteria.js";',
    'import { compileCriteria } from "../../c2c_api/vendor/shims/criteria.js";',
    'export { compileCriteria } from "../../c2c_api/vendor/shims/criteria.js";',
    'export * from "../../c2c_api/vendor/shims/criteria.js";',
    'export * as criteria from "../../c2c_api/vendor/shims/criteria.js";',
    'const criteria = import("../../c2c_api/vendor/shims/criteria.js");',
    'import "../vendor/shims/criteria.js";',
  ];

  for (const data of references) {
    const generated: DeployFile[] = [{ path: 'functions/aio/reference.mjs', data }];
    const modules = computeShimModules(generated);
    assert.ok(modules !== null, data);
    assert.ok(modules.has('criteria.js'), data);
    const files = functionDir(generated, { mode: 'dry-run', subsetShims: true });
    assert.ok(
      files.some((f) => f.path === 'functions/c2c_api/vendor/shims/criteria.js'),
      data,
    );
  }
});

test('subset shims: a function reaching a shim only via a side-effect import loads', async () => {
  const generated: DeployFile[] = [
    {
      path: 'functions/aio/needs-criteria.mjs',
      data: 'import "../vendor/shims/criteria.js";\nexport const endpoint = { type: "advancedio", method: "POST", path: "/needs-criteria" };\n',
    },
  ];
  const files = functionDir(generated, { mode: 'dry-run', subsetShims: true });
  assert.ok(files.some((f) => f.path === 'functions/c2c_api/vendor/shims/criteria.js'));

  const out = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'c2c-subset-side-effect-'));
  try {
    writeDeployTree(out, files);
    const mod = (await import(pathToFileURL(join(out, 'functions/c2c_api/aio/needs-criteria.mjs')).href)) as { endpoint: { path: string } };
    assert.equal(mod.endpoint.path, '/needs-criteria');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('subset shims: named re-exports of the index resolve to their modules', () => {
  const generated: DeployFile[] = [
    { path: 'functions/aio/reexport.mjs', data: 'export { compileCriteria } from "creator-to-catalyst/shims";' },
  ];
  const modules = computeShimModules(generated);
  assert.ok(modules !== null);
  assert.ok(modules.has('criteria.js'));
  const files = functionDir(generated, { mode: 'dry-run', subsetShims: true });
  assert.ok(files.some((f) => f.path === 'functions/c2c_api/vendor/shims/criteria.js'));
});

test('subset shims: non-named references to the module fail closed', () => {
  const references = [
    'export * from "creator-to-catalyst/shims";',
    'const shims = require("creator-to-catalyst/shims");',
    'const shims = import("creator-to-catalyst/shims");',
    'import * as shims from "creator-to-catalyst/shims";',
    'import "creator-to-catalyst/shims";',
    'const shims = await import(name);',
    'const shims = await import(`./vendor/shims/${name}.js`);',
    'const shims = await import("../" + name);',
  ];

  for (const data of references) {
    const generated: DeployFile[] = [{ path: 'functions/aio/reference.mjs', data }];
    assert.equal(computeShimModules(generated), null, data);
    const files = functionDir(generated, { mode: 'dry-run', subsetShims: true });
    const shimFiles = files.filter((f) => f.path.startsWith('functions/c2c_api/vendor/shims/'));
    assert.equal(shimFiles.length, vendoredShims().length, data);
  }
});

test('subset shims: unknown symbols fail closed to the full set', () => {
  const generated: DeployFile[] = [
    { path: 'functions/aio/unknown.mjs', data: 'import { notARealShim } from "creator-to-catalyst/shims";' },
  ];
  assert.equal(computeShimModules(generated), null);
  const files = functionDir(generated, { mode: 'dry-run', subsetShims: true });
  const shimFiles = files.filter((f) => f.path.startsWith('functions/c2c_api/vendor/shims/'));
  assert.equal(shimFiles.length, vendoredShims().length);
});

test('subset shims: multiline dynamic imports fail closed', () => {
  const generated: DeployFile[] = [
    { path: 'functions/aio/dynamic.mjs', data: 'const shims = await import(\n  "creator-to-catalyst/shims"\n);' },
  ];
  assert.equal(computeShimModules(generated), null);
  const files = functionDir(generated, { mode: 'dry-run', subsetShims: true });
  const shimFiles = files.filter((f) => f.path.startsWith('functions/c2c_api/vendor/shims/'));
  assert.equal(shimFiles.length, vendoredShims().length);
});

test('subset shims: library ignores C2C_SUBSET_SHIMS environment setting', () => {
  const previous = process.env.C2C_SUBSET_SHIMS;
  process.env.C2C_SUBSET_SHIMS = '1';
  try {
    const generated: DeployFile[] = [
      { path: 'functions/aio/env.mjs', data: 'export default function handler() {};' },
    ];
    const files = functionDir(generated, { mode: 'dry-run' });
    const shimFiles = files.filter((f) => f.path.startsWith('functions/c2c_api/vendor/shims/'));
    assert.equal(shimFiles.length, vendoredShims().length);
  } finally {
    if (previous === undefined) delete process.env.C2C_SUBSET_SHIMS;
    else process.env.C2C_SUBSET_SHIMS = previous;
  }
});

test('subset shims: default output is unchanged when option is omitted', () => {
  const handlerSource = `import { jsonReplacer } from "creator-to-catalyst/shims";
export const endpoint = { type: "advancedio", method: "POST", path: "/items/submit" };
export default async function handler(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }, jsonReplacer));
}
`;
  const generated: DeployFile[] = [
    { path: 'functions/aio/items/submit.mjs', data: handlerSource },
  ];
  const filesDefault = functionDir(generated, { mode: 'dry-run' });
  const shimFilesDefault = filesDefault.filter((f) => f.path.startsWith('functions/c2c_api/vendor/shims/'));
  const allShims = vendoredShims();
  assert.equal(shimFilesDefault.length, allShims.length);
});

test('subset shims: computes byte savings on small fixture apps', () => {
  const allShims = vendoredShims();
  const allBytes = allShims.reduce((acc, f) => acc + Buffer.byteLength(f.data), 0);
  assert.ok(allBytes > 470000 && allBytes < 600000, `total shims size should remain in the expected range: ${allBytes}`);

  for (const appName of ['freight-forwarding', 'library-application-system']) {
    const fixtureDir = join(root, 'fixtures/redistributable', appName);
    const ir = parseProject(fixtureDir).ir;
    const defaultBundle = deployFiles(ir, guardFor(ir), false, { mode: 'dry-run', subsetShims: false });
    const subsetBundle = deployFiles(ir, guardFor(ir), false, { mode: 'dry-run', subsetShims: true });

    const defaultShims = defaultBundle.files.filter((f) => f.path.startsWith('functions/c2c_api/vendor/shims/'));
    const subsetShims = subsetBundle.files.filter((f) => f.path.startsWith('functions/c2c_api/vendor/shims/'));

    const defaultBytes = defaultShims.reduce((acc, f) => acc + Buffer.byteLength(f.data), 0);
    const subsetBytes = subsetShims.reduce((acc, f) => acc + Buffer.byteLength(f.data), 0);
    const savings = defaultBytes - subsetBytes;

    assert.ok(savings > 20000, `${appName} byte savings: ${savings} bytes`);
    assert.ok(subsetShims.length < defaultShims.length);
  }
});

test('appOrigins yields the API base origin and the Slate origin, exactly and deterministically', () => {
  const origins = appOrigins({
    apiBase: 'https://c2c-test-1001.development.catalystserverless.in/server/c2c_api',
    slateDomain: 'c2c-app-4f3a.onslate.in',
  });
  assert.deepEqual(origins, ['https://c2c-app-4f3a.onslate.in', 'https://c2c-test-1001.development.catalystserverless.in']);
  // A relative API base identifies no external function origin.
  assert.deepEqual(appOrigins({ apiBase: '/server/c2c_api', slateDomain: 'c2c-app-4f3a.onslate.in' }), ['https://c2c-app-4f3a.onslate.in']);
  // No inputs, no origins — the deploy writes no allowlist rather than guessing one.
  assert.deepEqual(appOrigins({}), []);
  // Malformed, wildcard and non-HTTP(S) values contribute nothing.
  assert.deepEqual(
    appOrigins({ apiBase: 'ftp://files.example.test/server/c2c_api', slateDomain: '*.onslate.in' }),
    [],
  );
  assert.deepEqual(appOrigins({ apiBase: 'not a url', slateDomain: '' }), []);
  // A full https slateDomain and a duplicated origin deduplicate and sort stably.
  assert.deepEqual(
    appOrigins({ apiBase: 'https://x.test:8443/server/c2c_api', slateDomain: 'https://x.test:8443/' }),
    ['https://x.test:8443'],
  );
});

test('the generated c2c-deploy.json stamps allowedOrigins only when origins are known', () => {
  const deployJson: DeployFile = { path: 'functions/c2c-deploy.json', data: '{"mode":"dry-run","dc":null,"appTimeZone":""}\n' };
  const withOrigins = functionDir([deployJson], {
    mode: 'live',
    origins: appOrigins({ apiBase: 'https://c2c-test-1001.development.catalystserverless.in/server/c2c_api', slateDomain: 'c2c-app-4f3a.onslate.in' }),
  });
  const config = JSON.parse(text(withOrigins, 'functions/c2c_api/c2c-deploy.json')) as { mode: string; allowedOrigins?: string[] };
  assert.equal(config.mode, 'live');
  assert.deepEqual(config.allowedOrigins, ['https://c2c-app-4f3a.onslate.in', 'https://c2c-test-1001.development.catalystserverless.in']);
  const without = functionDir([deployJson], { mode: 'live' });
  assert.equal('allowedOrigins' in (JSON.parse(text(without, 'functions/c2c_api/c2c-deploy.json')) as object), false);
});
