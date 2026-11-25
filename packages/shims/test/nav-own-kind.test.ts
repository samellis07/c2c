import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../src/runtime.js';

test('nav.merge takes only an instruction that owns its kind', () => {
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC' });
  const nav = (runtime.shim as unknown as { nav: { merge(a: unknown, b: unknown): unknown } }).nav;
  assert.equal(nav.merge('previous', Object.create({ kind: 'closePage' })), 'previous');
  const own = { kind: 'reload' };
  assert.equal(nav.merge('previous', own), own);
});
