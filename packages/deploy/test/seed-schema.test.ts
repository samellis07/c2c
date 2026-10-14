import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse, parseFile } from '../../core/src/index.js';
import { canonicalSeedJson, generateSeed } from '../../data/src/seed.js';
import { emptyCheckpoint, type FetchLike, type MigrateResponse } from '../../data/src/migrate.js';
import { seedMigrateCli, type Io } from '../src/index.js';
import { assertSeedReferences, foreignKeysForApp } from '../src/remap.js';
import { migrateSeed, parseSeed, parseSeedBlocked, type SeedTable } from '../src/seed.js';

const SCOPE = { org: '10000000000', projectId: '1001', token: 'test-cli-token' };

const DS = `application "Widget"
{
\tform Author
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
\t}
\tform Node
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tParent
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Node.Name
\t\t)
\t}
}
`;

function response(body: unknown, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

interface StoredRow {
  rowid: string;
  columns: Record<string, string>;
}

/** In-memory Data Store: ZCQL reconcile + ROWID lookup queries, row-batch writes, row updates. */
function storeFetch(calls: string[]): { fetch: FetchLike; stored: Map<string, Map<string, StoredRow>> } {
  const stored = new Map<string, Map<string, StoredRow>>();
  let seq = 1;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('seed migrate called Creator');
    calls.push(`${method} ${new URL(url).pathname}`);
    const path = new URL(url).pathname;
    if (path.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
      const rows = stored.get(table) ?? new Map<string, StoredRow>();
      if (/^SELECT ROWID, c2c_source_id FROM /i.test(sql)) {
        return response({ data: [...rows].map(([source, row]) => ({ c2c_source_id: source, ROWID: row.rowid })) });
      }
      return response({ data: [...rows].map(([source, row]) => ({ ...row.columns, c2c_source_id: source, ROWID: row.rowid })) });
    }
    if (method === 'PUT') {
      const table = decodeURIComponent(path.split('/').at(-2) ?? '');
      const bucket = stored.get(table) ?? new Map<string, StoredRow>();
      const list = JSON.parse(init?.body ?? '[]') as Record<string, string>[];
      for (const update of list) {
        for (const row of bucket.values()) {
          if (row.rowid === update.ROWID) Object.assign(row.columns, update);
        }
      }
      stored.set(table, bucket);
      return response({});
    }
    const table = decodeURIComponent(path.split('/').at(-2) ?? '');
    const parsed: unknown = JSON.parse(init?.body ?? '[]');
    const records = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
        ? (parsed as { rows: unknown[] }).rows
        : [];
    const bucket = stored.get(table) ?? new Map<string, StoredRow>();
    const acked: { c2c_source_id: string }[] = [];
    for (const row of records) {
      const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      const nested = record.columns;
      const sourceObj = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : record;
      const columns: Record<string, string> = {};
      for (const [key, value] of Object.entries(sourceObj)) {
        if (typeof value === 'string') columns[key] = value;
      }
      const source = columns.c2c_source_id ?? (typeof record.id === 'string' ? record.id : '');
      if (source && !columns.c2c_source_id) columns.c2c_source_id = source;
      bucket.set(source, { rowid: `rowid-${table}-${seq++}`, columns });
      acked.push({ c2c_source_id: source });
    }
    stored.set(table, bucket);
    return response({ data: acked });
  };
  return { fetch, stored };
}

const BOOK_KEYS = [{ table: 'Book', column: 'Author', parent: 'Author' }];

test('parseSeed reads the legacy tables shape, the canonical form map, and synthetic seed.json', () => {
  const legacy = parseSeed(JSON.stringify({ version: 1, tables: [{ table: 'Author', rows: [{ c2c_source_id: 'a1', Name: 'Ada' }] }] }));
  assert.deepEqual(legacy, [{ table: 'Author', rows: [{ id: 'a1', columns: { Name: 'Ada' } }] }]);
  const canonical = parseSeed(JSON.stringify({ Author: [{ c2c_source_id: 'a1', Name: 'Ada' }] }));
  assert.deepEqual(canonical, legacy);
  const synthetic = parseSeed(
    JSON.stringify({ app_name: 'tiny', forms: { Author: [{ Name: 'Ada' }], Book: [{ Title: 'T', Author: { $ref: 'Author', key: 'Name', index: 0 } }] } }),
    { today: '2026-01-15' },
  );
  assert.deepEqual(synthetic, [
    { table: 'Author', rows: [{ id: 'Author#1', columns: { Name: 'Ada' } }] },
    { table: 'Book', rows: [{ id: 'Book#1', columns: { Title: 'T', Author: 'Author#1' } }] },
  ]);
  assert.throws(() => parseSeed(JSON.stringify({ version: 2, tables: [] })), /seed version must be 1/);
  assert.throws(() => parseSeed(JSON.stringify({})), /no tables/);
});

test('a parent/child seed remaps the child lookup to the parent ROWID', async () => {
  const tables: SeedTable[] = [
    { table: 'Author', rows: [{ id: 'a1', columns: { Name: 'Ada' } }, { id: 'a2', columns: { Name: 'Lin' } }] },
    { table: 'Book', rows: [{ id: 'b1', columns: { Title: 'T', Author: 'a1' } }] },
  ];
  const calls: string[] = [];
  const { fetch, stored } = storeFetch(calls);
  const result = await migrateSeed({
    tables,
    foreignKeys: BOOK_KEYS,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true);
  const parentRowid = stored.get('Author')!.get('a1')!.rowid;
  assert.equal(stored.get('Book')!.get('b1')!.columns.Author, parentRowid);
});

test('subform rows keep their lookups on read-back and a broken reference names its row id', async () => {
  const tables = parseSeed(JSON.stringify({
    app_name: 'orders',
    forms: {
      Product: [{ SKU: 'a' }, { SKU: 'b' }],
      Order: [
        { Lines: [{ $ref: 'Product', key: 'SKU', index: 0 }, { $ref: 'Product', key: 'SKU', index: 1 }] },
        { Lines: [{ $ref: 'Product', key: 'SKU', index: 1 }] },
      ],
    },
  }), { today: '2026-01-15' });
  assert.deepEqual(
    tables.find((table) => table.table === 'Order__Lines')?.rows.map((row) => row.id),
    ['Order__Lines#1#1', 'Order__Lines#1#2', 'Order__Lines#2#1'],
  );
  const keys = [
    { table: 'Order__Lines', column: 'Lines', parent: 'Product' },
    { table: 'Order__Lines', column: 'parent_id', parent: 'Order' },
  ];
  const calls: string[] = [];
  const { fetch, stored } = storeFetch(calls);
  const result = await migrateSeed({
    tables,
    foreignKeys: keys,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true);
  const line = stored.get('Order__Lines')!.get('Order__Lines#1#2')!;
  assert.equal(line.columns.parent_id, stored.get('Order')!.get('Order#1')!.rowid);
  assert.equal(line.columns.Lines, stored.get('Product')!.get('Product#2')!.rowid);
  assert.equal(line.columns.row_order, '1');
  const broken = tables.map((table) => table.table === 'Order__Lines'
    ? {
      ...table,
      rows: table.rows.map((row) => row.id === 'Order__Lines#2#1'
        ? { ...row, columns: { ...row.columns, Lines: 'Product#9' } }
        : row),
    }
    : table);
  assert.throws(
    () => assertSeedReferences(broken, keys),
    /lookup Order__Lines\.Lines row Order__Lines#2#1 source id Product#9 is not in Product/,
  );
  const written = calls.length;
  await assert.rejects(
    () => migrateSeed({
      tables: broken,
      foreignKeys: keys,
      dc: 'in',
      catalystBase: 'https://api.catalyst.zoho.in',
      dryRun: false,
      fetch,
      checkpoint: emptyCheckpoint(),
      scope: SCOPE,
    }),
    /lookup Order__Lines\.Lines row Order__Lines#2#1 source id Product#9 is not in Product/,
  );
  assert.equal(calls.length, written, 'a broken reference is refused before any write');
});

test('a self-lookup is deferred and set with a row update once both sides have ROWIDs', async () => {
  const tables: SeedTable[] = [
    { table: 'Node', rows: [{ id: 'n1', columns: { Name: 'root' } }, { id: 'n2', columns: { Name: 'leaf', Parent: 'n1' } }] },
  ];
  const calls: string[] = [];
  const { fetch, stored } = storeFetch(calls);
  const result = await migrateSeed({
    tables,
    foreignKeys: [{ table: 'Node', column: 'Parent', parent: 'Node' }],
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true);
  assert.ok(calls.some((call) => call.startsWith('PUT')), `no row update issued: ${calls.join(', ')}`);
  const root = stored.get('Node')!.get('n1')!.rowid;
  assert.equal(stored.get('Node')!.get('n2')!.columns.Parent, root);
});

test('a seed referencing an unknown parent id is refused before any write', async () => {
  const tables: SeedTable[] = [
    { table: 'Author', rows: [{ id: 'a1', columns: { Name: 'Ada' } }] },
    { table: 'Book', rows: [{ id: 'b1', columns: { Title: 'T', Author: 'ghost' } }] },
  ];
  for (const dryRun of [false, true]) {
    const calls: string[] = [];
    const { fetch } = storeFetch(calls);
    await assert.rejects(
      () =>
        migrateSeed({
          tables,
          foreignKeys: BOOK_KEYS,
          dc: 'in',
          catalystBase: 'https://api.catalyst.zoho.in',
          dryRun,
          fetch,
          checkpoint: emptyCheckpoint(),
          ...(dryRun ? {} : { scope: SCOPE }),
        }),
      /ghost/,
    );
    assert.deepEqual(calls, [], `a fetch ran before the refusal (dryRun=${dryRun})`);
  }
});

test('a seed column the schema does not define is refused before any write', async () => {
  const tables: SeedTable[] = [
    { table: 'Book', rows: [{ id: 'b1', columns: { Title: 'T', Extra: 'nope' } }] },
  ];
  for (const dryRun of [false, true]) {
    const calls: string[] = [];
    const { fetch } = storeFetch(calls);
    await assert.rejects(
      () =>
        migrateSeed({
          tables,
          dc: 'in',
          catalystBase: 'https://api.catalyst.zoho.in',
          dryRun,
          fetch,
          checkpoint: emptyCheckpoint(),
          columnsByTable: { Book: [{ name: 'Title', dataType: 'VarChar' }] },
          ...(dryRun ? {} : { scope: SCOPE }),
        }),
      /seed table Book column Extra is not in the app schema/,
    );
    assert.deepEqual(calls, [], `a fetch ran before the refusal (dryRun=${dryRun})`);
  }
});

test('c2c seed output parses and loads: the child lookup holds the parent ROWID', async () => {
  const app = deriveIr(parse(DS));
  const seed = generateSeed(app, { n: 2, seed: 'library' });
  // What `c2c seed --out` writes as seed.json.
  const tables = parseSeed(canonicalSeedJson(seed.tables));
  const calls: string[] = [];
  const { fetch, stored } = storeFetch(calls);
  const result = await migrateSeed({
    tables,
    foreignKeys: foreignKeysForApp(app).filter((key) => key.table !== 'Node'),
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true);
  const authorRowids = new Set([...stored.get('Author')!.values()].map((row) => row.rowid));
  for (const row of stored.get('Book')!.values()) {
    assert.ok(authorRowids.has(row.columns.Author), `Book.Author ${row.columns.Author} is not an Author ROWID`);
  }
});

function cliCapture(fetch: FetchLike): { io: Io; stdout: () => string; stderr: () => string; fetched: string[] } {
  let out = '';
  let err = '';
  const fetched: string[] = [];
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env: { X_ZC_CREDENTIAL_PATH: '/tmp/c2c-test-cred' },
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    rest: async (call) => {
      if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) {
        const projectId = call.path.split('/').at(-1) ?? '';
        return {
          status: 200,
          body: {
            status: 'success',
            data: {
              id: projectId,
              project_name: 'c2c-widget',
              project_type: 'Live',
              timezone: 'Asia/Kolkata',
              project_domain_details: { project_domain_id: '10', project_domain_name: 'c2c-widget' },
              env_details: [
                {
                  env_name: 'Development',
                  env_type: 1,
                  env_zgid: '10000000000',
                  id: '10000000000',
                  is_default: true,
                  project_details: { id: projectId, project_name: 'c2c-widget' },
                },
              ],
            },
          },
        };
      }
      return { status: 404, body: {} };
    },
    fetch: async (url, init) => {
      fetched.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      return fetch(url, init);
    },
    accessToken: async () => SCOPE.token,
  };
  return { io, stdout: () => out, stderr: () => err, fetched };
}

function writeCliFiles(seed: unknown): { dir: string; ds: string; seedPath: string; projects: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-seed-cli-'));
  const ds = join(dir, 'app.ds');
  writeFileSync(ds, DS);
  const seedPath = join(dir, 'seed.json');
  writeFileSync(seedPath, JSON.stringify(seed));
  const projects = join(dir, 'projects.json');
  writeFileSync(projects, JSON.stringify({ org: '10000000000', dc: 'in', env: 'Development', projects: { 'c2c-widget': '1001' } }));
  return { dir, ds, seedPath, projects };
}

const CANONICAL_SEED = {
  Author: [{ c2c_source_id: 'a1', Name: 'Ada' }],
  Book: [{ c2c_source_id: 'b1', Title: 'T', Author: 'a1' }],
};

test('migrate-data --seed plans by default and remaps lookups with --ds --confirm', async () => {
  const { ds, seedPath, projects } = writeCliFiles(CANONICAL_SEED);
  const base = ['--seed', seedPath, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projects];
  const planned = cliCapture(async () => {
    throw new Error('plan must not fetch');
  });
  const planCode = await seedMigrateCli([...base, '--ds', ds], planned.io);
  assert.equal(planCode, 0);
  assert.match(planned.stdout(), /writes: no/);
  assert.match(planned.stdout(), /- Author source 1/);
  assert.deepEqual(planned.fetched, []);
  const calls: string[] = [];
  const { fetch, stored } = storeFetch(calls);
  const live = cliCapture(fetch);
  const liveCode = await seedMigrateCli([...base, '--ds', ds, '--confirm'], live.io);
  assert.equal(liveCode, 0);
  assert.match(live.stdout(), /Book: source 1 written 1 mismatch false/);
  assert.equal(stored.get('Book')!.get('b1')!.columns.Author, stored.get('Author')!.get('a1')!.rowid);
});

test('migrate-data --seed --ds refuses a seed table outside the app schema before any write', async () => {
  const { ds, seedPath, projects } = writeCliFiles({ Nope: [{ c2c_source_id: 'x1', Name: 'x' }] });
  const live = cliCapture(async () => {
    throw new Error('refused seed must not fetch');
  });
  const code = await seedMigrateCli(
    ['--seed', seedPath, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projects, '--ds', ds, '--confirm'],
    live.io,
  );
  assert.equal(code, 1);
  assert.match(live.stderr(), /not in the app schema/);
  assert.deepEqual(live.fetched, []);
});

test('migrate-data --seed with file columns verifies the Stratus first-use gate before any write', async () => {
  const { dir, seedPath, projects } = writeCliFiles({ Doc: [{ c2c_source_id: 'd1', Title: 'T' }] });
  const ds = join(dir, 'files.ds');
  writeFileSync(ds, 'application "Widget"\n{\n\tform Doc\n\t{\n\t\tTitle\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t\tAttachment\n\t\t(\n\t\t\ttype = file upload\n\t\t)\n\t}\n}\n');
  const live = cliCapture(async () => {
    throw new Error('a closed gate must not write');
  });
  const inner = live.io.rest!;
  const probes: string[] = [];
  live.io.rest = async (call) => {
    if (call.method === 'GET' && call.path === '/baas/v1/project/1001/bucket') {
      probes.push(call.path);
      return { status: 404, body: { status: 'failure', data: { error_code: 'INVALID_URL_PATTERN', message: 'Please check if the URL trying to access is a correct one' } } };
    }
    return inner(call);
  };
  const code = await seedMigrateCli(['--seed', seedPath, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projects, '--ds', ds, '--confirm'], live.io);
  assert.equal(code, 1);
  assert.deepEqual(probes, ['/baas/v1/project/1001/bucket']);
  assert.match(live.stderr(), /Stratus first-use gate is closed \(GET \/baas\/v1\/project\/<project>\/bucket → 404/);
  assert.match(live.stderr(), /Cloud Scale → Stratus → Start Exploring/);
  assert.deepEqual(live.fetched, []);
  rmSync(dir, { recursive: true, force: true });
});

const FIXTURES = process.env.C2C_FIXTURES_DIR;
const CORPUS_SEED = FIXTURES ? join(FIXTURES, 'synthetic/s01-purchase-orders/L3/seed.json') : '';
const CORPUS_DS = FIXTURES ? join(FIXTURES, 'synthetic/s01-purchase-orders/L3/c2c-syn-po-l3.ds') : '';
const hasCorpus = Boolean(FIXTURES && existsSync(CORPUS_SEED) && existsSync(CORPUS_DS));

test('a synthetic seed.json round-trips with lookups remapped to ROWIDs', { skip: hasCorpus ? undefined : 'C2C_FIXTURES_DIR corpus missing' }, async () => {
  const app = parseFile(CORPUS_DS).ir;
  const keys = foreignKeysForApp(app);
  assert.ok(keys.some((key) => key.table === 'Purchase_Order' && key.column === 'Vendor' && key.parent === 'Vendor'));
  assert.ok(keys.some((key) => key.table === 'Department' && key.column === 'Cost_Center' && key.parent === 'Cost_Center'));
  const tables = parseSeed(readFileSync(CORPUS_SEED, 'utf8'), { today: '2026-01-15', loginUser: 'tester@example.com' });
  const calls: string[] = [];
  const { fetch, stored } = storeFetch(calls);
  const result = await migrateSeed({
    tables,
    foreignKeys: keys,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true);
  const rowids = new Map<string, Set<string>>();
  for (const [table, rows] of stored) rowids.set(table, new Set([...rows.values()].map((row) => row.rowid)));
  const sourceIds = new Set<string>();
  for (const table of tables) for (const row of table.rows) sourceIds.add(row.id);
  for (const key of keys) {
    const rows = stored.get(key.table);
    if (!rows) continue;
    for (const row of rows.values()) {
      const value = row.columns[key.column];
      if (!value) continue;
      assert.equal(sourceIds.has(value), false, `${key.table}.${key.column} still holds source id ${value}`);
      assert.ok(rowids.get(key.parent)?.has(value), `${key.table}.${key.column} ${value} is not a ROWID in ${key.parent}`);
    }
  }
  const po = [...stored.get('Purchase_Order')!.values()].find((row) => row.columns.c2c_source_id === 'Purchase_Order#1')!;
  assert.equal(po.columns.Order_Date, '2026-01-16');
  assert.equal(po.columns.Approver, 'tester@example.com');
  assert.equal(po.columns.Vendor, stored.get('Vendor')!.get('Vendor#1')!.rowid);
  const lines = [...stored.get('Purchase_Order__Line_Items')!.values()].filter((row) => row.columns.parent_id === po.rowid);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(rowids.get('Product')!.has(line.columns.Product), `line Product ${line.columns.Product} is not a Product ROWID`);
  }
});

test('migrate-data --seed refuses if --app does not match the app in --ds', async () => {
  const { ds, seedPath, projects } = writeCliFiles({ Book: [{ c2c_source_id: 'b1', Name: 'b' }] });
  const live = cliCapture(async () => {
    throw new Error('must not fetch');
  });
  const code = await seedMigrateCli(
    ['--seed', seedPath, '--app', 'Mismatch', '--project', '1001', '--org', '10000000000', '--projects', projects, '--ds', ds, '--confirm'],
    live.io,
  );
  assert.equal(code, 2);
  assert.match(live.stderr(), /does not match --app/);
});

test('a seed with an omitted form due to missing mandatory choices does not trigger a POST and handles MANDATORY_MISSING if it did', async () => {
  const app = deriveIr(parse(`application "Widget"\n{\n\tform Tags\n\t{\n\t\tmust have Picks\n\t\t(\n\t\t\ttype = checkboxes\n\t\t)\n\t}\n\tform Keeps\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n}\n`));
  const seed = generateSeed(app, { n: 2, seed: 'library' });
  const tables = parseSeed(canonicalSeedJson(seed.tables));
  const calls: string[] = [];
  const { fetch: baseFetch } = storeFetch(calls);
  const fetch: FetchLike = async (url, init) => {
    if (init?.method === 'POST' && url.includes('Tags')) {
      calls.push(`POST /Tags (blocked)`);
      return response({ status: 'failure', data: { error_code: 'MANDATORY_MISSING', message: 'missing field' } }, 403);
    }
    return baseFetch(url, init);
  };
  const result = await migrateSeed({
    tables,
    foreignKeys: foreignKeysForApp(app),
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true);
  assert.ok(calls.some(c => c.includes('POST') && c.includes('Keeps')));
  assert.ok(!calls.some(c => c.includes('Tags')));
});


test('migrate-data --seed names a blocked table and exits non-zero while the rest loads', async () => {
  const seedFile = {
    Author: [{ c2c_source_id: 'a1', Name: 'Ada' }],
    Book: [{ c2c_source_id: 'b1', Title: 'T', Author: 'a1' }],
    c2c_blocked: [{ form: 'Parent', field: 'Picks', reason: 'required choice field has no choices' }],
  };
  // The blocked record is not a table.
  assert.deepEqual(
    parseSeed(JSON.stringify(seedFile)).map((table) => table.table),
    ['Author', 'Book'],
  );
  const { ds, seedPath, projects } = writeCliFiles(seedFile);
  const base = ['--seed', seedPath, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projects, '--ds', ds];
  const planned = cliCapture(async () => {
    throw new Error('plan must not fetch');
  });
  const planCode = await seedMigrateCli(base, planned.io);
  assert.equal(planCode, 1);
  assert.match(planned.stdout(), /blocked:/);
  assert.match(planned.stdout(), /- Parent\/Picks: required choice field has no choices/);
  assert.deepEqual(planned.fetched, []);
  const calls: string[] = [];
  const { fetch, stored } = storeFetch(calls);
  const live = cliCapture(fetch);
  const liveCode = await seedMigrateCli([...base, '--confirm'], live.io);
  assert.equal(liveCode, 1);
  assert.match(live.stdout(), /blocked Parent\/Picks: required choice field has no choices/);
  assert.equal(stored.get('Parent'), undefined);
  assert.equal(stored.get('Book')!.get('b1')!.columns.Author, stored.get('Author')!.get('a1')!.rowid);
});

test('c2c seed writes the c2c_blocked record for a form it refused', () => {
  const app = deriveIr(
    parse(
      `application "Widget"\n{\n\tform Parent\n\t{\n\t\tmust have Picks\n\t\t(\n\t\t\ttype = checkboxes\n\t\t)\n\t}\n\tform Keeps\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n}\n`,
    ),
  );
  const seed = generateSeed(app, { n: 2, seed: 'library' });
  const parsed = JSON.parse(canonicalSeedJson(seed.tables, seed.blockers)) as Record<string, unknown>;
  assert.deepEqual(parsed.c2c_blocked, [{ form: 'Parent', field: 'Picks', reason: 'required choice field has no choices; add choices in the source app or make it optional' }]);
  assert.deepEqual(Object.keys(parsed).filter((key) => key !== 'c2c_blocked'), ['Keeps']);
  assert.deepEqual(parseSeed(canonicalSeedJson(seed.tables, seed.blockers)).map((table) => table.table), ['Keeps']);
});

test('a seed that only carries c2c_blocked names every blocked table and writes nothing', async (t) => {
  const app = deriveIr(
    parse(
      `application "Widget"\n{\n\tform Parent\n\t{\n\t\tmust have Picks\n\t\t(\n\t\t\ttype = checkboxes\n\t\t)\n\t}\n}\n`,
    ),
  );
  const generated = generateSeed(app, { n: 2, seed: 'library' });
  assert.equal(generated.tables.length, 0);
  const { dir, ds, seedPath, projects } = writeCliFiles(JSON.parse(canonicalSeedJson(generated.tables, generated.blockers)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = ['--seed', seedPath, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projects, '--ds', ds];
  const planned = cliCapture(async () => {
    throw new Error('plan must not fetch');
  });
  const planCode = await seedMigrateCli(base, planned.io);
  assert.equal(planCode, 1);
  assert.match(planned.stdout(), /- Parent\/Picks: required choice field has no choices/);
  assert.equal(planned.stderr().includes('seed file has no tables'), false);
  const live = cliCapture(async () => {
    throw new Error('nothing to load must not fetch');
  });
  const liveCode = await seedMigrateCli([...base, '--confirm'], live.io);
  assert.equal(liveCode, 1);
  assert.match(live.stdout(), /blocked Parent\/Picks: required choice field has no choices/);
  assert.equal(live.stderr().includes('seed file has no tables'), false);
});

test('a c2c_blocked entry carrying c2c_source_id is a table row, not a blocker record', async (t) => {
  const seedFile = {
    c2c_blocked: [{ c2c_source_id: 'x1', form: 'Fake', reason: 'planted' }],
    Author: [{ c2c_source_id: 'k1', Name: 'n' }],
  };
  assert.deepEqual(parseSeedBlocked(JSON.stringify(seedFile)), []);
  assert.deepEqual(parseSeed(JSON.stringify(seedFile)).map((table) => table.table), ['Author']);
  const { dir, ds, seedPath, projects } = writeCliFiles(seedFile);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const planned = cliCapture(async () => {
    throw new Error('plan must not fetch');
  });
  const code = await seedMigrateCli(
    ['--seed', seedPath, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projects, '--ds', ds],
    planned.io,
  );
  assert.equal(code, 0);
  assert.match(planned.stdout(), /- Author source 1/);
});
