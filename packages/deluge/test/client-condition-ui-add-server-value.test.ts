import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyApp, type App, type FunctionDef, type Workflow } from '../../core/src/index.js';
import { generate } from '../src/generate.js';
import { translate } from '../src/translate.js';

const Z = { start: 0, end: 0 };
const ADMIN = { name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: Z };

function stripComments(s: string) { return (s || '').replace(/^\s*\/\/ Deluge: .*\n?/gm, ''); }

function field(name: string, type = 'text'): App['forms'][number]['fields'][number] {
  return { name, type, modifiers: [], required: false, unique: false, properties: [], subfields: [], annotations: [], flags: [], span: Z };
}

function fn(name: string, signature: string, body: string): FunctionDef {
  return { name, kind: 'deluge', signature, deluge: [{ text: body, span: Z }], properties: [], span: Z };
}

function build(text: string, functions: FunctionDef[]): ReturnType<typeof generate> {
  const wf: Workflow = { name: 'load', form: 'Orders', event: 'on load', deluge: { text, span: Z }, properties: [], span: Z };
  return generate({
    ...emptyApp('empty'),
    name: 'Demo_App',
    forms: [{ name: 'Orders', properties: [], fields: [field('Choice'), field('Room'), field('Kind')], actions: [], blocks: [], span: Z }],
    profiles: [ADMIN],
    functions,
    workflows: [wf],
  } as App);
}

const READER = fn('Rooms.find', 'map Rooms.find(string kind)', 'm = Map();\nm.put("Availability", Orders[Kind == kind].count());\nm.put("Rooms", Orders[Kind == kind].Room.getAll());\nreturn m;');
const WRITER = fn('Rooms.book', 'map Rooms.book(string kind)', 'row = insert into Orders [ Kind = kind ];\nm = Map();\nm.put("Rooms", {"A"});\nreturn m;');

const todos = (g: ReturnType<typeof generate>) => g.todos.filter((t) => t.construct === 'client-condition-uses-server');
const client = (g: ReturnType<typeof generate>) => stripComments(g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs')!.source);

test('a local bound to a read-only app call feeds ui.add through the client call route', () => {
  for (const text of [
    'room_map = thisapp.Rooms.find(input.Kind);\ninput.Room:ui.add(room_map.get("Rooms"));',
    'room_map = thisapp.Rooms.find(input.Kind);\ninput.Room:ui.clear();\ninput.Room:ui.add(room_map.get("Rooms"));',
    'room_map = thisapp.Rooms.find(input.Kind);\nrooms = room_map.get("Rooms");\ninput.Room:ui.add(rooms);',
  ]) {
    const g = build(text, [READER]);
    assert.equal(todos(g).length, 0, text);
    assert.match(client(g), /shim\.client\.call\(ctx, "Rooms\.find"/, text);
    assert.doesNotMatch(client(g), /shim\.todo\(/, text);
  }
});

test('a local bound to a writing app call is never a client call: the server run calls it once', () => {
  for (const [text, fns] of [
    ['room_map = thisapp.Rooms.book(input.Kind);\ninput.Room:ui.add(room_map.get("Rooms"));', [WRITER]],
  ] as [string, FunctionDef[]][]) {
    const g = build(text, fns);
    assert.equal(todos(g).length, 0, text);
    assert.doesNotMatch(client(g), /shim\.client\.call\(|shim\.todo\(|thisapp/, text);
    assert.match(client(g), /op: "serverEffect"/, text);
    const server = stripComments(g.files.find((f) => f.path === 'functions/aio/orders/on-load.mjs')!.source);
    assert.equal(server.split('shim.thisapp.call(').length - 1, 1, text);
    assert.match(server, /shim\.client\.effect\(ctx, "e\d+", \{ op: "ui", method: "add", target: \["Room"\]/, text);
  }
});

const step = (src: string, options = {}): string[] =>
  translate(src, { formNames: ['Staff', 'Rooms'], inputFields: ['N', 'Assignee', 'Room'], ...options })
    .todos.filter((t) => t.construct === 'client-condition-uses-server')
    .map((t) => t.manualStep ?? '');

test('a ui.add fed by a write result names the field, the local, and the write step', () => {
  const [one, ...rest] = step('if (Staff[Name == input.N].count() <= 0) { r = insert into Staff [Name = input.N]; input.Assignee:ui.add(r); }');
  assert.equal(rest.length, 0);
  assert.match(one!, /`Assignee:ui\.add` takes its value through `r` from a write, mail or outbound call/);
  assert.match(one!, /A client action here depends on a server value/, 'the generic step still follows');
});

test('a ui.add fed by an app function the generator did not prove read-only names the callee', () => {
  const [one] = step('room_map = thisapp.Rooms.book(input.N);\ninput.Room:ui.add(room_map.get("Rooms"));');
  assert.match(one!, /`Room:ui\.add` takes its value through `room_map` from thisapp\.Rooms\.book, which the generator could not prove read-only/);
});

test('a ui.add reading a binding that does not dominate it names the local', () => {
  const [one] = step('if (input.N == "A") { if (input.N == "B") { m = Rooms[ID != 0].Room_No.getAll(); } }\ninput.Room:ui.add(m);');
  assert.match(one ?? '', /reads `m`, which is not assigned on every path/);
});

test('a ui.add reading a name one arm assigns straight in the arm replays it under that arm\'s test', () => {
  const r = translate('if (input.N == "A") { m = Rooms[ID != 0].Room_No.getAll(); }\ninput.Room:ui.add(m);', { formNames: ['Rooms'], inputFields: ['N', 'Room'] });
  assert.deepEqual(r.todos, []);
  assert.match(r.prefetch, /var m = \(\(shim\.input\.get\(ctx, "N"\) == "A"\) \? await shim\.datastore\.column\(.*\) : undefined\);/);
});

test('manual steps name the precise dependency cause for every binding shape', () => {
  const cases = [
    ['if/else app-function arms', 'if (input.N == "A") { m = thisapp.Rooms.book(input.N); } else { m = thisapp.Rooms.book(input.N); } input.Room:ui.add(m);', /from thisapp\.Rooms\.book/],
    ['if/else write arms', 'if (input.N == "A") { m = insert into Staff [Name = input.N]; } else { m = insert into Staff [Name = input.N]; } input.Room:ui.add(m);', /from a write, mail or outbound call/],
    ['app-function arm and literal arm', 'if (input.N == "A") { m = thisapp.Rooms.book(input.N); } else { m = "A"; } input.Room:ui.add(m);', /from thisapp\.Rooms\.book/],
    ['method chain one hop', 'm = thisapp.Rooms.book(input.N).get("Rooms"); input.Room:ui.add(m);', /from thisapp\.(?!get\b)/],
    ['method chain two hops', 'm = thisapp.Rooms.book(input.N).get("Rooms").get("A"); input.Room:ui.add(m);', /from thisapp\.(?!get\b)/],
    ['local function call chain', 'm = helper(input.N).get("Rooms"); input.Room:ui.add(m);', /^$/],
    ['if/else app-function and write', 'if (input.N == "A") { m = thisapp.Rooms.book(input.N); } else { m = insert into Staff [Name = input.N]; } input.Room:ui.add(m);', /from thisapp\.Rooms\.book|from a write/],
    ['try/catch write arms', 'try { m = insert into Staff [Name = input.N]; } catch (e) { m = insert into Staff [Name = input.N]; } input.Room:ui.add(m);', /from a write, mail or outbound call/],
    ['app function then arm mutation', 'rooms = thisapp.Rooms.book(input.N).get("Rooms"); if (input.N == "A") { rooms.add("X"); } input.Room:ui.add(rooms);', /takes its value through `rooms` from thisapp\./],
    ['write result', 'if (input.N == "A") { r = insert into Staff [Name = input.N]; input.Assignee:ui.add(r); }', /through `r` from a write, mail or outbound call/],
    ['non-dominating binding', 'if (input.N == "A") { if (input.N == "B") { m = Rooms[ID != 0].Room_No.getAll(); } } input.Room:ui.add(m);', /reads `m`, which is not assigned on every path/],
    ['pre-branch mutated in arm', 'rooms = thisapp.Rooms.book(input.N).get("Rooms"); if (input.N == "A") { rooms.add("X"); } input.Room:ui.add(rooms);', /takes its value through `rooms` from thisapp\./],
    ['loop-carried (fully replayable)', 'rooms = Rooms[ID != 0].Room_No.getAll(); for each r in Rooms[ID != 0] { rooms.add(r.Room_No); } input.Room:ui.add(rooms);', /^$/],
    ['shadowed internal name', 'rooms = Rooms[ID != 0].Room_No.getAll(); if (input.N == "A") { rooms = thisapp.Rooms.book(input.N).get("Rooms"); } input.Room:ui.add(rooms);', /prefetch cannot replay safely/],
  ] as const;
  for (const [label, src, expected] of cases) {
    const [manual] = step(src);
    assert.match(manual ?? '', expected, label);
    assert.doesNotMatch(manual ?? '', /\u0000|#[0-9]+/, label);
  }
});

test('a ui.add that translates (pure read, read loop) carries no todo', () => {
  assert.deepEqual(step('l = List(); for each r in Rooms[ID != 0] { l.add(r.Room_No); } input.Room:ui.add(l);'), []);
  assert.deepEqual(step('l = Rooms[ID != 0].Room_No.getAll(); input.Room:ui.add(l);'), []);
});
