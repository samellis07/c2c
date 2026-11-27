/**
 * A report criteria on a lookup whose field name is a reserved column name
 * (`From` is stored as `From_col`) must filter on the stored column. The
 * resolver rewrote `From.Name == "x"` to `From IN (ids)`, a column the table
 * does not have, so the served read dropped the filter and returned every row.
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
${tab(1)}form Account
${tab(1)}{
${tab(2)}Name
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(1)}}
${tab(1)}form Transfer
${tab(1)}{
${tab(2)}Label
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}From
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = Account[ID != 0].ID
${tab(3)}displayformat = [Name]
${tab(2)})
${tab(1)}}
${tab(1)}list Moved
${tab(1)}{
${tab(2)}show all rows from Transfer [From.Name == "x"]
${tab(2)}(
${tab(3)}Label
${tab(3)}From
${tab(2)})
${tab(1)}}
${tab(1)}list Account_All
${tab(1)}{
${tab(2)}show all rows from Account
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
${tab(4)}Transfer
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Moved = {"View"}
${tab(5)}}
${tab(5)}FieldPermissions
${tab(5)}{
${tab(6)}Label
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(6)}From
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(5)}}
${tab(4)}}
${tab(4)}Account
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Account_All = {"View"}
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

test('a lookup-path report criteria on a reserved-name lookup filters on the stored column', async () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-reserved-lookup-'));
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
    )) as { createSdkDatastore: (app: unknown, opts?: Record<string, unknown>) => unknown };
    const sdkApp = fakeSdk.initialize({});
    const store = (await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href)) as { setDatastore(next: unknown): unknown };
    store.setDatastore(createSdkDatastore(sdkApp, { projections: () => '*' }));
    const report = (await import(pathToFileURL(join(dir, 'functions/reports/moved.mjs')).href)) as { default: (req: unknown, res: unknown) => unknown };

    const hit = String((await sdkApp.datastore().table('Account').insertRows([{ Name: 'x' }]))[0]!.ROWID);
    const miss = String((await sdkApp.datastore().table('Account').insertRows([{ Name: 'y' }]))[0]!.ROWID);
    await sdkApp.datastore().table('Transfer').insertRows([
      { Label: 'in', From_col: hit },
      { Label: 'out', From_col: miss },
    ]);

    process.env.C2C_DEPLOY_MODE = 'live';
    const res = await invoke(report.default, { user: { profile: 'Staff', loginUser: 'ada@example.test' }, body: { op: 'query', page: 0, pageSize: 50 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const labels = (res.body.rows as Record<string, unknown>[]).map((row) => row.Label);
    assert.deepEqual(labels, ['in']);
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});
