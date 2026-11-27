/**
 * `readValues` groups data-choice checkboxes by field name, a name picked by the
 * app author. A field named `constructor` or `prototype` must be an ordinary
 * group: `if (!boxes[name]) boxes[name] = []` finds the inherited `Object` and
 * `boxes[name].push` then throws in the browser.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
const start = source.indexOf('function readValues(formEl) {');
const end = source.indexOf('\nfunction showErrors', start);
const readValues = vm.runInNewContext(
  `const OTHERS_VALUE = '__others__'; const viewOf = () => ({ FormData: class { entries() { return [][Symbol.iterator](); } } });\n${source.slice(start, end)}\nreadValues`,
) as (form: unknown) => Record<string, unknown>;

const shared = () => [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Object).sort()];

for (const name of ['constructor', 'prototype']) {
  test(`data-choice checkboxes of a field named ${name} are collected as an ordinary group`, () => {
    const before = shared();
    const box = (value: string, checked: boolean) => ({ name, value, checked, hasAttribute: () => true });
    const boxes = [box('a', true), box('b', false), box('c', true)];
    const form = {
      querySelectorAll: (selector: string) => (selector.includes('data-choice') ? boxes : []),
    };
    const values = readValues(form);
    assert.deepEqual(shared(), before);
    assert.equal(JSON.stringify(Object.getOwnPropertyDescriptor(values, name)?.value), '["a","c"]');
  });
}
