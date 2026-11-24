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

test('a local bound to a writing app call keeps the counted todo', () => {
  for (const [text, fns] of [
    ['room_map = thisapp.Rooms.book(input.Kind);\ninput.Room:ui.add(room_map.get("Rooms"));', [WRITER]],
  ] as [string, FunctionDef[]][]) {
    const g = build(text, fns);
    assert.equal(todos(g).length, 1, text);
    assert.match(client(g), /shim\.todo\(ctx, "client-condition-uses-server"\)/, text);
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
  const [one] = step('if (input.N == "A") { m = Rooms[ID != 0].Room_No.getAll(); }\ninput.Room:ui.add(m);');
  assert.match(one ?? '', /reads `m`, which is not assigned on every path/);
});

test('a ui.add that translates (pure read, read loop) carries no todo', () => {
  assert.deepEqual(step('l = List(); for each r in Rooms[ID != 0] { l.add(r.Room_No); } input.Room:ui.add(l);'), []);
  assert.deepEqual(step('l = Rooms[ID != 0].Room_No.getAll(); input.Room:ui.add(l);'), []);
});
