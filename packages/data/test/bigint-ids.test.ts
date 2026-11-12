/** Golden: a Creator Get Records reply with bare 19-digit ids is moved exactly. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyCheckpoint, migrateData as migrateDataReal, type FetchLike, type MigrateResponse } from '../src/migrate.js';
import { rowEndpoint } from './catalyst-row-fake.js';

const migrateData: typeof migrateDataReal = (opts) => migrateDataReal({ ...opts, fetch: rowEndpoint(opts.fetch) });

const CREATOR = '1000000000000000001';
const LOOKUP = '1000000000000000002';

function raw(text: string): MigrateResponse {
  return { status: 200, headers: { get: () => null }, text: async () => text };
}

test('Creator read: a bare 19-digit ID and lookup ID are not rounded before the Catalyst write', async () => {
  assert.equal(Number(CREATOR), Number(LOOKUP));
  const posts: { id: string; columns: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return raw(`{"code":3000,"data":[{"ID":${CREATOR},"Name":"a","Qty":2,"Rate":1.5,"Author":{"ID":${LOOKUP},"display_value":"Ada"}}]}`);
    }
    if (new URL(url).pathname.endsWith('/query')) return raw('{"rows":[]}');
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, unknown> }[] };
    posts.push(...body.rows);
    return raw(`{"ids":[${body.rows.map((row) => `"${row.id}"`).join(',')}]}`);
  };
  const result = await migrateData({
    dc: 'in',
    creatorBase: 'https://www.zohoapis.in',
    catalystBase: 'https://api.catalyst.zoho.in',
    owner: 'owner',
    appLink: 'demo',
    tables: [{ report: 'Book_Report', table: 'Book' }],
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(result.ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.id, CREATOR);
  assert.equal(posts[0]!.columns.c2c_source_id, CREATOR);
  assert.equal(String((posts[0]!.columns.Author as { ID: unknown }).ID), LOOKUP);
  assert.equal(posts[0]!.columns.Qty, 2);
  assert.equal(posts[0]!.columns.Rate, 1.5);
});
