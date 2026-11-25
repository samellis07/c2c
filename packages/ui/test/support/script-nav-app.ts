/**
 * Shared by the openUrl seam tests: builds a gallery-shaped app whose report
 * custom actions end in an `openUrl("#Script:...")` (the admission-management
 * and hotel-management shapes), runs the generated live dispatch endpoint
 * against the fake Catalyst store, and hands back the reply the page receives.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse } from '../../../core/src/index.js';
import { repoRoot } from '../../../core/src/toolchain.js';
import { generate } from '../../../deluge/src/generate.js';
import { buildUi } from '../../src/index.js';

/** Every `#Script:` target Creator documents for openUrl, and the instruction it becomes. */
export const SCRIPT_TARGETS = [
  ['#Script:page.refresh', 'reload'],
  ['#Script:page.reload', 'reload'],
  ['#Script:dialog.close', 'closeDialog'],
  ['#Script:page.close', 'closePage'],
  ['#Script:page.parent.refresh', 'refreshParent'],
] as const;

/** The two shapes: the workflow does its server work and then navigates (hotel-management), or it only navigates (admission-management Cancel). */
export type ScriptShape = 'after-server-work' | 'navigation-only';

const tab = (n: number) => '\t'.repeat(n);

export function scriptNavSource(script: string, shape: ScriptShape): string {
  const body = shape === 'after-server-work' ? `${tab(5)}rec.Status = "Closed";\n${tab(5)}openUrl("${script}","same window");` : `${tab(5)}openUrl("${script}","same window");`;
  return `application "Demo"
{
${tab(1)}time zone = "Asia/Kolkata"
${tab(1)}form Item
${tab(1)}{
${tab(2)}Name\n${tab(2)}(\n${tab(3)}type = text\n${tab(2)})
${tab(2)}Status\n${tab(2)}(\n${tab(3)}type = text\n${tab(2)})
${tab(1)}}
${tab(1)}list All_Items
${tab(1)}{
${tab(2)}show all rows from Item
${tab(2)}(
${tab(3)}Name
${tab(3)}Status
${tab(3)}custom action "Finish"
${tab(3)}(
${tab(4)}workflow = Finish
${tab(4)}column header = "Finish"
${tab(3)})
${tab(2)})
${tab(1)}}
${tab(1)}workflow
${tab(1)}{
${tab(1)}functions
${tab(1)}{
${tab(2)}Finish as "Finish"
${tab(2)}{
${tab(3)}type = functions
${tab(3)}form = Item
${tab(3)}execution type = for each record
${tab(3)}on start
${tab(3)}{
${tab(4)}actions
${tab(4)}{
${body}
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
${tab(4)}Item
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}All_Items = {"View","Edit"}
${tab(5)}}
${tab(5)}FieldPermissions
${tab(5)}{
${['Name', 'Status'].map((name) => `${tab(6)}${name}\n${tab(6)}{\n${tab(7)}visibility:true,readonly:false\n${tab(6)}}`).join('\n')}
${tab(5)}}
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
}
`;
}

interface FakeSdk {
  initialize(req: unknown): { datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> } } };
  state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
}

interface SdkDatastore {
  query(form: string, where: string, limit: number, offset?: number, orderBy?: string, columns?: unknown): Promise<Record<string, unknown>[]>;
}

export interface EndpointReply {
  status: number;
  body: Record<string, unknown>;
  /** The stored Status of the row the action ran on. */
  status_after: unknown;
  /** The manual steps the generator counted for this app, from the page and from the generated functions. */
  manualSteps: string[];
}

function manualSteps(files: readonly { path: string; data: string | Uint8Array }[]): string[] {
  const file = files.find((item) => item.path === 'ui-manual-steps.json');
  return file ? (JSON.parse(String(file.data)) as { manualSteps: string[] }).manualSteps : [];
}

/** Generates the app, runs its live custom-action endpoint on one stored row and returns the reply. */
export async function runScriptNavEndpoint(source: string): Promise<EndpointReply> {
  const ir = deriveIr(parse(source));
  const built = buildUi(ir);
  const actionFile = built.files.find((file) => file.path === 'functions/reports/all-items-action-finish.mjs');
  if (!actionFile) throw new Error('the custom action endpoint was not generated');
  const dir = mkdtempSync(join(tmpdir(), 'c2c-script-nav-'));
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
    const { createSdkDatastore } = (await import(pathToFileURL(join(root, 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href)) as {
      createSdkDatastore: (app: unknown, opts?: Record<string, unknown>) => SdkDatastore;
    };
    const sdkApp = fakeSdk.initialize({});
    const store = (await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href)) as { setDatastore(next: unknown): unknown };
    const action = (await import(pathToFileURL(join(dir, actionFile.path)).href)) as { default: (req: unknown, res: unknown) => unknown };
    const rowId = String((await sdkApp.datastore().table('Item').insertRows([{ Name: 'one', Status: 'Open' }]))[0]!.ROWID);
    process.env.C2C_DEPLOY_MODE = 'live';
    process.env.C2C_APP_TIMEZONE = 'Asia/Kolkata';
    store.setDatastore(createSdkDatastore(sdkApp, { projections: () => '*' }));
    let status = 0;
    let raw = '';
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(text: string) {
        raw = text;
      },
    };
    await action.default({ user: { profile: 'Staff', loginUser: 'ada@example.test' }, body: { ROWID: rowId } }, res);
    const stored = (fakeSdk.state().tables.Item ?? []).find((row) => String(row.ROWID) === rowId);
    return { status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, status_after: stored?.Status, manualSteps: [...manualSteps(built.files), ...generate(ir).todos.map((todo) => `${todo.construct}: ${todo.manualStep ?? ''}`)] };
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    if (prevZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = prevZone;
    rmSync(dir, { recursive: true, force: true });
  }
}
