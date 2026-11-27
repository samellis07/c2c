/**
 * The file-bytes checkpoint is keyed by table name and resumed from JSON. A table named `constructor` or
 * `__proto__` must be an ordinary own entry: a plain read returned the inherited member and a plain write to
 * `__proto__` replaced the map's prototype, so a finished table was downloaded again on every run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyFileCheckpoint, migrateFileBytes, type BytesFetch, type FetchLike, type FileCheckpoint, type ObjectSink } from '../src/index.js';

const shared = () => [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Object).sort()];

for (const name of ['constructor', '__proto__', 'prototype']) {
  test(`a table named ${name} resumes from a JSON file checkpoint and a finished table is not downloaded again`, async () => {
    const before = shared();
    const puts: string[] = [];
    const sink = {
      dc: 'in',
      creatorBase: 'https://www.zohoapis.in',
      catalystBase: 'https://api.catalyst.zoho.in',
      owner: 'owner',
      appLink: 'demo',
      tables: [],
      dryRun: false,
      fetch: undefined,
      checkpoint: undefined,
      async put(key: string) {
        puts.push(key);
        return 'created' as const;
      },
    } as unknown as ObjectSink;
    const downloads: string[] = [];
    const download: BytesFetch = async (url) => {
      downloads.push(url);
      return { status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new TextEncoder().encode('x').buffer as ArrayBuffer };
    };
    const pages: FetchLike = async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data: [{ ID: '101', Photo: '/api/v2.1/owner/demo/report/All_Orders/101/Photo/download?filepath=a.png' }] }),
    });
    const base = { dc: 'in', creatorBase: 'https://www.zohoapis.in', owner: 'owner', appLink: 'demo', tables: [{ report: 'All_Orders', form: 'Order', table: name, columns: ['Photo'] }], fetch: pages, download, sink, dryRun: false };
    let checkpoint: FileCheckpoint = emptyFileCheckpoint();
    const first = await migrateFileBytes({ ...base, checkpoint });
    assert.equal(first.ok, true, JSON.stringify(first.tables));
    assert.equal(first.tables[0]!.uploaded, 1);
    assert.equal(Object.hasOwn(checkpoint.tables, name), true);
    assert.equal(checkpoint.tables[name]!.done, true);
    checkpoint = JSON.parse(JSON.stringify(checkpoint)) as FileCheckpoint;
    downloads.length = 0;
    const again = await migrateFileBytes({ ...base, checkpoint });
    assert.equal(again.ok, true);
    assert.equal(downloads.length, 0, 'a finished table is not downloaded again');
    assert.equal(again.tables[0]!.uploaded, 0);
    assert.equal(puts.length, 1);
    assert.deepEqual(shared(), before, 'nothing was written onto Object.prototype or Object');
    assert.equal(Object.getPrototypeOf(checkpoint.tables), Object.prototype);
  });
}
