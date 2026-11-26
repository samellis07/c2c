import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { applyInitialValues, type WriteField } from '../../shims/src/access.js';
import { generateUi } from '../../ui/src/generate.js';

/**
 * A checkbox left out of an insert takes its Creator initial value as a real
 * boolean, so an on-validate guard written `Flag == false` sees the same record
 * as when the caller sends the field explicitly.
 */
const APP = `application "DecisionDefault"
{
form Slot
{
Title
(
type = text
)
Open_ended
(
type = checkbox
initial value = false
)
Reminder
(
type = checkbox
initial value = true
)
}
workflow
{
form
{
Guard as "Guard"
{
type = form
form = Slot
on add
{
actions (Open_ended == false)
{
on validate
(
if(input.Title == "")
{
cancel submit;
}
)
}
}
}
}
}
}`;

const app = deriveIr(parse(APP));

function fieldsOf(suffix: string): WriteField[] {
  const file = generateUi(app).files.find((item) => item.path.endsWith(suffix));
  assert.ok(file, `${suffix} is generated`);
  const match = /export const fields = (.*);\n/.exec(String(file.data));
  assert.ok(match, `${suffix} exports its write fields`);
  return JSON.parse(match[1]!) as WriteField[];
}

for (const suffix of ['aio/slot/submit.mjs', 'aio/slot/on-validate.mjs']) {
  test(`omitted checkbox takes a boolean initial value in ${suffix}`, () => {
    const record: Record<string, unknown> = { Title: 'x' };
    applyInitialValues(record, fieldsOf(suffix));
    assert.strictEqual(record.Open_ended, false);
    assert.strictEqual(record.Reminder, true);
  });
}

test('an explicit checkbox value is kept', () => {
  const record: Record<string, unknown> = { Open_ended: true, Reminder: false };
  applyInitialValues(record, fieldsOf('aio/slot/submit.mjs'));
  assert.deepEqual(record, { Open_ended: true, Reminder: false });
});
