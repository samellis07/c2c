/**
 * `uniqueByTable` and `foreignKeysByTable` are keyed by table name, a form
 * name picked by the app author. A table named `__proto__` / `constructor` /
 * `prototype` is an ordinary entry: `(out[table] ??= []).push` threw.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foreignKeysByTable, uniqueByTable } from '../src/verify-behavior.js';

const shared = () => [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Object).sort()];

for (const name of ['__proto__', 'constructor', 'prototype']) {
  test(`a table named ${name} is an ordinary entry of the unique and foreign-key maps`, () => {
    const before = shared();
    const steps = [
      { table: name, columns: [{ column_name: 'Code', data_type: 'varchar', is_unique: true }, { column_name: 'Parent', data_type: 'foreign key' }] },
    ] as never;
    const unique = uniqueByTable(steps);
    const fks = foreignKeysByTable(steps);
    assert.deepEqual(shared(), before);
    assert.deepEqual(Object.keys(unique), [name]);
    assert.deepEqual(Object.keys(fks), [name]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(unique, name)?.value, ['Code']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(fks, name)?.value, ['Parent']);
  });
}
