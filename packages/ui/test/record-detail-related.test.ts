/**
 * A report detail view's related-record blocks (`related field = Item`) and
 * dotted lookup fields (`Member.Photo`) read through the record endpoint:
 * the reply carries each related field as the parent rows array and each
 * dotted field as the joined parent values, read under the caller's grant on
 * the parent form. Own-form block fields join the projected field list even
 * when they are not list columns.
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
${tab(2)}Code
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
${tab(2)}Note
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}Parent
${tab(2)}(
${tab(3)}type = list
${tab(3)}values = Other.Name
${tab(2)})
${tab(1)}}
${tab(1)}list Item_Detail
${tab(1)}{
${tab(2)}show all rows from Item
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
${tab(1)}web
${tab(1)}{
${tab(2)}reports
${tab(2)}{
${tab(3)}report Item_Detail
${tab(3)}{
${tab(4)}detailview
${tab(4)}(
${tab(5)}layout
${tab(5)}(
${tab(6)}datablock1
${tab(6)}(
${tab(7)}title = "Parent"
${tab(7)}related field = Parent
${tab(7)}fields
${tab(7)}(
${tab(8)}Name
${tab(8)}Code
${tab(7)})
${tab(6)})
${tab(6)}datablock2
${tab(6)}(
${tab(7)}title = "Self"
${tab(7)}fields
${tab(7)}(
${tab(8)}Name
${tab(8)}Note
${tab(8)}Parent.Name
${tab(7)})
${tab(6)})
${tab(5)})
${tab(4)})
${tab(3)}}
${tab(2)}}
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
${tab(6)}Item_Detail = {"View"}
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

test('a record read hydrates the detail view related rows and dotted lookup fields', async () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-record-detail-'));
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

    const parentId = String((await sdkApp.datastore().table('Other').insertRows([{ Name: 'pname', Code: 'pcode' }]))[0].ROWID);
    const itemId = String((await sdkApp.datastore().table('Item').insertRows([{ Name: 'own', Note: 'memo', Parent: parentId }]))[0].ROWID);

    process.env.C2C_DEPLOY_MODE = 'live';
    const got = await invoke(rec.default, { ...staff, body: { ROWID: itemId, REPORT: 'Item_Detail' } });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const record = got.body.record as Record<string, unknown>;

    // The related-field block reads Parent as the array of parent rows.
    const related = record.Parent;
    assert.ok(Array.isArray(related), JSON.stringify(record));
    assert.equal(related.length, 1);
    assert.equal((related[0] as Record<string, unknown>).Name, 'pname');
    assert.equal((related[0] as Record<string, unknown>).Code, 'pcode');

    // The dotted block field reads as the joined parent value.
    assert.equal(record['Parent.Name'], 'pname');

    // A block field of the record's own form is projected even off the column list.
    assert.equal(record.Note, 'memo');
    assert.equal(record.Name, 'own');
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});
