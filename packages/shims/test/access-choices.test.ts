/**
 * A single-choice picklist or radio with a closed `values = {...}` list
 * refuses a client value outside the list, as Creator does (code 3001
 * "Invalid column value for <Field>"). The refusal is a store-classified
 * WriteRuleError, so the submit replies 400 INVALID_INPUT naming the field.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeWrite, type AccessPolicy, type WriteSchema } from '../src/access.js';
import { classifyStoreError } from '../src/store-errors.js';
import { WriteRuleError } from '../src/write-rules.js';

const policy: AccessPolicy = { roles: [], profiles: { Administrator: { Task: { write: true, delete: true } } } };
const admin = { profile: 'Administrator', loginUser: 'a@example.test' };
const schema: WriteSchema = {
  fieldNames: ['Title', 'Priority', 'Mood', 'Steps', 'Step', 'Size'],
  fields: [
    { name: 'Title' },
    { name: 'Priority', choices: ['Low', 'Medium', 'High'] },
    { name: 'Mood' },
    { name: 'Steps', kind: 'subform', fields: [{ name: 'Step' }, { name: 'Size', choices: ['S', 'M'] }] },
  ],
};

function refusedField(values: Record<string, unknown>): string {
  let thrown: unknown;
  try {
    authorizeWrite(policy, admin, 'Task', values, schema, 'insert');
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof WriteRuleError, `expected WriteRuleError, got ${String(thrown)}`);
  assert.equal(thrown.rule, 'not-a-choice');
  assert.deepEqual(classifyStoreError(thrown), { code: 'INVALID_INPUT', field: thrown.field });
  return thrown.field;
}

test('a value outside the closed choice list is refused naming the field', () => {
  assert.equal(refusedField({ Title: 't', Priority: 'ZZ_Not_A_Choice' }), 'Priority');
  // Choice match is exact, as Creator's list is.
  assert.equal(refusedField({ Priority: 'low' }), 'Priority');
  // A subform column with a closed list is screened in every row.
  assert.equal(refusedField({ Steps: [{ Step: 'a', Size: 'S' }, { Step: 'b', Size: 'XL' }] }), 'Size');
});

test('listed values, blanks and fields without a closed list pass', () => {
  const ok = authorizeWrite(policy, admin, 'Task', { Priority: 'High', Mood: 'anything', Steps: [{ Size: 'M' }] }, schema, 'insert');
  assert.equal(ok.values.Priority, 'High');
  assert.equal(ok.values.Mood, 'anything');
  assert.deepEqual(authorizeWrite(policy, admin, 'Task', { Priority: '' }, schema, 'insert').values, { Priority: '' });
  assert.deepEqual(authorizeWrite(policy, admin, 'Task', { Priority: null }, schema, 'insert').values, { Priority: null });
  // Without the field list (a script's grant-level screen) nothing is checked against choices.
  assert.deepEqual(authorizeWrite(policy, admin, 'Task', { Priority: 'ZZ' }, undefined, 'insert').values, { Priority: 'ZZ' });
});
