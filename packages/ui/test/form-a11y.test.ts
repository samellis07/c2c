import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, clientRuntimeSource, type UiModel } from '../src/index.js';

// Accessibility of the served form: each control is named, a shown error is
// the control's description and marks it invalid, an invalid submit moves
// focus to the first invalid control, and grid rows name their cells.

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = '', modifiers = ''): string {
  const head = modifiers ? `${modifiers} ${name}` : name;
  return `\t\t${head}\n\t\t(\n\t\t\ttype = ${type}${extra ? `\n${extra}` : ''}\n\t\t)`;
}

const FORM = `\tform Visit
\t{
${field('Patient', 'text', '\t\t\tdisplayname = "Patient"', 'must have')}
${field('Contact', 'email', '\t\t\tdisplayname = "Contact"', 'must have')}
${field('Kind', 'radiobuttons', '\t\t\tdisplayname = "Kind"\n\t\t\tvalues = {"New","Repeat"}')}
${field('Doses', 'grid', '\t\t\tdisplayname = "Doses"\n\t\t\tDrug\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t\tdisplayname = "Drug"\n\t\t\t)\n\t\t\tQty\n\t\t\t(\n\t\t\t\ttype = number\n\t\t\t\tdisplayname = "Qty"\n\t\t\t)')}
\t}`;

interface Runtime {
  boot(model: UiModel, doc: Document): Promise<void>;
}

type Win = Window & typeof globalThis;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function bootForm(t: TestContext, mutate?: (model: UiModel) => void): Promise<Win> {
  const model = buildUi(appOf(FORM)).model;
  mutate?.(model);
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>', {
    url: 'http://localhost/slate/index.html#/form/Visit',
  }).window as unknown as Win;
  win.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ dryRun: true }) })) as unknown as typeof fetch;
  const globals = globalThis as { model?: UiModel; document?: Document; CSS?: unknown };
  globals.CSS ??= { escape: (s: string) => s };
  globals.model = model;
  globals.document = win.document;
  t.after(() => {
    delete globals.model;
    delete globals.document;
  });
  const source = clientRuntimeSource();
  const runtime = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as Runtime;
  await runtime.boot(model, win.document);
  await settle();
  return win;
}

function submit(win: Win): Promise<void> {
  const form = win.document.querySelector('form[data-form]')!;
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  return settle();
}

function control(win: Win, name: string): HTMLInputElement {
  const el = win.document.querySelector<HTMLInputElement>(`form [name="${name}"]`);
  assert.ok(el, `no control ${name}`);
  return el;
}

test('a field error is the control description, marks it invalid and takes focus on submit', async (t) => {
  const win = await bootForm(t);
  const doc = win.document;
  const patient = control(win, 'Patient');
  const slot = doc.querySelector('[data-error-for="Patient"]')!;
  assert.ok(slot.id, 'the error slot has an id');
  assert.ok(patient.getAttribute('aria-describedby')?.split(' ').includes(slot.id), 'the control is described by its error slot');
  assert.equal(patient.getAttribute('aria-invalid'), null, 'no error before submit');

  await submit(win);
  assert.notEqual(slot.textContent, '', 'the required error shows');
  assert.equal(patient.getAttribute('aria-invalid'), 'true');
  assert.equal(control(win, 'Contact').getAttribute('aria-invalid'), 'true');
  assert.equal(doc.activeElement, patient, 'focus moves to the first invalid control');

  // Fixing one field clears its invalid state and focus moves on to the next one.
  patient.value = 'Synthetic Patient';
  await submit(win);
  assert.equal(patient.getAttribute('aria-invalid'), null, 'a fixed field is no longer invalid');
  assert.equal(control(win, 'Contact').getAttribute('aria-invalid'), 'true');
  assert.equal(doc.activeElement, control(win, 'Contact'));
});

test('the form banner is a live status region', async (t) => {
  const win = await bootForm(t);
  assert.equal(win.document.querySelector('[data-banner]')?.getAttribute('role'), 'status');
});

test('a radio list is one group named by the field label', async (t) => {
  const win = await bootForm(t);
  const block = win.document.querySelector('[data-field="Kind"]')!;
  assert.equal(block.getAttribute('role'), 'group');
  const labelId = block.getAttribute('aria-labelledby');
  assert.ok(labelId);
  assert.equal(win.document.getElementById(labelId)?.textContent, 'Kind');
  // A single-value field is not a group.
  assert.equal(win.document.querySelector('[data-field="Patient"]')?.getAttribute('role'), null);
});

test('grid cells and remove buttons are named by column and row, and renumber after a removal', async (t) => {
  const win = await bootForm(t);
  const doc = win.document;
  const add = doc.querySelector<HTMLButtonElement>('[data-add-row]')!;
  add.click();
  add.click();
  await settle();
  const names = (): string[][] =>
    [...doc.querySelectorAll('.subform tbody tr')].map((tr) =>
      [...tr.querySelectorAll('[data-subfield], [data-remove-row]')].map((el) => el.getAttribute('aria-label') ?? ''),
    );
  assert.deepEqual(names(), [
    ['Drug, row 1', 'Qty, row 1', 'Remove row 1'],
    ['Drug, row 2', 'Qty, row 2', 'Remove row 2'],
  ]);
  const errorId = doc.querySelector('[data-field="Doses"] [data-error-for="Doses"]')!.id;
  assert.ok(errorId);
  assert.equal(doc.querySelector('.subform tbody [data-subfield="Drug"]')?.getAttribute('aria-describedby'), errorId);
  assert.ok(add.getAttribute('aria-describedby')?.includes(errorId));

  doc.querySelector<HTMLButtonElement>('.subform tbody tr [data-remove-row]')!.click();
  await settle();
  assert.deepEqual(names(), [['Drug, row 1', 'Qty, row 1', 'Remove row 1']]);
});

test('a help text is part of the control description, ahead of the error', async (t) => {
  const win = await bootForm(t, (model) => {
    const patient = model.forms[0]!.fields.find((f) => f.name === 'Patient')! as { help?: string };
    patient.help = 'Full name as on the card';
  });
  const doc = win.document;
  const hint = doc.querySelector('[data-field="Patient"] [data-help]')!;
  assert.ok(hint.id);
  const ids = control(win, 'Patient').getAttribute('aria-describedby')!.split(' ');
  assert.deepEqual(ids, [hint.id, doc.querySelector('[data-error-for="Patient"]')!.id]);
  // A field without help keeps only its error description.
  assert.equal(control(win, 'Contact').getAttribute('aria-describedby')?.split(' ').length, 1);
});
