/**
 * A bulk-load checkpoint resumed from JSON, for a table named `constructor` or `__proto__`: the finished
 * table is recognised as finished (no second job), the chunk ledger is the table's own, and the column rules
 * keyed by the same name are read as an own entry.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bulkLoad, emptyBulkCheckpoint, type BulkCheckpoint } from '../src/bulk-load.js';
import { FakeBulkStore } from './bulk-fake-store.js';

const shared = () => [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Object).sort()];
const noWait = async (): Promise<void> => {};

for (const name of ['__proto__', 'constructor']) {
  test(`a table named ${name}: a second run from the JSON checkpoint loads nothing again, and its column rules apply`, async () => {
    const before = shared();
    const store = new FakeBulkStore();
    const columnsByTable = JSON.parse(`{${JSON.stringify(name)}:[{"name":"Code","dataType":"VarChar","length":4}]}`) as Record<string, { name: string; dataType: string; length: number }[]>;
    const run = (rows: { id: string; columns: Record<string, string> }[], checkpoint: BulkCheckpoint) =>
      bulkLoad({ tables: [{ table: name, rows: () => rows }], columnsByTable, bucket: 'b', prefix: 'p', dryRun: false, store, checkpoint, wait: noWait });
    const refused = await run([{ id: 'R1', columns: { Code: 'toolong' } }], emptyBulkCheckpoint());
    assert.equal(refused.ok, false, 'the table’s own column rule refused the long value');
    const good = [{ id: 'R1', columns: { Code: 'ok' } }];
    const checkpoint = emptyBulkCheckpoint();
    const first = await run(good, checkpoint);
    assert.equal(first.ok, true, first.error ?? 'load failed');
    assert.equal(first.tables[0]!.loaded, 1);
    const jobs = store.jobs.size;
    const resumed = JSON.parse(JSON.stringify(checkpoint)) as BulkCheckpoint;
    const second = await run(good, resumed);
    assert.equal(second.ok, true, second.error ?? 'second load failed');
    assert.equal(store.jobs.size, jobs, 'a finished chunk is not written again');
    assert.deepEqual(shared(), before);
    assert.deepEqual(Object.keys(resumed.tables), [name]);
  });
}
