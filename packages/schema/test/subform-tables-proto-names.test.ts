/**
 * `subformTablesOf` is keyed by the parent form name, picked by the app
 * author. A form named `__proto__` / `constructor` / `prototype` is an ordinary
 * entry: `(out[form] ??= []).push` found the inherited value and threw.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateSchema, subformTablesOf, type SchemaPlan } from '../src/generator.js';

const shared = () => [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Object).sort()];

// The analyzer refuses a form named `__proto__` (see core `refuseNames`), so only a hand-built plan reaches it.
test('a plan table of a form named __proto__ is an ordinary entry of subformTablesOf', () => {
  const before = shared();
  const plan = { tables: [{ name: '__proto____Sub', role: 'child', subform: { form: '__proto__', field: 'Sub', parentColumn: 'Parent', orderColumn: 'Pos' } }] } as unknown as SchemaPlan;
  const map = subformTablesOf(plan);
  assert.deepEqual(shared(), before);
  assert.deepEqual(Object.keys(map), ['__proto__']);
  assert.equal(Object.getOwnPropertyDescriptor(map, '__proto__')?.value.length, 1);
});

for (const name of ['constructor', 'prototype']) {
  test(`a form named ${name} with a subform is an ordinary entry of subformTablesOf`, () => {
    const before = shared();
    const app = deriveIr(parse(`application "Evil"\n{\n\tform ${name}\n\t{\n\t\tSub\n\t\t(\n\t\t\ttype = grid\n\t\t\tX\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t)\n\t}\n}\n`));
    const map = subformTablesOf(generateSchema(app));
    assert.deepEqual(shared(), before);
    assert.equal(Object.hasOwn(map, name), true);
    assert.deepEqual(Object.keys(map), [name]);
    assert.equal(map[name]!.length, 1);
    assert.equal(map[name]![0]!.field, 'Sub');
  });
}
