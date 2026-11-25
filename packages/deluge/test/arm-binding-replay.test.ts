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

const CLEARS = (read: string): string => `if(input.K == "a")
{
  n = P[ID == input.r].count();
}
else
{
  clear Due_Date;
  n = S[T == ${read}].count();
}
if(n > 0)
{
  alert "x";
}`;

test('an arm that clears a field its own value does not read still replays as a choice', () => {
  const r = translate(CLEARS('input.K'), {});
  assert.deepEqual(r.todos, []);
  assert.match(r.prefetch, /var n = \(\(shim\.input\.get\(ctx, "K"\) == "a"\) \? /);
});

test('an arm that clears a field its own value reads stays a counted todo', () => {
  const r = translate(CLEARS('input.Due_Date'), {});
  assert.deepEqual(r.todos.map((t) => t.construct), ['client-condition-uses-server']);
});

const ARMS = (arm: string): string => `if(input.K == "a")
{
${arm}
}
else
{
  n = S[T == input.K].count();
}
if(n > 0)
{
  alert "x";
}`;

test('an arm whose value follows its own write stays a counted todo', () => {
  for (const arm of [
    '  input.r = 5;\n  n = P[ID == input.r].count();',
    '  x = insert into P [Name = "q"];\n  n = P[ID != 0].count();',
    '  n = P[ID == 1].count();\n  n = P[ID == 2].count();',
    '  if (input.r == 1) { n = P[ID == 1].count(); }',
  ]) {
    const r = translate(ARMS(arm), { formNames: ['P', 'S'], inputFields: ['K', 'r'] });
    assert.deepEqual(r.todos.map((t) => t.construct), ['client-condition-uses-server'], arm);
  }
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

const CHAIN = `t = Events[ID == input.Ev];
if(t.Book == "Whole")
{
  hide Day;
  seats = Booked[Ev == input.Ev].Seat.getAll();
}
else if(t.Book == "Daily")
{
  show Day;
  seats = Booked[Ev == input.Ev && Day == input.Day].Seat.getAll();
}
seats.removeAll({"x"});
if(seats.size() < t.Total)
{
  show Seats;
}`;

test('a name an if / else if chain assigns in each arm, with no else, replays as nested choices', () => {
  const r = translate(CHAIN, { formNames: ['Events', 'Booked'], inputFields: ['Ev', 'Day'] });
  assert.deepEqual(r.todos, []);
  assert.match(r.prefetch, /var seats = \(\(.*"Whole"\) \? await shim\.datastore\.column\(.*\) : \(\(.*"Daily"\) \? await shim\.datastore\.column\(.*\) : undefined\)\);/);
});

test('a chain whose arms leave different shapes, or whose arm is not straight-line, stays a counted todo', () => {
  const shapes = CHAIN.replace('seats = Booked[Ev == input.Ev && Day == input.Day].Seat.getAll();', 'seats = Booked[Ev == input.Ev && Day == input.Day].count();');
  const nested = CHAIN.replace('  show Day;\n  seats = Booked[Ev == input.Ev && Day == input.Day].Seat.getAll();', '  if (input.Day != null) { seats = Booked[Ev == input.Ev && Day == input.Day].Seat.getAll(); }');
  for (const src of [shapes, nested]) {
    const r = translate(src, { formNames: ['Events', 'Booked'], inputFields: ['Ev', 'Day'] });
    assert.ok(r.todos.some((t) => t.construct === 'client-condition-uses-server'), src);
  }
});
