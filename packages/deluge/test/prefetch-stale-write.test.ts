import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate, type TranslateOptions } from '../src/translate.js';

const OPTS: TranslateOptions = {
  inputFields: ['Total_Day_s', 'Employee_ID', 'LineItems'],
  formNames: ['Leave_Balance'],
  formFields: { Leave_Balance: ['Employee_ID', 'Available'] },
};

const SERVER_READ = 'avail = Leave_Balance[Employee_ID == 1].Available;';

// A field write earlier in the handler makes a prefetch read of that field
// stale: the snapshot the prefetch endpoint evaluates predates the handler.
// When the write itself is a read-only expression (or sits behind replayable
// if-tests), the prefetch replays it first, so the slot reads the post-write
// value — exactly what the program saw — and still compiles. Writes the
// prefetch cannot reproduce in order (loops, try/catch, function bodies,
// `thisapp` calls, other effects) keep the refusal.

test('a condition reading a field the handler wrote earlier replays the write and compiles', () => {
  const out = translate(`input.Total_Day_s = 0.5;\n${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.match(out.prefetch, /shim\.input\.set\(ctx, \["Total_Day_s"\], shim\.decimal\.from\("0\.5"\)\);/);
  assert.match(out.prefetch, /slots\["c0"\] = \(avail >= shim\.input\.get\(ctx, "Total_Day_s"\)\)/);
  assert.match(out.client, /if \(slots\["c0"\]\)/);
  assert.deepEqual(out.todos, []);
});

test('a local bound to a written field replays the write before the binding', () => {
  const out = translate(`input.Total_Day_s = 0.5;\nd = input.Total_Day_s;\n${SERVER_READ}\nif (avail >= d) { alert "ok"; }`, OPTS);
  assert.ok(out.prefetch.indexOf('shim.input.set') < out.prefetch.indexOf('var d = shim.input.get'));
  assert.match(out.prefetch, /var d = shim\.input\.get\(ctx, "Total_Day_s"\)/);
  assert.deepEqual(out.todos, []);
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

test('a member-path write replays its deep set; a bare assignment declares a local instead', () => {
  const member = translate(`input.Employee_ID.Name = "x";\n${SERVER_READ}\nif (avail >= input.Employee_ID) { alert "ok"; }`, OPTS);
  assert.match(member.prefetch, /shim\.input\.set\(ctx, \["Employee_ID","Name"\], "x"\);/);
  assert.deepEqual(member.todos, []);

  // `Total_Day_s = 0.5` binds a local; it does not write the field, so the
  // later field read keeps its slot.
  const local = translate(`Total_Day_s = 0.5;\n${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.match(local.prefetch, /shim\.input\.get\(ctx, "Total_Day_s"\)/);
  assert.deepEqual(local.todos, []);
});

test('a computed-key write replays with its segment expression', () => {
  const out = translate(`k = "Total_Day_s";\ninput[k] = 0.5;\n${SERVER_READ}\nif (avail >= input.Employee_ID) { alert "ok"; }`, OPTS);
  assert.match(out.prefetch, /var k = "Total_Day_s";\nshim\.input\.set\(ctx, \[k\]/);
  assert.deepEqual(out.todos, []);
});

test('an old-record write replays through shim.old.set', () => {
  const out = translate(`old.Total_Day_s = 0.5;\n${SERVER_READ}\nif (avail >= old.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.match(out.prefetch, /shim\.old\.set\(ctx, \["Total_Day_s"\]/);
  assert.match(out.prefetch, /avail >= shim\.old\.get\(ctx, "Total_Day_s"\)/);
  assert.deepEqual(out.todos, []);
});

test('a subform insert replays with its row argument', () => {
  const out = translate(`input.LineItems.insert({"Qty": 1});\n${SERVER_READ}\nif (avail >= input.LineItems.count()) { alert "ok"; }`, OPTS);
  assert.match(out.prefetch, /shim\.input\.insert\(ctx, \["LineItems"\]/);
  assert.deepEqual(out.todos, []);
});

test('a whole-record read replays the earlier field write first', () => {
  const out = translate(`input.Employee_ID = 7;\n${SERVER_READ}\nif (input != null && avail > 0) { alert "ok"; }`, OPTS);
  assert.match(out.prefetch, /shim\.input\.set\(ctx, \["Employee_ID"\], 7\);/);
  assert.deepEqual(out.todos, []);
});

test('a write in only one arm replays under its guard', () => {
  const out = translate(`if (input.Employee_ID == 1) { input.Total_Day_s = 1; }\n${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.match(out.prefetch, /var __wcond\d+ = \(shim\.input\.get\(ctx, "Employee_ID"\) == 1\);\nif \(__wcond\d+\) \{\n {2}shim\.input\.set\(ctx, \["Total_Day_s"\], 1\);\n\}/);
  assert.deepEqual(out.todos, []);
});

test('writes in both arms of an if-else replay under opposite guards', () => {
  const out = translate(`if (input.Employee_ID == 1) { input.Total_Day_s = 1; } else { input.Total_Day_s = 2; }\n${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.match(out.prefetch, /if \(__wcond\d+\) \{\n {2}shim\.input\.set\(ctx, \["Total_Day_s"\], 1\);\n\}/);
  assert.match(out.prefetch, /if \(!__wcond\d+\) \{\n {2}shim\.input\.set\(ctx, \["Total_Day_s"\], 2\);\n\}/);
  assert.deepEqual(out.todos, []);
});

test('a write in a loop keeps the refusal: the prefetch cannot replay an iteration count', () => {
  const out = translate(`for each x in [1, 2] { input.Total_Day_s = x; }\n${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.ok(out.todos.some((t) => t.construct === 'client-condition-uses-server'));
  assert.doesNotMatch(out.prefetch, /shim\.input\.set/);
});

test('a write in a try arm keeps the refusal: a throw may skip it', () => {
  const out = translate(`try { input.Total_Day_s = 0.5; } catch (e) { }\n${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.ok(out.todos.some((t) => t.construct === 'client-condition-uses-server'));
  assert.doesNotMatch(out.prefetch, /shim\.input\.set/);
});

test('a write behind an app-function test keeps the refusal', () => {
  const out = translate(`if (thisapp.helper.yes()) { input.Total_Day_s = 1; }\n${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.ok(out.todos.some((t) => t.construct === 'client-condition-uses-server'));
  assert.doesNotMatch(out.prefetch, /shim\.input\.set/);
});

test('a write whose value calls an app function keeps the refusal', () => {
  const out = translate(`input.Total_Day_s = thisapp.helper.get();\n${SERVER_READ}\nif (avail >= input.Total_Day_s) { alert "ok"; }`, OPTS);
  assert.ok(out.todos.some((t) => t.construct === 'client-condition-uses-server'));
  assert.doesNotMatch(out.prefetch, /shim\.input\.set/);
});

// The null-default idiom after a server aggregate: one arm assigns one local
// from a read-only expression, so the value after the if is `test ? arm : previous`.
const AGG = 'tot = Leave_Balance[Employee_ID == 1].sum(Available);';

test('a null-defaulted aggregate replays as a guarded self-assign and compiles the later condition', () => {
  const out = translate(`${AGG}\nif (tot == null) { tot = 0; }\nif (tot > input.Total_Day_s) { alert "over"; }`, OPTS);
  assert.match(out.prefetch, /var tot = \(\(tot == null\) \? 0 : tot\);/);
  assert.match(out.prefetch, /slots\["c1"\] = \(tot > shim\.input\.get\(ctx, "Total_Day_s"\)\)/);
  assert.deepEqual(out.todos, []);
});

test('an aggregate local zeroed behind a client-field test replays the guarded assignment', () => {
  const out = translate(`tot = 0;\nif (input.Total_Day_s > 1) { ${AGG.replace('tot =', 'tot =')} }\nif (tot > input.Total_Day_s) { alert "over"; }`, OPTS);
  assert.match(out.prefetch, /var tot = \(.* \? .* : tot\);/);
  assert.deepEqual(out.todos, []);
});

test('a guarded arm that calls out keeps the counted todo', () => {
  const out = translate(`${AGG}\nif (tot == null) { tot = thisapp.Fallback(); }\nif (tot > input.Total_Day_s) { alert "over"; }`, OPTS);
  assert.ok(out.todos.some((t) => t.construct === 'client-condition-uses-server'));
});

test('an if-else that assigns the aggregate local in both arms replays as a ternary and compiles the later condition', () => {
  const out = translate(`if (input.Total_Day_s > 1) { ${AGG} } else { tot = 0; }\nif (tot < input.Total_Day_s) { alert "over"; }`, OPTS);
  assert.match(out.prefetch, /var tot = \(.* \? .* : 0\);/);
  assert.match(out.prefetch, /slots\["c\d+"\] = \(tot < shim\.input\.get\(ctx, "Total_Day_s"\)\)/);
  assert.deepEqual(out.todos, []);
});

test('an if-else whose arm calls out keeps the counted todo', () => {
  const out = translate(`if (input.Total_Day_s > 1) { ${AGG} } else { tot = thisapp.Fallback(); }\nif (tot < input.Total_Day_s) { alert "over"; }`, OPTS);
  assert.ok(out.todos.some((t) => t.construct === 'client-condition-uses-server'));
});
