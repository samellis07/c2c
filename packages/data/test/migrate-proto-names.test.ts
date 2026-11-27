/**
 * The row migrator's checkpoint is keyed by table name, a form name picked by the app author, and a resumed
 * checkpoint is parsed JSON. A table named `constructor` or `__proto__` must be an ordinary own entry: a plain
 * read found the inherited member (the table looked resumed from a function) and a plain write to `__proto__`
 * replaced the map's prototype, so a finished table was redone on every run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCheckpoint, migrateData as migrateDataReal, type Checkpoint, type FetchLike, type MigrateResponse } from '../src/index.js';
import { rowEndpoint } from './catalyst-row-fake.js';

const migrateData: typeof migrateDataReal = (opts) => migrateDataReal({ ...opts, fetch: rowEndpoint(opts.fetch) });
const shared = () => [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Object).sort()];

function response(body: unknown): MigrateResponse {
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

const rows = Array.from({ length: 450 }, (_, index) => ({ ID: `r${index}`, Name: 'n' }));

for (const name of ['constructor', '__proto__', 'prototype']) {
  test(`a table named ${name} resumes from a JSON checkpoint and a finished table is not redone`, async () => {
    const before = shared();
    const written: string[] = [];
    let reads = 0;
    let posts = 0;
    const fetch: FetchLike = async (url, init) => {
      if (new URL(url).pathname.endsWith('/baas/v1/query')) return response({ rows: [] });
      if ((init?.method ?? 'GET') === 'GET') {
        reads += 1;
        return response({ data: rows });
      }
      const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string }[] };
      posts += 1;
      if (posts === 2) throw new Error('mid-run');
      written.push(...body.rows.map((row) => row.id));
      return response({ ids: body.rows.map((row) => row.id) });
    };
    const opts = { dc: 'in', creatorBase: 'https://www.zohoapis.in', catalystBase: 'https://api.catalyst.zoho.in', owner: 'owner', appLink: 'demo', tables: [{ report: 'Book_Report', table: name }], dryRun: false, fetch };
    let checkpoint: Checkpoint = emptyCheckpoint();
    const first = await migrateData({ ...opts, checkpoint });
    assert.equal(first.ok, false);
    assert.equal(Object.hasOwn(checkpoint.tables, name), true, 'the half-done table is an own entry');
    assert.equal(checkpoint.tables[name]!.count, 200);
    // The checkpoint file as code with plain objects wrote it: an own key by any spelling.
    checkpoint = JSON.parse(JSON.stringify(checkpoint)) as Checkpoint;
    const second = await migrateData({ ...opts, checkpoint });
    assert.equal(second.ok, true, JSON.stringify(second.tables[0]));
    assert.equal(new Set(written).size, 450);
    assert.equal(written.filter((id) => id === 'r0').length, 1, 'the resumed run does not rewrite the first slice');
    assert.equal(checkpoint.tables[name]!.done, true);
    const readsBefore = reads;
    const postsBefore = posts;
    const third = await migrateData({ ...opts, checkpoint: JSON.parse(JSON.stringify(checkpoint)) as Checkpoint });
    assert.equal(third.ok, true);
    assert.equal(posts, postsBefore, 'a finished table is not written again');
    assert.equal(reads, readsBefore, 'a finished table is not read again');
    assert.deepEqual(shared(), before, 'nothing was written onto Object.prototype or Object');
    assert.equal(Object.getPrototypeOf(checkpoint.tables), Object.prototype);
    assert.equal(({} as Record<string, unknown>).count, undefined);
  });
}
