/**
 * `seedCompositeMap` is keyed by table and field name, both picked by the app
 * author. A table or field named `__proto__` or `constructor` must be an
 * ordinary entry: `(map[table] ??= {})[field] = ...` would find the inherited
 * `Object.prototype` / `Object` and write the field onto it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { generateSchema } from '../../schema/src/generator.js';
import { seedCompositeMap } from '../src/seed.js';

/** The analyzer refuses a literal `__proto__` name at derive time, so the fixture is derived under a stand-in and renamed in the IR. */
const STAND_IN = 'Zz_proto';
function derive(text: string): App {
  const app = deriveIr(parse(text.replaceAll('__proto__', STAND_IN)));
  const restore = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') (node as Record<string, unknown>)[key] = value.replaceAll(STAND_IN, '__proto__');
      else restore(value);
    }
  };
  restore(app);
  return app;
}

function appOf(form: string, field: string) {
  return derive((`application "Evil"\n{\n\tform ${form}\n\t{\n\t\t${field}\n\t\t(\n\t\t\ttype = address\n\t\t\tcity\n\t\t\t(\n\t\t\t\ttype = district_city\n\t\t\t)\n\t\t)\n\t}\n}\n`));
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
