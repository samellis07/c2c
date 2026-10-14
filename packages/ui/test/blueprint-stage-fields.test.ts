/**
 * Blueprint stage field settings reach the generated record read, the edit
 * submit, and the edit screen. While a record sits in a stage, the record
 * read leaves out the fields that stage hides, an edit of a field the stage
 * does not let the user change answers 400 naming it, and the edit screen
 * hides and disables the same fields. The React app spec carries the same
 * settings.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse, type App, type Property, type PropertyBlock } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { reactAppSpec } from '../../ui-react/src/index.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);
const field = (name: string) => `${tab(2)}${name}\n${tab(2)}(\n${tab(3)}type = text\n${tab(2)})`;

const SOURCE = `application "Demo"
{
${tab(1)}time zone = "Asia/Kolkata"
${tab(1)}form Item
${tab(1)}{
${field('Name')}
${field('Amount')}
${field('Notes')}
${tab(1)}}
${tab(1)}list Item_All
${tab(1)}{
${tab(2)}show all rows from Item
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
${tab(6)}Item_All = {"View","Edit"}
${tab(5)}}
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
}
`;

const Z = { start: 0, end: 0 };
const prop = (key: string, value: string): Property => ({ key, value, span: Z });
const pb = (name: string, properties: Property[] = []): PropertyBlock => ({ name, properties, blocks: [], items: [], span: Z });

/** The parsed app plus an Item blueprint whose Review stage hides Amount and lets only Notes change. */
function blueprintApp(): App {
  const app = deriveIr(parse(SOURCE));
  app.workflows.push({
    name: 'Item flow',
    form: 'Item',
    event: 'blueprint',
    deluge: null,
    properties: [],
    span: Z,
    blueprint: {
      start: pb('Draft'),
      stages: [pb('Draft'), pb('Review', [prop('hidden fields', 'Amount'), prop('editable fields', 'Notes')])],
      transitions: [{ name: 'Send', fromStage: 'Draft', toStage: 'Review', properties: [], phases: [], span: Z }],
    },
  });
  return app;
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

interface FakeSdk {
  initialize(req: unknown): { datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> } } };
  state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
}

const staff = { user: { profile: 'Staff', loginUser: 'ada@example.test' } };

test('the record read drops fields the stored stage hides, and an edit of a locked field answers 400', async (t) => {
  const built = buildUi(blueprintApp());
  const dir = mkdtempSync(join(tmpdir(), 'c2c-stage-fields-'));
  const prevMode = process.env.C2C_DEPLOY_MODE;
  t.after(() => {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  });
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
  const rec = (await import(pathToFileURL(join(dir, 'functions/aio/item/record.mjs')).href)) as { default: (req: unknown, res: unknown) => unknown };
  const submit = (await import(pathToFileURL(join(dir, 'functions/aio/item/submit.mjs')).href)) as { default: (req: unknown, res: unknown) => unknown };
  const [reviewId, draftId] = (
    await sdkApp.datastore().table('Item').insertRows([
      { Name: 'r', Amount: '10', Notes: 'x', Status: 'Review' },
      { Name: 'd', Amount: '20', Notes: 'y', Status: 'Draft' },
    ])
  ).map((row) => String(row.ROWID));

  const review = await invoke(rec.default, { ...staff, body: { ROWID: reviewId } });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const record = review.body.record as Record<string, unknown>;
  assert.equal(Object.hasOwn(record, 'Amount'), false, 'a field the stage hides is not read');
  assert.equal(record.Notes, 'x');
  assert.deepEqual(review.body.stages, { Status: 'Review' });
  const draft = await invoke(rec.default, { ...staff, body: { ROWID: draftId } });
  assert.equal((draft.body.record as Record<string, unknown>).Amount, '20', 'a stage without settings shows every field');

  const locked = await invoke(submit.default, { ...staff, body: { ROWID: reviewId, record: { Name: 'renamed' } } });
  assert.equal(locked.status, 400, JSON.stringify(locked.body));
  assert.equal(locked.body.field, 'Name');
  assert.equal(locked.body.error, 'field Name is not updatable in stage Review');
  const hidden = await invoke(submit.default, { ...staff, body: { ROWID: reviewId, record: { Amount: '1' } } });
  assert.equal(hidden.status, 400, JSON.stringify(hidden.body));
  assert.equal(hidden.body.field, 'Amount');
  const rows = fakeSdk.state().tables.Item ?? [];
  assert.equal(rows.find((row) => String(row.ROWID) === reviewId)?.Name, 'r', 'a refused edit writes nothing');
  const notes = await invoke(submit.default, { ...staff, body: { ROWID: reviewId, record: { Notes: 'ok' } } });
  assert.notEqual(notes.status, 400, JSON.stringify(notes.body));
});

test('the report list read drops the fields each row\'s own stage hides', async (t) => {
  const built = buildUi(blueprintApp());
  const dir = mkdtempSync(join(tmpdir(), 'c2c-stage-report-'));
  const prevMode = process.env.C2C_DEPLOY_MODE;
  t.after(() => {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of built.files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.data);
  }
  const report = built.files.find((file) => file.path.includes('/reports/'));
  assert.ok(report, 'a report endpoint is generated');
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
  const [reviewId, draftId] = (
    await sdkApp.datastore().table('Item').insertRows([
      { Name: 'r', Amount: '10', Notes: 'x', Status: 'Review' },
      { Name: 'd', Amount: '20', Notes: 'y', Status: 'Draft' },
    ])
  ).map((row) => String(row.ROWID));
  const list = (await import(pathToFileURL(join(dir, report!.path)).href)) as { default: (req: unknown, res: unknown) => unknown };
  const res = await invoke(list.default, { ...staff, body: { op: 'query' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body.rows as Record<string, unknown>[];
  const review = rows.find((row) => String(row.ROWID) === reviewId)!;
  assert.equal(Object.hasOwn(review, 'Amount'), false, 'a stage-hidden field must not reach the list read');
  assert.equal(review.Notes, 'x');
  const draft = rows.find((row) => String(row.ROWID) === draftId)!;
  assert.equal(draft.Amount, '20', 'a stage without settings shows every readable field');
});

test('the edit screen and the React spec carry the same stage field settings', async () => {
  const app = blueprintApp();
  const built = buildUi(app);
  const form = built.model.forms.find((item) => item.name === 'Item')!;
  assert.deepEqual(form.stageFields, [{ statusColumn: 'Status', stages: { Review: { hidden: ['Amount'], updatable: ['Notes'] } }, transitions: {} }]);
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    stageFieldActions(form: unknown, stages: unknown): unknown;
  };
  assert.deepEqual(runtime.stageFieldActions(form, { Status: 'Review' }), [
    { op: 'hide', targets: ['Amount'] },
    { op: 'disable', targets: ['Name'] },
  ]);
  assert.deepEqual(runtime.stageFieldActions(form, { Status: 'Draft' }), []);
  assert.deepEqual(runtime.stageFieldActions(form, null), []);
  assert.deepEqual(reactAppSpec(app, built.model).forms.Item!.stageFields, form.stageFields);
  // A form no blueprint governs carries no settings.
  const plain = buildUi(deriveIr(parse(SOURCE))).model.forms.find((item) => item.name === 'Item')!;
  assert.equal(Object.hasOwn(plain, 'stageFields'), false);
});
