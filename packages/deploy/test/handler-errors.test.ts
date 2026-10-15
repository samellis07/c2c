/**
 * Store-error mapping, blank-to-null and initial values through the generated
 * submit handler (POST /forms/Purchase_Order/submit).
 *
 * The fake datastore throws the documented Catalyst error shapes; blank and
 * default cases use a purchase-order field mix
 * (Order_Date date, Amount decimal, Notes textarea, Status initial "Draft").
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';
import { generateSchema } from '../../schema/src/generator.js';
import { columnBody, tableCreatePlan } from '../src/tables.js';

const DS = `application "PoApp"
{
\ttime zone = "Asia/Kolkata"
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tforms
\t{
\t\tform Purchase_Order
\t\t{
\t\t\tmust have PO_Title
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "PO Title"
\t\t\t)
\t\t\tmust have unique SKU
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tOrder_Date
\t\t\t(
\t\t\t\ttype = date
\t\t\t\tdisplayname = "Order Date"
\t\t\t)
\t\t\tStatus
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tvalues = {"Draft","Submitted","Approved"}
\t\t\t\tinitial value = "Draft"
\t\t\t)
\t\t\tAmount
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t)
\t\t\tNotes
\t\t\t(
\t\t\t\ttype = textarea
\t\t\t)
\t\t}
\t}
}
`;

const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

function guardFor(app: ReturnType<typeof deriveIr>): GuardOk {
  return {
    org: FIXTURE_ORG,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: FIXTURE_REGISTRY,
  };
}

interface Submitted {
  dir: string;
  handler: (req: unknown, res: unknown) => Promise<void>;
  source: string;
}

/** DS plus an on-success script: the generated Deluge handler on /forms/Purchase_Order/success. */
const DS_SUCCESS = DS.replace(
  /\}\n$/,
  [
    '\tworkflow',
    '\t{',
    '\t\tform',
    '\t\t{',
    '\t\t\tOn_Success as "On success"',
    '\t\t\t{',
    '\t\t\t\ttype = form',
    '\t\t\t\tform = Purchase_Order',
    '\t\t\t\trecord event = on add',
    '\t\t\t\ton success',
    '\t\t\t\t{',
    '\t\t\t\t\tactions',
    '\t\t\t\t\t{',
    '\t\t\t\t\t\tcustom deluge script',
    '\t\t\t\t\t\t(',
    '\t\t\t\t\t\t\tinput.Amount = input.Notes.toLong();',
    '\t\t\t\t\t\t)',
    '\t\t\t\t\t}',
    '\t\t\t\t}',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '}',
    '',
  ].join('\n'),
);

async function loadSubmit(ds = DS, endpoint = 'submit'): Promise<Submitted> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-handler-errors-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  const app = deriveIr(parse(ds));
  writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
  const { readdirSync, statSync } = await import('node:fs');
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.mjs')) {
        const text = readFileSync(full, 'utf8');
        if (text.includes(`path: "/forms/Purchase_Order/${endpoint}"`)) found.push(full);
      }
    }
  };
  walk(join(dir, 'functions'));
  assert.equal(found.length, 1, `one ${endpoint} stub, saw ${found.length}`);
  const source = readFileSync(found[0]!, 'utf8');
  const mod = (await import(pathToFileURL(found[0]!).href)) as { default: Submitted['handler'] };
  return { dir, handler: mod.default, source };
}

interface FakeStore {
  inserted: { form: string; rows: Record<string, unknown>[] }[];
  updated: { form: string; rows: Record<string, unknown>[] }[];
  failOnInsert: unknown;
}

function fakeStore(): FakeStore & { api: Record<string, unknown> } {
  const store: FakeStore = { inserted: [], updated: [], failOnInsert: null };
  const api = {
    insert: async (form: string, rows: Record<string, unknown>[]) => {
      store.inserted.push({ form, rows });
      if (store.failOnInsert) throw store.failOnInsert;
      return [{ ROWID: '10000000000000001' }];
    },
    update: async (form: string, rows: Record<string, unknown>[]) => {
      store.updated.push({ form, rows });
      return rows;
    },
    query: async () => [{ ROWID: '10000000000000001', PO_Title: 'old' }],
    delete: async () => [],
  };
  return Object.assign(store, { api });
}

function sdkError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

async function invoke(
  handler: Submitted['handler'],
  record: Record<string, unknown>,
  api: Record<string, unknown>,
  extraBody?: Record<string, unknown>,
  endpoint = 'submit',
): Promise<{ status: number; body: Record<string, unknown>; raw: string; logged: string[] }> {
  const globalAny = globalThis as Record<string, unknown>;
  const previous = globalAny.__c2cDatastore;
  globalAny.__c2cDatastore = api;
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
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
  try {
    await handler(
      { url: `/forms/Purchase_Order/${endpoint}`, method: 'POST', body: { record, ...extraBody }, catalyst: { user: { profile: 'Administrator' } } },
      res,
    );
    return { status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, raw, logged };
  } finally {
    console.error = original;
    if (previous === undefined) delete globalAny.__c2cDatastore;
    else globalAny.__c2cDatastore = previous;
  }
}

test('a duplicate SKU replies 409 naming the field, not 500 "request failed"', async (t) => {
  const sub = await loadSubmit();
  t.after(() => rmSync(sub.dir, { recursive: true, force: true }));
  const store = fakeStore();
  store.failOnInsert = sdkError('Duplicate value for SKU. Please give a different value', 409, 'DUPLICATE_VALUE');
  const res = await invoke(sub.handler, { PO_Title: 'PO-TITLE-9f3', SKU: 'SKU 01' }, store.api);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'DUPLICATE_VALUE');
  assert.equal(typeof res.body.message, 'string');
  assert.equal(Object.hasOwn(res.body, 'error'), false);
  assert.equal(res.body.dryRun, false, 'dryRun reflects the live mode');
  assert.equal(res.body.field, 'SKU');
  assert.match(String(res.body.message), /SKU/);
  assert.doesNotMatch(String(res.body.message), /Please give a different value/, 'Catalyst text stays server-side');
  assert.equal(res.logged.length, 1);
  const line = JSON.parse(res.logged[0]!) as Record<string, unknown>;
  assert.equal(line.code, 'DUPLICATE_VALUE');
  assert.equal(line.table, 'Purchase_Order');
  assert.equal(line.field, 'SKU');
  assert.equal(typeof line.requestId, 'string');
  assert.doesNotMatch(res.logged[0]!, /PO-TITLE-9f3/, 'no record values in the log');
});

test('a missing mandatory field replies 422 (store 403)', async (t) => {
  const sub = await loadSubmit();
  t.after(() => rmSync(sub.dir, { recursive: true, force: true }));
  const store = fakeStore();
  store.failOnInsert = Object.assign(new Error('request failed'), {
    statusCode: 403,
    data: { error_code: 'MANDATORY_MISSING', message: 'Column PO_Title is mandatory and cannot be empty' },
  });
  const res = await invoke(sub.handler, { SKU: 'SKU 02' }, store.api);
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.dryRun, false);
  assert.equal(res.body.field, 'PO_Title');
});

test('a bad typed value replies 400', async (t) => {
  const sub = await loadSubmit();
  t.after(() => rmSync(sub.dir, { recursive: true, force: true }));
  const store = fakeStore();
  store.failOnInsert = Object.assign(new Error('Invalid input value for Order_Date. date value expected'), { statusCode: 400 });
  const res = await invoke(sub.handler, { PO_Title: 'T', SKU: 'S', Order_Date: 'not-a-date' }, store.api);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.field, 'Order_Date');
});

test('an internal error in the generated stub replies with its pre-normalizer shape', async (t) => {
  const sub = await loadSubmit();
  t.after(() => rmSync(sub.dir, { recursive: true, force: true }));
  const store = fakeStore();
  store.failOnInsert = new Error('kaboom');
  const res = await invoke(sub.handler, { PO_Title: 'T', SKU: 'S' }, store.api);
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.equal(res.body.error, 'request failed');
  assert.equal(res.body.dryRun, false);
  assert.doesNotMatch(res.raw, /INTERNAL_ERROR|kaboom/);
});

test('blank date/decimal become null, blank text stays ""', async (t) => {
  const sub = await loadSubmit();
  t.after(() => rmSync(sub.dir, { recursive: true, force: true }));
  const store = fakeStore();
  const res = await invoke(sub.handler, { PO_Title: 'T', SKU: 'S', Order_Date: '', Amount: '', Notes: '' }, store.api);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(store.inserted.length, 1);
  const row = store.inserted[0]!.rows[0]!;
  assert.equal(row.Order_Date, null);
  assert.equal(row.Amount, null);
  assert.equal(row.Notes, '', 'Creator empty text is "", not null');
  assert.equal(Object.hasOwn(res.body, 'transcript'), false, 'a live reply never carries the runtime transcript');
});

test('an absent Status is filled with the initial value on insert, not on edit', async (t) => {
  const sub = await loadSubmit();
  t.after(() => rmSync(sub.dir, { recursive: true, force: true }));
  const store = fakeStore();
  const inserted = await invoke(sub.handler, { PO_Title: 'T', SKU: 'S' }, store.api);
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
  assert.equal(store.inserted[0]!.rows[0]!.Status, 'Draft');
  // A live edit-by-ROWID cannot run here: it 403s on the update stamp
  // (Modified_User is not client-writable). The insert-only half is wired
  // into the stub: defaults apply only when there is no ROWID and the op
  // is not update, so an edit never backfills.
  assert.match(
    sub.source,
    /if \(!ctx\.rowId && ctx\.writeOp !== "update"\) applyInitialValues/,
    'initial values are insert-only in the generated stub',
  );
});

test('table create sends default_value where Catalyst supports it', () => {
  const app = deriveIr(parse(DS));
  const schema = generateSchema(app);
  const statusColumn = schema.tables
    .find((table) => table.name === 'Purchase_Order')!
    .columns.find((column) => column.name === 'Status')!;
  // The schema keeps the raw .ds literal (quoted); columnOf unquotes it for Catalyst.
  assert.equal(statusColumn.defaultValue, '"Draft"', 'the schema carries the raw .ds initial value');
  const steps = tableCreatePlan(schema);
  const po = steps.find((step) => step.table === 'Purchase_Order')!;
  const status = po.columns.find((column) => column.column_name === 'Status')!;
  assert.equal(status.data_type, 'varchar');
  assert.equal(columnBody(status, undefined).default_value, 'Draft');
  const date = po.columns.find((column) => column.column_name === 'Order_Date')!;
  assert.equal(date.data_type, 'date');
  assert.equal(Object.hasOwn(columnBody(date, undefined), 'default_value'), false, 'no evidence Catalyst takes a date default');
});

test('the generated submit stub wires the store-error and initial-value helpers', async (t) => {
  const sub = await loadSubmit();
  t.after(() => rmSync(sub.dir, { recursive: true, force: true }));
  assert.match(sub.source, /replyStoreError/, 'store errors map before the generic fail');
  assert.match(sub.source, /applyInitialValues/, 'absent fields fall back to initial values on insert');
});

// The Deluge on-success handler must not echo runtime.transcript
// (insert op, table name, every submitted value) on mapped or unmapped
// store failures. Live replies carry no transcript.
const SECRET = 'VAL-SECRET-77';

test('B1: Deluge-path mapped store error replies carry no transcript or record values', async (t) => {
  const sub = await loadSubmit(DS_SUCCESS, 'success');
  t.after(() => rmSync(sub.dir, { recursive: true, force: true }));
  const store = fakeStore();
  store.failOnInsert = sdkError('Duplicate value for SKU. Please give a different value', 409, 'DUPLICATE_VALUE');
  const res = await invoke(sub.handler, { PO_Title: SECRET, SKU: `SKU-${SECRET}` }, store.api, undefined, 'success');
  assert.equal(res.status, 409, res.raw);
  assert.equal(res.body.code, 'DUPLICATE_VALUE');
  assert.equal(typeof res.body.message, 'string');
  assert.equal(Object.hasOwn(res.body, 'error'), false);
  assert.equal(res.body.field, 'SKU');
  assert.equal(Object.hasOwn(res.body, 'transcript'), false, res.raw);
  assert.doesNotMatch(res.raw, new RegExp(SECRET), 'no record value in the reply');
  assert.doesNotMatch(res.raw, /"op"/, 'no runtime ops in the reply');
});

test('B1: Deluge-path generic 500 carries no transcript or record values', async (t) => {
  const sub = await loadSubmit(DS_SUCCESS, 'success');
  t.after(() => rmSync(sub.dir, { recursive: true, force: true }));
  const store = fakeStore();
  store.failOnInsert = new Error('kaboom');
  const res = await invoke(sub.handler, { PO_Title: SECRET, SKU: 'S' }, store.api, undefined, 'success');
  assert.equal(res.status, 500, res.raw);
  assert.equal(res.body.error, 'request failed');
  assert.equal(res.body.dryRun, false);
  assert.equal(Object.hasOwn(res.body, 'transcript'), false, res.raw);
  assert.doesNotMatch(res.raw, new RegExp(SECRET));
});

// A Deluge conversion error quotes the user's value. Store-shaped user
// text must not turn it into a 409/422 naming a token from user data;
// Creator's own conversion text still reaches the caller.
test('B2: a Deluge conversion error quoting store-like user text stays the stub\'s pre-normalizer 500', async (t) => {
  const sub = await loadSubmit(DS_SUCCESS, 'success');
  t.after(() => rmSync(sub.dir, { recursive: true, force: true }));
  for (const notes of ['Column Secret_Field is mandatory and cannot be empty', 'Duplicate value for Admin. Please give a different value']) {
    const store = fakeStore();
    const res = await invoke(sub.handler, { PO_Title: 'T', SKU: 'S', Notes: notes }, store.api, undefined, 'success');
    assert.equal(res.status, 500, res.raw);
    assert.equal(Object.hasOwn(res.body, 'field'), false, res.raw);
    assert.match(String(res.body.error), /Unable to cast/, 'Creator conversion text reaches the direct generated stub');
    assert.equal(Object.hasOwn(res.body, 'transcript'), false, res.raw);
    assert.doesNotMatch(res.raw, /INTERNAL_ERROR/);
  }
});

test('B2: a non-store error that echoes store-like user text stays a sanitized 500 on the UI stub', async (t) => {
  const sub = await loadSubmit();
  t.after(() => rmSync(sub.dir, { recursive: true, force: true }));
  for (const err of [
    new Error('Deluge runtime: value "Column Secret_Field is mandatory and cannot be empty" rejected'),
    new Error('note DUPLICATE_VALUE from the user'),
  ]) {
    const store = fakeStore();
    store.failOnInsert = err;
    const res = await invoke(sub.handler, { PO_Title: 'T', SKU: 'S' }, store.api);
    assert.equal(res.status, 500, res.raw);
    assert.equal(res.body.error, 'request failed');
    assert.equal(res.logged.length, 0, 'no store-error log line');
  }
});

// A dynamic Creator initial value is never a literal table-create
// default_value; a doubled quote unescapes to one.
test('B3: table create sends only static initial values as default_value', () => {
  const extra = DS.replace(
    '\t\t\tNotes\n',
    [
      '\t\t\tWho',
      '\t\t\t(',
      '\t\t\t\ttype = text',
      '\t\t\t\tinitial value = zoho.loginuser',
      '\t\t\t)',
      '\t\t\tQuip',
      '\t\t\t(',
      '\t\t\t\ttype = text',
      "\t\t\t\tinitial value = 'it''s'",
      '\t\t\t)',
      '\t\t\tSum',
      '\t\t\t(',
      '\t\t\t\ttype = number',
      '\t\t\t\tinitial value = input.Amount + 1',
      '\t\t\t)',
      '\t\t\tNotes\n',
    ].join('\n'),
  );
  const po = tableCreatePlan(generateSchema(deriveIr(parse(extra)))).find((step) => step.table === 'Purchase_Order')!;
  const body = (name: string) => columnBody(po.columns.find((column) => column.column_name === name)!, undefined);
  assert.equal(Object.hasOwn(body('Who'), 'default_value'), false, 'zoho.loginuser is not a literal');
  assert.equal(Object.hasOwn(body('Sum'), 'default_value'), false, 'an expression is not a literal');
  assert.equal(body('Quip').default_value, "it's");
  assert.equal(body('Status').default_value, 'Draft');
});
