/**
 * Grouped `values` literals (`{"Label" : {"a","b"}}`) on a picklist: the
 * generated select keeps the group headers as native `<optgroup>`s instead of
 * flattening the members and leaving a manual-step TODO. A radio has no
 * grouping element, so its headers stay a counted manual step.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { auditApp, collectOutputs, coverageLedger } from '../../quality/src/no-silent-drop.js';
import { buildUi, type UiForm } from '../src/index.js';

interface Runtime {
  renderForm(form: UiForm): string;
}

async function loadRuntime(): Promise<Runtime> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as Runtime;
}

const tab = (n: number) => '\t'.repeat(n);

const SOURCE = `application "Demo"
{
${tab(1)}form Task
${tab(1)}{
${tab(2)}Status
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = {"New" : {"Open","Hold"}, "Done" = {"Closed"}, "Loose"}
${tab(2)})
${tab(2)}Priority
${tab(2)}(
${tab(3)}type = radiobuttons
${tab(3)}values = {"Now" : {"Urgent","Today"}, "Later"}
${tab(2)})
${tab(1)}}
}
`;

const app = deriveIr(parse(SOURCE));
const built = buildUi(app);
const form = built.model.forms.find((item) => item.name === 'Task')!;
const uiField = (name: string) => form.fields.find((item) => item.name === name)!;

test('the model carries option groups on the picklist and drops its manual-step todo', () => {
  assert.deepEqual(uiField('Status').optionGroups, [
    { label: 'New', choices: ['Open', 'Hold'] },
    { label: 'Done', choices: ['Closed'] },
  ]);
  const todo = built.model.todos.find((t) => t.name === 'Task.Status option groups');
  assert.equal(todo, undefined, 'no manual-step todo remains for the grouped picklist');
});

test('the radio keeps its option-groups manual step: radios have no grouping element', () => {
  assert.equal(uiField('Priority').optionGroups, undefined);
  const todo = built.model.todos.find((t) => t.name === 'Task.Priority option groups');
  assert.ok(todo, 'a UI todo still names the radio option groups');
  assert.ok(todo.manualStep, 'the todo names a manual step');
});

test('the generated select groups its member options under optgroup headers', async () => {
  const { renderForm } = await loadRuntime();
  const html = renderForm(form);
  const select = /<select[^>]*name="Status"[^>]*>([\s\S]*?)<\/select>/.exec(html)![1]!;
  assert.match(select, /<optgroup label="New">[\s\S]*?<option value="Open">Open<\/option>[\s\S]*?<option value="Hold">Hold<\/option>[\s\S]*?<\/optgroup>/);
  assert.match(select, /<optgroup label="Done">[\s\S]*?<option value="Closed">Closed<\/option>[\s\S]*?<\/optgroup>/);
  assert.match(select, /<option value="Loose">Loose<\/option>/);
});

test('the audit emits the carried groups, and stripping them brings the drop back', () => {
  const out = collectOutputs(app);
  const rows = coverageLedger(app, out).filter((r) => r.name === 'Task.Status option groups');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'emitted');
  assert.equal(auditApp(app, out).filter((d) => d.name === 'Task.Status option groups').length, 0);
  // Mutation: strip the carried groups from the generated field — the drop returns.
  const mutated = structuredClone(out);
  for (const f of mutated.model.forms) for (const fld of f.fields) delete (fld as { optionGroups?: unknown }).optionGroups;
  const drops = auditApp(app, mutated).filter((d) => d.name === 'Task.Status option groups');
  assert.equal(drops.length, 1);
});
