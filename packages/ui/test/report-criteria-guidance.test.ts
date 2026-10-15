import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

function reports(criteria: string[]) {
  const lists = criteria
    .map(
      (text, i) => `\t\tlist Rows_${i}
\t\t{
\t\t\tshow all rows from Add_Item [${text}]
\t\t\t(
\t\t\t\tNote
\t\t\t)
\t\t}`,
    )
    .join('\n');
  const body = `\tsection Main
\t{
\t\tform Add_Item
\t\t{
\t\t\tNote
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tform Add_Person
\t\t{
\t\t\tMail
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
${lists}
\t}`;
  const model = buildUi(deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`))).model;
  return criteria.map((_, i) => model.reports.find((report) => report.name === `Rows_${i}`));
}

test('a report criteria comparing with an app function names the call as the manual step', () => {
  const [report] = reports(['Group.ID == thisapp.group_of() && Note == "a"']);
  assert.equal(report?.status, 'todo');
  assert.match(report?.todo ?? '', /Filter not migrated/);
  assert.match(report?.todo ?? '', /app function thisapp\.group_of\(\), which the generated report read does not call/);
  assert.doesNotMatch(report?.todo ?? '', /fetched from/);
});

test('a report criteria comparing with a field fetched from another form names that form', () => {
  const [report] = reports(['Note == "a" || (Note == "b" && Places.ID == Add_Person[Mail == zoho.loginuserid].Place.ID)']);
  assert.equal(report?.status, 'todo');
  assert.match(report?.todo ?? '', /a field fetched from Add_Person\[\.\.\.\], which the generated report read does not evaluate/);
  assert.doesNotMatch(report?.todo ?? '', /app function/);
});

test('names each call and form once, and a namespaced app function keeps its path', () => {
  const [report] = reports(['A == thisapp.Ns.f() || B == thisapp.Ns.f() || C == Add_Person[Mail == "x"].Mail || D == Add_Person[Mail == "y"].Mail']);
  const todo = report?.todo ?? '';
  assert.equal(todo.match(/thisapp\.Ns\.f\(\)/g)?.length, 1);
  assert.equal(todo.match(/Add_Person\[\.\.\.\]/g)?.length, 1);
});

test('no read guidance on a criteria that translates, or on text that only looks like a call', () => {
  const [plain, quoted, other] = reports(['Note == "thisapp.f()"', 'Note == "Add_Person[x]"', 'Lookup.Field']);
  assert.equal(plain?.status === 'todo' && /app function|fetched from/.test(plain.todo ?? ''), false);
  assert.equal(quoted?.status === 'todo' && /app function|fetched from/.test(quoted.todo ?? ''), false);
  // A gap with neither leaf keeps the generic notice only.
  assert.equal(other?.status, 'todo');
  assert.doesNotMatch(other?.todo ?? '', /app function|fetched from/);
});
