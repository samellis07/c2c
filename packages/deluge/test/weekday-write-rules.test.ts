/**
 * Creator `alloweddays` reaches the generated runtime write rules for a form
 * table and an inline subform's child table, so the shared write check that
 * the script-owned submit (shim.datastore.insert / update) and every other
 * runtime write run refuses a date on another weekday.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse } from '../../core/src/index.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { WriteRuleError } from '../../shims/src/write-rules.js';
import { fieldAllowedDays, writeRulesOf } from '../src/generate.js';

const APP = `application "D"
{
\tform Leave
\t{
\t\tFrom_Date
\t\t(
\t\t\ttype = date
\t\t\talloweddays = 0
\t\t)
\t\tStamp
\t\t(
\t\t\ttype = datetime
\t\t\talloweddays = 1,2,3,4,5
\t\t)
\t\tLoose
\t\t(
\t\t\ttype = date
\t\t\talloweddays = 1,1
\t\t)
\t\tAny_Day
\t\t(
\t\t\ttype = date
\t\t\talloweddays = 0,1,2,3,4,5,6
\t\t)
\t\tLabel
\t\t(
\t\t\ttype = text
\t\t\talloweddays = 1
\t\t)
\t\tLines
\t\t(
\t\t\ttype = grid
\t\t\tDay
\t\t\t(
\t\t\t\ttype = date
\t\t\t\talloweddays = 6
\t\t\t)
\t\t)
\t}
}
`;

test('restricted date columns carry their allowed weekdays on the write rules', () => {
  const app = deriveIr(parse(APP));
  const rules = writeRulesOf(app);
  const leave = rules.Leave ?? [];
  assert.deepEqual(leave.find((column) => column.name === 'From_Date')?.allowedDays, [0]);
  assert.deepEqual(leave.find((column) => column.name === 'Stamp')?.allowedDays, [1, 2, 3, 4, 5]);
  // Malformed, unrestricted, and non-date fields carry nothing.
  for (const name of ['Loose', 'Any_Day', 'Label']) assert.equal(leave.find((column) => column.name === name)?.allowedDays, undefined, name);
  const child = Object.entries(rules).find(([form, columns]) => form !== 'Leave' && columns.some((column) => column.name === 'Day'));
  assert.ok(child, 'expected the subform child table rules');
  assert.deepEqual(child![1].find((column) => column.name === 'Day')?.allowedDays, [6]);
  const field = app.forms[0]!.fields.find((item) => item.name === 'Loose')!;
  assert.equal(fieldAllowedDays(field), undefined);
});

test('the runtime built with the generated rules refuses a disallowed weekday on the submit write', async () => {
  const app = deriveIr(parse(APP));
  const writes: string[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    writeRules: writeRulesOf(app),
    datastore: {
      async insert(form, rows) {
        writes.push(form);
        return rows.map((row) => ({ ROWID: '1', ...row }));
      },
      async query() {
        return [];
      },
      async update(form, rows) {
        writes.push(form);
        return { updated: rows.length };
      },
      async delete(_form, ids) {
        return { deleted: ids.length };
      },
    },
  });
  const ctx = runtime.context({});
  // 2026-11-12 is a Thursday; From_Date allows Sunday only.
  await assert.rejects(runtime.shim.datastore.insert(ctx, 'Leave', { From_Date: '2026-11-12' }), (err: unknown) => err instanceof WriteRuleError && err.rule === 'weekday-not-allowed' && err.field === 'From_Date');
  await assert.rejects(runtime.shim.datastore.update(ctx, 'Leave', { op: '==', field: 'ROWID', value: '1' }, { From_Date: '2026-11-12' }), WriteRuleError);
  assert.deepEqual(writes, []);
  await runtime.shim.datastore.insert(ctx, 'Leave', { From_Date: '2026-11-15', Loose: '2026-11-12' });
  assert.deepEqual(writes, ['Leave']);
});
