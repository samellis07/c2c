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
  assert.doesNotMatch(r.client, /^if \(|shim\.todo\(|"openUrl"/m);
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
  assert.doesNotMatch(r.client, /^if \(|shim\.input\.set/m);
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

test('the same if inside a loop or without a client run keeps the counted todo', () => {
  const loop = ['for each u in Users[Mail != ""] {', '  id = insert into Users [Mail = u.Mail];', '  if (id > 0) {', '    openUrl("#Report:R", "same window");', '  }', '}'].join('\n');
  assert.ok(counted(translate(loop, options)) > 0);
  assert.doesNotMatch(translate(loop, options).server, /shim\.client\.effect/);
  assert.equal(counted(translate(OPEN, { ...options, serverOnly: true })), 0);
  assert.doesNotMatch(translate(OPEN, { ...options, serverOnly: true }).server, /shim\.client\.effect/);
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
