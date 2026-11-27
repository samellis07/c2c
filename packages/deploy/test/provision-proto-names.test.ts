import assert from 'node:assert/strict';
import { test } from 'node:test';
import { learnedTableIds } from '../src/provision.js';

for (const name of ['constructor', '__proto__']) {
  test(`learned project ${name} is an own entry`, () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const learned = learnedTableIds({ tables: { [name]: { id: 't1' } } } as never);
    assert.equal(learned[name], 't1');
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  });
}
