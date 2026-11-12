import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const sdk = createRequire(import.meta.url)(fileURLToPath(new URL('../fake-zcatalyst-sdk-node.cjs', import.meta.url)));

// A multi-app offline sweep shares this module-level store; reset() keeps one
// app's rows (and the ROWID sequence) from leaking into the next app's run.
test('reset clears tables, calls and the ROWID sequence', async () => {
  const table = sdk.initialize(undefined, { scope: 'admin' }).datastore().table('D8_Reset');
  const [made] = await table.insertRows([{ Name: 'first' }]);
  assert.equal(sdk.state().tables.D8_Reset.length, 1);
  assert.ok(sdk.state().calls.length > 0);
  sdk.reset();
  assert.deepEqual(sdk.state().tables, {});
  assert.equal(sdk.state().calls.length, 0);
  const [again] = await table.insertRows([{ Name: 'second' }]);
  assert.equal(again.ROWID, made.ROWID);
});
