import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePrivacyTodoEntries, type UiTodo } from '../src/model.js';

function todoWithReason(reason: string): UiTodo {
  return { area: 'field', name: 'privacy flags', reason, manualStep: 'n/a' };
}

test('parsePrivacyTodoEntries parses a normal consolidated reason', () => {
  const todo = todoWithReason(
    'Fields "Form.A (personal data = true), Form.B (private = true, personal data = true)" are flagged for data privacy; Catalyst generates no privacy or access control for these fields.',
  );
  const entries = parsePrivacyTodoEntries(todo);
  assert.deepEqual(entries, [
    { field: 'Form.A', flags: ['personal data'] },
    { field: 'Form.B', flags: ['private', 'personal data'] },
  ]);
});

test('parsePrivacyTodoEntries stays linear-time on a pathological non-matching tail', () => {
  // Regression for a polynomial-regex ReDoS (CodeQL high severity, confirmed
  // quadratic: 32k trailing tabs took ~1.2s against the old /\s*=\s*true$/i
  // trim once the string does NOT end in "true", forcing the engine to keep
  // retrying the \s* from every offset before giving up). The fix must stay
  // well under 1s even at well beyond that length.
  const flagValue = 'x' + '\t'.repeat(200000);
  const todo = todoWithReason(`Fields "Form.X (${flagValue})" are flagged for data privacy; Catalyst generates no privacy or access control for these fields.`);
  const start = performance.now();
  const entries = parsePrivacyTodoEntries(todo);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1000, `parse took ${elapsed}ms, expected well under 1000ms`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.field, 'Form.X');
  assert.deepEqual(entries[0]!.flags, [flagValue.trim()]);
});

test('parsePrivacyTodoEntries still strips a padded "= true" suffix correctly', () => {
  const todo = todoWithReason(
    `Fields "Form.X (personal data ${'\t'.repeat(5000)}=${'\t'.repeat(5000)}true)" are flagged for data privacy; Catalyst generates no privacy or access control for these fields.`,
  );
  const entries = parsePrivacyTodoEntries(todo);
  assert.deepEqual(entries, [{ field: 'Form.X', flags: ['personal data'] }]);
});

test('parsePrivacyTodoEntries leaves a flag without "= true" unchanged', () => {
  const todo = todoWithReason('Fields "Form.Y (weird flag)" are flagged for data privacy; Catalyst generates no privacy or access control for these fields.');
  const entries = parsePrivacyTodoEntries(todo);
  assert.deepEqual(entries, [{ field: 'Form.Y', flags: ['weird flag'] }]);
});
