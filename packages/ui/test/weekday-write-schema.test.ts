/**
 * Creator `alloweddays` on a date field: the generated write schema carries
 * the allowed weekdays so the server refuses a date the client would refuse,
 * and the field is no longer a counted manual step.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);

function source(days: string): string {
  return `application "Demo"
{
${tab(1)}form Leave
${tab(1)}{
${tab(2)}From_Date
${tab(2)}(
${tab(3)}type = date
${tab(3)}alloweddays = ${days}
${tab(2)})
${tab(1)}}
}`;
}

test('a restricted weekday set reaches the generated write schema', () => {
  const built = buildUi(deriveIr(parse(source('0,6'))));
  // Server-side files only: the client model carries allowedDays already.
  const writers = built.files.filter((file) => file.path.startsWith('functions/') && String(file.data).includes('"allowedDays"'));
  assert.ok(writers.length > 0, 'expected a generated write schema with allowedDays');
  assert.ok(writers.every((file) => /"allowedDays":\s*\[\s*0,\s*6\s*\]/.test(String(file.data))));
  assert.equal(built.model.todos.some((t) => t.name === 'Leave.From_Date property alloweddays'), false);
});

test('a malformed weekday set is not carried and stays a manual step', () => {
  const built = buildUi(deriveIr(parse(source('1,1'))));
  assert.equal(built.files.some((file) => file.path.startsWith('functions/') && String(file.data).includes('"allowedDays"')), false);
  assert.equal(built.model.todos.some((t) => t.name === 'Leave.From_Date property alloweddays'), true);
});
