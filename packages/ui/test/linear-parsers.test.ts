import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventField, readMeta, slug } from '../src/model.js';

// Each parser reads generated module source or export text, so each must stay
// linear: a 50k-character adversarial input finishes well inside the budget.
const BUDGET_MS = 250;

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

test('eventField reads the field after user input of / update of', () => {
  assert.equal(eventField('user input of Status'), 'Status');
  assert.equal(eventField('On User Input of  Due Date '), 'Due Date');
  assert.equal(eventField('on update of\tPriority'), 'Priority');
  assert.equal(eventField('update of\nX'), 'X');
  assert.equal(eventField('on add on validate'), undefined);
  assert.equal(eventField('update ofStatus'), undefined);
  assert.equal(eventField('update of   '), undefined);
  assert.equal(eventField('update of X\nY'), undefined);
  assert.equal(eventField('update of X\nY update of Z'), 'Z');
  assert.equal(eventField(''), undefined);
});

test('readMeta parses the c2cHandler object up to the first `};`', () => {
  const meta = { form: 'Orders', event: 'on add', when: 'submit', prefetch: null, recordEvent: null };
  const source = `// header\nexport const c2cHandler = ${JSON.stringify(meta)};\nexport function run() { return {}; }\n`;
  assert.deepEqual(readMeta(source), meta);
  assert.equal(readMeta('export const other = {};'), undefined);
  assert.equal(readMeta('export const c2cHandler = {"form": "A"}'), undefined);
  assert.equal(readMeta('export const c2cHandler = {not json};'), undefined);
  assert.deepEqual(readMeta('export const c2cHandler = {};'), {});
});

test('slug collapses non-alphanumerics and trims dashes', () => {
  assert.equal(slug('Close Order!'), 'close-order');
  assert.equal(slug('--A__b--'), 'a-b');
  assert.equal(slug('***'), 'item');
  assert.equal(slug(''), 'item');
  assert.equal(slug('Mark as Paid'), 'mark-as-paid');
});

test('the three parsers stay linear on 50k adversarial inputs', () => {
  const tabs = timed(() => eventField(`update of\t${'\t\t'.repeat(25_000)}\n`));
  assert.equal(tabs.value, undefined);
  assert.ok(tabs.ms < BUDGET_MS, `eventField took ${tabs.ms}ms`);
  const phrases = timed(() => eventField('update of '.repeat(5_000)));
  assert.ok(phrases.ms < BUDGET_MS, `eventField (repeated phrase) took ${phrases.ms}ms`);
  const meta = timed(() => readMeta('export const c2cHandler = {'.repeat(2_000)));
  assert.equal(meta.value, undefined);
  assert.ok(meta.ms < BUDGET_MS, `readMeta took ${meta.ms}ms`);
  const dashes = timed(() => slug(`${'-'.repeat(50_000)}a${'-'.repeat(50_000)}!`));
  assert.equal(dashes.value, 'a');
  assert.ok(dashes.ms < BUDGET_MS, `slug took ${dashes.ms}ms`);
  const mid = timed(() => slug(`a${' -'.repeat(25_000)}b`));
  assert.equal(mid.value, 'a-b');
  assert.ok(mid.ms < BUDGET_MS, `slug (interior) took ${mid.ms}ms`);
});
