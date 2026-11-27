/**
 * `seedRecord` builds the posted record from seed column names and composite
 * field names an app author picks. A composite field or column named
 * `__proto__` or `constructor` must be an ordinary key of the record:
 * `(record[field] ??= {})[part] = ...` would find the inherited
 * `Object.prototype` / `Object` and write the part onto it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type RecordPlan, seedRecord } from '../src/perf-seed.js';

const shared = () => [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Object).sort()];

function plan(form: string, field: string): RecordPlan {
  return {
    forms: [form],
    children: new Map(),
    composites: Object.fromEntries([[form, Object.fromEntries([[field, [{ part: 'city', column: 'Home_city' }, { part: 'zip', column: 'Home_zip' }]]])]]),
    dropped: new Map(),
    ids: new Set(),
    deferred: new Map(),
    warnings: [],
  };
}

const row = (columns: Record<string, string>) => ({ id: 'r1', columns });

for (const name of ['__proto__', 'constructor']) {
  test(`a composite field named ${name} groups its parts as an ordinary key of the record`, () => {
    const before = shared();
    const record = seedRecord('Guest', row({ Home_city: 'Oslo', Home_zip: '0150' }), plan('Guest', name), new Map(), new Map());
    assert.deepEqual(shared(), before, 'no part was written onto Object.prototype or Object');
    assert.equal(({} as Record<string, unknown>).city, undefined);
    assert.equal(Object.hasOwn(record, name), true);
    assert.deepEqual(Object.entries(record[name] as object), [['city', 'Oslo'], ['zip', '0150']]);
  });

  test(`a column named ${name} is an ordinary key of the record`, () => {
    const before = shared();
    const record = seedRecord('Guest', row(Object.fromEntries([[name, 'plain text']])), plan('Guest', 'Home'), new Map(), new Map());
    assert.deepEqual(shared(), before);
    assert.equal(Object.hasOwn(record, name), true);
    assert.equal(record[name], 'plain text');
  });
}
