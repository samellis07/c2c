import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '../src/translate.js';

const BOOKS_IF = `src_proj = zoho.books.getRecords("projects","1","cf=" + input.ID,"zoho_book");
if(src_proj.get("projects").size() == 0)
{
  prjctmp = Map();
  prjctmp.put("name",input.Job);
  created = zoho.books.createRecord("projects","1",prjctmp);
  info created;
}`;

test('info of a server write response under a server-only test logs on the server with no todo', () => {
  const r = translate(BOOKS_IF, {});
  assert.deepEqual(r.todos, []);
  assert.match(r.server, /shim\.log\.info\(ctx, created\)/);
  assert.doesNotMatch(r.client, /client-condition-uses-server|prjctmp/);
});

test('info of a server-bound local in a plain branch logs on the server', () => {
  const r = translate('res = zoho.books.createRecord("items","1",{"a":1});\ninfo res;', {});
  assert.deepEqual(r.todos, []);
  assert.match(r.server, /shim\.log\.info\(ctx, res\)/);
  assert.doesNotMatch(r.client, /op: "info"/);
});

test('info of a client-readable value stays a client action', () => {
  const r = translate('info input.Name;', {});
  assert.deepEqual(r.todos, []);
  assert.match(r.client, /op: "info"/);
});
