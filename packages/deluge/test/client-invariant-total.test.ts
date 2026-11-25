import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '../src/translate.js';

// A condition comparing a loop row with a server total the loop does not
// change: the prefetch reads the total once, the browser test binds it.
const run = (body: string, tail = '') =>
  translate(
    [
      'g = Sales[ID == input.Code];',
      'for each r in g.Items {',
      '  t = Ret[Code == input.Code].sum(Qty);',
      '  if (input.Q + t > r.Quantity) { alert "too many"; cancel submit; }',
      body,
      '}',
      tail,
    ].join('\n'),
    { formNames: ['Sales', 'Ret', 'Staff'], inputFields: ['Q', 'Code'] },
  );

const todos = (r: ReturnType<typeof run>): string[] => r.todos.filter((t) => t.construct === 'client-condition-uses-server').map((t) => t.construct);

test('a loop-invariant server total is read once and the loop row is compared in the browser', () => {
  const r = run('');
  assert.deepEqual(todos(r), []);
  assert.match(r.client, /\(\(t\) => \(\(\(shim\.input\.get\(ctx, "Q"\) \+ t\) > shim\.get\(r, "Quantity"\)\)\)\)\(slots\["c\d+"\]\)/);
  assert.doesNotMatch(r.client, /shim\.todo\(/);
  // The aggregate runs in the prefetch, not per iteration in the browser.
  assert.match(r.prefetch ?? '', /slots\["c\d+"\] = /);
});

test('a write to another form in the loop keeps the browser comparison', () => {
  assert.deepEqual(todos(run('insert into Staff [Name = input.Code];')), []);
});

for (const [label, body] of [
  ['an insert into the form the total reads', 'insert into Ret [Code = input.Code, Qty = 1];'],
  ['a row write to the form the total reads', 'x = Ret[Code == input.Code]; x.Qty = 2;'],
  ['an input field write the total reads', 'input.Code = "z";'],
  ['an app function call', 'thisapp.Fn(1);'],
  ['an unresolved row write', 'y.Qty = 2;'],
] as const) {
  test(`stays a counted todo with ${label} in the loop`, () => {
    assert.deepEqual(todos(run(body)), ['client-condition-uses-server']);
    assert.match(run(body).client, /shim\.todo\(ctx, "client-condition-uses-server"\)/);
  });
}

test('stays a counted todo when the total is rewritten by an insert before the test in the same iteration', () => {
  const r = translate(
    [
      'g = Sales[ID == input.Code];',
      'for each r in g.Items {',
      '  t = Ret[Code == input.Code].sum(Qty);',
      '  insert into Ret [Code = input.Code, Qty = 1];',
      '  if (input.Q + t > r.Quantity) { alert "x"; }',
      '}',
    ].join('\n'),
    { formNames: ['Sales', 'Ret'], inputFields: ['Q', 'Code'] },
  );
  assert.deepEqual(todos(r), ['client-condition-uses-server']);
});
