import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyApp, type FunctionDef } from '../../core/src/index.js';
import { replayFunctionNames } from '../src/generate.js';
import { translate } from '../src/translate.js';

const SUBJECT_LOOP = `session_rec = Session[Timing == input.T];
mondayNewList = List();
for each ses_rec in session_rec
{
  if(ses_rec.Monday != null)
  {
    mondayNewList = thisapp.appendSubject(mondayNewList,ses_rec.Monday.Subject_Name);
  }
  else
  {
    mondayNewList.add(ses_rec.Start_Time);
  }
}
input.Monday:ui.append(mondayNewList);`;

test('a list-building loop that calls a replayable function replays on a copy', () => {
  const r = translate(SUBJECT_LOOP, { replayFunctions: ['appendSubject'] });
  assert.deepEqual(r.todos, []);
  assert.match(r.prefetch, /mondayNewList = await shim\.thisapp\.call\(ctx, \["appendSubject"\], \[mondayNewList, /);
  assert.match(r.prefetch, /\}\)\(shim\.list\.duplicate\(mondayNewList\)\);/);
  assert.match(r.client, /op: "ui", method: "append", target: \["Monday"\], args: \[slots\["c\d+"\]\]/);
});

test('a function outside the replay set keeps the counted todo with its manual step', () => {
  const r = translate(SUBJECT_LOOP, { replayFunctions: [] });
  const todo = r.todos.find((t) => t.construct === 'client-condition-uses-server');
  assert.ok(todo);
  assert.ok(todo.manualStep);
  assert.doesNotMatch(r.prefetch, /appendSubject/);
});

test('a call that does not pass the list back to itself is not a list update', () => {
  const r = translate(SUBJECT_LOOP.replace('thisapp.appendSubject(mondayNewList,', 'thisapp.appendSubject(other,'), { replayFunctions: ['appendSubject'] });
  assert.ok(r.todos.some((t) => t.construct === 'client-condition-uses-server'));
});

test('a local counter carried through the loop does not block the list replay', () => {
  const r = translate(`row_count = 0;
all_subject_list = Add_Subject[ID != 0].ID.getAll();
for each rec in input.Allocation
{
  row_count = row_count + 1;
  all_subject_list.removeelement(rec.Subject_field);
}
row.Subject_field:ui.add(all_subject_list);`, {});
  assert.deepEqual(r.todos, []);
  assert.match(r.prefetch, /async \(all_subject_list, row_count\) =>|async \(row_count, all_subject_list\) =>/);
});

test('a loop value that reads another carried local stays a counted todo', () => {
  const r = translate(`n = 0;
s = "";
ids = List();
for each rec in Item[ID != 0]
{
  n = n + 1;
  s = s + n;
  ids.add(rec.ID);
}
input.A:ui.add(ids);
input.B = s;
if(s != "")
{
  alert s;
}`, {});
  assert.ok(r.todos.some((t) => t.construct === 'client-condition-uses-server'));
});

// The replay set is an authorization boundary: a function in it runs in the
// prefetch. Each class of write must keep a function out of it.
const Z = { start: 0, end: 0 };
const replaySet = (signature: string, body: string): ReadonlySet<string> => {
  const name = /\s(\w+)\(/.exec(signature)![1]!;
  const fn = { name, kind: 'creator', signature, properties: [], deluge: [{ text: body, span: Z }], span: Z } as unknown as FunctionDef;
  return replayFunctionNames({ ...emptyApp('empty'), name: 'Demo_App', functions: [fn] });
};

test('a function that updates only its list parameter replays at that parameter', () => {
  assert.deepEqual([...replaySet('list f(string s, list L)', 'L.add(s);\nreturn L;')], ['f:1']);
});

test('a function that only reads replays with no parameter update', () => {
  assert.deepEqual([...replaySet('list f(list L)', 'return L;')], ['f']);
});

test('attack: setting a field on a fetched row is never replayable', () => {
  assert.equal(replaySet('list f(list L, int id)', 's = Assign_Workouts[ID == id];\nfor each w in s.Workouts\n{\n  w.Done = "True";\n}\nreturn L;').size, 0);
  assert.equal(replaySet('list f(list L, int id)', 'r = Add_Staffs[ID == id];\nr.Note = "x";\nreturn L;').size, 0);
});

test('attack: an insert or a delete is never replayable', () => {
  assert.equal(replaySet('list f(list L)', 'x = insert into Add_User\n[\n  Name = "x"\n];\nreturn L;').size, 0);
  assert.equal(replaySet('list f(list L, int id)', 'delete from Add_User[ID == id];\nreturn L;').size, 0);
});

test('attack: a body that calls a writing function, directly or in a loop, is never replayable', () => {
  const writer = { name: 'w', kind: 'creator', signature: 'void w(int id)', properties: [], deluge: [{ text: 'delete from Add_User[ID == id];', span: Z }], span: Z } as unknown as FunctionDef;
  const caller = (text: string) => ({ name: 'f', kind: 'creator', signature: 'list f(list L)', properties: [], deluge: [{ text, span: Z }], span: Z }) as unknown as FunctionDef;
  for (const text of ['thisapp.w(1);\nreturn L;', 'for each x in L\n{\n  thisapp.w(x);\n}\nreturn L;']) {
    const set = replayFunctionNames({ ...emptyApp('empty'), name: 'Demo_App', functions: [writer, caller(text)] });
    assert.equal(set.size, 0, text);
  }
});

test('attack: a nested call to a function that updates its own parameter is not replayable', () => {
  const inner = { name: 'g', kind: 'creator', signature: 'list g(list M)', properties: [], deluge: [{ text: 'M.add(1);\nreturn M;', span: Z }], span: Z } as unknown as FunctionDef;
  const outer = { name: 'f', kind: 'creator', signature: 'list f(list L, list K)', properties: [], deluge: [{ text: 'thisapp.g(K);\nreturn L;', span: Z }], span: Z } as unknown as FunctionDef;
  assert.deepEqual([...replayFunctionNames({ ...emptyApp('empty'), name: 'Demo_App', functions: [inner, outer] })], ['g:0']);
});

test('attack: updating a second collection parameter or input is not replayable', () => {
  assert.equal(replaySet('list f(list L, map M)', 'M.put("k", 1);\nreturn L;').size, 0);
  assert.equal(replaySet('list f(list L, list K)', 'L.add(1);\nreturn L;').size, 0);
  assert.equal(replaySet('list f(list L)', 'input.L.add(1);\nreturn L;').size, 0);
});

test('attack: the call site must pass the loop list at the updated parameter', () => {
  const swapped = SUBJECT_LOOP.replace('thisapp.appendSubject(mondayNewList,ses_rec.Monday.Subject_Name)', 'thisapp.appendSubject(ses_rec.Monday.Subject_Name,mondayNewList)');
  const r = translate(swapped, { replayFunctions: ['appendSubject:0'] });
  assert.ok(r.todos.some((t) => t.construct === 'client-condition-uses-server'));
  assert.doesNotMatch(r.prefetch, /appendSubject/);
});
