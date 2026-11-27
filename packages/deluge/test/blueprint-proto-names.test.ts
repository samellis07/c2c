/**
 * Blueprint stage and transition settings are keyed by display names from the export. A stage or transition
 * named __proto__ must be an ordinary entry, never a write that replaces the map's prototype.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { App, Property } from '../../core/src/index.js';
import { blueprintFieldSpec } from '../src/blueprint-rules.js';

const Z = { start: 0, end: 0, line: 1, column: 1 } as never;
const prop = (key: string, value: string): Property => ({ key, value, span: Z });

test('a blueprint stage and a transition named __proto__ are ordinary entries of the field spec', () => {
  const form: App['forms'][number] = {
    name: 'Orders',
    properties: [],
    fields: [{ name: 'Status', type: 'text', properties: [], span: Z } as never],
    actions: [],
    blocks: [],
    span: Z,
  };
  const w = {
    blueprint: {
      stages: [{ name: '__proto__', properties: [prop('mandatory fields', '[Status]')], blocks: [], span: Z }],
      transitions: [
        {
          name: '__proto__',
          properties: [],
          phases: [{ phase: 'during', properties: [prop('action', 'update_fields'), prop('visible fields', '[Status]')], blocks: [], deluge: [], span: Z }],
          span: Z,
        },
      ],
    },
  } as never;
  const spec = blueprintFieldSpec(w, form, 'Status', (name) => name);
  assert.ok(spec, 'the spec is produced');
  for (const map of [spec.stages, spec.transitions]) {
    assert.equal(Object.getPrototypeOf(map), Object.prototype, 'the prototype was not replaced');
    assert.deepEqual(Object.keys(map), ['__proto__'], '__proto__ is an ordinary entry');
  }
});
