/**
 * The autonumber map is keyed by form and field names taken from the export. A form or field called
 * __proto__, constructor or prototype must be an ordinary key of the map, never a write into
 * Object.prototype.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { autonumbersOf } from '../src/generate.js';

test('autonumbersOf keeps a form named __proto__ out of Object.prototype', () => {
  const app = deriveIr(parse(['application "Proto"', '{', '\ttime zone = "Asia/Kolkata"', '}', ''].join('\n')));
  const schema = {
    tables: [
      { role: 'form', form: '__proto__', name: '__proto__', columns: [{ matrixId: 'auto-number', field: 'polluted', name: 'polluted', note: 'start index 5' }] },
      { role: 'form', form: 'Order', name: 'Order', columns: [{ matrixId: 'auto-number', field: 'constructor', name: 'constructor', note: 'start index 7' }] },
    ],
  };
  const map = autonumbersOf(app, schema as never);
  assert.equal(Object.getPrototypeOf(map), null, 'the map has no prototype to write into');
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype was not written to');
  assert.deepEqual(Object.entries(map['__proto__'] ?? {}), [['polluted', { start: 5 }]], '__proto__ is an ordinary key');
  assert.deepEqual(Object.entries(map['Order'] ?? {}), [['constructor', { start: 7 }]]);
});
