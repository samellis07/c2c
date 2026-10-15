/**
 * Live /forms/<form>/delete must really delete: a `200 { deleted: true }` reply
 * means the datastore adapter's delete ran and the row is gone from the store.
 * The generated handler runs the caller-scoped read and the on-delete validate
 * before the shim delete; a `cancel delete` answers 422 and the row stays. A
 * live runtime without a delete adapter fails closed (500), never deleted:true.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);

function field(name: string, type = 'text'): string {
  return `${tab(2)}${name}\n${tab(2)}(\n${tab(3)}type = ${type}\n${tab(2)})`;
}

function fieldPermissions(hidden: readonly string[] = []): string {
  const names = ['Name', 'Owner', 'Secret'];
  return `${tab(5)}FieldPermissions\n${tab(5)}{\n${names
    .map((name) => `${tab(6)}${name}\n${tab(6)}{\n${tab(7)}visibility:${hidden.includes(name) ? 'false' : 'true'},readonly:false\n${tab(6)}}`)
    .join('\n')}\n${tab(5)}}`;
}

function modulePermissions(reports: string): string {
  return `${tab(4)}Item\n${tab(4)}{\n${tab(5)}enabled = true\n${tab(5)}ReportPermissions\n${tab(5)}{\n${tab(6)}Item_All = {${reports}}\n${tab(5)}}\n${fieldPermissions(['Secret'])}\n${tab(4)}}`;
}

const SOURCE = `application "Demo"
{
${tab(1)}time zone = "Asia/Kolkata"
${tab(1)}form Item
${tab(1)}{
${field('Name')}
${field('Owner')}
${field('Secret')}
${tab(1)}}
${tab(1)}form Other
${tab(1)}{
${field('Note')}
${tab(1)}}
${tab(1)}list Item_All
${tab(1)}{
${tab(2)}show all rows from Item [Owner == zoho.loginuser]
${tab(2)}(
${tab(3)}Name
${tab(3)}Owner
${tab(2)})
${tab(1)}}
${tab(1)}workflow
${tab(1)}{
${tab(1)}form
${tab(1)}{
${tab(2)}Guard_Item as "Guard Item"
${tab(2)}{
${tab(3)}type = form
${tab(3)}form = Item
${tab(3)}on delete
${tab(3)}{
${tab(4)}actions
${tab(4)}{
${tab(4)}on validate
${tab(4)}(
${tab(5)}if (input.Name == "keepme")
${tab(5)}{
${tab(6)}cancel delete;
${tab(5)}}
${tab(4)})
${tab(4)}on success
${tab(4)}(
${tab(5)}result = "deleted";
${tab(4)})
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
${tab(1)}}
${tab(1)}share_settings
${tab(1)}{
${tab(2)}"Staff"
${tab(2)}{
${tab(3)}name = "Staff"
${tab(3)}type = Users_Permissions
${tab(3)}ModulePermissions
${tab(3)}{
${modulePermissions('"View","Edit","Delete"')}
${tab(3)}}
${tab(2)}}
${tab(2)}"Editor"
${tab(2)}{
${tab(3)}name = "Editor"
${tab(3)}type = Users_Permissions
${tab(3)}ModulePermissions
${tab(3)}{
${modulePermissions('"View","Edit"')}
${tab(3)}}
${tab(2)}}
${tab(2)}"Stranger"
${tab(2)}{
${tab(3)}name = "Stranger"
${tab(3)}type = Users_Permissions
${tab(2)}}
${tab(1)}}
}
`;

interface FakeSdk {
  initialize(req: unknown): { datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> } } };
  state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
}

interface SdkDatastore {
  insert(form: string, rows: Record<string, unknown>[]): Promise<unknown>;
  update(form: string, rows: Record<string, unknown>[]): Promise<unknown>;
  delete(form: string, rowIds: readonly unknown[]): Promise<unknown>;
  query(form: string, where: string, limit: number, offset?: number, orderBy?: string, columns?: unknown): Promise<Record<string, unknown>[]>;
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
const editor = { user: { profile: 'Editor', loginUser: 'ada@example.test' } };
const stranger = { user: { profile: 'Stranger' } };

test('the generated delete endpoint removes a permitted row in live mode', async () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-delete-live-'));
  const prevMode = process.env.C2C_DEPLOY_MODE;
  const prevZone = process.env.C2C_APP_TIMEZONE;
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
    const { createSdkDatastore } = (await import(
      pathToFileURL(join(root, 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href
    )) as { createSdkDatastore: (app: unknown, opts?: Record<string, unknown>) => SdkDatastore };
    process.env.C2C_DEPLOY_MODE = 'live';
    process.env.C2C_APP_TIMEZONE = 'Asia/Kolkata';
    const sdkApp = fakeSdk.initialize({});
    const datastore = createSdkDatastore(sdkApp, { projections: () => '*' });
    const store = (await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href)) as {
      setDatastore(next: unknown): unknown;
    };
    store.setDatastore(datastore);
    const del = (await import(pathToFileURL(join(dir, 'functions/aio/item/delete.mjs')).href)) as {
      default: (req: unknown, res: unknown) => unknown;
    };
    const rec = (await import(pathToFileURL(join(dir, 'functions/aio/item/record.mjs')).href)) as {
      default: (req: unknown, res: unknown) => unknown;
    };

    const [ownId, keepId, foreignId] = (
      await sdkApp.datastore().table('Item').insertRows([
        { Name: 'own', Owner: 'ada@example.test', Secret: 's-own' },
        { Name: 'keepme', Owner: 'ada@example.test', Secret: 's-keep' },
        { Name: 'foreign', Owner: 'mallory@example.test', Secret: 's-foreign' },
      ])
    ).map((row) => String(row.ROWID));
    const itemRows = () => (fakeSdk.state().tables.Item ?? []).map((row) => String(row.ROWID));
    const deleteCalls = () => fakeSdk.state().calls.filter((call) => call[0] === 'deleteRows').length;

    // Grant checks run before any store read.
    assert.equal((await invoke(del.default, { body: { ROWID: ownId } })).status, 401);
    assert.equal((await invoke(del.default, { ...stranger, body: { ROWID: ownId } })).status, 403);
    // A write grant is not a delete grant.
    assert.equal((await invoke(del.default, { ...editor, body: { ROWID: ownId } })).status, 403);

    // Outside the caller's record filter the row is a 404 and untouched.
    const foreign = await invoke(del.default, { ...staff, body: { ROWID: foreignId } });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    assert.ok(itemRows().includes(foreignId));
    const injected = await invoke(del.default, { ...staff, body: { ROWID: "1' OR '1'='1" } });
    assert.equal(injected.status, 404, JSON.stringify(injected.body));

    // An on-delete `cancel delete` answers 422 before the write; the row stays.
    const refused = await invoke(del.default, { ...staff, body: { ROWID: keepId } });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.refused, true);
    assert.ok(itemRows().includes(keepId), 'a refused delete must leave the row');
    assert.equal(deleteCalls(), 0, 'a refused delete must not reach the adapter');

    // The permitted delete: the reply claim must match the store.
    const removed = await invoke(del.default, { ...staff, body: { ROWID: ownId } });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.deleted, true);
    assert.equal(deleteCalls(), 1, 'deleteRows must reach the adapter exactly once');
    assert.ok(!itemRows().includes(ownId), 'row still present after a deleted:true reply');

    // The record read behind the edit route stays scoped and projected.
    const ok = await invoke(rec.default, { ...staff, body: { ROWID: keepId } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const record = ok.body.record as Record<string, unknown>;
    assert.equal(Object.hasOwn(record, 'Secret'), false, 'hidden field leaked');
    assert.equal((await invoke(rec.default, { ...staff, body: { ROWID: foreignId } })).status, 404);
    assert.equal((await invoke(rec.default, { ...staff, body: { ROWID: "1' OR '1'='1" } })).status, 404);

    // A live runtime with no delete adapter fails closed: 500, never deleted:true.
    const freeId = String((await sdkApp.datastore().table('Item').insertRows([{ Name: 'free', Owner: 'ada@example.test' }]))[0].ROWID);
    store.setDatastore({ query: datastore.query });
    const unconfigured = await invoke(del.default, { ...staff, body: { ROWID: freeId } });
    assert.equal(unconfigured.status, 500, JSON.stringify(unconfigured.body));
    assert.notEqual(unconfigured.body.deleted, true);
    assert.ok(itemRows().includes(freeId), 'a failed delete must leave the row');
    assert.equal(deleteCalls(), 1, 'no adapter must not reach deleteRows');
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    if (prevZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = prevZone;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delete success workflow failure is reported after the row has committed', async () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-delete-success-failure-'));
  const prevMode = process.env.C2C_DEPLOY_MODE;
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
    const successModule = built.files.find((file) =>
      file.path.startsWith('functions/aio/item/') && /\/success"/.test(String(file.data)),
    );
    assert.ok(successModule, 'delete-scoped on-success module was not generated');
    for (const file of built.files) {
      const full = join(dir, file.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(
        full,
        file === successModule
          ? 'export async function handle() { throw new Error("workflow failed"); }\n'
          : file.data,
      );
    }

    const require = createRequire(import.meta.url);
    const fakeSdk = require(join(repoRoot(), 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs')) as FakeSdk;
    const { createSdkDatastore } = (await import(
      pathToFileURL(join(repoRoot(), 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href
    )) as { createSdkDatastore: (app: unknown, opts?: Record<string, unknown>) => SdkDatastore };
    process.env.C2C_DEPLOY_MODE = 'live';
    const sdkApp = fakeSdk.initialize({});
    const datastore = createSdkDatastore(sdkApp, { projections: () => '*' });
    const store = (await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href)) as {
      setDatastore(next: unknown): unknown;
    };
    store.setDatastore(datastore);
    const del = (await import(pathToFileURL(join(dir, 'functions/aio/item/delete.mjs')).href)) as {
      default: (req: unknown, res: unknown) => unknown;
    };
    const id = String((await sdkApp.datastore().table('Item').insertRows([{ Name: 'committed', Owner: 'ada@example.test' }]))[0].ROWID);
    const result = await invoke(del.default, { ...staff, body: { ROWID: id } });
    assert.equal(result.status, 500, JSON.stringify(result.body));
    assert.equal(result.body.deleted, true, 'the response must distinguish post-commit failure from failed deletion');
    assert.equal(result.body.error, 'request failed');
    assert.ok(!(fakeSdk.state().tables.Item ?? []).some((row) => String(row.ROWID) === id), 'success workflow failure must not restore a deleted row');
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});
