import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyApp, type App, type FunctionDef, type Workflow } from '../../core/src/index.js';
import { generate } from '../src/generate.js';

const Z = { start: 0, end: 0 };
const ADMIN = { name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: Z };

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
    forms: [
      { name: 'Orders', properties: [], fields: [field('Choice'), field('Room'), field('Kind')], actions: [], blocks: [], span: Z },
      { name: 'Rooms', properties: [], fields: [field('Kind'), field('Name')], actions: [], blocks: [], span: Z },
    ],
    profiles: [ADMIN],
    functions,
    workflows: [wf],
  } as App);
}

const todos = (g: ReturnType<typeof generate>) => g.todos.filter((t) => t.construct === 'client-condition-uses-server');

// removeAll lands on the fresh list the column read built, never on a stored row.
const TRIMMER = fn('Rooms.free', 'map Rooms.free(string kind)', 'rooms = Rooms[Kind == kind].Name.getAll();\ntaken = Orders[Kind == kind].Room.getAll();\nrooms.removeAll(taken);\nm = Map();\nm.put("Rooms", rooms);\nreturn m;');
// removeAll on a record fetched into a list that is not a column read stays refused.
const ALIAS = fn('Rooms.alias', 'map Rooms.alias(string kind)', 'rows = Rooms[Kind == kind];\nrows.removeAll({});\nm = Map();\nm.put("Rooms", rows);\nreturn m;');

test('a function that trims a list built from a column read is read-only for a client call', () => {
  const g = build('room_map = thisapp.Rooms.free(input.Kind);\ninput.Room:ui.add(room_map.get("Rooms"));', [TRIMMER]);
  assert.equal(todos(g).length, 0);
});

test('a function that trims a fetched record collection keeps the counted todo', () => {
  const g = build('room_map = thisapp.Rooms.alias(input.Kind);\ninput.Room:ui.add(room_map.get("Rooms"));', [ALIAS]);
  assert.equal(todos(g).length, 1);
});

const AVAIL = fn('Rooms.hasKind', 'bool Rooms.hasKind(string kind)', 'rows = Rooms[Kind == kind];\nfor each r in rows.Name\n{\n\tif(r.Name == "Main")\n\t{\n\t\treturn true;\n\t}\n}\nreturn false;');

test('a function that reads a field of a fetched row is read-only for a client condition', () => {
  const g = build('if(thisapp.Rooms.hasKind(input.Kind))\n{\n\tinput.Room:ui.add({"A"});\n}', [AVAIL]);
  assert.equal(todos(g).length, 0);
});
