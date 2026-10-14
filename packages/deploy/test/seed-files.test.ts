import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { canonicalSeedJson, generateSeed } from '../../data/src/seed.js';
import { emptyCheckpoint, type FetchLike, type MigrateResponse } from '../../data/src/migrate.js';
import type { ObjectSink } from '../../data/src/files.js';
import { generateSchema } from '../../schema/src/generator.js';
import { keyBelongsTo, uploadObjectKey } from '../../shims/src/files.js';
import { bucketName } from '../src/offline-plan.js';
import { migrateSeed, parseSeed, seedBucketName, seedFileColumns, type SeedTable } from '../src/seed.js';

const SCOPE = { org: '10000000000', projectId: '1001', token: 'test-cli-token' };

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

const CONTACTS = `\tform Contacts
\t{
\t\tmust have Picture
\t\t(
\t\t\ttype = image
\t\t)
\t\tDocument
\t\t(
\t\t\ttype = file upload
\t\t)
\t}`;

function response(body: unknown, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

interface StoredRow {
  rowid: string;
  columns: Record<string, string>;
}

function storeFetch(calls: string[]): { fetch: FetchLike; stored: Map<string, Map<string, StoredRow>> } {
  const stored = new Map<string, Map<string, StoredRow>>();
  let seq = 1;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('seed migrate called Creator');
    calls.push(`${method} ${new URL(url).pathname}`);
    const path = new URL(url).pathname;
    if (path.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
      const rows = stored.get(table) ?? new Map<string, StoredRow>();
      if (/^SELECT ROWID, c2c_source_id FROM /i.test(sql)) {
        return response({ data: [...rows].map(([source, row]) => ({ c2c_source_id: source, ROWID: row.rowid })) });
      }
      return response({ data: [...rows].map(([source, row]) => ({ ...row.columns, c2c_source_id: source, ROWID: row.rowid })) });
    }
    if (method === 'PUT') {
      const table = decodeURIComponent(path.split('/').at(-2) ?? '');
      const bucket = stored.get(table) ?? new Map<string, StoredRow>();
      const list = JSON.parse(init?.body ?? '[]') as Record<string, string>[];
      for (const update of list) {
        for (const row of bucket.values()) {
          if (row.rowid === update.ROWID) Object.assign(row.columns, update);
        }
      }
      stored.set(table, bucket);
      return response({});
    }
    const table = decodeURIComponent(path.split('/').at(-2) ?? '');
    const parsed: unknown = JSON.parse(init?.body ?? '[]');
    const records = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
        ? (parsed as { rows: unknown[] }).rows
        : [];
    const bucket = stored.get(table) ?? new Map<string, StoredRow>();
    const acked: { c2c_source_id: string }[] = [];
    for (const row of records) {
      const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      const nested = record.columns;
      const sourceObj = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : record;
      const columns: Record<string, string> = {};
      for (const [key, value] of Object.entries(sourceObj)) {
        if (typeof value === 'string') columns[key] = value;
      }
      const source = columns.c2c_source_id ?? (typeof record.id === 'string' ? record.id : '');
      if (source && !columns.c2c_source_id) columns.c2c_source_id = source;
      bucket.set(source, { rowid: `rowid-${table}-${seq++}`, columns });
      acked.push({ c2c_source_id: source });
    }
    stored.set(table, bucket);
    return response({ data: acked });
  };
  return { fetch, stored };
}

function memorySink(): ObjectSink & { objects: Map<string, { bytes: Uint8Array; type: string }>; puts: string[] } {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const puts: string[] = [];
  return {
    objects,
    puts,
    async put(key, bytes, contentType) {
      puts.push(key);
      if (objects.has(key)) return 'exists';
      objects.set(key, { bytes: Uint8Array.from(bytes), type: contentType });
      return 'created';
    },
  };
}

test('the seed upload bucket matches the plan bucket name', () => {
  assert.equal(seedBucketName('Contacts'), bucketName('Contacts'));
  assert.equal(seedBucketName('My App'), bucketName('My App'));
});

test('the loader uploads Picture as a PNG and stores the Stratus key', async (t) => {
  const app = appOf(CONTACTS);
  const seed = generateSeed(app, { n: 2, seed: 'test' });
  const picture = seed.fixtureFiles.find((file) => file.name.endsWith('-Picture-value.png'));
  const document = seed.fixtureFiles.find((file) => file.name.endsWith('-Document-value.pdf'));
  assert.ok(picture);
  assert.ok(document);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-seed-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of seed.fixtureFiles) writeFileSync(join(dir, file.name), file.bytes);
  const tables = parseSeed(canonicalSeedJson(seed.tables));
  assert.equal(tables[0]?.rows[0]?.columns.Picture, picture.name);
  const fileColumns = seedFileColumns(generateSchema(app));
  assert.deepEqual(fileColumns.Contacts, [
    { column: 'Picture', field: 'Picture' },
    { column: 'Document', field: 'Document' },
  ]);
  const calls: string[] = [];
  const { fetch, stored } = storeFetch(calls);
  const sink = memorySink();
  const loaded = await migrateSeed({
    tables,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
    seedDir: dir,
    fileColumnsByTable: fileColumns,
    sink,
  });
  assert.equal(loaded.ok, true);
  assert.equal(tables[0]?.rows[0]?.columns.Picture, picture.name);
  const sha = createHash('sha256').update(picture.bytes).digest('hex');
  const key = uploadObjectKey('Contacts', 'Picture', sha, picture.name);
  assert.equal(keyBelongsTo('Contacts', 'Picture', key), true);
  const rows = [...(stored.get('Contacts')?.values() ?? [])];
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.columns.Picture, key);
  assert.equal(sink.objects.get(key)?.type, 'image/png');
  assert.equal(sink.objects.get(key)?.bytes[0], 0x89);
  assert.equal(sink.objects.get(key)?.bytes[1], 0x50);
  assert.equal(sink.objects.get(key)?.bytes[2], 0x4e);
  assert.equal(sink.objects.get(key)?.bytes[3], 0x47);
  const docKey = uploadObjectKey('Contacts', 'Document', createHash('sha256').update(document.bytes).digest('hex'), document.name);
  assert.equal(sink.objects.get(docKey)?.type, 'application/pdf');
  assert.equal(sink.objects.get(docKey)?.bytes[0], 0x25);
  assert.equal(sink.puts.length, 2);

  const again = await migrateSeed({
    tables,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
    seedDir: dir,
    fileColumnsByTable: fileColumns,
    sink,
  });
  assert.equal(again.ok, true);
  assert.equal(sink.objects.size, 2);
  assert.equal(sink.puts.length, 4);
});

test('a missing Picture fixture refuses the load before any write', async (t) => {
  const app = appOf(CONTACTS);
  const seed = generateSeed(app, { n: 1, seed: 'test' });
  const picture = seed.fixtureFiles.find((file) => file.name.includes('Picture'));
  assert.ok(picture);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-seed-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of seed.fixtureFiles) {
    if (file.name !== picture.name) writeFileSync(join(dir, file.name), file.bytes);
  }
  const calls: string[] = [];
  const { fetch } = storeFetch(calls);
  await assert.rejects(
    () =>
      migrateSeed({
        tables: parseSeed(canonicalSeedJson(seed.tables)),
        dc: 'in',
        catalystBase: 'https://api.catalyst.zoho.in',
        dryRun: false,
        fetch,
        checkpoint: emptyCheckpoint(),
        scope: SCOPE,
        seedDir: dir,
        fileColumnsByTable: seedFileColumns(generateSchema(app)),
        sink: memorySink(),
      }),
    /seed fixture .+ is missing/,
  );
  assert.deepEqual(calls, []);
});

test('a fixture name cannot leave the seed directory', async () => {
  const calls: string[] = [];
  const { fetch } = storeFetch(calls);
  const sink = memorySink();
  const tables: SeedTable[] = [{ table: 'Contacts', rows: [{ id: 'Contacts#1', columns: { Picture: '../Picture.png' } }] }];
  await assert.rejects(
    () =>
      migrateSeed({
        tables,
        dc: 'in',
        catalystBase: 'https://api.catalyst.zoho.in',
        dryRun: false,
        fetch,
        checkpoint: emptyCheckpoint(),
        scope: SCOPE,
        seedDir: 'seed-dir',
        fileColumnsByTable: { Contacts: [{ column: 'Picture', field: 'Picture' }] },
        sink,
      }),
    /not a file name/,
  );
  assert.deepEqual(calls, []);
  assert.equal(sink.puts.length, 0);
});

test('a dry run does not upload fixture files', async () => {
  const app = appOf(CONTACTS);
  const seed = generateSeed(app, { n: 1, seed: 'test' });
  const tables = parseSeed(canonicalSeedJson(seed.tables));
  const sink: ObjectSink = {
    async put() {
      throw new Error('dry run uploaded a file');
    },
  };
  const calls: string[] = [];
  const { fetch } = storeFetch(calls);
  const result = await migrateSeed({
    tables,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: true,
    fetch,
    checkpoint: emptyCheckpoint(),
    seedDir: 'seed-dir',
    fileColumnsByTable: seedFileColumns(generateSchema(app)),
    sink,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
});
