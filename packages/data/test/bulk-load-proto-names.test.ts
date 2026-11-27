/**
 * The bulk-load checkpoint is keyed by table name, a form name picked by the
 * app author, and a resumed checkpoint comes from JSON. A table named
 * `__proto__`, `constructor` or `prototype` must be an ordinary entry:
 * `checkpoint.tables[name] ??= ...` finds the inherited value and the chunk
 * bookkeeping then lands on Object.prototype / Object.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bulkLoad, emptyBulkCheckpoint, type BulkCheckpoint } from '../src/bulk-load.js';
import { FakeBulkStore } from './bulk-fake-store.js';

const shared = () => [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Object).sort()];
const noWait = async (): Promise<void> => {};

for (const name of ['__proto__', 'constructor', 'prototype']) {
  for (const resumed of [false, true]) {
    test(`a table named ${name} is an ordinary checkpoint entry (${resumed ? 'resumed from JSON' : 'fresh'})`, async () => {
      const before = shared();
      const store = new FakeBulkStore();
      const checkpoint: BulkCheckpoint = resumed ? (JSON.parse('{"version":1,"tables":{}}') as BulkCheckpoint) : emptyBulkCheckpoint();
      const result = await bulkLoad({
        tables: [{ table: name, rows: function* () { yield { id: 'R1', columns: { Name: 'a' } }; } }],
        bucket: 'b',
        prefix: 'p',
        dryRun: false,
        store,
        checkpoint,
        wait: noWait,
      });
      assert.equal(result.ok, true, result.error ?? 'load failed');
      assert.deepEqual(shared(), before, 'nothing was written onto Object.prototype or Object');
      assert.equal(({} as Record<string, unknown>).chunks, undefined);
      assert.equal(Object.hasOwn(checkpoint.tables, name), true);
      assert.deepEqual(Object.keys(checkpoint.tables), [name]);
      assert.equal(result.tables[0]!.loaded, 1);
    });
  }
}
