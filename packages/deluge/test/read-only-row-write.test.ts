import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emittedReadOnly, translate } from '../src/translate.js';

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
