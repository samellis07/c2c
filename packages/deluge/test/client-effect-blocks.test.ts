import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../../shims/src/runtime.js';
import { translate } from '../src/translate.js';

// A client condition only the server run can decide (it reads what an insert or a
// writing call left) used to keep a counted todo even when every client action under it
// is one the server run can answer. The browser posts the form event's server half
// anyway, so that run now evaluates the condition once, queues the arm's actions as
// effects under one marker key, and the browser keeps the marker where the if sat.
const options = { formNames: ['Users'], inputFields: ['Organizers', 'Name', 'Title', 'Edition'], serverEffects: true };
const counted = (r: ReturnType<typeof translate>): number => r.todos.filter((t) => t.construct === 'client-condition-uses-server').length;
const keyOf = (r: ReturnType<typeof translate>): string => /op: "serverEffect", key: "(e\d+)"/.exec(r.client)![1]!;

type Effect = { op: string; [k: string]: unknown };
async function run(r: ReturnType<typeof translate>, seed: Record<string, Record<string, unknown>[]> = {}, record: Record<string, unknown> = {}): Promise<Record<string, Effect[]>> {
  const runtime = createRuntime({ dryRun: true, seed });
  const ctx = runtime.context({ record, old: {}, principal: { profile: 'Administrator' } });
  const body = new (Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (ctx: unknown, shim: unknown) => Promise<void>)('ctx', 'shim', r.server);
  await body(ctx, runtime.shim);
  return JSON.parse(JSON.stringify(ctx.clientEffects ?? {}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

const ALERT = ['id = insert into Users [Mail = "a"];', 'alert "Your reference is " + id + ".";'].join('\n');

test('an alert whose text only the server run knows is one server effect', async () => {
  const r = translate(ALERT, options);
  assert.equal(counted(r), 0);
  assert.doesNotMatch(r.client, /op: "alert"|shim\.todo\(/);
  const key = keyOf(r);
  assert.match(r.server, new RegExp(`shim\\.client\\.effect\\(ctx, "${key}", \\{ op: "alert", message: `));
  assert.ok(r.server.indexOf('shim.datastore.insert') < r.server.indexOf('shim.client.effect'));
  const [alert] = (await run(r))[key]!;
  assert.match(String(alert!.message), /^Your reference is .+\.$/);
  assert.equal(counted(translate(ALERT, { ...options, serverEffects: false })), 1);
});

test('an alert with a text the browser can build stays a browser action', () => {
  const r = translate('alert "Saved " + input.Name;', options);
  assert.match(r.client, /actions\.push\(\{ op: "alert"/);
  assert.doesNotMatch(r.client, /serverEffect/);
});

const OPEN = ['id = insert into Users [Mail = "a"];', 'n = id.toString().length();', 'if (n > 0) {', '  openUrl("#Report:R", "same window");', '}'].join('\n');

test('an if over a count the server run took is answered by the server run', async () => {
  const r = translate(OPEN, options);
  assert.equal(counted(r), 0);
  assert.doesNotMatch(r.client, /(?:^if \()|shim\.todo\(|"openUrl"/m);
  const key = keyOf(r);
  assert.match(r.server, new RegExp(`if \\(\\(n > 0\\)\\) \\{\\n  shim\\.client\\.effect\\(ctx, "${key}", \\{ op: "openUrl", args: \\["#Report:R", "same window"\\] \\}\\);\\n\\}`));
  assert.deepEqual((await run(r))[key], [{ op: 'openUrl', args: ['#Report:R', 'same window'] }]);
  assert.equal(counted(translate(OPEN, { ...options, serverEffects: false })), 1);
});

const LIST = [
  'rec = Users[ID == 3].Mail;',
  'input.Name = rec;',
  'list1 = List();',
  'for each u in Users[Mail != input.Name] {',
  '  list1.add(u.Mail);',
  '}',
  'for each r in input.Items {',
  '  list1.removeelement(r.Code);',
  '}',
  'if (!list1.isEmpty()) {',
  '  input.Organizers:ui.add(list1);',
  '}',
].join('\n');

test('a :ui task under a test over a list a loop over the form trimmed is queued by the server run', async () => {
  const r = translate(LIST, { ...options, inputFields: [...options.inputFields, 'Items'] });
  assert.equal(counted(r), 0);
  assert.doesNotMatch(r.client, /shim\.todo\(/);
  const key = keyOf(r);
  assert.match(r.server, new RegExp(`shim\\.client\\.effect\\(ctx, "${key}", \\{ op: "ui", method: "add", target: \\["Organizers"\\], args: \\[list1\\] \\}\\);`));
  const users = [{ ROWID: '3', Mail: 'own' }, { ROWID: '4', Mail: 'x' }, { ROWID: '5', Mail: 'y' }];
  const effects = await run(r, { Users: users }, { Items: [{ Code: 'x' }] });
  assert.deepEqual(effects[key], [{ op: 'ui', method: 'add', target: ['Organizers'], args: [['y']] }]);
  // A list the trim empties queues nothing: the arm did not run.
  assert.deepEqual((await run(r, { Users: users.slice(0, 2) }, { Items: [{ Code: 'x' }] }))[key] ?? [], []);
});

const BOOK = [
  'id = insert into Users [Mail = "a"];',
  'if (id != null) {',
  '  input.Title = id;',
  '  disable Title;',
  '  input.Edition = "";',
  '  enable Edition;',
  '} else {',
  '  input.Title = "";',
  '  hide Edition;',
  '}',
].join('\n');

test('the arms of a server-decided if queue their field writes and visibility changes in order', async () => {
  const r = translate(BOOK, options);
  assert.equal(counted(r), 0);
  assert.deepEqual(r.todos, []);
  assert.doesNotMatch(r.client, /(?:^if \()|shim\.input\.set/m);
  const key = keyOf(r);
  const effects = (await run(r))[key]!;
  assert.deepEqual(effects.map((e) => [e.op, e.targets]), [
    ['setValue', ['Title']],
    ['disable', ['Title']],
    ['setValue', ['Edition']],
    ['enable', ['Edition']],
  ]);
  assert.match(String(effects[0]!.args), /.+/);
  assert.deepEqual(effects[2]!.args, ['']);
  // The else arm queues under the same key, and only the arm that ran queues.
  const other = translate(BOOK.replace('!= null', '== null'), options);
  assert.deepEqual((await run(other))[keyOf(other)], [
    { op: 'setValue', targets: ['Title'], args: [''] },
    { op: 'hide', targets: ['Edition'] },
  ]);
  for (const row of r.coverage) assert.notEqual(row.bucket, 'skipped');
});

test('an arm with a client action the reply cannot carry keeps the counted todo', () => {
  const r = translate(['id = insert into Users [Mail = "a"];', 'if (id > 0) {', '  reload;', '}'].join('\n'), options);
  assert.equal(counted(r), 1);
  assert.doesNotMatch(r.server, /shim\.client\.effect/);
});

test('the same if inside a try arm or without a client run keeps the counted todo', () => {
  const attempt = ['try {', '  id = insert into Users [Mail = "a"];', '  if (id > 0) {', '    openUrl("#Report:R", "same window");', '  }', '} catch (e) {', '  info e;', '}'].join('\n');
  assert.ok(counted(translate(attempt, options)) > 0);
  assert.doesNotMatch(translate(attempt, options).server, /shim\.client\.effect/);
  assert.equal(counted(translate(OPEN, { ...options, serverEffects: false })), 1);
  assert.equal(counted(translate(OPEN, { ...options, serverOnly: true })), 0);
  assert.doesNotMatch(translate(OPEN, { ...options, serverOnly: true }).server, /shim\.client\.effect/);
});

// The education shape: a loop over the rows of a subform adds one list to a column of each, and the
// list reads a field the script wrote, so only the server run can build it.
const COLUMN = [
  'input.Name = "n";',
  'ids = List();',
  'for each u in Users[Mail == input.Name] {',
  '  ids.add(u.Mail);',
  '}',
  'for each r in input.Items {',
  '  r.Pick:ui.add(ids);',
  '}',
].join('\n');
const withItems = { ...options, inputFields: [...options.inputFields, 'Items'] };

test('a loop over the rows of a subform that adds one list to a column of each is answered by the server run', async () => {
  const r = translate(COLUMN, withItems);
  assert.deepEqual(r.todos, []);
  assert.doesNotMatch(r.client, /shim\.todo\(|"Pick"|\bfor \(/);
  const key = keyOf(r);
  assert.match(r.server, new RegExp(`for \\(var r of shim\\.each\\(ctx, shim\\.input\\.get\\(ctx, "Items"\\)\\)\\) \\{\\n  shim\\.client\\.effect\\(ctx, "${key}", \\{ op: "ui", method: "add", target: \\["Items","Pick"\\], args: \\[ids\\] \\}\\);`));
  const effects = await run(r, { Users: [{ ROWID: '1', Mail: 'n' }] }, { Items: [{ Pick: 'x' }, { Pick: 'y' }] });
  assert.deepEqual(effects[key], [
    { op: 'ui', method: 'add', target: ['Items', 'Pick'], args: [['n']] },
    { op: 'ui', method: 'add', target: ['Items', 'Pick'], args: [['n']] },
  ]);
  assert.equal((await run(r, { Users: [{ ROWID: '1', Mail: 'n' }] }, { Items: [] }))[key], undefined);
  assert.equal(counted(translate(COLUMN, { ...withItems, serverEffects: false })), 1);
});

test('a loop that hands the row itself to the task keeps the counted todo', () => {
  const r = translate(COLUMN.replace('r.Pick:ui.add(ids)', 'r.Pick:ui.add(r.Code + ids.size())'), withItems);
  assert.doesNotMatch(r.server, /shim\.client\.effect/);
});

// The volunteer shape: each pass of a loop over the new rows writes the date of the row the event
// fired on, or alerts, depending on a date read from the server.
const DATES = [
  'ev = Users[ID == 3];',
  'start = ev.Mail.toDate();',
  'for each r in input.Items {',
  '  if (start > zoho.currenttime) {',
  '    alert "Too late";',
  '  } else {',
  '    row.Pick = start;',
  '    start = start.addDay(1);',
  '  }',
  '}',
].join('\n');

test('a row write and an alert under a server-read date in a loop are queued in loop order, the row addressed by index', async () => {
  const r = translate(DATES, { ...options, inputFields: [...options.inputFields, 'Items'], rowNames: ['row'] });
  assert.deepEqual(r.todos, []);
  const key = keyOf(r);
  assert.match(r.server, new RegExp(`shim\\.client\\.effect\\(ctx, "${key}", shim\\.client\\.rowValue\\(ctx, d_row, "Pick"\\)\\);`));
  const runtime = createRuntime({ dryRun: true, seed: { Users: [{ ROWID: '3', Mail: '2020-01-01' }] } });
  const record = { Items: [{ Pick: null }, { Pick: null }] };
  const ctx = runtime.context({ record, old: {}, principal: { profile: 'Administrator' }, subformRow: { field: 'Items', index: 1 } });
  const body = new (Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (ctx: unknown, shim: unknown) => Promise<void>)('ctx', 'shim', `const d_row = shim.subform.currentRow(ctx, "Items");\n${r.server}`);
  await body(ctx, runtime.shim);
  const queued = JSON.parse(JSON.stringify(ctx.clientEffects ?? {}))[key] as Effect[];
  assert.deepEqual(queued.map((e) => [e.op, e.targets, e.row]), [['setValue', ['Items.Pick'], 1], ['setValue', ['Items.Pick'], 1]]);
  // Outside a subform row event the value has no row to land in, so nothing is queued.
  const none = runtime.context({ record, old: {}, principal: { profile: 'Administrator' } });
  assert.equal(runtime.shim.client.rowValue(none, record.Items[1], 'Pick'), null);
});

test('an arm that writes a field the browser can never receive keeps the counted todo', () => {
  const src = ['id = insert into Users [Mail = "a"];', 'n = id.toString().length();', 'if (n > 0) {', '  input.Items.Pick = id;', '  openUrl("#Report:R", "same window");', '}'].join('\n');
  const r = translate(src, withItems);
  assert.equal(counted(r), 1);
  assert.doesNotMatch(r.server, /shim\.client\.effect/);
});

interface BrowserRuntime {
  browserShim(): { client: { settle(actions: unknown[], reply: unknown): unknown[] } };
  applyActions(actions: unknown[], root: unknown): string[];
}
const browser = async (): Promise<BrowserRuntime> => (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as BrowserRuntime;

test('the browser keeps an alert and a visibility change from a reply and refuses their malformed forms', async () => {
  const { settle } = (await browser()).browserShim().client;
  const marker = [{ op: 'serverEffect', key: 'e0' }];
  const good = [
    { op: 'alert', message: 'hello' },
    { op: 'hide', targets: ['A'] },
    { op: 'show', targets: ['A', 'B'] },
    { op: 'enable', targets: ['A'] },
    { op: 'disable', targets: ['A'] },
  ];
  assert.deepEqual(settle(marker, { effects: { e0: good } }), good);
  for (const bad of [
    { op: 'alert', message: { html: 'x' } },
    { op: 'alert' },
    { op: 'info', message: 'x' },
    { op: 'hide', targets: [] },
    { op: 'hide', targets: 'A' },
    { op: 'show', targets: [1] },
    { op: 'clear', targets: ['A'] },
    { op: 'disable' },
  ]) {
    assert.deepEqual(settle(marker, { effects: { e0: [bad] } }), [], JSON.stringify(bad));
  }
});

test('the browser puts a row value into the row it names and refuses a row that is not an index', async () => {
  const runtime = await browser();
  const { settle } = runtime.browserShim().client;
  const marker = [{ op: 'serverEffect', key: 'e0' }];
  const row = { op: 'setValue', targets: ['Items.Pick'], args: ['2020-01-01'], row: 1 };
  assert.deepEqual(settle(marker, { effects: { e0: [row] } }), [row]);
  for (const row of [-1, 1.5, '1', null, {}]) {
    assert.deepEqual(settle(marker, { effects: { e0: [{ op: 'setValue', targets: ['Items.Pick'], args: ['x'], row }] } }), [], JSON.stringify(row));
  }
});

test('the browser drops hostile server effects instead of replaying writes or unknown operations', async () => {
  const runtime = await browser();
  const { settle } = runtime.browserShim().client;
  const marker = [{ op: 'serverEffect', key: 'e0' }];
  const hostile = [
    { op: 'reload' },
    { op: 'setValue', targets: ['Items.Pick'], args: ['x'], row: Infinity },
    { op: 'setValue', targets: ['__proto__'], args: ['x'] },
    { op: 'ui', method: 'remove', target: ['Items'], args: [] },
    { op: 'subform', method: 'delete', target: ['Items'], args: [{}] },
  ];
  assert.deepEqual(settle(marker, { effects: { e0: hostile } }), []);
});
