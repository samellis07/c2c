/**
 * A report custom action must really run in a deployed app: a live
 * /reports/<report>/actions/<action> call dispatches the action's `type =
 * functions` workflow in-process through functions/thisapp.mjs on the posted
 * ROWID's row, and field writes inside the function persist. Preview mode
 * (any deploy mode but "live") answers the dry-run preview and writes
 * nothing. A record-bound action without a ROWID is an empty selection — a
 * 200 wrote:false no-op. A row the caller cannot read is a 404; a write the
 * caller's profile denies is a 403 and the row is untouched. A live runtime
 * without a writable store fails closed (500), never wrote:true.
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

function modulePermissions(reports: string, fields: string[] = []): string {
  return `${tab(4)}Item\n${tab(4)}{\n${tab(5)}enabled = true\n${tab(5)}ReportPermissions\n${tab(5)}{\n${tab(6)}All_Items = {${reports}}\n${tab(5)}}${
    fields.length
      ? `\n${tab(5)}FieldPermissions\n${tab(5)}{\n${fields
          .map((name) => `${tab(6)}${name}\n${tab(6)}{\n${tab(7)}visibility:true,readonly:false\n${tab(6)}}`)
          .join('\n')}\n${tab(5)}}`
      : ''
  }\n${tab(4)}}`;
}

const SOURCE = `application "Demo"
{
${tab(1)}time zone = "Asia/Kolkata"
${tab(1)}form Item
${tab(1)}{
${field('Name')}
${field('Status')}
${field('Secret')}
${tab(1)}}
${tab(1)}list All_Items
${tab(1)}{
${tab(2)}show all rows from Item
${tab(2)}(
${tab(3)}Name
${tab(3)}Status
${tab(3)}custom action "Mark as Lost"
${tab(3)}(
${tab(4)}workflow = Mark_Lost
${tab(4)}column header = "Mark as Lost"
${tab(3)})
${tab(2)})
${tab(1)}}
${tab(1)}workflow
${tab(1)}{
${tab(1)}functions
${tab(1)}{
${tab(2)}Mark_Lost as "Mark Lost"
${tab(2)}{
${tab(3)}type = functions
${tab(3)}form = Item
${tab(3)}execution type = for each record
${tab(3)}on start
${tab(3)}{
${tab(4)}actions
${tab(4)}{
${tab(5)}rec.Status = "Lost";
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
${modulePermissions('"View","Edit"', ['Name', 'Status'])}
${tab(3)}}
${tab(2)}}
${tab(2)}"Viewer"
${tab(2)}{
${tab(3)}name = "Viewer"
${tab(3)}type = Users_Permissions
${tab(3)}ModulePermissions
${tab(3)}{
${modulePermissions('"View"', ['Name', 'Status'])}
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

interface ActionModule {
  default: (req: unknown, res: unknown) => unknown;
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
const viewer = { user: { profile: 'Viewer', loginUser: 'ada@example.test' } };
const stranger = { user: { profile: 'Stranger' } };

test('a generated record action writes in live mode and previews in dry-run mode', async () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const actionFile = built.files.find((file) => file.path === 'functions/reports/all-items-action-mark-as-lost.mjs');
  assert.ok(actionFile, 'the custom action endpoint was not generated');
  const dir = mkdtempSync(join(tmpdir(), 'c2c-record-action-'));
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
    const sdkApp = fakeSdk.initialize({});
    const datastore = createSdkDatastore(sdkApp, { projections: () => '*' });
    const store = (await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href)) as {
      setDatastore(next: unknown): unknown;
    };
    const action = (await import(pathToFileURL(join(dir, actionFile.path)).href)) as ActionModule;

    const rowId = String(
      (await sdkApp.datastore().table('Item').insertRows([{ Name: 'own', Status: 'Open', Secret: 's' }]))[0].ROWID,
    );
    const itemRows = () => fakeSdk.state().tables.Item ?? [];
    const statusOf = (id: string) => itemRows().find((row) => String(row.ROWID) === id)?.Status;
    const updateCalls = () => fakeSdk.state().calls.filter((call) => call[0] === 'updateRows').length;

    // Preview: the default deploy config (and an explicit dry-run override)
    // answer the dry-run preview and write nothing.
    const preview = await invoke(action.default, { ...staff, body: { ROWID: rowId } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.dryRun, true);
    assert.equal(statusOf(rowId), 'Open', 'a preview must not write');
    assert.equal(updateCalls(), 0, 'a preview must not reach the adapter');

    process.env.C2C_DEPLOY_MODE = 'live';
    process.env.C2C_APP_TIMEZONE = 'Asia/Kolkata';
    store.setDatastore(datastore);

    // Grant checks run before any store read.
    assert.equal((await invoke(action.default, { body: { ROWID: rowId } })).status, 401);
    assert.equal((await invoke(action.default, { ...stranger, body: { ROWID: rowId } })).status, 403);

    // A row the caller cannot see is a 404 and untouched.
    const missing = await invoke(action.default, { ...staff, body: { ROWID: '999999999' } });
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(updateCalls(), 0);

    // A record-bound action with no record is an empty selection: a 200
    // wrote:false no-op, never an error and never a write.
    const none = await invoke(action.default, { ...staff, body: {} });
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.equal(none.body.dryRun, false);
    assert.equal(none.body.wrote, false);
    assert.equal(updateCalls(), 0, 'no selection must not reach the adapter');

    // A profile that can read but not write is denied; the row is untouched.
    const denied = await invoke(action.default, { ...viewer, body: { ROWID: rowId } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(statusOf(rowId), 'Open', 'a denied action must not write');
    assert.equal(updateCalls(), 0);

    // The permitted action: the reply claim must match the store.
    const ran = await invoke(action.default, { ...staff, body: { ROWID: rowId } });
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    assert.equal(ran.body.dryRun, false);
    assert.equal(ran.body.wrote, true);
    assert.equal(updateCalls(), 1, 'the field write must reach the adapter exactly once');
    assert.equal(statusOf(rowId), 'Lost', 'the function did not persist its write');

    // A live runtime with no update adapter fails closed: 500, never wrote:true.
    store.setDatastore({ query: datastore.query });
    const unconfigured = await invoke(action.default, { ...staff, body: { ROWID: rowId } });
    assert.equal(unconfigured.status, 500, JSON.stringify(unconfigured.body));
    assert.notEqual(unconfigured.body.wrote, true);
    assert.equal(updateCalls(), 1, 'a failed action must not reach updateRows');
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    if (prevZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = prevZone;
    rmSync(dir, { recursive: true, force: true });
  }
});
