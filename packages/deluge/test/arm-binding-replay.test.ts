import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '../src/translate.js';

const COUNT_ARMS = `if(input.Kind == "Sub")
{
  n = New_Project[ID == input.recID].count();
}
else
{
  hide Due_Date;
  n = Add_Staff[Job_Title == input.Kind].count();
}
if(n > 0)
{
  alert "x";
}`;

test('a show/hide beside the one assignment in an arm still replays the if as a choice', () => {
  const r = translate(COUNT_ARMS, {});
  assert.deepEqual(r.todos, []);
  assert.match(r.prefetch, /var n = \(\(shim\.input\.get\(ctx, "Kind"\) == "Sub"\) \? await shim\.datastore\.aggregate\(.*"New_Project".* : await shim\.datastore\.aggregate\(.*"Add_Staff"/);
  assert.match(r.client, /if \(slots\["c0"\]\)/);
  assert.match(r.client, /op: "hide", targets: \["Due_Date"\]/);
});

const COLUMN_ARMS = `if(input.Daily == "Yes")
{
  booked = Booking[Date_field == input.Date_field && Book_For == input.Book_For].spots.getAll();
}
else
{
  booked = Booking[Book_For == input.Book_For].spots.getAll();
}
spots.deselect(booked);`;

test('two arms that each fetch a column replay as a choice and feed the client action', () => {
  const r = translate(COLUMN_ARMS, {});
  assert.deepEqual(r.todos, []);
  assert.match(r.prefetch, /var booked = \(.* \? await shim\.datastore\.column\(.*\) : await shim\.datastore\.column\(.*\)\);/);
  assert.match(r.prefetch, /slots\["c0"\] = booked;/);
});

test('arms that leave different shapes stay a counted todo', () => {
  const r = translate(`if(input.K == "a")
{
  s = P[ID == input.r].Subs;
}
else
{
  s = S[T == input.K].ID.getAll();
}
input.A:ui.add(s);`, {});
  assert.deepEqual(r.todos.map((t) => t.construct), ['client-condition-uses-server']);
});

test('an arm with a second value statement is not a choice', () => {
  const r = translate(`if(input.K == "a")
{
  n = P[ID == input.r].count();
}
else
{
  clear Due_Date;
  n = S[T == input.K].count();
}
if(n > 0)
{
  alert "x";
}`, {});
  assert.deepEqual(r.todos.map((t) => t.construct), ['client-condition-uses-server']);
});

test('a client action that needs a server side effect stays a counted todo with a manual step', () => {
  const r = translate(`rec = insert into Add_User
[
  Name = "x"
];
input.Organizers:ui.add(rec);`, {});
  const todo = r.todos.find((t) => t.construct === 'client-condition-uses-server');
  assert.ok(todo, 'counted todo');
  assert.match(todo.manualStep ?? '', /prefetch cannot replay safely/);
});
