import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DelugeConversionError } from '../src/convert.js';
import { Decimal } from '../src/decimal.js';
import { createRuntime } from '../src/runtime.js';

test('the runtime number table carries sin, cos, tan and asin', () => {
  const { shim } = createRuntime({ dryRun: true });
  for (const fn of ['sin', 'cos', 'tan', 'asin'] as const) {
    const f = shim.number[fn];
    const js = Math[fn];
    assert.equal(typeof f, 'function', fn);
    assert.equal(f(null), null, `${fn}(null)`);
    assert.equal(f(''), null, `${fn}("")`);
    assert.equal(String(f(0.5)), String(js(0.5)), `${fn}(0.5)`);
    assert.equal(String(f(Decimal.from('0.5'))), String(js(0.5)), `${fn}(Decimal 0.5)`);
    assert.equal(String(f(1n)), String(js(1)), `${fn}(1n)`);
    assert.ok(f(0.5) instanceof Decimal, `${fn} returns a Decimal`);
    assert.throws(() => f(2n ** 53n + 1n), (e: unknown) => e instanceof DelugeConversionError && /refusing to lose precision/.test(e.message));
    assert.throws(() => f(Decimal.from('0.10000000000000000001')), (e: unknown) => e instanceof DelugeConversionError && /refusing to lose precision/.test(e.message));
    assert.throws(() => f(true), DelugeConversionError);
    assert.throws(() => f('0x1'), DelugeConversionError);
  }
  assert.equal(shim.number.asin(1.5), null);
  assert.equal(shim.number.asin(-1.0001), null);
});
