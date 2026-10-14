/**
 * Record contract tests: the controls the field widgets emit are built in a
 * jsdom form, values are set the way the widget would leave them, and
 * readRecord/chosenFiles/validate must decode them exactly — hidden inputs
 * carry custom-widget answers, real controls carry native answers.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { chosenFiles, readRecord, validate } from '../template/lib/c2c-ui/form/record.js';
import { canonicalNumber, fractionDigits, localDateTime, localDay, parseLocalDateTime, parseLocalDay, toCanonicalDecimal, toMinorUnits } from '../template/lib/c2c-ui/form/value.js';
import type { FieldSpec, FormSpec } from '../template/lib/c2c-ui/types.js';

function field(name: string, widget: FieldSpec['widget'], extra: Partial<FieldSpec> = {}): FieldSpec {
  return { name, label: name, widget, required: false, readonly: false, generated: true, ...extra };
}

function spec(fields: FieldSpec[]): FormSpec {
  return { name: 'F', label: 'F', layout: 'one', fields, submitEndpoint: '/s', recordEndpoint: '/r', buttons: { add: [], edit: [] } };
}

function jsdom(controls: string, mode: 'add' | 'edit' = 'add'): { formEl: HTMLFormElement; doc: Document } {
  const dom = new JSDOM(`<!doctype html><body><form data-mode="${mode}">${controls}</form></body>`);
  const doc = dom.window.document;
  return { formEl: doc.querySelector('form') as unknown as HTMLFormElement, doc: doc as unknown as Document };
}

test('decision: the hidden carrier posts true when checked, false when not', () => {
  const form = spec([field('Agree', 'decision', { required: true })]);
  const on = jsdom('<input type="hidden" name="Agree" value="true">');
  assert.equal(readRecord(on.formEl, form).Agree, true);
  assert.equal(validate(form, readRecord(on.formEl, form), chosenFiles(on.formEl, form)).Agree, undefined);

  const off = jsdom('<input type="hidden" name="Agree" value="false">');
  assert.equal(readRecord(off.formEl, form).Agree, false);
  assert.equal(validate(form, readRecord(off.formEl, form), chosenFiles(off.formEl, form)).Agree, 'Enter Agree.');
});

test('decision: a native checkbox still posts its checked state', () => {
  const form = spec([field('Agree', 'decision')]);
  const { formEl } = jsdom('<input type="checkbox" name="Agree" value="true" checked>');
  assert.equal(readRecord(formEl, form).Agree, true);
});

test('radio: the hidden carrier posts the picked option value', () => {
  const form = spec([field('Status', 'radio', { required: true, choices: ['Open', 'Closed'] })]);
  const picked = jsdom('<input type="hidden" name="Status" value="Closed">');
  assert.equal(readRecord(picked.formEl, form).Status, 'Closed');
  assert.equal(validate(form, readRecord(picked.formEl, form), chosenFiles(picked.formEl, form)).Status, undefined);

  const none = jsdom('<input type="hidden" name="Status" value="">');
  assert.equal(readRecord(none.formEl, form).Status, undefined);
  assert.equal(validate(form, readRecord(none.formEl, form), chosenFiles(none.formEl, form)).Status, 'Enter Status.');
});

test('radio: real radio inputs still post the checked value', () => {
  const form = spec([field('Status', 'radio')]);
  const { formEl } = jsdom('<input type="radio" name="Status" value="Open"><input type="radio" name="Status" value="Closed" checked>');
  assert.equal(readRecord(formEl, form).Status, 'Closed');
});

test('multiselect: one hidden carrier per picked option posts them all', () => {
  const form = spec([field('Tags', 'multiselect', { choices: ['a', 'b', 'c'] })]);
  const { formEl } = jsdom('<input type="hidden" name="Tags" value="a"><input type="hidden" name="Tags" value="c">');
  assert.deepEqual(readRecord(formEl, form).Tags, ['a', 'c']);
});

test('multiselect: checked checkboxes still post all their values', () => {
  const form = spec([field('Tags', 'multiselect')]);
  const { formEl } = jsdom('<input type="checkbox" name="Tags" value="a" checked><input type="checkbox" name="Tags" value="b"><input type="checkbox" name="Tags" value="c" checked>');
  assert.deepEqual(readRecord(formEl, form).Tags, ['a', 'c']);
});

test('signature: drawn strokes in the hidden carrier upload as a JSON file', () => {
  const form = spec([field('Sig', 'signature', { required: true, uploadEndpoint: '/u' })]);
  const strokes = JSON.stringify([{ points: [0, 0, 4, 4], width: 5 }]);
  const signed = jsdom(`<input type="hidden" name="Sig" value="${strokes.replace(/"/g, '&quot;')}">`);
  const file = chosenFiles(signed.formEl, form).get(form.fields[0]!);
  assert.ok(file);
  assert.equal(file?.name, 'Sig.json');
  assert.equal(file?.type, 'application/json');
  assert.equal(validate(form, readRecord(signed.formEl, form), chosenFiles(signed.formEl, form)).Sig, undefined);

  const empty = jsdom('<input type="hidden" name="Sig" value="">');
  assert.equal(chosenFiles(empty.formEl, form).size, 0);
  assert.equal(validate(form, readRecord(empty.formEl, form), chosenFiles(empty.formEl, form)).Sig, 'Enter Sig.');
});

test('currency: major units round-trip exactly, 12.50 stays "12.50"', () => {
  const form = spec([field('Amount', 'currency', { currencyCode: 'USD', decimalPlaces: 2 })]);
  const { formEl } = jsdom('<input type="hidden" name="Amount" value="12.50">');
  assert.equal(readRecord(formEl, form).Amount, '12.50');
  assert.equal(validate(form, readRecord(formEl, form), chosenFiles(formEl, form)).Amount, undefined);
  // The widget speaks minor units of the currency; the record speaks canonical majors.
  assert.equal(toMinorUnits('12.50', fractionDigits('USD')), 1250);
  assert.equal(toCanonicalDecimal(1250 / 10 ** fractionDigits('USD'), 2), '12.50');
  assert.equal(toCanonicalDecimal(29 / 100, 2), '0.29');
  assert.equal(toCanonicalDecimal(-550 / 100, 2), '-5.50');
  // JPY has no minor unit; INR decimals quantize to the field scale.
  assert.equal(toMinorUnits('1234', fractionDigits('JPY')), 1234);
  assert.equal(toCanonicalDecimal(1234 / 1, 2), '1234.00');
  assert.equal(toMinorUnits('12.346', 2), 1235);
  assert.equal(toMinorUnits('-12.346', 2), -1235);
});

test('decimal: typed value posts as a canonical decimal string at the field scale', () => {
  const form = spec([field('Ratio', 'decimal', { decimalPlaces: 3 })]);
  const { formEl } = jsdom('<input type="hidden" name="Ratio" value="0.125">');
  assert.equal(readRecord(formEl, form).Ratio, '0.125');
  assert.equal(toCanonicalDecimal(0.125, 3), '0.125');
  assert.equal(toCanonicalDecimal(1.23456, 3), '1.235');
});

test('date: the picked local day posts YYYY-MM-DD — never shifted by UTC', () => {
  const form = spec([field('Due', 'date', { required: true })]);
  // Kolkata (UTC+5:30) picking October 10: the Date is local midnight, whose
  // ISO string is October 9 — the contract is the local day, not the UTC day.
  const picked = parseLocalDay('2026-10-10');
  assert.equal(localDay(picked!), '2026-10-10');
  const { formEl } = jsdom('<input type="hidden" name="Due" value="2026-10-10">');
  assert.equal(readRecord(formEl, form).Due, '2026-10-10');
  assert.equal(validate(form, readRecord(formEl, form), chosenFiles(formEl, form)).Due, undefined);
});

test('datetime: datetime-local shape round-trips through the local formatter', () => {
  const form = spec([field('When', 'datetime')]);
  const picked = parseLocalDateTime('2026-10-10T14:30');
  assert.equal(localDateTime(picked!), '2026-10-10T14:30');
  const { formEl } = jsdom('<input type="datetime-local" name="When" value="2026-10-10T14:30">');
  assert.equal(readRecord(formEl, form).When, '2026-10-10T14:30');
});

test('subform rows post as arrays of column values; empty rows drop', () => {
  const form = spec([field('Lines', 'subform', { subfields: [field('Item', 'text'), field('Qty', 'number')] })]);
  const { formEl } = jsdom('<input name="Lines[0].Item" value="Bolt"><input name="Lines[0].Qty" value="4"><input name="Lines[1].Item" value=""><input name="Lines[1].Qty" value="">');
  assert.deepEqual(readRecord(formEl, form).Lines, [{ Item: 'Bolt', Qty: '4' }]);
});

test('file: a chosen file on the named input reaches the upload map', () => {
  const form = spec([field('Receipt', 'file', { required: true, uploadEndpoint: '/u' })]);
  const { formEl, doc } = jsdom('<input type="file" name="Receipt">');
  const input = doc.querySelector('input[name="Receipt"]')! as HTMLInputElement;
  const FileCtor = (doc.defaultView as unknown as { File: typeof File }).File;
  const chosen = new FileCtor(['bytes'], 'receipt.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: { 0: chosen, length: 1, item: (i: number) => (i === 0 ? chosen : null) }, configurable: true });
  assert.equal(chosenFiles(formEl, form).get(form.fields[0]!), chosen);
  assert.equal(validate(form, readRecord(formEl, form), chosenFiles(formEl, form)).Receipt, undefined);
});

test('edit: an empty control sends a clear (null typed, "" text, [] list); add leaves it out; no control sends nothing', () => {
  const form = spec([
    field('Owner', 'lookup'),
    field('When', 'datetime'),
    field('At', 'time'),
    field('Note', 'text'),
    field('Kind', 'radio', { choices: ['A'] }),
    field('Tags', 'multiselect', { choices: ['a'] }),
    field('Gone', 'number'),
    field('Title', 'text', { required: true }),
  ]);
  const controls = '<input name="Owner" value=""><input name="When" value=""><input name="At" value=""><input name="Note" value=""><input type="hidden" name="Kind" value=""><input type="hidden" name="Tags" value=""><input name="Title" value="">';
  const edited = readRecord(jsdom(controls, 'edit').formEl, form);
  assert.deepEqual(edited, { Owner: null, When: null, At: null, Note: '', Kind: '', Tags: [], Title: '' });
  // A required field cleared on edit is still caught before the post.
  assert.equal(validate(form, edited, new Map()).Title, 'Enter Title.');
  assert.deepEqual(readRecord(jsdom(controls, 'add').formEl, form), {});
});

test('canonicalNumber keeps every digit and fixes the scale with string math', () => {
  assert.equal(canonicalNumber('1234567890123456789012', null), '1234567890123456789012');
  assert.equal(canonicalNumber('1,000.50', 2), '1000.50');
  assert.equal(canonicalNumber('007', null), '7');
  assert.equal(canonicalNumber('-0.004', 2), '0.00');
  assert.equal(canonicalNumber('-12.345', 2), '-12.35');
  assert.equal(canonicalNumber('9.995', 2), '10.00');
  assert.equal(canonicalNumber(' ', null), null);
  assert.equal(canonicalNumber('1e21', null), null);
  assert.equal(toCanonicalDecimal(1e21, 0), '1000000000000000000000');
});
