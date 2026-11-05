/**
 * `others option = true` on a picklist or radio: the generated form offers an
 * "Others" entry whose free text is the stored value. The submit stub leaves
 * the field open (the typed text is not a listed choice), the client runtime
 * validates it like any text value, and the audit counts the property emitted.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { closedChoices, deriveIr, parse } from '../../core/src/index.js';
import { auditApp, collectOutputs } from '../../quality/src/no-silent-drop.js';
import { buildUi, type UiField, type UiForm } from '../src/index.js';

interface Runtime {
  renderForm(form: UiForm): string;
  validateField(field: UiField, value: unknown): string | null;
}

async function loadRuntime(): Promise<Runtime> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as Runtime;
}

const tab = (n: number) => '\t'.repeat(n);

const SOURCE = `application "Demo"
{
${tab(1)}form Task
${tab(1)}{
${tab(2)}Priority
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = {"Low","High"}
${tab(3)}others option = true
${tab(3)}maxchar = 40
${tab(2)})
${tab(2)}Size
${tab(2)}(
${tab(3)}type = radiobuttons
${tab(3)}values = {"S","M"}
${tab(3)}others option = true
${tab(2)})
${tab(2)}Sealed
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = {"a","b"}
${tab(2)})
${tab(1)}}
}
`;

const app = deriveIr(parse(SOURCE));
const built = buildUi(app);
const form = built.model.forms.find((item) => item.name === 'Task')!;
const uiField = (name: string) => form.fields.find((item) => item.name === name)!;

test('the model carries othersOption on the picklist and radio, and their lists stay open', () => {
  assert.equal(uiField('Priority').othersOption, true);
  assert.equal(uiField('Size').othersOption, true);
  assert.equal(uiField('Sealed').othersOption, undefined);
  const irForm = app.forms.find((item) => item.name === 'Task')!;
  const irField = (name: string) => irForm.fields.find((item) => item.name === name)!;
  assert.equal(closedChoices(irField('Priority')), undefined);
  assert.equal(closedChoices(irField('Size')), undefined);
  assert.deepEqual(closedChoices(irField('Sealed')), ['a', 'b']);
});

test('the submit stub keeps an others-option field open and a plain picklist closed', () => {
  const text = String(built.files.find((file) => file.path === 'functions/aio/task/submit.mjs')?.data);
  const fields = JSON.parse(/^export const fields = (.*);$/m.exec(text)![1]!) as { name: string; choices?: string[] }[];
  const byName = new Map(fields.map((field) => [field.name, field]));
  assert.equal(byName.get('Priority')?.choices, undefined);
  assert.equal(byName.get('Size')?.choices, undefined);
  assert.deepEqual(byName.get('Sealed')?.choices, ['a', 'b']);
});

test('the generated form draws an Others entry and its free-text box', async () => {
  const { renderForm } = await loadRuntime();
  const html = renderForm(form);
  const select = /<select[^>]*name="Priority"[^>]*>([\s\S]*?)<\/select>/.exec(html)![1]!;
  assert.match(select, /<option value="__c2c_others__">Others<\/option>/);
  assert.match(html, /<input type="text" data-others-text maxlength="40" hidden>/);
  const radios = html.match(/<input[^>]*type="radio"[^>]*name="Size"[^>]*>/g) ?? [];
  assert.equal(radios.length, 3, 'two listed choices plus the Others radio');
  assert.match(radios[2]!, /value="__c2c_others__"/);
});

test('the typed Others text validates like a text value and stores verbatim', async () => {
  const { validateField } = await loadRuntime();
  const field = uiField('Priority');
  // A stored value outside the list is not "choose a listed value".
  assert.equal(validateField(field, 'Custom answer'), null);
  // Data-only text is stored and rendered as text, not refused.
  assert.equal(validateField(field, '<img onerror=alert(1)>'), null);
  // The text rules still apply.
  assert.equal(validateField(field, 'x'.repeat(41)), 'Use at most 40 characters.');
  // The sealed picklist still refuses an out-of-list value.
  assert.equal(validateField(uiField('Sealed'), 'Custom answer'), 'Choose a listed value.');
});

test('the audit emits the property from the generated output, and breaking the output brings the drop back', () => {
  const out = collectOutputs(app);
  assert.equal(auditApp(app, out).filter((d) => d.name.includes('others option')).length, 0);
  // Mutation: remove the carried flag from the generated field — the drop returns.
  const mutated = {
    ...out,
    model: {
      ...out.model,
      forms: out.model.forms.map((f) => ({
        ...f,
        fields: f.fields.map((fld) => (fld.othersOption ? { ...fld, othersOption: false } : fld)),
      })),
    },
  };
  const drops = auditApp(app, mutated).filter((d) => d.kind === 'field-property' && d.name.includes('others option'));
  assert.equal(drops.length, 2);
});
