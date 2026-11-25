import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../src/runtime.js';

// A name no statement bound (assigned only in an arm that did not run) holds no
// query: reading it fetches nothing, like a criteria that matches no record.
test('a read through an unbound query is empty, not an error', async () => {
  const runtime = createRuntime({ dryRun: true, seed: { Events: [{ ROWID: '1', Name: 'a' }] } });
  const ctx = runtime.context({ record: {}, old: {} });
  const { datastore } = runtime.shim;
  const before = runtime.transcript.length;
  for (const query of [undefined, null] as never[]) {
    assert.equal(await datastore.field(ctx, query, 'Name'), null);
    assert.deepEqual(await datastore.column(ctx, query, 'Name'), []);
    assert.deepEqual(await datastore.rows(ctx, query), []);
    assert.equal(await datastore.aggregate(ctx, query, 'count'), 0);
    assert.equal(await datastore.aggregate(ctx, query, 'sum', 'Name'), null);
  }
  assert.equal(runtime.transcript.length, before, 'no read was issued');
});
