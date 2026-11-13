/**
 * A date or datetime field with Creator `alloweddays` restricts the weekdays
 * a user may pick. The generated client refuses another day; a direct post
 * to the write path is refused the same way, as a store-classified
 * WriteRuleError naming the field (400 INVALID_INPUT), never the value.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeWrite, type AccessPolicy, type WriteSchema } from '../src/access.js';
import { classifyStoreError } from '../src/store-errors.js';
import { WriteRuleError } from '../src/write-rules.js';

const policy: AccessPolicy = { roles: [], profiles: { Administrator: { Leave: { write: true, delete: true } } } };
const admin = { profile: 'Administrator', loginUser: 'a@example.test' };
const schema: WriteSchema = {
  fieldNames: ['From_Date', 'Stamp', 'Rows', 'Day'],
  fields: [
    // Sunday only (0), as `alloweddays = 0`.
    { name: 'From_Date', scalar: 'date', input: 'date', allowedDays: [0] },
    // Monday to Friday.
    { name: 'Stamp', scalar: 'datetime', input: 'datetime', allowedDays: [1, 2, 3, 4, 5] },
    { name: 'Rows', kind: 'subform', fields: [{ name: 'Day', scalar: 'date', input: 'date', allowedDays: [6] }] },
  ],
};

function refusedField(values: Record<string, unknown>): string {
  let thrown: unknown;
  try {
    authorizeWrite(policy, admin, 'Leave', values, schema, 'insert');
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof WriteRuleError, `expected WriteRuleError, got ${String(thrown)}`);
  assert.equal(thrown.rule, 'weekday-not-allowed');
  assert.deepEqual(classifyStoreError(thrown), { code: 'INVALID_INPUT', field: thrown.field });
  return thrown.field;
}

test('a date on a weekday the field does not allow is refused naming the field', () => {
  // 2026-11-12 is a Thursday.
  assert.equal(refusedField({ From_Date: '2026-11-12' }), 'From_Date');
  assert.equal(refusedField({ From_Date: '12-Nov-2026' }), 'From_Date');
  // 2026-11-14 is a Saturday.
  assert.equal(refusedField({ Stamp: '2026-11-14 09:00:00' }), 'Stamp');
  assert.equal(refusedField({ Rows: [{ Day: '2026-11-14' }, { Day: '2026-11-15' }] }), 'Day');
});

test('an allowed weekday, a blank, and a field without the restriction pass', () => {
  const ok = authorizeWrite(policy, admin, 'Leave', { From_Date: '2026-11-15', Stamp: '2026-11-13T09:00:00', Rows: [{ Day: '2026-11-14' }] }, schema, 'insert');
  assert.equal(ok.values.From_Date, '2026-11-15');
  assert.deepEqual(authorizeWrite(policy, admin, 'Leave', { From_Date: '' }, schema, 'insert').values, { From_Date: null });
  // Without the field list (a script's grant-level screen) no weekday check runs.
  assert.deepEqual(authorizeWrite(policy, admin, 'Leave', { From_Date: '2026-11-12' }, undefined, 'insert').values, { From_Date: '2026-11-12' });
});
