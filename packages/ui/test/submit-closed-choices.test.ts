/**
 * The submit stub's client write schema carries the closed choice list of a
 * single-choice picklist or radio; the store re-check of script-set values
 * strips it. An "allow other" option, a lookup picklist and a multi select
 * stay open.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closedChoices, deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);

const SOURCE = `application "Demo"
{
${tab(1)}form Task
${tab(1)}{
${tab(2)}Priority
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = {"Low","High"}
${tab(2)})
${tab(2)}Size
${tab(2)}(
${tab(3)}type = radiobuttons
${tab(3)}values = {"S","M"}
${tab(2)})
${tab(2)}Tags
${tab(2)}(
${tab(3)}type = multiselect
${tab(3)}values = {"a","b"}
${tab(2)})
${tab(2)}Owner
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = Person.Name
${tab(2)})
${tab(1)}}
${tab(1)}form Person
${tab(1)}{
${tab(2)}Name
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(1)}}
}
`;

test('closedChoices closes single-choice lists only', () => {
  const app = deriveIr(parse(SOURCE));
  const form = app.forms.find((item) => item.name === 'Task')!;
  const field = (name: string) => form.fields.find((item) => item.name === name)!;
  assert.deepEqual(closedChoices(field('Priority')), ['Low', 'High']);
  assert.deepEqual(closedChoices(field('Size')), ['S', 'M']);
  assert.equal(closedChoices(field('Tags')), undefined);
  assert.equal(closedChoices(field('Owner')), undefined);
  const open = { ...field('Priority'), properties: [...field('Priority').properties, { key: 'allow other choice', value: 'true', span: { start: 0, end: 0 } }] };
  assert.equal(closedChoices(open), undefined);
});

test('the submit stub screens client values against the list and the re-check strips it', () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const text = String(built.files.find((file) => file.path === 'functions/aio/task/submit.mjs')?.data);
  const fields = JSON.parse(/^export const fields = (.*);$/m.exec(text)![1]!) as { name: string; choices?: string[] }[];
  const byName = new Map(fields.map((field) => [field.name, field]));
  assert.deepEqual(byName.get('Priority')?.choices, ['Low', 'High']);
  assert.deepEqual(byName.get('Size')?.choices, ['S', 'M']);
  assert.equal(byName.get('Tags')?.choices, undefined);
  assert.equal(byName.get('Owner')?.choices, undefined);
  assert.match(text, /const \{ hidden, choices, \.\.\.rest \} = field;/);
});
