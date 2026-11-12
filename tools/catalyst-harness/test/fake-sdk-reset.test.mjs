import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sdk = require('../fake-zcatalyst-sdk-node.cjs');

test('reset() returns the store to a fresh state but keeps sessions', async () => {
  assert.equal(typeof sdk.reset, 'function', 'the fake SDK exports reset()');

  // Dirty every piece of store state: rows, a call log, unique/foreign-key
  // declarations, and the ROWID counter.
  sdk.setUnique({ T: ['Code'] });
  sdk.setForeignKeys({ T: ['Parent'] });
  const admin = sdk.initialize(undefined, { scope: 'admin' });
  const [row] = await admin.datastore().table('T').insertRows([{ Code: 'A', Parent: '1' }]);
  assert.ok(row.ROWID, 'seed row got a ROWID');
  assert.ok(sdk.state().calls.length > 0, 'call log is populated');

  // A session registered before the reset is a harness fixture, not store
  // state: it survives (importers register the admin session once, then reset
  // between apps).
  const token = 'reset-keeps-session';
  sdk.setSession(token, { user_id: '42', email_id: 'u@example.test' });

  sdk.reset();

  assert.deepEqual(sdk.state().tables, {}, 'tables cleared');
  assert.deepEqual(sdk.state().calls, [], 'call log cleared');

  // Declared unique/foreign-key columns are per-app schema: they must not leak
  // into the next app, so a reset clears them too.
  const [a, b] = await admin.datastore().table('T').insertRows([
    { Code: 'A', Parent: 'not-a-number' },
    { Code: 'A', Parent: 'also-not-a-number' },
  ]);
  assert.equal(a.Code, 'A', 'duplicate unique value allowed after reset');
  assert.equal(b.Parent, 'also-not-a-number', 'non-id foreign-key value allowed after reset');

  // The ROWID counter restarts so two runs over the same app seed identically.
  assert.equal(a.ROWID, '10000000000000002', 'ROWID counter restarted');

  const user = await sdk
    .initialize({ headers: { cookie: `c2c-harness-session=${token}` } })
    .userManagement()
    .getCurrentUser();
  assert.equal(user?.user_id, '42', 'session survives a store reset');
});
