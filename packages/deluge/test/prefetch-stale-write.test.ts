import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate, type TranslateOptions } from '../src/translate.js';

const OPTS: TranslateOptions = {
  inputFields: ['Total_Day_s', 'Employee_ID'],
  formNames: ['Leave_Balance'],
  formFields: { Leave_Balance: ['Employee_ID', 'Available'] },
};

const SERVER_READ = 'avail = Leave_Balance[Employee_ID == 1].Available;';

// A field write earlier in the handler makes a prefetch read of that field
// stale: the snapshot the prefetch endpoint evaluates predates the handler,
// so a slot must not replay `shim.input.get` for the written field. The
// condition stays a counted client-split todo instead.

test('a condition reading a field the handler wrote earlier is counted, not a stale slot', () => {
  const out = translate(`input.Total_Day_s = 0.5;\n${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.doesNotMatch(out.prefetch, /Total_Day_s/);
  assert.doesNotMatch(out.client, /slots\[/);
  assert.match(out.client, /shim\.todo\(ctx, "client-condition-uses-server"\)/);
  assert.equal(out.todos.length, 1);
  assert.equal(out.todos[0]!.construct, 'client-condition-uses-server');
});

test('a local bound to a written field is stale: the binding must not replay either', () => {
  const out = translate(`input.Total_Day_s = 0.5;\nd = input.Total_Day_s;\n${SERVER_READ}\nif (avail >= d) { alert "ok"; }`, OPTS);
  assert.doesNotMatch(out.prefetch, /Total_Day_s/);
  assert.equal(out.todos.length, 1);
  assert.equal(out.todos[0]!.construct, 'client-condition-uses-server');
});

test('a local bound before the write still replays: the prefetch serves the value the program saw', () => {
  const out = translate(`d = input.Total_Day_s;\ninput.Total_Day_s = 0.5;\n${SERVER_READ}\nif (avail >= d) { alert "ok"; }`, OPTS);
  assert.match(out.prefetch, /var d = shim\.input\.get\(ctx, "Total_Day_s"\)/);
  assert.match(out.client, /if \(slots\["c0"\]\)/);
  assert.deepEqual(out.todos, []);
});

test('a read with no write, and a write after the read, keep their slots', () => {
  const noWrite = translate(`${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.match(noWrite.prefetch, /shim\.input\.get\(ctx, "Total_Day_s"\)/);
  assert.deepEqual(noWrite.todos, []);

  const writeAfter = translate(`${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }\ninput.Total_Day_s = 0.5;`, OPTS);
  assert.match(writeAfter.prefetch, /shim\.input\.get\(ctx, "Total_Day_s"\)/);
  assert.deepEqual(writeAfter.todos, []);
});

test('a member-path write marks the top-level field; a bare assignment declares a local instead', () => {
  const member = translate(`input.Employee_ID.Name = "x";\n${SERVER_READ}\nif (avail >= input.Employee_ID) { alert "ok"; }`, OPTS);
  assert.equal(member.todos.length, 1);
  assert.equal(member.todos[0]!.construct, 'client-condition-uses-server');

  // `Total_Day_s = 0.5` binds a local; it does not write the field, so the
  // later field read keeps its slot.
  const local = translate(`Total_Day_s = 0.5;\n${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.match(local.prefetch, /shim\.input\.get\(ctx, "Total_Day_s"\)/);
  assert.deepEqual(local.todos, []);
});

test('a computed-key write on input poisons every later field read', () => {
  const out = translate(`k = "Total_Day_s";\ninput[k] = 0.5;\n${SERVER_READ}\nif (avail >= input.Employee_ID) { alert "ok"; }`, OPTS);
  assert.doesNotMatch(out.prefetch, /input\.get/);
  assert.equal(out.todos.length, 1);
  assert.equal(out.todos[0]!.construct, 'client-condition-uses-server');
});

test('a whole-record read after any field write is stale', () => {
  const out = translate(`input.Employee_ID = 7;\n${SERVER_READ}\nif (input != null && avail > 0) { alert "ok"; }`, OPTS);
  assert.equal(out.todos.length, 1);
  assert.equal(out.todos[0]!.construct, 'client-condition-uses-server');
});

test('a write in only one arm still refuses: the arm may have run', () => {
  const out = translate(`if (input.Employee_ID == 1) { input.Total_Day_s = 1; }\n${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.doesNotMatch(out.prefetch, /Total_Day_s/);
  assert.equal(out.todos.length, 1);
  assert.equal(out.todos[0]!.construct, 'client-condition-uses-server');
});
