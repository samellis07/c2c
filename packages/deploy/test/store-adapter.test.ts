/**
 * The Data Store adapter (packages/deploy/fn/c2c-sdk-datastore.mjs) by column type, the
 * c2c-columns.json it reads, and the console environment a deploy carries in
 * catalyst-config.json env_variables (catalyst deploy replaces the console env with it).
 * Offline: a recorded fake SDK answers the way Data Store does (every value as text).
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';
import { deployFiles, writeDeployTree, type DeployFile } from '../src/plan.js';
import { columnTypes, envVariables } from '../src/function-dir.js';
import { deployCli, readFunctionEnv, type Io } from '../src/cli.js';

const root = repoRoot();

type Row = Record<string, unknown>;
interface Adapter {
  insert(form: string, rows: Row[]): Promise<Row[]>;
  update(form: string, rows: Row[]): Promise<Row[]>;
  delete(form: string, ids: unknown[]): Promise<unknown[]>;
  query(form: string, where: string, limit: number, offset?: number, orderBy?: string): Promise<Row[]>;
}
interface AdapterModule {
  createSdkDatastore(app: unknown, opts?: Record<string, unknown>): Adapter;
  wallTime(ms: number, timeZone: string): string;
}

async function adapterModule(): Promise<AdapterModule> {
  return (await import(pathToFileURL(join(root, 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href)) as AdapterModule;
}

const COLUMNS = { Task: { Done: 'Boolean', Due: 'DateTime', Owner: 'Foreign Key', Ref: 'BigInt' } };

/** Records every SDK call; ZCQL replays the given responses in order, writes echo like Data Store. */
function recordedSdk(replies: unknown[] = []) {
  const calls: [string, string, unknown][] = [];
  const next = (fallback: unknown) => fallback;
  const nextQuery = () => (replies.length ? replies.shift() : []);
  const app = {
    datastore: () => ({
      table: (name: string) => ({
        insertRows: async (rows: Row[]) => {
          calls.push(['insertRows', name, rows]);
          return next(rows.map((row, i) => ({ ...row, ROWID: String(9007199254740993n + BigInt(i)) })));
        },
        updateRows: async (rows: Row[]) => {
          calls.push(['updateRows', name, rows]);
          return next(rows);
        },
        deleteRows: async (ids: string[]) => {
          calls.push(['deleteRows', name, ids]);
          return next(ids.map((ROWID) => ({ ROWID })));
        },
      }),
    }),
    zcql: () => ({
      executeZCQLQuery: async (sql: string) => {
        calls.push(['zcql', '', sql]);
        return nextQuery();
      },
    }),
  };
  return { app, calls };
}

test('boolean columns: written as "true"/"false" text and read back as booleans, never the truthy string "false"', async () => {
  const { createSdkDatastore } = await adapterModule();
  const { app, calls } = recordedSdk([[{ Task: { ROWID: '1', Done: 'false' } }, { Task: { ROWID: '2', Done: 'TRUE' } }, { Task: { ROWID: '3', Done: null } }]]);
  const ds = createSdkDatastore(app, { columns: COLUMNS });
  await ds.insert('Task', [{ Done: true }, { Done: false }]);
  assert.deepEqual(calls[0]?.[2], [{ Done: 'true' }, { Done: 'false' }]);
  const rows = await ds.query('Task', '', 300);
  assert.deepEqual(rows.map((row) => row.Done), [false, true, null]);
  assert.equal(rows[0]?.Done ? 'truthy' : 'falsy', 'falsy');
});

test('datetime columns: wall time to the second; an instant is converted to the app time zone; reads come back ISO local', async () => {
  const { createSdkDatastore } = await adapterModule();
  const { app, calls } = recordedSdk([[{ Task: { ROWID: '1', Due: '2026-10-06 15:50:58' } }, { Task: { ROWID: '2', Due: '2026-10-06 15:50:58:123' } }]]);
  const ds = createSdkDatastore(app, { columns: COLUMNS, appTimeZone: 'Asia/Kolkata' });
  await ds.insert('Task', [
    { Due: '2026-10-06T15:50:58' },
    { Due: '2026-10-06T15:50:58.987' },
    { Due: '2026-10-06T10:20:58Z' },
    { Due: '2026-10-06T12:20:58+02:00' },
    { Due: new Date(Date.UTC(2026, 9, 6, 10, 20, 58)) },
    { Due: '2026-10-06' },
    { Due: null },
  ]);
  assert.deepEqual(
    (calls[0]?.[2] as Row[]).map((row) => row.Due),
    ['2026-10-06 15:50:58', '2026-10-06 15:50:58', '2026-10-06 15:50:58', '2026-10-06 15:50:58', '2026-10-06 15:50:58', '2026-10-06 00:00:00', null],
  );
  const rows = await ds.query('Task', '', 300);
  assert.deepEqual(rows.map((row) => row.Due), ['2026-10-06T15:50:58', '2026-10-06T15:50:58']);
});

test('an instant with no app time zone throws instead of guessing UTC', async () => {
  const { createSdkDatastore } = await adapterModule();
  const { app, calls } = recordedSdk();
  const ds = createSdkDatastore(app, { columns: COLUMNS });
  await assert.rejects(ds.insert('Task', [{ Due: '2026-10-06T10:20:58Z' }]), /Task\.Due is an instant; set C2C_APP_TIMEZONE/);
  assert.equal(calls.length, 0, 'nothing is written');
  // A wall time needs no zone.
  await ds.insert('Task', [{ Due: '2026-10-06T10:20:58' }]);
  assert.deepEqual(calls[0]?.[2], [{ Due: '2026-10-06 10:20:58' }]);
});

test('wallTime crosses a DST change in the zone, not on the host clock', async () => {
  const { wallTime } = await adapterModule();
  assert.equal(wallTime(Date.UTC(2026, 2, 8, 6, 59, 59), 'America/New_York'), '2026-03-08 01:59:59');
  assert.equal(wallTime(Date.UTC(2026, 2, 8, 7, 0, 0), 'America/New_York'), '2026-03-08 03:00:00');
  assert.equal(wallTime(Date.UTC(2026, 0, 1, 0, 0, 0), 'UTC'), '2026-01-01 00:00:00');
});

test('ids stay digit strings: ROWID, CREATORID, BigInt and Foreign Key columns; a lossy JS number throws', async () => {
  const { createSdkDatastore } = await adapterModule();
  const { app, calls } = recordedSdk([
    [{ Task: { ROWID: 12, CREATORID: 34, Owner: 56, Ref: '1000000000171021001', Name: 7 } }],
    [{ Task: { ROWID: 2 ** 53 + 2 } }],
  ]);
  const ds = createSdkDatastore(app, { columns: COLUMNS });
  const rows = await ds.query('Task', '', 300);
  assert.deepEqual(rows[0], { ROWID: '12', CREATORID: '34', Owner: '56', Ref: '1000000000171021001', Name: 7 });
  await assert.rejects(ds.query('Task', '', 300), /Task\.ROWID is the JS number 9007199254740994, which has lost digits/);
  const inserted = await ds.insert('Task', [{ Owner: 1000000000171021001n, Ref: 42 }]);
  assert.deepEqual(calls.at(-1)?.[2], [{ Owner: '1000000000171021001', Ref: '42' }]);
  assert.equal(inserted[0]?.ROWID, '9007199254740993');
  await assert.rejects(ds.insert('Task', [{ Owner: 1000000000171021001 }]), /Task\.Owner is the JS number/);
  await assert.rejects(ds.update('Task', [{ ROWID: 1000000000171021001, Done: true }]), /Task\.ROWID is the JS number/);
  await assert.rejects(ds.delete('Task', [1000000000171021001]), /Task\.ROWID is the JS number/);
  await ds.delete('Task', [1000000000171021001n, '1000000000171021002', 5]);
  assert.deepEqual(calls.at(-1), ['deleteRows', 'Task', ['1000000000171021001', '1000000000171021002', '5']]);
});

test('checkWrite runs before the SDK on insert and update; a refused row never reaches it', async () => {
  const { createSdkDatastore } = await adapterModule();
  const { assertWritable } = (await import('../../shims/src/write-rules.js')) as typeof import('../../shims/src/write-rules.js');
  const rules: Record<string, { name: string; dataType: string; length?: number; required?: boolean }[]> = {
    Task: [
      { name: 'Title', dataType: 'VarChar', length: 5, required: true },
      { name: 'Done', dataType: 'Boolean' },
    ],
  };
  const seen: [string, string, string][] = [];
  const { app, calls } = recordedSdk();
  const ds = createSdkDatastore(app, {
    columns: COLUMNS,
    checkWrite: (form: string, row: Row, kind: string) => {
      seen.push([form, kind, String(row.Title ?? '')]);
      return assertWritable(form, rules[form], row, { required: kind === 'insert' });
    },
  });
  await assert.rejects(ds.insert('Task', [{ Title: 'toolong' }]), /Task: write refused: Title \(text-length\)/);
  assert.equal(calls.length, 0, 'the refused insert never reached the SDK');
  assert.deepEqual(seen, [['Task', 'insert', 'toolong']]);
  await assert.rejects(ds.insert('Task', [{ Done: true }]), /mandatory-missing/);
  assert.equal(calls.length, 0);
  // An update is a partial row: a missing required column is allowed, a bad value is not.
  await ds.update('Task', [{ ROWID: '1', Title: 'ok' }]);
  assert.deepEqual(calls.at(-1)?.[0], 'updateRows');
  assert.deepEqual(seen.at(-1), ['Task', 'update', 'ok']);
  await assert.rejects(ds.update('Task', [{ ROWID: '1', Title: '' }]), /mandatory-missing/);
});

test('checkWrite sees the converted DateTime: fractional, date-only, instant, and Date values pass the write rules', async () => {
  const { createSdkDatastore } = await adapterModule();
  const { assertWritable } = (await import('../../shims/src/write-rules.js')) as typeof import('../../shims/src/write-rules.js');
  const rules: Record<string, { name: string; dataType: string }[]> = { Task: [{ name: 'Due', dataType: 'DateTime' }] };
  const seen: Row[] = [];
  const { app, calls } = recordedSdk();
  const ds = createSdkDatastore(app, {
    columns: COLUMNS,
    appTimeZone: 'Asia/Kolkata',
    checkWrite: (form: string, row: Row, kind: string) => {
      seen.push({ ...row });
      return assertWritable(form, rules[form], row, { required: kind === 'insert' });
    },
  });
  const instant = new Date(Date.UTC(2026, 9, 6, 10, 20, 58));
  await ds.insert('Task', [
    { Due: '2026-10-06T15:50:58.987' },
    { Due: '2026-10-06' },
    { Due: '2026-10-06T10:20:58Z' },
    { Due: instant },
  ]);
  assert.deepEqual(
    (calls[0]?.[2] as Row[]).map((row) => row.Due),
    ['2026-10-06 15:50:58', '2026-10-06 00:00:00', '2026-10-06 15:50:58', '2026-10-06 15:50:58'],
  );
  assert.deepEqual(
    seen.map((row) => row.Due),
    ['2026-10-06 15:50:58', '2026-10-06 00:00:00', '2026-10-06 15:50:58', '2026-10-06 15:50:58'],
  );
});

test('c2c-rules.json carries the schema write rules keyed like the runtime options', () => {
  const app = deriveIr(parse(`application "Tasks"
{
	form Vendor
	{
		must have Vendor_Name
		(
			type = text
			maxchar = 10
		)
		When
		(
			type = date
		)
	}
}
`));
  const { files } = deployFiles(app, guardFor(app), false, { mode: 'dry-run' });
  const rules = JSON.parse(text(files, 'functions/c2c_api/c2c-rules.json')) as Record<string, { name: string; required?: boolean; length?: number }[]>;
  const vendor = rules.Vendor;
  assert.ok(vendor, 'rules for the Vendor form');
  const name = vendor.find((column) => column.name === 'Vendor_Name');
  assert.equal(name?.required, true);
  assert.equal(name?.length, 10);
  assert.ok(vendor.some((column) => column.name === 'When'));
  assert.equal(Object.keys(rules).includes('All_Vendors'), false, 'report names are not keys');
});

test('a table without column types keeps the untyped conversion (ISO local datetimes only)', async () => {
  const { createSdkDatastore } = await adapterModule();
  const { app, calls } = recordedSdk([[{ Other: { ROWID: '1', Flag: 'false', At: '2026-10-06 15:50:58' } }]]);
  const ds = createSdkDatastore(app, { columns: COLUMNS });
  await ds.insert('Other', [{ Flag: true, At: '2026-10-06T15:50:58' }]);
  assert.deepEqual(calls[0]?.[2], [{ Flag: true, At: '2026-10-06 15:50:58' }]);
  assert.deepEqual(await ds.query('Other', '', 300), [{ ROWID: '1', Flag: 'false', At: '2026-10-06 15:50:58' }]);
});

const DS = `application "Tasks"
{
	time zone = "Asia/Kolkata"
	form Person
	{
		Name
		(
			type = text
		)
	}
	form Task
	{
		Title
		(
			type = text
		)
		Done
		(
			type = checkbox
		)
		Due
		(
			type = datetime
		)
		Assignee
		(
			type = picklist
			values = Person.Name
		)
	}
	list All_Tasks
	{
		show all rows from Task
	}
}
`;

function tasksApp(): App {
  return deriveIr(parse(DS));
}

const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

function guardFor(app: App): GuardOk {
  return { org: FIXTURE_ORG, projectId: '1001', environment: ALLOWED_ENV, projectName: catalystProjectName(app.name || 'app'), dc: 'in', registry: FIXTURE_REGISTRY };
}

function text(files: readonly DeployFile[], path: string): string {
  const file = files.find((item) => item.path === path);
  assert.ok(file, `missing ${path}`);
  return typeof file.data === 'string' ? file.data : file.data.toString('utf8');
}

test('c2c-columns.json lists the typed Data Store columns of every table, sorted', () => {
  const app = tasksApp();
  const { files, schema } = deployFiles(app, guardFor(app), false, { mode: 'dry-run' });
  const columns = JSON.parse(text(files, 'functions/c2c_api/c2c-columns.json')) as Record<string, Record<string, string>>;
  assert.deepEqual(columns, columnTypes(schema.tables));
  assert.equal(columns.Task?.Done, 'Boolean');
  assert.equal(columns.Task?.Due, 'DateTime');
  assert.ok(['Foreign Key', 'BigInt'].includes(String(columns.Task?.Assignee)), JSON.stringify(columns.Task));
  assert.equal(columns.Task?.Title, undefined, 'untyped columns are left out');
  assert.deepEqual(Object.keys(columns), [...Object.keys(columns)].sort());
  const nosql = columnTypes([{ name: 'B', nosql: false, columns: [{ name: 'z', dataType: 'Boolean' }, { name: 'a', dataType: 'DateTime' }] }, { name: 'A', nosql: true, columns: [{ name: 'x', dataType: 'Boolean' }] }]);
  assert.equal(JSON.stringify(nosql), '{"B":{"a":"DateTime","z":"Boolean"}}');
});

test('the Advanced I/O entry hands the adapter the column types and the app time zone: a report reads Done as a boolean', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-store-'));
  const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const app = tasksApp();
  writeDeployTree(out, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
  // The fixture app has no share_settings; give the signed-in role a profile to map to.
  writeFileSync(join(out, 'functions/c2c_api/access-policy.json'), JSON.stringify({ profiles: { Administrator: { Task: { write: true } } }, roles: [] }));
  const req = createRequire(import.meta.url);
  const sdk = req(fake) as {
    setSession(token: string, user: unknown): void;
    initialize(rq: unknown, opts: unknown): { datastore(): { table(name: string): { insertRows(rows: Row[]): Promise<Row[]> } } };
  };
  sdk.setSession('s1', { user_id: '1', role_details: { role_name: 'App Administrator' } });
  // As Data Store stores them: text.
  await sdk.initialize({}, { scope: 'admin' }).datastore().table('Task').insertRows([{ Title: 'Ship', Done: 'false', Due: '2026-10-06 15:50:58' }]);
  const entry = req(join(out, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
  const server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api/reports/All_Tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=s1' },
      body: JSON.stringify({ op: 'query' }),
    });
    const body = (await res.json()) as { rows?: Row[] };
    assert.equal(res.status, 200, JSON.stringify(body));
    const row = (body.rows ?? []).find((item) => item.Title === 'Ship');
    assert.ok(row, JSON.stringify(body));
    assert.equal(row.Done, false);
    assert.equal(row.Due, '2026-10-06T15:50:58');
    assert.equal(typeof row.ROWID, 'string');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    moduleAny._resolveFilename = original;
    rmSync(out, { recursive: true, force: true });
  }
});

test('env_variables carry the kept console environment, sorted, and C2C_DEPLOY_MODE is always this deploy\'s mode', () => {
  assert.deepEqual(envVariables('live', { ZETA: 'z', C2C_MAIL_FROM: 'a@example.test', C2C_DEPLOY_MODE: 'dry-run' }), {
    C2C_DEPLOY_MODE: 'live',
    C2C_MAIL_FROM: 'a@example.test',
    ZETA: 'z',
  });
  assert.throws(() => envVariables('live', { 'BAD-NAME': 'x' }), /"BAD-NAME" is not an environment variable name/);
  const app = tasksApp();
  const env = { C2C_OWNER_APPROVAL_TOKEN: 'tok', C2C_MAIL_FROM: 'ops@example.test', TABLE_ID: '1000000000171021' };
  const { files } = deployFiles(app, guardFor(app), false, { mode: 'live', functionEnv: env });
  const config = JSON.parse(text(files, 'functions/c2c_api/catalyst-config.json')) as { deployment: { env_variables: Record<string, string> } };
  // Secret names are kept with an empty value; non-secret values stay inline.
  assert.deepEqual(config.deployment.env_variables, { C2C_DEPLOY_MODE: 'live', C2C_MAIL_FROM: 'ops@example.test', C2C_OWNER_APPROVAL_TOKEN: '', TABLE_ID: '1000000000171021' });
  for (const key of Object.keys(env)) assert.ok(key in config.deployment.env_variables, `${key} would be erased`);
  // Input order does not change the bytes.
  const reversed = deployFiles(app, guardFor(app), false, { mode: 'live', functionEnv: Object.fromEntries(Object.entries(env).reverse()) }).files;
  assert.equal(text(reversed, 'functions/c2c_api/catalyst-config.json'), text(files, 'functions/c2c_api/catalyst-config.json'));
});

test('readFunctionEnv: --confirm needs the console env (or "new"); values must be strings; only key names are reported', () => {
  assert.equal(readFunctionEnv(undefined, false), undefined);
  assert.throws(() => readFunctionEnv(undefined, true), /--confirm needs --function-env <file>.*or --function-env new/);
  assert.deepEqual(readFunctionEnv('new', true), {});
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fenv-'));
  try {
    const good = join(dir, 'env.json');
    writeFileSync(good, JSON.stringify({ C2C_MAIL_FROM: 'ops@example.test' }));
    assert.deepEqual(readFunctionEnv(good, true), { C2C_MAIL_FROM: 'ops@example.test' });
    const numeric = join(dir, 'n.json');
    writeFileSync(numeric, JSON.stringify({ PORT: 8080 }));
    assert.throws(() => readFunctionEnv(numeric, true), /PORT must be a string/);
    const list = join(dir, 'l.json');
    writeFileSync(list, '["A"]');
    assert.throws(() => readFunctionEnv(list, true), /JSON object/);
    assert.throws(() => readFunctionEnv(join(dir, 'missing.json'), true), /readable JSON file/);
    const secret = join(dir, 's.json');
    writeFileSync(secret, JSON.stringify({ 'bad name': 'SECRET_VALUE_SHOULD_NOT_PRINT' }));
    assert.throws(
      () => readFunctionEnv(secret, true),
      (err: Error) => /not an environment variable name/.test(err.message) && !err.message.includes('SECRET_VALUE'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy --confirm without --function-env refuses before any spawn or REST call; with a file the env reaches catalyst-config.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fenv-deploy-'));
  const ds = join(dir, 'app.ds');
  writeFileSync(ds, DS);
  const projects = join(dir, 'projects.json');
  writeFileSync(projects, JSON.stringify({ org: FIXTURE_ORG, dc: 'in', env: 'Development', projects: { [catalystProjectName('Tasks')]: '1001' } }));
  let spawned = 0;
  let rested = 0;
  let stderr = '';
  let stdout = '';
  const io: Io = {
    env: { X_ZC_CREDENTIAL_PATH: join(dir, 'cred') },
    stdout: (s: string) => void (stdout += s),
    stderr: (s: string) => void (stderr += s),
    spawn: async () => {
      spawned += 1;
      return { code: 1, stdout: '', stderr: 'stop' };
    },
    rest: async () => {
      rested += 1;
      return { status: 500, body: {} };
    },
  } as unknown as Io;
  try {
    const base = [ds, '--project', '1001', '--org', FIXTURE_ORG, '--projects', projects];
    const refused = await deployCli([...base, '--confirm'], io);
    assert.notEqual(refused, 0);
    assert.match(stderr, /--confirm needs --function-env/);
    assert.equal(spawned + rested, 0);
    const envFile = join(dir, 'env.json');
    writeFileSync(envFile, JSON.stringify({ C2C_MAIL_FROM: 'SECRET_VALUE_SHOULD_NOT_PRINT' }));
    const out = join(dir, 'out');
    assert.equal(await deployCli([...base, '--out', out, '--function-env', envFile], io), 0, stderr);
    const config = JSON.parse(readFileSync(join(out, 'functions/c2c_api/catalyst-config.json'), 'utf8')) as { deployment: { env_variables: Record<string, string> } };
    assert.deepEqual(config.deployment.env_variables, { C2C_DEPLOY_MODE: 'dry-run', C2C_MAIL_FROM: 'SECRET_VALUE_SHOULD_NOT_PRINT' });
    assert.ok(!stdout.includes('SECRET_VALUE'), 'the plan never prints an env value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
