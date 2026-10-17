/**
 * An `on start` presuccess body (Creator form-properties actions) runs inside
 * the live submit pipeline: after the access gate and before on validate, on
 * the same record. Its field sets reach the validate script and the stored
 * row, and its cancel submit answers 422 with nothing written. Both submit
 * owners run it: the submit stub, and an on-success module the UI promotes
 * to the form's submit URL.
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

function field(name: string): string {
  return `${tab(2)}${name}\n${tab(2)}(\n${tab(3)}type = text\n${tab(2)})`;
}

function presuccess(name: string, form: string, body: string[]): string {
  return `${tab(2)}${name} as "${name}"
${tab(2)}{
${tab(3)}type = presuccess
${tab(3)}form = ${form}
${tab(3)}on start
${tab(3)}{
${tab(4)}actions
${tab(4)}{
${body.map((line) => `${tab(5)}${line}`).join('\n')}
${tab(4)}}
${tab(3)}}
${tab(2)}}`;
}

function recordEvent(name: string, form: string, event: string, body: string[]): string {
  return `${tab(2)}${name} as "${name}"
${tab(2)}{
${tab(3)}type = form
${tab(3)}form = ${form}
${tab(3)}on add
${tab(3)}{
${tab(4)}actions
${tab(4)}{
${tab(4)}${event}
${tab(4)}(
${body.map((line) => `${tab(5)}${line}`).join('\n')}
${tab(4)})
${tab(4)}}
${tab(3)}}
${tab(2)}}`;
}

const SOURCE = `application "Demo"
{
${tab(1)}time zone = "Asia/Kolkata"
${tab(1)}form Item
${tab(1)}{
${field('Name')}
${field('Stage')}
${tab(1)}}
${tab(1)}form Note
${tab(1)}{
${field('Title')}
${field('Stage')}
${tab(1)}}
${tab(1)}list Note_All
${tab(1)}{
${tab(2)}show all rows from Note
${tab(2)}(
${tab(3)}Title
${tab(2)})
${tab(1)}}
${tab(1)}workflow
${tab(1)}{
${tab(1)}form
${tab(1)}{
${presuccess('Item_Start', 'Item', ['if (input.Name == "stop")', '{', '\tcancel submit;', '}', 'input.Stage = "started";'])}
${recordEvent('Item_Check', 'Item', 'on validate', ['if (input.Stage != "started")', '{', '\tcancel submit;', '}'])}
${presuccess('Note_Start', 'Note', ['input.Stage = "started";'])}
${recordEvent('Note_Done', 'Note', 'on success', ['input.Title = input.Title + "!";', 'openUrl("#Report:Note_All","same window");'])}
${tab(1)}}
${tab(1)}}
${tab(1)}share_settings
${tab(1)}{
${tab(2)}"Administrator"
${tab(2)}{
${tab(3)}name = "Administrator"
${tab(3)}type = Users_Permissions
${tab(2)}}
${tab(1)}}
}
`;

interface FakeSdk {
  initialize(req: unknown): unknown;
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

const admin = { user: { profile: 'Administrator', loginUser: 'ada@example.test' } };

async function withLiveApp(
  source: string,
  run: (ctx: { dir: string; load: (path: string) => Promise<Record<string, unknown>>; rows: (table: string) => Record<string, unknown>[]; files: { path: string; data: string | Uint8Array }[] }) => Promise<void>,
): Promise<void> {
  const built = buildUi(deriveIr(parse(source)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-presuccess-live-'));
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
    const datastore = createSdkDatastore(fakeSdk.initialize({}), { projections: () => '*' });
    const store = (await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href)) as { setDatastore(next: unknown): unknown };
    store.setDatastore(datastore);
    await run({
      dir,
      load: (path) => import(pathToFileURL(join(dir, path)).href) as Promise<Record<string, unknown>>,
      rows: (table) => fakeSdk.state().tables[table] ?? [],
      files: built.files as { path: string; data: string | Uint8Array }[],
    });
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the submit stub runs the on start presuccess body before on validate', async () => {
  await withLiveApp(SOURCE, async ({ load, rows }) => {
    const presuccessModule = await load('functions/aio/item/on-start.mjs');
    assert.equal(presuccessModule.presuccess, true);
    const submit = (await load('functions/aio/item/submit.mjs')).default as Handler;

    // The access gate runs first: no principal is a 401 and nothing is stored.
    assert.equal((await invoke(submit, { body: { record: { Name: 'a' } } })).status, 401);
    assert.equal(rows('Item').length, 0);

    // The presuccess body sets Stage; on validate refuses unless it is set,
    // so a 200 proves the body ran first, on the same record.
    const ok = await invoke(submit, { ...admin, body: { record: { Name: 'kept' } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.wrote, true);
    assert.deepEqual(
      rows('Item').map((row) => [row.Name, row.Stage]),
      [['kept', 'started']],
    );

    // A cancel submit in the presuccess body is a 422 with nothing written.
    const refused = await invoke(submit, { ...admin, body: { record: { Name: 'stop' } } });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.refused, true);
    assert.equal(refused.body.wrote, false);
    assert.equal(rows('Item').length, 1);
  });
});

test('an on-success module that owns the submit URL runs the presuccess body before the write', async () => {
  await withLiveApp(SOURCE, async ({ load, rows, files }) => {
    const success = files.find((file) => file.path.startsWith('functions/aio/note/') && /path: "\/forms\/Note\/success"/.test(String(file.data)));
    assert.ok(success, 'the on-success module was not generated');
    assert.match(String(success.data), /const presuccessAdd = \["\.\/on-start\.mjs"\];/);
    const handler = (await load(success.path)).default as Handler;
    const ok = await invoke(handler, { ...admin, body: { record: { Title: 'memo' } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.wrote, true);
    const stored = rows('Note');
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.Stage, 'started');
  });
});

test('only a form with a presuccess body gets the presuccess run in its submit stub', async () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const stub = String(built.files.find((file) => file.path === 'functions/aio/item/submit.mjs')?.data ?? '');
  assert.match(stub, /const presuccessAdd = \["\.\/on-start\.mjs"\];/);
  const withoutStart = SOURCE.replace(presuccess('Item_Start', 'Item', ['if (input.Name == "stop")', '{', '\tcancel submit;', '}', 'input.Stage = "started";']), '');
  assert.notEqual(withoutStart, SOURCE);
  const plain = buildUi(deriveIr(parse(withoutStart)));
  const source = String(plain.files.find((file) => file.path === 'functions/aio/item/submit.mjs')?.data ?? '');
  assert.ok(source, 'submit stub missing');
  assert.doesNotMatch(source, /presuccess/);
  // A plain form workflow on `on start` still emits a /handler route, but
  // without the presuccess mark the submit stub never imports it.
  const plainStart = SOURCE.replace('type = presuccess\n\t\t\tform = Item', 'type = form\n\t\t\tform = Item');
  assert.notEqual(plainStart, SOURCE);
  const unmarked = buildUi(deriveIr(parse(plainStart)));
  const handler = unmarked.files.find((file) => /path: "\/forms\/Item\/handler"/.test(String(file.data)));
  assert.ok(handler, 'the /handler route is still generated');
  assert.doesNotMatch(String(handler.data), /export const presuccess/);
  const unmarkedStub = String(unmarked.files.find((file) => file.path === 'functions/aio/item/submit.mjs')?.data ?? '');
  assert.ok(unmarkedStub);
  assert.doesNotMatch(unmarkedStub, /presuccess/);
});
