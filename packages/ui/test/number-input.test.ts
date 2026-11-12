/**
 * Number-family fields (number, decimal, percent, currency) render a plain,
 * typeable text control — a real box that can be clicked, focused and typed
 * or pasted into — never a stepper-only widget. The typed text is the posted
 * value, so grouped digits and decimal places reach the record exactly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

interface UiField {
  name: string;
  label: string;
  widget: string;
  required: boolean;
  unique: boolean;
  readonly: boolean;
  status: 'generated' | 'todo';
  scan: boolean;
}

function field(name: string, widget: string): UiField {
  return { name, label: name, widget, required: false, unique: false, readonly: false, status: 'generated', scan: false };
}

async function runtime() {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    renderForm: (form: unknown) => string;
    validateField: (field: unknown, value: unknown) => string | null;
    submitRecord: (formEl: unknown, form: unknown, upload: unknown) => Promise<Record<string, unknown>>;
  };
}

const FORM = {
  name: 'Book',
  label: 'Book',
  submitEndpoint: '/s',
  fields: [
    field('Publication_Year', 'number'),
    field('Rating', 'decimal'),
    field('Price', 'currency'),
    field('Margin', 'percent'),
  ],
};

test('number-family fields render a plain typeable input, not a stepper', async () => {
  const mod = await runtime();
  const html = mod.renderForm(FORM);
  for (const name of ['Publication_Year', 'Rating', 'Price', 'Margin']) {
    const match = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html);
    assert.ok(match, `${name} renders an input`);
    const tag = match[0];
    assert.match(tag, /type="text"/, `${name} is a text control so digits, signs and decimal places type freely`);
    assert.match(tag, /inputmode="decimal"/, `${name} asks mobile for the numeric keypad`);
    assert.equal(tag.includes('readonly'), false, `${name} is writable`);
  }
  assert.equal(html.includes('role="spinbutton"'), false);
  assert.equal(html.includes('aria-label="Increase'), false, 'no stepper buttons stand between the user and the field');
});

test('a typed value posts verbatim; grouped digits stay the typed text', async () => {
  const mod = await runtime();
  const entries: [string, string][] = [
    ['Publication_Year', '1985'],
    ['Rating', '4.5'],
    ['Price', '1985.50'],
  ];
  const view = {
    FormData: class {
      *entries(): Generator<[string, string]> {
        yield* entries;
      }
    },
    File: undefined,
  };
  const formEl = { ownerDocument: { defaultView: view }, querySelectorAll: () => [] };
  const record = await mod.submitRecord(formEl, FORM, async () => {
    throw new Error('no uploads in this test');
  });
  assert.equal(record.Publication_Year, 1985, 'a whole number posts as a number');
  assert.equal(record.Rating, '4.5');
  assert.equal(record.Price, '1985.50', 'currency keeps the typed decimal places');
});

test('field-level number checks reject non-numbers with the Creator messages', async () => {
  const mod = await runtime();
  assert.equal(mod.validateField(field('Publication_Year', 'number'), 'abc'), 'Enter a whole number.');
  assert.equal(mod.validateField(field('Publication_Year', 'number'), '19.5'), 'Enter a whole number.');
  assert.equal(mod.validateField(field('Rating', 'decimal'), 'abc'), 'Enter a number.');
  assert.equal(mod.validateField(field('Price', 'currency'), 'abc'), 'Enter a number.');
  assert.equal(mod.validateField(field('Publication_Year', 'number'), '-1985'), null, 'negative whole numbers are valid');
  assert.equal(mod.validateField(field('Rating', 'decimal'), '-4.5'), null);
});
