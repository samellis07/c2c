import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as shimList from '../../shims/src/list.js';
import { emittedReadOnly, LIST_SHIM_READERS, mutatesOnlyFreshLocals, translate } from '../src/translate.js';

const readOnly = (src: string): boolean => emittedReadOnly(translate(src, {}).server, () => false);

test('setting a field on a fetched record row inside a loop is not read-only', () => {
  const src = `s = Assign_Workouts[ID == input.setId];
for each w in s.Workouts
{
  w.Exercise_Done = "True";
}
return 1;`;
  assert.match(translate(src, {}).server, /shim\.set\(w, "Exercise_Done"/);
  assert.equal(readOnly(src), false);
});

test('setting a field on a fetched record is not read-only', () => {
  assert.equal(readOnly(`r = Add_Staffs[ID == input.id];\nr.Note = "x";\nreturn 1;`), false);
});

test('a local map rebound to a fetched row before the set is not read-only', () => {
  assert.equal(readOnly(`m = Map();\nr = Add_Staffs[ID == input.id];\nm = r;\nm.put("Note", "x");\nreturn 1;`), false);
});

test('putting into a map the body created stays read-only', () => {
  assert.equal(readOnly(`m = Map();\nm.put("a", 1);\nreturn m;`), true);
});

const FETCH = `r = Add_Staffs[ID == input.id];\n`;

test('mutating a fetched row element or loop row is not read-only', () => {
  const bodies: Record<string, string> = {
    'nested get on a fetched field': `${FETCH}r.Tags.get(0).put("Name", "pwn");\nreturn 1;`,
    'get on a list holding a fetched row': `${FETCH}l = List();\nl.add(r);\nl.get(0).put("Name", "pwn");\nreturn 1;`,
    'put on a loop row': `s = Assign_Workouts[ID == input.setId];\nfor each w in s.Workouts\n{\n  w.put("Done", "True");\n}\nreturn 1;`,
    'alias of a fetched element': `${FETCH}t = r.Tags.get(0);\nt.put("Name", "x");\nreturn 1;`,
    'clear on a loop row': `${FETCH}for each t in r.Tags\n{\n  t.clear();\n}\nreturn 1;`,
    'addAll on a loop row': `${FETCH}for each t in r.Tags\n{\n  t.addAll({1});\n}\nreturn 1;`,
    'add on a fetched field': `${FETCH}r.Tags.add(1);\nreturn 1;`,
    'remove through a list alias': `${FETCH}l = r.Tags;\nl.remove(0);\nreturn 1;`,
    'list alias of a fresh list then element put': `l = List();\nm = l;\nm.add(1);\nreturn m;`,
    'map alias of a fresh map': `m = Map();\nn = m;\nn.put("a", 1);\nreturn n;`,
    'alias of a fetched list put through the alias': `${FETCH}l = List();\nl = r.Tags;\nl.add(1);\nreturn l;`,
    'get chain on a fresh list': `l = List();\nl.add(Map());\nl.get(0).put("a", 1);\nreturn l;`,
    'removeAll on a fetched field': `${FETCH}r.Tags.removeAll({1});\nreturn 1;`,
    'insert on a fetched field': `${FETCH}r.Tags.insert(0, 1);\nreturn 1;`,
  };
  for (const [name, src] of Object.entries(bodies)) assert.equal(readOnly(src), false, name);
});

test('a fresh local list or map built and mutated in the body stays read-only', () => {
  assert.equal(readOnly(`l = List();\nl.add(1);\nl.addAll({2, 3});\nl.remove(0);\nl.clear();\nreturn l;`), true);
  assert.equal(readOnly(`m = Map();\nm.put("a", 1);\nm.putAll({"b": 2});\nreturn m;`), true);
  assert.equal(readOnly(`${FETCH}l = List();\nfor each t in r.Tags\n{\n  l.add(t);\n}\nreturn l;`), true);
});

test('every shim list function is classified as a reader or treated as a write', () => {
  const lists = shimList as Record<string, unknown>;
  for (const name of Object.keys(lists)) {
    const code = `var r = 1;\nshim.list.${name}(r, 1);`;
    assert.equal(mutatesOnlyFreshLocals(code), LIST_SHIM_READERS.has(name), name);
  }
  assert.equal(mutatesOnlyFreshLocals('var r = 1;\nshim.list.removeText(r, 1);'), false);
  assert.equal(mutatesOnlyFreshLocals('var r = 1;\nshim.set(r, "a", 1);'), false);
  assert.equal(mutatesOnlyFreshLocals('var m = {};\nshim.set(m, "a", 1);'), true);
});

test('a mutable parameter is writable only while it is never rebound', () => {
  assert.equal(mutatesOnlyFreshLocals('shim.list.add(L, 1);', ['L']), true);
  assert.equal(mutatesOnlyFreshLocals('L = r;\nshim.list.add(L, 1);', ['L']), false);
  assert.equal(mutatesOnlyFreshLocals('shim.list.add(shim.list.get(L, 0), 1);', ['L']), false);
  assert.equal(mutatesOnlyFreshLocals('shim.list.add(L, 1);', []), false);
});
