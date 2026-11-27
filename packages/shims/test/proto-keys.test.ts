/**
 * The client-effect queue is keyed by a marker key and the hydrated linked rows
 * by lookup field. A key spelled `__proto__` or `constructor` must be an
 * ordinary entry of the queue: `(queued[key] ??= []).push(...)` would find the
 * inherited `Object.prototype` / `Object` and call a method that is not there.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../src/runtime.js';

const shared = () => [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Object).sort(), Object.getOwnPropertyNames(Array.prototype).sort()];

for (const key of ['__proto__', 'constructor']) {
  test(`a client effect keyed ${key} queues as an ordinary entry`, () => {
    const before = shared();
    const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
    const ctx = runtime.context({});
    runtime.shim.client.effect(ctx, key, { op: 'alert', message: 'one' });
    runtime.shim.client.effect(ctx, key, { op: 'alert', message: 'two' });
    runtime.shim.client.effect(ctx, 'other', { op: 'alert', message: 'three' });
    const queued = ctx.clientEffects!;
    assert.deepEqual(shared(), before);
    assert.equal(Object.hasOwn(queued, key), true);
    assert.deepEqual(Object.keys(queued).sort(), [key, 'other'].sort());
    assert.deepEqual(queued[key], [{ op: 'alert', message: 'one' }, { op: 'alert', message: 'two' }]);
    // The reply carries the queue as JSON; the key survives the round trip as an own key.
    const wire = JSON.parse(JSON.stringify({ effects: queued })) as { effects: Record<string, unknown[]> };
    assert.equal(Object.hasOwn(wire.effects, key), true);
    assert.equal(wire.effects[key]!.length, 2);
  });
}
