/**
 * The mover writes through Catalyst's row insert,
 * names Catalyst's error code and message, and keeps c2c_source_id unique itself.
 * Fakes answer only the shapes recorded live; nothing here uses rowEndpoint().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalystWriteUrl, emptyCheckpoint, migrateData, type FetchLike, type MigrateResponse } from '../src/migrate.js';
import { catalystFailure, catalystRows, quirkRowServer, textResponse } from './catalyst-row-fake.js';

const SCOPE = { org: '10000000000', projectId: '10000000000000001', token: 'cli-token' };

const bases = {
  dc: 'in',
  creatorBase: 'https://www.zohoapis.in',
  catalystBase: 'https://api.catalyst.zoho.in',
  owner: 'owner',
  appLink: 'demo',
  tables: [{ report: 'All_Vendors', table: 'Vendor' }],
  scope: SCOPE,
};

function creatorPage(ids: string[]): MigrateResponse {
  return textResponse(JSON.stringify({ code: 3000, data: ids.map((ID, i) => ({ ID, Vendor_Name: `Vendor ${i}` })) }));
}

/** Catalyst as observed: /rows is 404 INVALID_URL_PATTERN, /row takes an array and echoes stored rows. */
function liveCatalyst(posted: Record<string, unknown>[][]): FetchLike {
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/query')) return textResponse(JSON.stringify({ status: 'success', data: [] }));
    if (path.endsWith('/rows')) return catalystFailure(404, 'INVALID_URL_PATTERN', 'Please check if the URL trying to access is a correct one');
    assert.match(path, /^\/baas\/v1\/project\/10000000000000001\/table\/Vendor\/row$/);
    const body = JSON.parse(init?.body ?? 'null') as Record<string, unknown>[];
    assert.ok(Array.isArray(body));
    posted.push(body);
    return catalystRows(body);
  };
}

test('the write URL is /table/<t>/row, never the 404 /rows path', () => {
  assert.equal(
    catalystWriteUrl('https://api.catalyst.zoho.in', 'Vendor', SCOPE),
    'https://api.catalyst.zoho.in/baas/v1/project/10000000000000001/table/Vendor/row',
  );
});

test('rows go to /row as an array of row objects and the data[] echo confirms them', async () => {
  const ids = ['1000000000000123001', '1000000000000123002'];
  const posted: Record<string, unknown>[][] = [];
  const catalyst = liveCatalyst(posted);
  const fetch: FetchLike = async (url, init) => ((init?.method ?? 'GET') === 'GET' ? creatorPage(ids) : catalyst(url, init));
  const result = await migrateData({ ...bases, dryRun: false, fetch, checkpoint: emptyCheckpoint() });
  assert.equal(result.ok, true);
  assert.equal(result.tables[0]!.writtenCount, 2);
  assert.equal(posted.length, 1);
  assert.deepEqual(
    posted[0]!.map((row) => [row.c2c_source_id, row.Vendor_Name]),
    [
      ['1000000000000123001', 'Vendor 0'],
      ['1000000000000123002', 'Vendor 1'],
    ],
  );
});

test('a refused write names Catalyst error_code, message, and the path', async () => {
  const fetch: FetchLike = async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return creatorPage(['1']);
    if (new URL(url).pathname.endsWith('/query')) return textResponse('{"status":"success","data":[]}');
    return catalystFailure(403, 'MANDATORY_MISSING', 'Column c2c_source_id is mandatory and cannot be empty');
  };
  const result = await migrateData({ ...bases, dryRun: false, fetch, checkpoint: emptyCheckpoint() });
  assert.equal(result.ok, false);
  const message = result.tables[0].error ?? '';
  assert.match(message, /^catalyst write failed: 403 MANDATORY_MISSING: Column c2c_source_id is mandatory and cannot be empty/);
  assert.match(message, /\/table\/Vendor\/row/);
  assert.ok(!message.includes(SCOPE.token));
});

test('a source that repeats a record id is refused with a report before any write', async () => {
  const posted: Record<string, unknown>[][] = [];
  const catalyst = liveCatalyst(posted);
  const fetch: FetchLike = async (url, init) => ((init?.method ?? 'GET') === 'GET' ? creatorPage(['1', '2', '1', '3', '2']) : catalyst(url, init));
  const result = await migrateData({ ...bases, dryRun: false, fetch, checkpoint: emptyCheckpoint() });
  assert.equal(result.ok, false);
  assert.deepEqual(result.tables[0]!.duplicateIds, ['1', '2']);
  assert.match(result.tables[0]!.error ?? '', /repeats 2 record id/);
  assert.equal(posted.length, 0);
});

test('the store fake answers a WHERE ROWID IN comparison read with the stored rows', async () => {
  const store = quirkRowServer();
  const post = await store.fetch('https://api.catalyst.zoho.in/baas/v1/project/p/table/Book/row', {
    method: 'POST',
    body: JSON.stringify([
      { c2c_source_id: 'b1', Title: 'one' },
      { c2c_source_id: 'b2', Title: 'two' },
    ]),
  });
  const inserted = (JSON.parse(await post.text()) as { data: { ROWID: string }[] }).data;
  const rowids = inserted.map((row) => row.ROWID);
  const read = await store.fetch('https://api.catalyst.zoho.in/baas/v1/project/p/query', {
    method: 'POST',
    body: JSON.stringify({ query: `SELECT ROWID, Title FROM Book WHERE ROWID IN (${rowids.map((id) => `'${id}'`).join(', ')})` }),
  });
  const found = (JSON.parse(await read.text()) as { data: Record<string, unknown>[] }).data;
  assert.deepEqual(
    found.map((row) => [row.ROWID, row.Title]),
    [
      [rowids[0], 'one'],
      [rowids[1], 'two'],
    ],
  );
  // A ROWID from another table must not resolve here, and a count follows the same match.
  const other = await store.fetch('https://api.catalyst.zoho.in/baas/v1/project/p/table/Author/row', {
    method: 'POST',
    body: JSON.stringify([{ c2c_source_id: 'a1' }]),
  });
  const authorRowid = (JSON.parse(await other.text()) as { data: { ROWID: string }[] }).data[0]!.ROWID;
  const cross = await store.fetch('https://api.catalyst.zoho.in/baas/v1/project/p/query', {
    method: 'POST',
    body: JSON.stringify({ query: `SELECT ROWID FROM Book WHERE ROWID IN ('${authorRowid}')` }),
  });
  assert.deepEqual((JSON.parse(await cross.text()) as { data: unknown[] }).data, []);
  const count = await store.fetch('https://api.catalyst.zoho.in/baas/v1/project/p/query', {
    method: 'POST',
    body: JSON.stringify({ query: `SELECT COUNT(ROWID) FROM Book WHERE ROWID IN (${rowids.map((id) => `'${id}'`).join(', ')}, '${authorRowid}')` }),
  });
  assert.deepEqual((JSON.parse(await count.text()) as { data: unknown[] }).data, [{ Book: { 'COUNT(ROWID)': '2' } }]);
});
