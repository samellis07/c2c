/**
 * `seedCompositeMap` is keyed by table and field name, both picked by the app
 * author. A table or field named `__proto__` or `constructor` must be an
 * ordinary entry: `(map[table] ??= {})[field] = ...` would find the inherited
 * `Object.prototype` / `Object` and write the field onto it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateSchema } from '../../schema/src/generator.js';
import { seedCompositeMap } from '../src/seed.js';

function appOf(form: string, field: string) {
  return deriveIr(parse(`application "Evil"\n{\n\tform ${form}\n\t{\n\t\t${field}\n\t\t(\n\t\t\ttype = address\n\t\t\tcity\n\t\t\t(\n\t\t\t\ttype = district_city\n\t\t\t)\n\t\t)\n\t}\n}\n`));
}

const shared = () => [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Object).sort()];

for (const name of ['__proto__', 'constructor']) {
  test(`a table named ${name} is an ordinary entry of the seed composite map`, () => {
    const before = shared();
    const app = appOf(name, 'Home');
    const map = seedCompositeMap(app, generateSchema(app));
    assert.deepEqual(shared(), before, 'no field was written onto Object.prototype or Object');
    assert.equal(({} as Record<string, unknown>).Home, undefined);
    assert.equal(Object.hasOwn(map, name), true);
    assert.deepEqual(Object.keys(map), [name]);
    assert.deepEqual(Object.keys(map[name]!), ['Home']);
    assert.equal(map[name]!.Home![0]!.part, 'city');
  });

  test(`a composite field named ${name} is an ordinary entry of its table's map`, () => {
    const before = shared();
    const app = appOf('Orders', name);
    const map = seedCompositeMap(app, generateSchema(app));
    assert.deepEqual(shared(), before);
    assert.deepEqual(Object.keys(map), ['Orders']);
    assert.equal(Object.hasOwn(map.Orders!, name), true);
    assert.equal(map.Orders![name]![0]!.part, 'city');
  });
}
