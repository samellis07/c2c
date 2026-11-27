/**
 * The offline fake SDK orders integer values numerically in ORDER BY, as Data
 * Store does for a BigInt column: the autonumber claim table is read with
 * `ORDER BY n DESC LIMIT 1`, and a text order ("9" above "10") hands out the
 * same number twice, so the 11th autonumber write fails with CounterContention
 * and the perf harness crawls through 64 retries per row.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';

interface Fake {
  state(): { tables: Record<string, Record<string, string>[]> };
  initialize(req: unknown): {
    datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<unknown> } };
    zcql(): { executeZCQLQuery(sql: string): Promise<Record<string, Record<string, string>>[]> };
  };
}

const fake = createRequire(import.meta.url)(join(repoRoot(), 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs')) as Fake;

test('ORDER BY <integer column> DESC puts 10 above 9', async () => {
  for (const rows of Object.values(fake.state().tables)) rows.splice(0);
  const sdk = fake.initialize({});
  await sdk.datastore().table('seq').insertRows([1, 2, 9, 10, 11].map((n) => ({ n: String(n) })));
  const top = await sdk.zcql().executeZCQLQuery('SELECT * FROM seq ORDER BY n DESC LIMIT 1');
  assert.equal(top[0]!.seq!.n, '11');
  const asc = await sdk.zcql().executeZCQLQuery('SELECT * FROM seq ORDER BY n LIMIT 5');
  assert.deepEqual(asc.map((r) => r.seq!.n), ['1', '2', '9', '10', '11']);
});

test('ORDER BY a text column still sorts as text', async () => {
  for (const rows of Object.values(fake.state().tables)) rows.splice(0);
  const sdk = fake.initialize({});
  await sdk.datastore().table('names').insertRows([{ s: 'b' }, { s: 'a' }, { s: 'c' }]);
  const asc = await sdk.zcql().executeZCQLQuery('SELECT * FROM names ORDER BY s LIMIT 5');
  assert.deepEqual(asc.map((r) => r.names!.s), ['a', 'b', 'c']);
});
