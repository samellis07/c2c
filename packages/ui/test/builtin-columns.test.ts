/**
 * Creator's built-in record columns Added_Location, Modified_Location and
 * Record_Status are real generated columns. The generated submit endpoint
 * stamps the browser position the form captured (never a client-written
 * column), a denied or malformed position leaves the columns null, and the
 * report cells read the stored columns.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { generateSchema } from '../../schema/src/generator.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);

const SOURCE = `application "Demo"
{
${tab(1)}time zone = "UTC"
${tab(1)}form Visit
${tab(1)}{
${tab(2)}Name
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(1)}}
${tab(1)}form Plain
${tab(1)}{
${tab(2)}Title
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(1)}}
${tab(1)}list Visit_All
${tab(1)}{
${tab(2)}show all rows from Visit
${tab(2)}(
${tab(3)}Name
${tab(3)}Added_Location as "Added Location"
${tab(3)}Modified_Location as "Modified Location"
${tab(3)}Record_Status as "Record Status"
${tab(2)})
${tab(1)}}
${tab(1)}list Plain_All
${tab(1)}{
${tab(2)}show all rows from Plain
${tab(2)}(
${tab(3)}Title
${tab(2)})
${tab(1)}}
${tab(1)}share_settings
${tab(1)}{
${tab(2)}"Staff"
${tab(2)}{
${tab(3)}name = "Staff"
${tab(3)}type = Users_Permissions
${tab(3)}ModulePermissions
${tab(3)}{
${tab(4)}Visit
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Visit_All = {"View","Edit"}
${tab(5)}}
${tab(4)}}
${tab(4)}Plain
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Plain_All = {"View","Edit"}
${tab(5)}}
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
}
`;

interface FakeSdk {
  initialize(req: unknown): { datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> } } };
  state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
}

function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body: string) {
      raw = body;
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }));
}

const staff = { user: { profile: 'Staff', loginUser: 'ada@example.test' } };

test('the schema stores the built-in columns only on forms whose reports list them', () => {
  const plan = generateSchema(deriveIr(parse(SOURCE)));
  const names = (form: string) => plan.tables.find((t) => t.form === form && t.role === 'form')!.columns.map((c) => c.name);
  for (const name of ['Added_Location_latitude', 'Added_Location_longitude', 'Modified_Location_latitude', 'Modified_Location_longitude', 'Record_Status']) {
    assert.ok(names('Visit').includes(name), `Visit has ${name}`);
    assert.ok(!names('Plain').includes(name), `Plain has no ${name}`);
  }
  const col = (name: string) => plan.tables.find((t) => t.form === 'Visit')!.columns.find((c) => c.name === name)!;
  assert.equal(col('Added_Location_latitude').dataType, 'Double');
  assert.equal(col('Record_Status').dataType, 'VarChar');
});

test('no report counts a built-in record column as a TODO', () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const left = built.model.todos.filter((t) => /Added_Location|Modified_Location|Record_Status/.test(t.reason));
  assert.deepEqual(left.map((t) => t.reason), []);
});

test('submit stamps the captured position and Record_Status; a bad or absent position stays null', async () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-builtin-cols-'));
  const prevMode = process.env.C2C_DEPLOY_MODE;
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
    for (const file of built.files) {
      const full = join(dir, file.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.data);
    }
    const require = createRequire(import.meta.url);
    const root = repoRoot();
    const fakeSdk = require(join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs')) as FakeSdk;
    const { createSdkDatastore } = (await import(pathToFileURL(join(root, 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href)) as {
      createSdkDatastore: (app: unknown, opts?: Record<string, unknown>) => unknown;
    };
    process.env.C2C_DEPLOY_MODE = 'live';
    const sdkApp = fakeSdk.initialize({});
    const store = (await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href)) as { setDatastore(next: unknown): unknown };
    store.setDatastore(createSdkDatastore(sdkApp, { projections: () => '*' }));
    const load = async (path: string) => ((await import(pathToFileURL(join(dir, path)).href)) as { default: (req: unknown, res: unknown) => unknown }).default;
    const submit = await load('functions/aio/visit/submit.mjs');
    const report = await load('functions/reports/visit-all.mjs');
    const rows = () => fakeSdk.state().tables.Visit ?? [];

    const ok = await invoke(submit, { ...staff, body: { record: { Name: 'a' }, geo: { latitude: 12.5, longitude: 77.25 } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(rows()[0]!.Added_Location_latitude, '12.5');
    assert.equal(rows()[0]!.Added_Location_longitude, '77.25');
    assert.equal(rows()[0]!.Modified_Location_latitude ?? null, null);
    assert.equal(rows()[0]!.Record_Status, 'Not Applicable');

    // Denied or unavailable: no position posted, the columns stay null.
    assert.equal((await invoke(submit, { ...staff, body: { record: { Name: 'b' } } })).status, 200);
    assert.equal(rows()[1]!.Added_Location_latitude ?? null, null);
    // Malformed positions are dropped, never stored and never fail the submit.
    let n = 2;
    for (const geo of [{ latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: '12', longitude: 1 }, { latitude: null, longitude: null }, [1, 2], 'x', { latitude: 1 }, { latitude: Number.POSITIVE_INFINITY, longitude: 1 }]) {
      const res = await invoke(submit, { ...staff, body: { record: { Name: 'c' }, geo } });
      assert.equal(res.status, 200, JSON.stringify(geo));
      assert.equal(rows()[n]!.Added_Location_latitude ?? null, null, JSON.stringify(geo));
      n += 1;
    }
    // A client cannot write the stamped columns through the record.
    const forged = await invoke(submit, { ...staff, body: { record: { Name: 'd', Added_Location_latitude: 1, Record_Status: 'Approved' } } });
    assert.ok(forged.status === 400 || forged.status === 403 || rows()[n]!.Added_Location_latitude == null, JSON.stringify(forged.body));
    if (forged.status === 200) assert.equal(rows()[n]!.Record_Status, 'Not Applicable');

    // The report cells read the stored columns, in Creator's object shape.
    const list = await invoke(report, { ...staff, body: { op: 'query', page: 0, pageSize: 5 } });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const first = (list.body.rows as Record<string, unknown>[])[0]!;
    assert.deepEqual(first.Added_Location, { latitude: '12.5', longitude: '77.25', display_value: '12.5, 77.25' });
    assert.equal(first.Modified_Location ?? null, null);
    assert.equal(first.Record_Status, 'Not Applicable');
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});
