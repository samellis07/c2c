import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyCheckpoint, migrateData, type MigrateResponse } from '../src/index.js';

const response = (body: unknown): MigrateResponse => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const names = ['constructor', '__proto__'];

for (const name of names) {
  test(`migrate resumes a ${name} table without inherited checkpoint state`, async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const posts: unknown[] = [];
    const checkpoint = JSON.parse('{"version":1,"tables":{}}');
    const fetch = async (_url: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? 'GET') === 'GET') return response({ data: [{ ID: 'r1', Name: 'ok' }] });
      posts.push(JSON.parse(init?.body ?? '{}'));
      return response({ ids: ['r1'] });
    };
    const opts = { dc: 'in', creatorBase: 'https://www.zohoapis.in', catalystBase: 'https://api.catalyst.zoho.in', owner: 'o', appLink: 'a', tables: [{ report: `${name}_Report`, table: name }], dryRun: false, fetch, checkpoint } as never;
    const first = await migrateData(opts);
    const second = await migrateData(opts);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(posts.length, 1);
    assert.equal(Object.hasOwn(checkpoint.tables, name), true);
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  });
}
