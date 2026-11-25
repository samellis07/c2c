import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '../src/translate.js';

// A server-only test over arms that only read a row field into locals leaves
// nothing for the browser to show or send: the server runs the if.
const run = (elseArm: string) =>
  translate(
    [
      'days = {input.Start, input.Start.addDay(1)};',
      'for each d in days {',
      'for each row in input.Logs {',
      '  ex = Ret[Code == row.Code && Day == d];',
      '  if (days.indexOf(d) == 0) { hrs = row.Sunday; } else { hrs = row.Monday; }',
      '  if (ex.count() > 0) {',
      '    ex.Qty = hrs;',
      '  } else {',
      elseArm,
      '  }',
      '}',
      '}',
    ].join('\n'),
    { formNames: ['Ret'], inputFields: ['Logs', 'Start'] },
  );

const counted = (r: ReturnType<typeof run>): number => r.todos.filter((t) => t.construct === 'client-condition-uses-server').length;

test('an if over a server read whose arms only read row fields into locals is run by the server', () => {
  const r = run(
    [
      '    if (hrs != "00:00") {',
      '      if (row.Project != null) { pm = row.Project.Manager; } else { pm = null; }',
      '      insert into Ret [Code = row.Code, Qty = hrs];',
      '    }',
    ].join('\n'),
  );
  assert.equal(counted(r), 0);
  assert.doesNotMatch(r.client, /shim\.todo\(/);
  assert.match(r.server, /shim\.datastore\.insert/);
});

test('an arm that shows an alert keeps the counted todo', () => {
  const r = run('    alert "none";');
  assert.equal(counted(r), 1);
});

test('an arm that writes a row field in the browser keeps the counted todo', () => {
  const r = run('    row.Qty = 5;');
  assert.equal(counted(r), 1);
});
