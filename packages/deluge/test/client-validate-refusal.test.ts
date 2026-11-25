import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '../src/translate.js';

// An `if` over a list the loop builds from server reads, in a validate script.
// The server half runs the same script at submit and refuses the save with the
// alert text, so the browser copy of a refusal-only `if` is a pre-check.
const script = (arm: string): string =>
  [
    'OutBound = List:Int();',
    'current = List:Int();',
    'temp = List:Int();',
    'gone = List:Int();',
    'gone = Sub[Parent == input.ID].Docket.getAll();',
    'for each re in input.Rows { current.add(re.Docket); }',
    'temp = gone.intersect(current);',
    'gone.removeall(temp);',
    'if (!gone.isEmpty()) {',
    '  for each doc in gone {',
    '    if (Ret[Docket == doc].count() != 0) { OutBound.add(Ret[Docket == doc].Docket); }',
    '  }',
    '}',
    'if (OutBound.size() != 0) {',
    arm,
    '}',
  ].join('\n');

const run = (arm: string, validateEvent: boolean) =>
  translate(script(arm), { formNames: ['Ret', 'Sub'], inputFields: ['ID', 'Rows', 'Note'], validateEvent });

const counted = (r: ReturnType<typeof run>): number => r.todos.filter((t) => t.construct === 'client-condition-uses-server').length;

const REFUSAL = '  alert "Cannot edit " + OutBound + " dispatched";\n  cancel submit;';

test('a refusal-only if the browser cannot evaluate is enforced by the validate server half', () => {
  const r = run(REFUSAL, true);
  assert.equal(counted(r), 0);
  assert.doesNotMatch(r.client, /shim\.todo\(|cancelSubmit/);
  // The refusal carries the computed alert text, not the generic line.
  assert.match(r.server, /shim\.validate\.cancelSubmit\(ctx, String\(\(\(\("Cannot edit " \+ OutBound\) \+ " dispatched"\)\) \?\? ""\)\)/);
  // Every statement the ledger counts as a todo has a covering todo item.
  for (const row of r.coverage) if (row.bucket === 'todo') assert.ok(r.todos.some((t) => t.start < row.end && t.end > row.start), row.kind);
});

test('the same if outside a validate script keeps the counted todo', () => {
  assert.ok(counted(run(REFUSAL, false)) > 0);
});

test('an alert the submit goes on past keeps the counted todo', () => {
  assert.ok(counted(run('  alert "careful";', true)) > 0);
});

test('an arm that also changes the screen keeps the counted todo', () => {
  assert.ok(counted(run(`${REFUSAL}\n  hide Docket_No;`, true)) > 0);
});

test('an arm that also assigns a field keeps the counted todo', () => {
  assert.ok(counted(run(`${REFUSAL}\n  input.Note = "x";`, true)) > 0);
});

test('a literal alert text stays a literal in the refusal', () => {
  const r = run('  alert "Not allowed";\n  cancel submit;', true);
  assert.equal(counted(r), 0);
  assert.match(r.server, /shim\.validate\.cancelSubmit\(ctx, "Not allowed"\)/);
});

test('two alerts before the cancel keep the counted todo', () => {
  assert.ok(counted(run('  alert "a";\n  alert "b" + OutBound;\n  cancel submit;', true)) > 0);
});
