import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownGet, ownSet } from '../src/own-keys.js';

test('ownGet never returns an inherited member and ownSet makes __proto__ an ordinary entry', () => {
  const map: Record<string, number> = {};
  assert.equal(ownGet(map, 'constructor'), undefined, 'constructor is not an entry');
  assert.equal(ownGet(map, '__proto__'), undefined, '__proto__ is not an entry');
  assert.equal(ownGet(map, 'toString'), undefined);
  ownSet(map, '__proto__', 1);
  ownSet(map, 'constructor', 2);
  assert.equal(Object.getPrototypeOf(map), Object.prototype, 'the prototype was not replaced');
  assert.deepEqual(Object.keys(map).sort(), ['__proto__', 'constructor']);
  assert.equal(ownGet(map, '__proto__'), 1);
  assert.equal(ownGet(map, 'constructor'), 2);
  assert.equal(JSON.parse(JSON.stringify(map)).constructor, 2);
  assert.equal(ownGet(undefined, 'x'), undefined);
});
