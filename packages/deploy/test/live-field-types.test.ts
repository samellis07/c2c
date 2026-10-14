/**
 * Live reads are typed by the schema. ZCQL returns BigInt and Int columns as
 * JSON strings and Boolean columns as the text "true"/"false"; the offline SDK
 * stand-in returns every stored value as text. Generated Deluge arithmetic and
 * comparison on a fetched field must see the Creator type, not that text:
 * `rec.Stock + 1` is 101, not "1001", and `rec.Qty > 5` with Qty 10 is true.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse, type App, type Workflow } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { appFormFields, appFormNames, decimalColumnsOf, generate, writeRulesOf } from '../../deluge/src/generate.js';
import { translate } from '../../deluge/src/translate.js';
import { generateSchema } from '../../schema/src/generator.js';
import { fieldTypeRow } from '../../schema/src/mapping.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { columnTypes } from '../src/function-dir.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
const Z = { start: 0, end: 0 };

const FORMS = `\tform Item
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tStock
\t\t(
\t\t\ttype = number
\t\t)
\t\tQty
\t\t(
\t\t\ttype = number
\t\t)
\t\tAmount
\t\t(
\t\t\ttype = INR
\t\t\tdecimalplace = 2
\t\t)
\t\tActive
\t\t(
\t\t\ttype = checkbox
\t\t)
\t\tDue
\t\t(
\t\t\ttype = date
\t\t)
\t\tSeen
\t\t(
\t\t\ttype = datetime
\t\t)
\t\tTally
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tform Order
\t{
\t\tItem_Name
\t\t(
\t\t\ttype = text
\t\t)
\t}`;

function app(): App {
  return deriveIr(parse(`application "T"\n{\n${FORMS}\n}\n`));
}

interface FakeSdk {
  initialize(req: unknown, opts: { scope: string }): unknown;
  state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
}

type Datastore = NonNullable<Parameters<typeof createRuntime>[0]>['datastore'];

async function adapterModule(): Promise<{
  createSdkDatastore(app: unknown, opts?: Record<string, unknown>): Datastore;
}> {
  return import(pathToFileURL(join(root, 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href);
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** The generated app wiring: the schema's column types to the adapter, the app's maps to the runtime. */
async function live(ir: App) {
  const req = createRequire(import.meta.url);
  const sdk = req(fake) as FakeSdk;
  // The stand-in keeps its tables for the process; each test starts from empty ones.
  for (const table of ['Item', 'Order']) sdk.state().tables[table]?.splice(0);
  const { createSdkDatastore } = await adapterModule();
  const schema = generateSchema(ir);
  const columns = columnTypes(schema.tables);
  const datastore = createSdkDatastore(sdk.initialize({}, { scope: 'admin' }), { columns, appTimeZone: 'UTC' });
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    now: new Date('2026-10-10T12:00:00Z'),
    decimalColumns: decimalColumnsOf(ir),
    writeRules: writeRulesOf(ir, schema),
    datastore,
  });
  const decimalFields = ir.forms.flatMap((form) =>
    form.fields.filter((field) => ['decimal', 'currency', 'percent'].includes(fieldTypeRow(field.type)?.id ?? '')).map((field) => field.name),
  );
  const run = async (script: string, record: Record<string, unknown> = {}): Promise<unknown> => {
    const translated = translate(script, { formNames: appFormNames(ir), formFields: appFormFields(ir), decimalFields });
    const fn = new AsyncFunction('shim', 'ctx', `${translated.server}\nreturn typeof golden === 'undefined' ? undefined : golden;`);
    return fn(runtime.shim, runtime.context({ record }));
  };
  const rows = (table: string) => sdk.state().tables[table] ?? [];
  return { sdk, run, rows, runtime };
}

const ITEMS = [
  { Name: 'ten', Stock: 100, Qty: 10, Amount: '10.10', Active: true, Due: '2026-10-01', Seen: '2026-10-01T09:30:00', Tally: null },
  { Name: 'nine', Stock: 7, Qty: 9, Amount: '0.20', Active: false, Due: '2026-10-20', Seen: '2026-10-20T18:00:00', Tally: null },
];

async function seeded() {
  const it = await live(app());
  for (const row of ITEMS) {
    await it.run(
      `insert into Item [ Name = input.Name Stock = input.Stock Qty = input.Qty Amount = input.Amount Active = input.Active Due = input.Due Seen = input.Seen Tally = input.Tally ];`,
      row,
    );
  }
  return it;
}

test('the stand-in store holds every value as text, as ZCQL returns BigInt and Boolean columns', async () => {
  const { rows } = await seeded();
  const stored = rows('Item').find((row) => row.Name === 'ten')!;
  assert.equal(stored.Stock, '100');
  assert.equal(stored.Active, 'true');
  assert.equal(stored.Due, '2026-10-01');
});

test('number field + 1 writes the sum back, not the joined text', async () => {
  const { run, rows } = await seeded();
  await run(`for each rec in Item[Name == "ten"]\n{\n\trec.Stock = rec.Stock + 1;\n}`);
  assert.equal(rows('Item').find((row) => row.Name === 'ten')!.Stock, '101');
  const got = await run(`r = Item[Name == "ten"];\ngolden = r.Stock + 1;`);
  assert.equal(got, 102);
});

test('a number total over records is a number sum', async () => {
  const { run } = await seeded();
  assert.equal(await run(`total = 0;\nfor each rec in Item[ID != 0]\n{\n\ttotal = total + rec.Stock;\n}\ngolden = total;`), 107);
});

test('a currency sum over records is the exact decimal sum', async () => {
  const { run } = await seeded();
  const got = await run(`total = 0.00;\nfor each rec in Item[ID != 0]\n{\n\ttotal = total + rec.Amount;\n}\ngolden = total;`);
  assert.equal(String(got), '10.30');
});

test('rec.Qty > 5 compares numbers: 10 and 9 are both greater, 10 > 9', async () => {
  const { run } = await seeded();
  assert.deepEqual(await run(`out = List();\nfor each rec in Item[ID != 0]\n{\n\tout.add(rec.Qty > 5);\n}\ngolden = out;`), [true, true]);
  assert.equal(await run(`a = Item[Name == "ten"];\nb = Item[Name == "nine"];\ngolden = a.Qty > b.Qty;`), true);
});

test('a boolean field compares as a boolean: false is not true', async () => {
  const { run } = await seeded();
  assert.equal(await run(`r = Item[Name == "nine"];\ngolden = r.Active == true;`), false);
  assert.equal(await run(`r = Item[Name == "nine"];\nif(r.Active)\n{\n\tgolden = "yes";\n}\nelse\n{\n\tgolden = "no";\n}`), 'no');
  assert.equal(await run(`r = Item[Name == "ten"];\ngolden = r.Active == true;`), true);
});

test('a date field compares as a date against today and against another record', async () => {
  const { run } = await seeded();
  assert.equal(await run(`r = Item[Name == "ten"];\ngolden = r.Due < zoho.currentdate;`), true);
  assert.equal(await run(`r = Item[Name == "nine"];\ngolden = r.Due < zoho.currentdate;`), false);
  assert.equal(await run(`a = Item[Name == "ten"];\nb = Item[Name == "nine"];\ngolden = a.Seen < b.Seen;`), true);
});

test('an empty number field reads as null, not 0 or ""', async () => {
  const { run } = await seeded();
  assert.equal(await run(`r = Item[Name == "ten"];\ngolden = r.Tally;`), null);
  assert.equal(await run(`r = Item[Name == "ten"];\ngolden = r.Tally == null;`), true);
});

test('read then write unchanged stores every column identically', async () => {
  const { run, rows } = await seeded();
  const before = rows('Item').map((row) => ({ ...row }));
  await run(`for each rec in Item[ID != 0]\n{\n\trec.Stock = rec.Stock;\n\trec.Qty = rec.Qty;\n\trec.Amount = rec.Amount;\n\trec.Active = rec.Active;\n\trec.Due = rec.Due;\n\trec.Seen = rec.Seen;\n\trec.Tally = rec.Tally;\n}`);
  const strip = (row: Record<string, unknown>) => {
    const { MODIFIEDTIME: _m, ...rest } = row;
    return rest;
  };
  assert.deepEqual(rows('Item').map(strip), before.map(strip));
});

test('a number past 2^53 reads exactly and writes back the same digits', async () => {
  const it = await live(app());
  const big = '9007199254740993';
  await it.run(`insert into Item [ Name = "big" Stock = input.S ];`, { S: big });
  assert.equal(it.rows('Item')[0]!.Stock, big);
  const got = await it.run(`r = Item[Name == "big"];\ngolden = r.Stock;`);
  assert.equal(String(got), big);
  await it.run(`for each rec in Item[Name == "big"]\n{\n\trec.Stock = rec.Stock;\n}`);
  assert.equal(it.rows('Item')[0]!.Stock, big);
});

async function loadModule(source: string, t: { after(fn: () => void): void }): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-live-types-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(root, join(dir, 'node_modules/creator-to-catalyst'));
  writeFileSync(join(dir, 'handler.mjs'), source);
  return (await import(pathToFileURL(join(dir, 'handler.mjs')).href)) as Record<string, unknown>;
}

function workflow(partial: Partial<Workflow> & Pick<Workflow, 'name' | 'event'>): Workflow {
  return { deluge: null, properties: [], span: Z, ...partial };
}

test('gallery shape: an Order on-success workflow decrements the item stock and keeps a running total', async (t) => {
  const ir = app();
  ir.workflows.push(
    workflow({
      name: 'Reduce_stock',
      form: 'Order',
      event: 'on add on success',
      deluge: {
        text: [
          'item = Item[Name == input.Item_Name];',
          'if(item.Active && item.Qty > 5)',
          '{',
          '\titem.Stock = item.Stock - 1;',
          '\titem.Tally = ifnull(item.Tally,0) + item.Qty;',
          '}',
        ].join('\n'),
        span: Z,
      },
    }),
  );
  const file = generate(ir).files.find((f) => f.path.startsWith('functions/aio/order/') && f.source.includes('Item'));
  assert.ok(file, 'generated Order handler');
  const mod = (await loadModule(file.source, t)) as { handle: (ctx: unknown) => Promise<unknown> };
  const it = await seeded();
  for (const name of ['ten', 'nine']) await mod.handle(it.runtime.context({ record: { Item_Name: name } }));
  const ten = it.rows('Item').find((row) => row.Name === 'ten')!;
  const nine = it.rows('Item').find((row) => row.Name === 'nine')!;
  assert.equal(ten.Stock, '99');
  assert.equal(ten.Tally, '10');
  assert.equal(nine.Stock, '7', 'inactive item is untouched');
  assert.equal(nine.Tally ?? null, null);
});

test('readRow types a number the same whether the store sends digit text or a JSON number', async () => {
  const { readRow, storedRow } = (await import(pathToFileURL(join(root, 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href)) as {
    readRow(row: Record<string, unknown>, types: Record<string, string>, form?: string): Record<string, unknown>;
    storedRow(row: Record<string, unknown>, types: Record<string, string>, opts?: Record<string, unknown>): Record<string, unknown>;
  };
  const types = { Stock: 'Number', Rate: 'Double', Owner: 'BigInt' };
  const asText = readRow({ ROWID: '10000000000315013', Stock: '100', Rate: '2.5', Owner: '1000000000000000001' }, types, 'Item');
  const asJson = readRow({ ROWID: '10000000000315013', Stock: 100, Rate: 2.5, Owner: '1000000000000000001' }, types, 'Item');
  assert.deepEqual(asText, asJson);
  assert.deepEqual(asText, { ROWID: '10000000000315013', Stock: 100, Rate: 2.5, Owner: '1000000000000000001' });
  assert.deepEqual(readRow({ Stock: null, Rate: null }, types), { Stock: null, Rate: null });
  assert.equal(readRow({ Stock: '9007199254740993' }, types).Stock, 9007199254740993n);
  assert.throws(() => readRow({ Stock: 9007199254740993 }, types), /lost digits/);
  assert.deepEqual(storedRow({ Stock: 101, Big: 9007199254740993n }, { ...types, Big: 'Number' }), { Stock: '101', Big: '9007199254740993' });
  assert.throws(() => storedRow({ Stock: 2 ** 60 }, types), /lost digits/);
});

interface FieldValuesModule {
  parseValue(type: string, value: unknown): { value?: unknown; reason?: string };
  readValue(type: string, value: unknown, where: string): unknown;
  inputValue(type: string, value: unknown, field: string, scale?: number): unknown;
  createFieldReader(opts: Record<string, unknown>): { input(form: string, record: Record<string, unknown>): Record<string, unknown>; stored(form: string, row: Record<string, unknown>): Record<string, unknown> };
  inputRecord(record: Record<string, unknown>, types?: Record<string, string>, renames?: Record<string, string>): Record<string, unknown>;
  FieldValueError: new (...args: unknown[]) => Error & { status: number; field: string };
}

async function fieldValues(): Promise<FieldValuesModule> {
  return (await import(pathToFileURL(join(root, 'packages/deploy/fn/c2c-field-values.mjs')).href)) as FieldValuesModule;
}

test('store reads take the shapes Data Store returns: bigint and ROWID text, padded Double text, date text, wall time with :ms', async () => {
  const { readRow } = (await import(pathToFileURL(join(root, 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href)) as {
    readRow(row: Record<string, unknown>, types: Record<string, string>, form?: string): Record<string, unknown>;
  };
  const types = { Stock: 'Number', Rate: 'Double', Amount: 'Decimal', Due: 'Date', Seen: 'DateTime', Active: 'Boolean' };
  const row = readRow(
    { ROWID: '9007199254740992', Stock: '9007199254740992', Rate: '12.5000', Amount: '10.30', Due: '2026-10-10', Seen: '2026-10-10 06:53:35:628', Active: 'FALSE' },
    types,
    'Item',
  );
  assert.deepEqual(row, { ROWID: '9007199254740992', Stock: 9007199254740992n, Rate: 12.5, Amount: '10.30', Due: '2026-10-10', Seen: '2026-10-10T06:53:35', Active: false });
  assert.deepEqual(readRow({ Rate: 12.5, Seen: '2026-10-10 06:53:35' }, types), { Rate: 12.5, Seen: '2026-10-10T06:53:35' });
  assert.deepEqual(readRow({ Amount: '', Due: null, Active: '' }, types), { Amount: null, Due: null, Active: null });
  // A store value that does not parse is returned as it came; a posted one is refused.
  assert.equal(readRow({ Stock: 'abc' }, types).Stock, 'abc');
});

test('posted values read by field type with the same rules as stored ones', async () => {
  const { inputValue, inputRecord, readValue, FieldValueError } = await fieldValues();
  assert.equal(inputValue('Number', '5', 'Qty'), 5);
  assert.equal(inputValue('Number', 5, 'Qty'), 5);
  assert.equal(inputValue('Number', ' -12 ', 'Qty'), -12);
  assert.equal(inputValue('Number', '9007199254740993', 'Qty'), 9007199254740993n);
  assert.equal(inputValue('Number', '', 'Qty'), null);
  assert.equal(inputValue('Decimal', '10.30', 'Amount'), '10.30');
  assert.equal(inputValue('Decimal', 10.3, 'Amount'), '10.3');
  assert.equal(inputValue('Decimal', 10.3, 'Amount', 2), '10.30', 'a JSON number takes the field\'s decimal places');
  assert.equal(inputValue('Decimal', 10, 'Amount', 2), '10.00');
  assert.equal(inputValue('Decimal', 10.125, 'Amount', 2), '10.125', 'extra digits are left for the write path to round');
  assert.equal(inputValue('Decimal', '10.3', 'Amount', 2), '10.3', 'posted text keeps the digits that were typed');
  assert.equal(inputValue('Decimal', '007.50', 'Amount'), '7.50');
  assert.equal(inputValue('Decimal', '.5', 'Amount'), '0.5');
  assert.equal(inputValue('Boolean', 'true', 'Active'), true);
  assert.equal(inputValue('Boolean', false, 'Active'), false);
  assert.equal(inputValue('Date', '2026-10-10', 'Due'), '2026-10-10');
  assert.equal(inputValue('Date', '05-Oct-2026', 'Due'), '2026-10-05');
  assert.equal(inputValue('DateTime', '2026-10-10T06:53', 'Seen'), '2026-10-10T06:53:00');
  assert.equal(inputValue('DateTime', '2026-10-10 06:53:35', 'Seen'), '2026-10-10T06:53:35');
  assert.equal(inputValue('DateTime', '10-Oct-2026 06:53:35', 'Seen'), '2026-10-10T06:53:35');
  assert.equal(inputValue('DateTime', '2026-10-10T01:23:35Z', 'Seen'), '2026-10-10T01:23:35Z');
  assert.equal(inputValue('Double', '12.5000', 'Rate'), 12.5);
  for (const [type, value] of [
    ['Number', 'abc'],
    ['Number', '5.5'],
    ['Number', 5.5],
    ['Number', 'NaN'],
    ['Number', 9007199254740993],
    ['Number', {}],
    ['Double', 'abc'],
    ['Decimal', '10.3.0'],
    ['Decimal', '1e3'],
    ['Decimal', 'abc'],
    ['Boolean', 'yes'],
    ['Date', '2026-02-30'],
    ['Date', '05-10-2026'],
    ['DateTime', '2026-10-10T25:00:00'],
    ['DateTime', 'soon'],
  ] as const) {
    assert.throws(
      () => inputValue(type, value, 'F'),
      (err: unknown) => err instanceof FieldValueError && (err as { status: number }).status === 400 && /^F is /.test((err as Error).message),
      `${type} ${String(value)}`,
    );
  }
  // Every typed value parses the same posted or stored: one set of rules.
  for (const [type, value] of [['Number', '100'], ['Number', 100], ['Decimal', '10.30'], ['Boolean', 'false'], ['DateTime', '2026-10-10 06:53:35'], ['Date', '2026-10-10']] as const) {
    assert.deepEqual(inputValue(type, value, 'F'), readValue(type, value, 'F'), `${type} ${String(value)}`);
  }
  // Text is untouched; a renamed field is typed by its stored column.
  assert.deepEqual(inputRecord({ Code: '007', Qty: '5', Stock: '1' }, { Qty_c: 'Number', Code: 'Number' }, { Qty: 'Qty_c', Code: 'Code_c' }), { Code: '007', Qty: 5, Stock: '1' });
  assert.deepEqual(columnTypes(generateSchema(app()).tables).Item, {
    Active: 'Boolean',
    Added_Time: 'DateTime',
    Amount: 'Decimal',
    Amount__n: 'Double',
    Due: 'Date',
    Modified_Time: 'DateTime',
    Qty: 'Number',
    Seen: 'DateTime',
    Stock: 'Number',
    Tally: 'Number',
  });
});

const SHOP = [
  'application "Shop"',
  '{',
  '\ttime zone = "UTC"',
  '\tsection Main',
  '\t{',
  FORMS.split('\n').map((line) => `\t${line}`).join('\n'),
  '\t}',
  '\tshare_settings',
  '\t{',
  '\t\t"Administrator"',
  '\t\t{',
  '\t\t\tname = "Administrator"',
  '\t\t\ttype = Users_Permissions',
  '\t\t\tdescription = "This profile will have all the permissions."',
  '\t\t}',
  '\t}',
  '}',
  '',
].join('\n');

/** Shop with Qty, Amount and Code on Order, and an Order workflow adding them to the item. */
function shopWithOrderFields(): App {
  const ir = deriveIr(parse(SHOP));
  const order = ir.forms.find((form) => form.name === 'Order')!;
  for (const name of ['Qty', 'Amount', 'Code']) {
    order.fields.push({ ...ir.forms.find((form) => form.name === 'Item')!.fields.find((field) => field.name === (name === 'Code' ? 'Name' : name))!, name });
  }
  ir.workflows.push(
    workflow({
      name: 'Restock',
      form: 'Order',
      event: 'on add on success',
      deluge: { text: ['item = Item[Name == input.Item_Name];', 'item.Stock = input.Qty + item.Stock;', 'item.Amount = input.Amount + item.Amount;'].join('\n'), span: Z },
    }),
  );
  return ir;
}

/** The deployed entry (fn/index.js) over HTTP on 127.0.0.1, with the offline SDK stand-in. */
async function deployedEntry(t: { after(fn: () => Promise<void> | void): void }, build?: () => App) {
  const ir = build ? build() : shopWithOrderFields();
  const out = mkdtempSync(join(tmpdir(), 'c2c-live-input-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const previousMode = process.env.C2C_DEPLOY_MODE;
  const previousZone = process.env.C2C_APP_TIMEZONE;
  process.env.C2C_APP_TIMEZONE = 'UTC';
  const org = '10000000000';
  const guard: GuardOk = { org, projectId: '1001', environment: ALLOWED_ENV, projectName: catalystProjectName(ir.name || 'app'), dc: 'in', registry: { org, env: 'Development', projects: {}, dc: 'in' } };
  writeDeployTree(out, deployFiles(ir, guard, false, { mode: 'live' }).files);
  const req = createRequire(import.meta.url);
  const sdk = req(fake) as FakeSdk & { setSession(token: string, user: unknown): void };
  for (const table of Object.keys(sdk.state().tables)) sdk.state().tables[table]?.splice(0);
  sdk.setSession('input-types', { user_id: '1', role_details: { role_name: 'App Administrator' } });
  const entry = req(join(out, 'functions/c2c_api/index.js')) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    moduleAny._resolveFilename = original;
    if (previousMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = previousMode;
    if (previousZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = previousZone;
    rmSync(out, { recursive: true, force: true });
  });
  const port = (server.address() as { port: number }).port;
  const submit = async (form: string, record: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api/forms/${form}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=input-types' },
      body: JSON.stringify({ record }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const rows = (table: string) => sdk.state().tables[table] ?? [];
  return { submit, rows, tables: () => sdk.state().tables };
}

test('a number posted as text adds to a stored number in a handler: "5" + 100 is 105', async (t) => {
  const { submit, rows } = await deployedEntry(t);
  const seeded = await submit('Item', { Name: 'ten', Stock: 100, Amount: '10.10' });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  const posted = await submit('Order', { Item_Name: 'ten', Qty: '5', Amount: '10.30', Code: '007' });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const item = rows('Item').find((row) => row.Name === 'ten')!;
  assert.equal(item.Stock, '105');
  assert.equal(item.Amount, '20.40');
  const saved = rows('Order')[0]!;
  assert.equal(saved.Qty, '5');
  assert.equal(saved.Amount, '10.30', 'a decimal posted as text keeps its exact digits');
  assert.equal(saved.Code, '007', 'a text field is never read as a number');
});

test('a number posted as a JSON number still adds: 5 + 100 is 105', async (t) => {
  const { submit, rows } = await deployedEntry(t);
  assert.equal((await submit('Item', { Name: 'ten', Stock: '100', Amount: '0.00' })).status, 200);
  const posted = await submit('Order', { Item_Name: 'ten', Qty: 5, Amount: 10.3, Code: '007' });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(rows('Item').find((row) => row.Name === 'ten')!.Stock, '105');
  assert.equal(rows('Order')[0]!.Amount, '10.30', 'a JSON number is written out to the field\'s 2 decimal places, not binary64 digits');
});

test('text that is not a number in a number field is a 400 naming the field, and nothing is written', async (t) => {
  const { submit, rows } = await deployedEntry(t);
  assert.equal((await submit('Item', { Name: 'ten', Stock: 100 })).status, 200);
  const refused = await submit('Order', { Item_Name: 'ten', Qty: 'abc' });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.field, 'Qty');
  assert.match(String(refused.body.error), /Qty is "abc", not a valid number value/);
  assert.equal(rows('Order').length, 0);
  assert.equal(rows('Item').find((row) => row.Name === 'ten')!.Stock, '100');
});

const SUBFORM_SHOP = [
  'application "Lines"',
  '{',
  '\ttime zone = "UTC"',
  '\tsection Main',
  '\t{',
  '\t\tform Item',
  '\t\t{',
  '\t\t\tName',
  '\t\t\t(',
  '\t\t\t\ttype = text',
  '\t\t\t)',
  '\t\t\tStock',
  '\t\t\t(',
  '\t\t\t\ttype = number',
  '\t\t\t)',
  '\t\t}',
  '\t\tform Order',
  '\t\t{',
  '\t\t\tItem_Name',
  '\t\t\t(',
  '\t\t\t\ttype = text',
  '\t\t\t)',
  '\t\t\tLines',
  '\t\t\t(',
  '\t\t\t\ttype = grid',
  '\t\t\t\tQty',
  '\t\t\t\t(',
  '\t\t\t\t\ttype = number',
  '\t\t\t\t)',
  '\t\t\t\tPrice',
  '\t\t\t\t(',
  '\t\t\t\t\ttype = decimal',
  '\t\t\t\t\tdecimalplace = 2',
  '\t\t\t\t)',
  '\t\t\t)',
  '\t\t}',
  '\t}',
  '\tshare_settings',
  '\t{',
  '\t\t"Administrator"',
  '\t\t{',
  '\t\t\tname = "Administrator"',
  '\t\t\ttype = Users_Permissions',
  '\t\t\tdescription = "This profile will have all the permissions."',
  '\t\t}',
  '\t}',
  '}',
  '',
].join('\n');

/** Lines: an Order workflow adds each subform row's Qty to the item's stock. */
function linesApp(): App {
  const ir = deriveIr(parse(SUBFORM_SHOP));
  ir.workflows.push(
    workflow({
      name: 'Restock_lines',
      form: 'Order',
      event: 'on add on success',
      deluge: { text: ['item = Item[Name == input.Item_Name];', 'for each line in input.Lines', '{', '\titem.Stock = line.Qty + item.Stock;', '}'].join('\n'), span: Z },
    }),
  );
  return ir;
}

test('a subform row number posted as text adds to a stored number: child Qty "5" + 100 is 105', async (t) => {
  const { submit, rows, tables } = await deployedEntry(t, linesApp);
  assert.equal((await submit('Item', { Name: 'ten', Stock: 100 })).status, 200);
  const posted = await submit('Order', { Item_Name: 'ten', Lines: [{ Qty: '5', Price: 2.5 }] });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(rows('Item').find((row) => row.Name === 'ten')!.Stock, '105');
  const child = Object.entries(tables()).find(([table]) => table !== 'Item' && table !== 'Order')?.[1] ?? [];
  assert.equal(child.length, 1, 'one child row saved');
  assert.equal(child[0]!.Qty, '5');
  assert.equal(child[0]!.Price, '2.50', 'a child decimal JSON number takes its 2 decimal places');
});

test('text that is not a number in a subform number field is a 400 naming the subform field', async (t) => {
  const { submit, rows } = await deployedEntry(t, linesApp);
  assert.equal((await submit('Item', { Name: 'ten', Stock: 100 })).status, 200);
  const refused = await submit('Order', { Item_Name: 'ten', Lines: [{ Qty: '1' }, { Qty: 'abc' }] });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.field, 'Lines[1].Qty');
  assert.match(String(refused.body.error), /Lines\[1\]\.Qty is "abc", not a valid number value/);
  assert.equal(rows('Order').length, 0);
  assert.equal(rows('Item').find((row) => row.Name === 'ten')!.Stock, '100');
});

test('a local dry run reads posted and seeded values like the deployed entry: "5" + stored "100" is 105 in both', async () => {
  const ir = shopWithOrderFields();
  const schema = generateSchema(ir);
  const { createFieldReader } = await fieldValues();
  const reader = createFieldReader({ columns: columnTypes(schema.tables), rules: writeRulesOf(ir, schema) });
  const script = `item = Item[Name == "ten"];\ngolden = input.Qty + item.Stock;`;
  const decimalFields = ['Amount'];
  const translated = translate(script, { formNames: appFormNames(ir), formFields: appFormFields(ir), decimalFields });
  const fn = new AsyncFunction('shim', 'ctx', `${translated.server}\nreturn typeof golden === 'undefined' ? undefined : golden;`);
  const dryRun = (fieldValues?: typeof reader) => {
    const runtime = createRuntime({
      dryRun: true,
      appTimeZone: 'UTC',
      now: new Date('2026-10-10T12:00:00Z'),
      decimalColumns: decimalColumnsOf(ir),
      seed: { Item: [{ Name: 'ten', Stock: '100', Amount: '10.10' }] },
      ...(fieldValues ? { fieldValues } : {}),
    });
    return fn(runtime.shim, runtime.context({ form: 'Order', record: { Item_Name: 'ten', Qty: '5', Amount: 10.3 } }));
  };
  // Live: the stored row reads through the adapter and the posted record through the entry's rules.
  const it = await live(ir);
  await it.run(`insert into Item [ Name = input.Name Stock = input.Stock Amount = input.Amount ];`, { Name: 'ten', Stock: '100', Amount: '10.10' });
  const liveGot = await it.run(script, reader.input('Order', { Item_Name: 'ten', Qty: '5', Amount: 10.3 }));
  assert.equal(liveGot, 105);
  assert.equal(await dryRun(reader), liveGot);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', fieldValues: reader });
  assert.equal(runtime.context({ form: 'Order', record: { Amount: 10.3 } }).record.Amount, '10.30');
  assert.throws(() => runtime.context({ form: 'Order', record: { Qty: 'abc' } }), /Qty is "abc", not a valid number value/);
});
