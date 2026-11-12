import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyCheckpoint, migrateData as migrateDataReal, writeCheckpointFile, type Checkpoint, type FetchLike, type MigrateResponse } from '../src/index.js';
import { rowEndpoint } from './catalyst-row-fake.js';

const migrateData: typeof migrateDataReal = (opts) => migrateDataReal({ ...opts, fetch: rowEndpoint(opts.fetch) });

function response(body: unknown): MigrateResponse {
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'c2c-checkpoint-'));
}

test('a multi-batch load checkpoints into a state directory that does not exist yet', async (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'c2c-out', 'demo', 'state', 'data.json');
  const posts: number[] = [];
  const saved: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (new URL(url).pathname.endsWith('/baas/v1/query')) return response({ rows: [] });
    if ((init?.method ?? 'GET') === 'GET') return response({ data: Array.from({ length: 450 }, (_, i) => ({ ID: `r${i}`, Name: 'n' })) });
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string }[] };
    posts.push(body.rows.length);
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const checkpoint = emptyCheckpoint();
  const result = await migrateData({
    dc: 'in',
    creatorBase: 'https://www.zohoapis.in',
    catalystBase: 'https://api.catalyst.zoho.in',
    owner: 'owner',
    appLink: 'demo',
    tables: [{ report: 'Book_Report', table: 'Book' }],
    dryRun: false,
    fetch,
    checkpoint,
    saveCheckpoint: (next) => {
      writeCheckpointFile(path, next);
      saved.push(readFileSync(path, 'utf8'));
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(posts, [200, 200, 50]);
  assert.ok(saved.length >= 3, `expected a save per batch, got ${saved.length}`);
  const onDisk = readFileSync(path, 'utf8');
  assert.equal(onDisk, `${JSON.stringify(checkpoint)}\n`);
  const parsed = JSON.parse(onDisk) as Checkpoint;
  assert.equal(parsed.version, 1);
  assert.equal(parsed.tables.Book.count, 450);
  assert.equal(parsed.tables.Book.done, true);
  assert.deepEqual(readdirSync(join(root, 'c2c-out', 'demo', 'state')), ['data.json']);
});

test('writeCheckpointFile replaces an existing checkpoint and leaves no temp file', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'data.json');
  writeFileSync(path, 'old\n');
  writeCheckpointFile(path, { version: 1, tables: {} });
  assert.equal(readFileSync(path, 'utf8'), '{"version":1,"tables":{}}\n');
  assert.deepEqual(readdirSync(root), ['data.json']);
});

test('a failed rename keeps the target untouched and removes the temp file', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A directory at the target path makes the rename fail after the temp write.
  const path = join(root, 'data.json');
  mkdirSync(path);
  writeFileSync(join(path, 'keep'), 'x');
  assert.throws(() => writeCheckpointFile(path, emptyCheckpoint()));
  assert.deepEqual(readdirSync(root), ['data.json']);
  assert.deepEqual(readdirSync(path), ['keep']);
});
