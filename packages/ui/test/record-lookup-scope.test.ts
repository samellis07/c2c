/**
 * A form whose report scope carries a lookup-path leaf (`Parent.Name == "x"`)
 * emits the scoped resolver into the record stub. The stub used to read
 * `datastore` before its declaration — every live read on such a form answered
 * 500, and the dry-run preview did too. The read must resolve the parent ids
 * through the store and answer the row (or 404), never a TDZ 500.
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

const SOURCE = `application "Demo"
{
${tab(1)}form Other
${tab(1)}{
${tab(2)}Name
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(1)}}
${tab(1)}form Item
${tab(1)}{
${tab(2)}Name
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}Parent
${tab(2)}(
${tab(3)}type = list
${tab(3)}values = Other.Name
${tab(2)})
${tab(1)}}
${tab(1)}list Item_All
${tab(1)}{
${tab(2)}show all rows from Item
${tab(2)}(
${tab(3)}Name
${tab(2)})
${tab(1)}}
${tab(1)}list Scoped
${tab(1)}{
${tab(2)}show all rows from Item [Parent.Name == "x"]
${tab(2)}(
${tab(3)}Name
${tab(2)})
${tab(1)}}
${tab(1)}list Other_All
${tab(1)}{
${tab(2)}show all rows from Other
${tab(2)}(
${tab(3)}Name
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
${tab(4)}Item
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Item_All = {"View"}
${tab(6)}Scoped = {"View"}
${tab(5)}}
${tab(5)}FieldPermissions
${tab(5)}{
${tab(6)}Name
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(6)}Parent
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(5)}}
${tab(4)}}
${tab(4)}Other
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Other_All = {"View"}
${tab(5)}}
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
}
`;

interface FakeSdk {
  initialize(req: unknown): { datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> } } };
  state(): { tables: Record<string, Record<string, unknown>[]> };
}

interface SdkDatastore {
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

test('a record read on a form with a lookup-path report scope answers the row', async () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-record-scope-'));
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
    const recSource = built.files.find((file) => file.path === 'functions/aio/item/record.mjs');
    assert.ok(recSource, 'record stub was not generated');
    assert.match(String(recSource.data), /resolveLookupCriteria/, 'lookup-path scope did not emit the resolver');

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
    store.setDatastore(datastore);
    const rec = (await import(pathToFileURL(join(dir, 'functions/aio/item/record.mjs')).href)) as {
      default: (req: unknown, res: unknown) => unknown;
    };

    const parentId = String((await sdkApp.datastore().table('Other').insertRows([{ Name: 'x' }]))[0].ROWID);
    const otherParentId = String((await sdkApp.datastore().table('Other').insertRows([{ Name: 'y' }]))[0].ROWID);
    const matchId = String((await sdkApp.datastore().table('Item').insertRows([{ Name: 'in', Parent: parentId }]))[0].ROWID);
    const plainId = String((await sdkApp.datastore().table('Item').insertRows([{ Name: 'out', Parent: otherParentId }]))[0].ROWID);

    // The dry-run preview answers before any store read.
    delete process.env.C2C_DEPLOY_MODE;
    const dry = await invoke(rec.default, { ...staff, body: { ROWID: matchId } });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.dryRun, true);

    // Live: the scope's lookup leaf resolves through the parent table.
    process.env.C2C_DEPLOY_MODE = 'live';
    const plain = await invoke(rec.default, { ...staff, body: { ROWID: plainId } });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal((plain.body.record as Record<string, unknown>).Name, 'out');

    const scoped = await invoke(rec.default, { ...staff, body: { ROWID: matchId, REPORT: 'Scoped' } });
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.equal((scoped.body.record as Record<string, unknown>).Name, 'in');

    // A row whose parent is outside the scope is a 404, never a 500.
    const outside = await invoke(rec.default, { ...staff, body: { ROWID: plainId, REPORT: 'Scoped' } });
    assert.equal(outside.status, 404, JSON.stringify(outside.body));
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});
