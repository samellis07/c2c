/**
 * Captured Creator behavior for the cases the docs leave open.
 *
 * `null <op> date` (`date.cmp.*-null`) is false, not the JS coercion
 * `null <= 0` (true). A date against null still throws, as do both blank
 * dates (`date.cmp.*-null-null`) and text that is not a date
 * (`date.rel.bad-eq`).
 *
 * `for each` over null (`foreach.null`): zero iterations, same as an empty
 * collection. https://www.zoho.com/deluge/help/datatypes/collection.html
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../../src/runtime.js';

test('captured: blank date ordering throws, and for-each null iterates zero times', () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata' });
  const ctx = runtime.context({});
  const jsNull = null as unknown as number;
  assert.equal(jsNull <= 0, true);
  assert.equal(jsNull >= 0, true);
  assert.equal(runtime.shim.date.rel(null, '01-Jan-2020', '<=', ctx), false);
  assert.throws(() => runtime.shim.date.rel(null, null, '<=', ctx), /UnParsable date/);
  assert.throws(() => runtime.shim.date.rel('   ', '01-Jan-2020', '>=', ctx), /UnParsable date/);
  assert.equal(runtime.transcript.some((e) => e.construct === 'blank-date-rel'), false);
  assert.equal(runtime.shim.each(ctx, []).length, 0);
  assert.deepEqual(runtime.shim.each(ctx, null), []);
  assert.equal(runtime.transcript.some((e) => e.construct === 'for-each-null'), false);
});
