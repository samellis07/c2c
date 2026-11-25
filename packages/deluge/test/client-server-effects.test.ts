import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { emptyApp, type App, type Workflow } from '../../core/src/index.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { generate } from '../src/generate.js';
import { translate } from '../src/translate.js';

// A field `:ui` task fed by a write result (the id an insert returned) cannot be
// prefetched: the browser would run the write a second time. The browser posts
// the server half anyway, so that run evaluates the task once and answers with
// the effect; the browser keeps a marker where the task sat.
const Z = { start: 0, end: 0 };
const ADMIN = { name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: Z };

const SCRIPT = [
  'rec = Users[Mail == zoho.loginuserid];',
  'if (rec.count() <= 0) {',
  '  newId = insert into Users [Mail = zoho.loginuserid];',
  '  input.Organizers:ui.add(newId);',
  '}',
].join('\n');

const options = { formNames: ['Users'], inputFields: ['Organizers', 'Name'] };
const counted = (r: ReturnType<typeof translate>): number => r.todos.filter((t) => t.construct === 'client-condition-uses-server').length;

test('a ui task fed by an insert result is one server effect with a marker in the client', () => {
  const r = translate(SCRIPT, { ...options, serverEffects: true });
  assert.equal(counted(r), 0);
  assert.match(r.client, /actions\.push\(\{ op: "serverEffect", key: "(e\d+)" \}\);/);
  assert.doesNotMatch(r.client, /shim\.todo\(|"ui"/);
  const key = /key: "(e\d+)"/.exec(r.client)![1];
  assert.match(r.server, new RegExp(`shim\\.client\\.effect\\(ctx, "${key}", \\{ op: "ui", method: "add", target: \\["Organizers"\\], args: \\[newId\\] \\}\\);`));
  // The effect follows the write it reads, inside the same arm.
  assert.ok(r.server.indexOf('shim.datastore.insert') < r.server.indexOf('shim.client.effect'));
  for (const row of r.coverage) assert.notEqual(row.bucket, 'skipped');
});

test('without a client run for the event the counted todo stays', () => {
  assert.equal(counted(translate(SCRIPT, options)), 1);
  assert.equal(counted(translate(SCRIPT, { ...options, serverEffects: false })), 1);
});

test('a task in a server-only unit has no client and no effect', () => {
  const r = translate(SCRIPT, { ...options, serverEffects: true, serverOnly: true });
  assert.equal(counted(r), 0);
  assert.doesNotMatch(r.server, /shim\.client\.effect/);
});

test('a task in a loop or a try arm keeps the counted todo', () => {
  const loop = 'for each u in Users[Mail != ""] {\n  newId = insert into Users [Mail = u.Mail];\n  input.Organizers:ui.add(newId);\n}';
  const attempt = 'try {\n  newId = insert into Users [Mail = zoho.loginuserid];\n  input.Organizers:ui.add(newId);\n} catch (e) {\n  info e;\n}';
  for (const src of [loop, attempt]) {
    const r = translate(src, { ...options, serverEffects: true });
    assert.ok(counted(r) > 0, src);
    assert.doesNotMatch(r.server, /shim\.client\.effect/, src);
  }
});

test('markers keep the script order with the client tasks around them', () => {
  const r = translate(
    ['input.Organizers:ui.clear();', SCRIPT.replace('input.Organizers:ui.add(newId);', 'input.Organizers:ui.add(newId);\n  input.Name:ui.add("x");')].join('\n'),
    { ...options, serverEffects: true },
  );
  const at = (needle: string): number => r.client.indexOf(needle);
  assert.ok(at('"clear"') < at('serverEffect') && at('serverEffect') < at('args: ["x"]'));
});

function build(event: string): ReturnType<typeof generate> {
  const wf: Workflow = { name: 'wf', form: 'Orders', event, deluge: { text: SCRIPT.replace(/Users/g, 'Orders').replace('Mail', 'Kind'), span: Z }, properties: [], span: Z };
  const field = (name: string): App['forms'][number]['fields'][number] => ({ name, type: 'text', modifiers: [], required: false, unique: false, properties: [], subfields: [], annotations: [], flags: [], span: Z });
  return generate({
    ...emptyApp('empty'),
    name: 'Demo_App',
    forms: [{ name: 'Orders', properties: [], fields: [field('Organizers'), field('Kind'), field('Name')], actions: [], blocks: [], span: Z }],
    profiles: [ADMIN],
    workflows: [wf],
  } as App);
}
const text = (g: ReturnType<typeof generate>, suffix: string): string => g.files.find((f) => f.path.endsWith(suffix))?.source ?? '';
const effectTodos = (g: ReturnType<typeof generate>): number => g.todos.filter((t) => t.construct === 'client-condition-uses-server').length;

test('on load the client settles the run reply and the route answers with the effects', () => {
  const g = build('on load');
  assert.equal(effectTodos(g), 0);
  assert.match(text(g, 'client/handlers/orders/on-load.mjs'), /actions\.splice\(0, actions\.length, \.\.\.shim\.client\.settle\(actions, await shim\.client\.run\(ctx\)\)\);/);
  const route = text(g, 'functions/aio/orders/on-load.mjs');
  assert.match(route, /shim\.client\.effect\(ctx, "e\d+", \{ op: "ui", method: "add"/);
  assert.match(route, /\.\.\.\(ctx\.clientEffects \? \{ effects: ctx\.clientEffects \} : \{\}\)/);
});

test('an event the browser does not post keeps the counted todo', () => {
  assert.ok(effectTodos(build('on validate')) > 0);
});

test('a route without effects does not mention them', () => {
  const g = build('on load');
  const other = generate({ ...emptyApp('empty'), name: 'Demo_App' } as App);
  assert.doesNotMatch(other.files.map((f) => f.source).join('\n'), /clientEffects/);
  assert.match(text(g, 'functions/aio/orders/on-load.mjs'), /clientEffects/);
});

test('the server runtime queues effects by marker, in the order they ran', () => {
  const { shim, context } = (() => {
    const rt = createRuntime({ dryRun: true });
    return { shim: rt.shim, context: rt.context({ record: {}, old: {} }) };
  })();
  const one = { op: 'ui' as const, method: 'add', target: ['A'], args: ['1'] };
  const two = { op: 'ui' as const, method: 'add', target: ['A'], args: ['2'] };
  shim.client.effect(context, 'e0', one);
  shim.client.effect(context, 'e1', two);
  shim.client.effect(context, 'e0', two);
  assert.deepEqual(context.clientEffects, { e0: [one, two], e1: [two] });
});

interface BrowserRuntime {
  browserShim(): { client: { settle(actions: unknown[], reply: unknown): unknown[] } };
  applyActions(actions: unknown[], root: unknown): string[];
}
const browserRuntime = async (): Promise<BrowserRuntime> => (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as BrowserRuntime;
const browserClient = async (): Promise<{ settle(actions: unknown[], reply: unknown): unknown[] }> => (await browserRuntime()).browserShim().client;

test('the browser puts each effect where its marker sat and drops an unanswered marker', async () => {
  const { settle } = await browserClient();
  const clear = { op: 'ui', method: 'clear', target: ['A'], args: [] };
  const add = { op: 'ui', method: 'add', target: ['A'], args: ['7'] };
  const info = { op: 'info', message: 'later' };
  const out = settle([clear, { op: 'serverEffect', key: 'e0' }, { op: 'serverEffect', key: 'e1' }, info], { effects: { e0: [add, add] } });
  assert.deepEqual(out, [clear, add, add, info]);
});

test('a reply cannot smuggle any other action through settle', async () => {
  const { settle } = await browserClient();
  const marker = [{ op: 'serverEffect', key: 'e0' }];
  const hostile = [
    { op: 'openUrl', url: 'https://example.invalid/', target: 'new window' },
    { op: 'openUrl', args: [] },
    { op: 'reload' },
    { op: 'subform', method: 'delete', target: ['S'], args: [[]] },
    { op: 'setValue', value: 'x', targets: ['A'] },
    { op: 'successMessage', message: 'x' },
    { op: 'ui', method: 'innerHTML', target: ['A'], args: ['<img>'] },
    { op: 'ui', method: 'add', target: 'A', args: ['x'] },
    { op: 'ui', method: 'add', target: [1], args: ['x'] },
    { op: 'ui', method: 'add', target: ['A'], args: 'x' },
    null,
    'add',
  ];
  assert.deepEqual(settle(marker, { effects: { e0: hostile } }), []);
  for (const reply of [null, undefined, {}, { effects: null }, { effects: [] }, { effects: 'x' }, { effects: { e0: 'add' } }, { effects: { e0: { op: 'ui' } } }, { effects: { __proto__: { e0: hostile } } }]) {
    assert.deepEqual(settle(marker, reply), [], JSON.stringify(reply));
  }
});

test('an openUrl whose address only the server run can build is a server effect', () => {
  const src = ['encoded = zoho.encryption.urlEncode(input.Name);', 'ok = insert into Users [Mail = encoded];', 'openUrl("#Form:Confirm?Code=" + ok, "popup window");'].join('\n');
  const r = translate(src, { ...options, serverEffects: true });
  assert.equal(counted(r), 0);
  assert.match(r.client, /actions\.push\(\{ op: "serverEffect", key: "e\d+" \}\);/);
  assert.doesNotMatch(r.client, /op: "openUrl"/);
  assert.match(r.server, /shim\.client\.effect\(ctx, "e\d+", \{ op: "openUrl", args: \[\("#Form:Confirm\?Code=" \+ ok\), "popup window"\] \}\);/);
  assert.equal(counted(translate(src, options)), 1);
});

test('an openUrl effect meets the address policy of any other openUrl', async () => {
  const runtime = await browserRuntime();
  const marker = [{ op: 'serverEffect', key: 'e0' }];
  const refused = ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', '//evil.example/x', 'https:\\\\evil.example/x', '#Script:evil'];
  for (const url of refused) {
    const settled = runtime.browserShim().client.settle(marker, { effects: { e0: [{ op: 'openUrl', args: [url, 'same window'] }] } });
    assert.deepEqual(runtime.applyActions(settled, null), ['openUrl refused'], url);
  }
  const ok = runtime.browserShim().client.settle(marker, { effects: { e0: [{ op: 'openUrl', args: ['#Form:Confirm?Code=1', 'popup window'] }] } });
  assert.deepEqual(runtime.applyActions(ok, null), ['#Form:Confirm?Code=1']);
  // Only strings reach the navigation: an object or a list is not an address.
  for (const args of [[], [{ href: 'https://example.invalid/' }], [['https://example.invalid/']], ['#a', 'same window', 'extra'], [null]]) {
    assert.deepEqual(runtime.browserShim().client.settle(marker, { effects: { e0: [{ op: 'openUrl', args }] } }), [], JSON.stringify(args));
  }
});

// The supply-chain invoice shape: rows built from a fetched order, inserted, then a
// loop over the subform writes each row's total and sums them into a field.
const INVOICE = [
  'if (input.Order_ID != null) {',
  '  order = Orders[ID == input.Order_ID];',
  '  input.Products.clear();',
  '  rows = Collection();',
  '  for each item in order.Products {',
  '    line = Invoice.Products();',
  '    line.Code = item.Product;',
  '    line.Qty = item.Quantity;',
  '    line.Price = 2;',
  '    rows.insert(line);',
  '  }',
  '  input.Products.insert(rows);',
  '  total = 0;',
  '  for each r in input.Products {',
  '    r.Sub_total = r.Qty * r.Price;',
  '    total = total + r.Sub_total;',
  '  }',
  '  input.Total = total;',
  '}',
].join('\n');
const invoice = (serverEffects: boolean) => translate(INVOICE, { formNames: ['Orders', 'Invoice'], inputFields: ['Order_ID', 'Products', 'Total'], serverEffects });

test('rows a script built, the loop that totals them and the field it feeds are answered by the server run', async () => {
  const r = invoice(true);
  assert.deepEqual(r.todos, []);
  assert.doesNotMatch(r.client, /client-loop-uses-server|r\.Sub_total|"Sub_total"/);
  assert.match(r.client, /actions\.push\(\{ op: "clear", targets: \["Products"\] \}\);[^]*op: "serverEffect", key: "e\d+"[^]*op: "serverEffect", key: "e\d+"/);
  const runtime = createRuntime({ dryRun: true, seed: { Orders: [{ ROWID: '7', Products: [{ Product: 'A', Quantity: 3 }, { Product: 'B', Quantity: 2 }] }] } });
  const ctx = runtime.context({ record: { Order_ID: '7', Products: [{ Code: 'stale' }] }, old: {}, principal: { profile: 'Administrator' } });
  const run = new (Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (ctx: unknown, shim: unknown) => Promise<void>)('ctx', 'shim', r.server);
  await run(ctx, runtime.shim);
  const effects = JSON.parse(JSON.stringify(ctx.clientEffects, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const keys = Object.keys(effects).sort();
  assert.equal(keys.length, 2);
  const [insert, total] = keys.map((k) => effects[k][0]);
  assert.equal(insert.op, 'subform');
  assert.deepEqual(insert.args[0].map((row: { values: unknown }) => row.values), [
    { Code: 'A', Qty: 3, Price: 2, Sub_total: 6 },
    { Code: 'B', Qty: 2, Price: 2, Sub_total: 4 },
  ]);
  assert.deepEqual(total, { op: 'setValue', targets: ['Total'], args: [10] });
});

test('without a client run for the event the loop over queued rows keeps the counted todo', () => {
  assert.ok(invoice(false).todos.some((t) => t.construct === 'client-loop-uses-server'));
});

test('a loop over a subform the script never inserted into keeps its own client copy', () => {
  const r = translate('total = 0;\nfor each r in input.Products {\n  r.Sub_total = r.Qty * r.Price;\n  total = total + r.Sub_total;\n}\ninput.Total = total;', {
    inputFields: ['Products', 'Total'],
    serverEffects: true,
  });
  assert.deepEqual(r.todos, []);
  assert.match(r.client, /for \(var r of shim\.each\(ctx, shim\.input\.get\(ctx, "Products"\)\)\)/);
  assert.doesNotMatch(r.client, /serverEffect/);
});

test('settle keeps a subform insert and a field value, and refuses their malformed forms', async () => {
  const { settle } = await browserClient();
  const marker = [{ op: 'serverEffect', key: 'e0' }];
  const insert = { op: 'subform', method: 'insert', target: ['Products'], args: [[{ __row: true, values: { A: 1 } }]] };
  const value = { op: 'setValue', targets: ['Total'], args: [10] };
  assert.deepEqual(settle(marker, { effects: { e0: [insert, value] } }), [insert, value]);
  for (const bad of [
    { op: 'subform', method: 'clear', target: ['Products'], args: [[]] },
    { op: 'subform', method: 'insert', target: 'Products', args: [[]] },
    { op: 'subform', method: 'insert', target: [], args: [[]] },
    { op: 'subform', method: 'insert', target: ['Products'], args: [[], []] },
    { op: 'setValue', targets: ['A', 'B'], args: [1] },
    { op: 'setValue', targets: [], args: [1] },
    { op: 'setValue', targets: ['A'], args: [] },
    { op: 'setValue', targets: [1], args: [1] },
    { op: 'setValue', targets: 'A', args: [1] },
  ]) {
    assert.deepEqual(settle(marker, { effects: { e0: [bad] } }), [], JSON.stringify(bad));
  }
});
