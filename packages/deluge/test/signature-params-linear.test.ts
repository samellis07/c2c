/**
 * The parenthesis scan of a function signature stays linear on a long run of '(' that never closes
 * (the old /\(([^)]*)\)/ rescanned the rest of the string from every '(').
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fnSignatureParams, rawFnParams } from '../src/generate.js';

const best = (run: () => void): number => {
  let fastest = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - t0);
  }
  return fastest;
};

test('signature parameters are read the same, and linearly on adversarial input', () => {
  assert.deepEqual(rawFnParams('string f(int a, string b)'), ['a', 'b']);
  assert.deepEqual(fnSignatureParams('void g(int a)'), [{ type: 'int', name: 'a' }]);
  assert.deepEqual(rawFnParams('no parens'), []);
  assert.deepEqual(rawFnParams('open ((( never closed'), []);
  assert.deepEqual(rawFnParams('f()'), []);
  const hostile = (n: number) => '('.repeat(n);
  for (const read of [rawFnParams, fnSignatureParams] as const) {
    const small = Math.max(best(() => read(hostile(100_000))), 1);
    const full = best(() => read(hostile(200_000)));
    assert.ok(full / small < 3.2, `${read.name}: 200k took ${full.toFixed(1)} ms vs ${small.toFixed(1)} ms at half size`);
    assert.ok(full < 5000, `${read.name}: ${full.toFixed(1)} ms`);
  }
});
