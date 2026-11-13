/**
 * Creator `alloweddays` on a date column is enforced by the runtime's one
 * shared write check (write rule `allowedDays`), so no write path that goes
 * through the runtime can store a date on another weekday: insert, update,
 * setField, writeRow, insertRow, a fetched record's field assignment, and a
 * subform child table keyed by its own name.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { checkCell, parseAllowedDays, WriteRuleError, type WriteRuleColumn } from '../src/write-rules.js';

// 2026-11-12 is a Thursday, 2026-11-14 a Saturday, 2026-11-15 a Sunday.
const THURSDAY = '2026-11-12';
const SUNDAY = '2026-11-15';

const LEAVE: readonly WriteRuleColumn[] = [
  { name: 'From_Date', dataType: 'Date', allowedDays: [0] },
  { name: 'Stamp', dataType: 'DateTime', allowedDays: [1, 2, 3, 4, 5] },
  { name: 'Note', dataType: 'VarChar' },
];
const ROWS: readonly WriteRuleColumn[] = [{ name: 'Day', dataType: 'Date', allowedDays: [6] }];

function live() {
  const calls: { op: string; form: string; rows?: Record<string, unknown>[] }[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    writeRules: { Leave: LEAVE, Leave_Rows: ROWS },
    datastore: {
      async insert(form, rows) {
        calls.push({ op: 'insert', form, rows });
        return rows.map((row, index) => ({ ROWID: String(index + 1), ...row }));
      },
      async query(form) {
        calls.push({ op: 'query', form });
        return [{ ROWID: '9', From_Date: SUNDAY, Note: 'n' }];
      },
      async update(form, rows) {
        calls.push({ op: 'update', form, rows });
        return { updated: rows.length };
      },
      async delete(form, rowIds) {
        calls.push({ op: 'delete', form });
        return { deleted: rowIds.length };
      },
    },
  });
  return { runtime, calls };
}

async function refused(run: () => unknown): Promise<WriteRuleError> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof WriteRuleError, `expected a WriteRuleError, got ${String(thrown)}`);
  assert.equal(thrown.rule, 'weekday-not-allowed');
  assert.equal(thrown.code, 'INVALID_INPUT');
  // The message names the column and the rule, never the value.
  assert.equal(thrown.message.includes(THURSDAY), false);
  return thrown;
}

const writes = (calls: { op: string }[]) => calls.filter((c) => c.op === 'insert' || c.op === 'update').length;

test('every runtime write path refuses a date on a disallowed weekday before the adapter runs', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({});
  const where = { op: '==' as const, field: 'ROWID', value: '9' };
  assert.equal((await refused(() => runtime.shim.datastore.insert(ctx, 'Leave', { From_Date: THURSDAY }))).field, 'From_Date');
  assert.equal((await refused(() => runtime.shim.datastore.insert(ctx, 'Leave', { From_Date: '12-Nov-2026' }))).field, 'From_Date');
  // A script-computed Deluge date (serial form) is the same day.
  await refused(() => runtime.shim.datastore.insert(ctx, 'Leave', { From_Date: `${THURSDAY}T00:00:00` }));
  assert.equal((await refused(() => runtime.shim.datastore.update(ctx, 'Leave', where, { Stamp: '2026-11-14 09:00:00' }))).field, 'Stamp');
  const query = runtime.shim.datastore.query(ctx, 'Leave', where);
  await refused(() => runtime.shim.datastore.setField(ctx, query, 'From_Date', THURSDAY));
  await refused(() => runtime.shim.datastore.writeRow(ctx, 'Leave', '9', { From_Date: THURSDAY }));
  await refused(() => runtime.shim.datastore.insertRow(ctx, 'Leave', { From_Date: THURSDAY }));
  // A subform child table carries its own rule.
  assert.equal((await refused(() => runtime.shim.datastore.insert(ctx, 'Leave_Rows', { Day: SUNDAY }))).field, 'Day');
  assert.equal(writes(calls), 0);
});

test('a fetched record field assignment is refused at the assignment, never queued', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({});
  const rows = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Leave', { op: '==', field: 'ROWID', value: '9' }));
  assert.equal(rows.length, 1);
  await refused(() => runtime.shim.record.set(rows[0], ['From_Date'], THURSDAY));
  await runtime.shim.datastore.flush(ctx);
  assert.equal(writes(calls), 0);
  // An allowed day is queued and written at flush.
  runtime.shim.record.set(rows[0], ['From_Date'], SUNDAY);
  await runtime.shim.datastore.flush(ctx);
  assert.equal(calls.find((c) => c.op === 'update')?.rows?.[0]?.From_Date, SUNDAY);
});

test('an allowed weekday, a blank, and an unrestricted column still write', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({});
  await runtime.shim.datastore.insert(ctx, 'Leave', { From_Date: SUNDAY, Stamp: '2026-11-13 09:00:00', Note: THURSDAY });
  await runtime.shim.datastore.insert(ctx, 'Leave', { From_Date: '' });
  await runtime.shim.datastore.insert(ctx, 'Leave_Rows', { Day: '2026-11-14' });
  assert.equal(writes(calls), 3);
});

test('the weekday is the calendar day, never shifted by a time of day or zone', () => {
  const column: WriteRuleColumn = { name: 'Stamp', dataType: 'DateTime', allowedDays: [4] };
  assert.deepEqual(checkCell(column, '2026-11-12 23:59:59'), { value: '2026-11-12 23:59:59' });
  assert.deepEqual(checkCell(column, '2026-11-12 00:00:00'), { value: '2026-11-12 00:00:00' });
  // A zone marker is still a format refusal, not a weekday guess.
  assert.deepEqual(checkCell(column, '2026-11-12T23:00:00Z'), { rule: 'date-format' });
  // A non-string never slips past as an allowed day.
  assert.deepEqual(checkCell({ name: 'D', dataType: 'Date', allowedDays: [4] }, 1762905600000), { rule: 'date-format' });
});

test('parseAllowedDays carries only a well-formed restricted list', () => {
  assert.deepEqual(parseAllowedDays('1,2,3,4,5'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseAllowedDays(' 0 '), [0]);
  for (const text of [undefined, '0,1,2,3,4,5,6', '6,5,4,3,2,1,0', '1,1', '7', '-1', '1.0', '', 'mon', '1,,2']) {
    assert.equal(parseAllowedDays(text), undefined, String(text));
  }
});
