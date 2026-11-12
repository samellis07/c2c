/**
 * Every generated report custom action route is gated before it dispatches:
 * a hidden form is a 403 for every caller, an anonymous call a 401, a profile
 * without a read grant on the report form a 403, and (for a live record
 * action) a row the caller cannot see a 404 and a row it may read but not
 * modify a 403. Nothing reaches the store until all of those pass; only then
 * does a stub action answer 422 or a dispatchable one run. The React and
 * vanilla deploy targets serve these same buildUi function files.
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

const t = (n: number) => '\t'.repeat(n);
const field = (name: string) => `${t(3)}${name}\n${t(3)}(\n${t(4)}type = text\n${t(3)})`;
const grant = (form: string, report: string, perms: string) =>
  `${t(4)}${form}\n${t(4)}{\n${t(5)}enabled = true\n${t(5)}ReportPermissions\n${t(5)}{\n${t(6)}${report} = {${perms}}\n${t(5)}}\n${t(4)}}`;
const profile = (name: string, grants: string[]) =>
  `${t(2)}"${name}"\n${t(2)}{\n${t(3)}name = "${name}"\n${t(3)}type = Users_Permissions${grants.length ? `\n${t(3)}ModulePermissions\n${t(3)}{\n${grants.join('\n')}\n${t(3)}}` : ''}\n${t(2)}}`;
const recordWorkflow = (name: string, form: string) =>
  `${t(2)}${name} as "${name}"\n${t(2)}{\n${t(3)}type = functions\n${t(3)}form = ${form}\n${t(3)}execution type = for each record\n${t(3)}on start\n${t(3)}{\n${t(4)}actions\n${t(4)}{\n${t(5)}rec.Status = "Done";\n${t(4)}}\n${t(3)}}\n${t(2)}}`;

const SOURCE = `application "Gate"
{
${t(1)}time zone = "Asia/Kolkata"
${t(1)}section Main
${t(1)}{
${t(2)}form Item
${t(2)}{
${field('Name')}
${field('Status')}
${t(2)}}
${t(2)}list All_Items
${t(2)}{
${t(3)}show all rows from Item
${t(3)}(
${t(4)}Name
${t(4)}Status
${t(4)}custom action "Finish"
${t(4)}(
${t(5)}workflow = Finish_Item
${t(4)})
${t(4)}custom action "Close"
${t(4)}(
${t(5)}workflow = Not_A_Workflow
${t(4)})
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}section Secret
${t(1)}{
${t(2)}hide = true
${t(2)}form Vault
${t(2)}{
${field('Name')}
${field('Status')}
${t(2)}}
${t(2)}list All_Vault
${t(2)}{
${t(3)}show all rows from Vault
${t(3)}(
${t(4)}Name
${t(4)}custom action "Seal"
${t(4)}(
${t(5)}workflow = Seal_Vault
${t(4)})
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}workflow
${t(1)}{
${t(1)}functions
${t(1)}{
${recordWorkflow('Finish_Item', 'Item')}
${recordWorkflow('Seal_Vault', 'Vault')}
${t(1)}}
${t(1)}}
${t(1)}share_settings
${t(1)}{
${profile('Staff', [grant('Item', 'All_Items', '"View","Edit"'), grant('Vault', 'All_Vault', '"View","Edit"')])}
${profile('Viewer', [grant('Item', 'All_Items', '"View"')])}
${profile('Stranger', [])}
${t(1)}}
}
`;

interface FakeSdk {
  initialize(req: unknown): { datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> } } };
  state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
}

type Handler = (req: unknown, res: unknown) => unknown;

function invoke(handler: Handler, req: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
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

const CALLERS: Record<string, { user?: { profile: string; loginUser?: string } }> = {
  anonymous: {},
  stranger: { user: { profile: 'Stranger' } },
  viewer: { user: { profile: 'Viewer', loginUser: 'vi@example.test' } },
  staff: { user: { profile: 'Staff', loginUser: 'ada@example.test' } },
};

test('every report custom action route refuses before dispatch: hidden 403, anonymous 401, no grant 403, invisible row 404', async (ctx) => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const actionFiles = built.files.filter((file) => /^functions\/reports\/.+-action-.+\.mjs$/.test(file.path)).map((file) => file.path).sort();
  assert.deepEqual(actionFiles, [
    'functions/reports/all-items-action-close.mjs',
    'functions/reports/all-items-action-finish.mjs',
    'functions/reports/all-vault-action-seal.mjs',
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-action-gate-'));
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
    const root = repoRoot();
    const fakeSdk = createRequire(import.meta.url)(join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs')) as FakeSdk;
    const { createSdkDatastore } = (await import(pathToFileURL(join(root, 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href)) as {
      createSdkDatastore: (app: unknown, opts?: Record<string, unknown>) => unknown;
    };
    const sdkApp = fakeSdk.initialize({});
    const store = (await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href)) as { setDatastore(next: unknown): unknown };
    store.setDatastore(createSdkDatastore(sdkApp, { projections: () => '*' }));
    process.env.C2C_DEPLOY_MODE = 'live';
    const itemId = String((await sdkApp.datastore().table('Item').insertRows([{ Name: 'a', Status: 'Open', Added_User: 'ada@example.test' }]))[0].ROWID);
    const vaultId = String((await sdkApp.datastore().table('Vault').insertRows([{ Name: 'v', Status: 'Open', Added_User: 'ada@example.test' }]))[0].ROWID);
    const writes = () => fakeSdk.state().calls.filter((call) => /^(insert|update|delete)Rows$/.test(String(call[0]))).length;
    const handlers: Record<string, Handler> = {};
    for (const path of actionFiles) handlers[path] = ((await import(pathToFileURL(join(dir, path)).href)) as { default: Handler }).default;

    const seal = 'functions/reports/all-vault-action-seal.mjs';
    const finish = 'functions/reports/all-items-action-finish.mjs';
    const close = 'functions/reports/all-items-action-close.mjs';
    // [route, caller, ROWID, expected status]; every row before the last runs
    // with no store write.
    const probes: [string, string, string, number][] = [
      [seal, 'anonymous', vaultId, 403],
      [seal, 'stranger', vaultId, 403],
      [seal, 'staff', vaultId, 403],
      [finish, 'anonymous', itemId, 401],
      [finish, 'stranger', itemId, 403],
      [finish, 'viewer', itemId, 403],
      [finish, 'staff', '999999999', 404],
      [close, 'anonymous', itemId, 401],
      [close, 'stranger', itemId, 403],
      [close, 'staff', itemId, 422],
      [finish, 'staff', itemId, 200],
    ];
    const table: string[] = ['route | caller | ROWID | expected | got | store writes'];
    const failures: string[] = [];
    for (const [path, caller, rowId, expected] of probes) {
      const before = writes();
      const res = await invoke(handlers[path]!, { ...CALLERS[caller], body: { ROWID: rowId } });
      const wrote = writes() - before;
      table.push(`${path.slice('functions/reports/'.length)} | ${caller} | ${rowId === '999999999' ? 'invisible' : 'seeded'} | ${expected} | ${res.status} | ${wrote}`);
      if (res.status !== expected) failures.push(`${path} ${caller}: expected ${expected}, got ${res.status} ${JSON.stringify(res.body)}`);
      if (expected !== 200 && wrote !== 0) failures.push(`${path} ${caller}: a refused call wrote to the store`);
      if (expected === 200 && (res.body.wrote !== true || wrote !== 1)) failures.push(`${path} ${caller}: the granted call did not write exactly once`);
    }
    for (const line of table) ctx.diagnostic(line);
    assert.deepEqual(failures, []);
    const vault = fakeSdk.state().tables.Vault ?? [];
    assert.equal(vault.find((row) => String(row.ROWID) === vaultId)?.Status, 'Open', 'a hidden form action must never run');
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});
