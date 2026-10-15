import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse } from '../../core/src/index.js';
import { fileColumnsOf, generateSchema } from '../../schema/src/index.js';
import { rowEndpoint } from './catalyst-row-fake.js';
import {
  creatorDownloadUrl,
  emptyCheckpoint,
  emptyFileCheckpoint,
  migrateData,
  migrateFileBytes,
  stratusObjectUrl,
  stratusRestSink,
  type BytesFetch,
  type BytesResponse,
  type FetchLike,
  type MigrateResponse,
  type ObjectSink,
} from '../src/index.js';

function response(body: unknown, headers: Record<string, string> = {}, status = 200): MigrateResponse {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { status, headers: { get: (name) => lower.get(name.toLowerCase()) ?? null }, text: async () => JSON.stringify(body) };
}

function bytesResponse(status: number, body = '', type = 'image/png'): BytesResponse {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
}

const PATH = (id: string, name: string) => `/api/v2.1/owner/demo/report/All_Orders/${id}/Photo/download?filepath=${name}`;

/** Two pages: 3 rows then 1. Row 102 has no photo. */
const PAGES: Record<string, { data: Record<string, unknown>[]; next?: string }> = {
  first: {
    data: [
      { ID: '101', Photo: PATH('101', 'a.png'), Scan: '' },
      { ID: '102', Photo: '', Scan: null },
      { ID: '103', Photo: PATH('103', 'c.png') },
    ],
    next: 'cursor-2',
  },
  'cursor-2': { data: [{ ID: '104', Photo: PATH('104', 'd.png') }] },
};

const pages: FetchLike = async (_url, init) => {
  const cursor = init?.headers?.record_cursor ?? 'first';
  const page = PAGES[cursor]!;
  return response({ data: page.data }, page.next ? { record_cursor: page.next } : {});
};

function memorySink(failOnKey?: string): ObjectSink & { objects: Map<string, { bytes: string; type: string }>; puts: string[] } {
  const objects = new Map<string, { bytes: string; type: string }>();
  const puts: string[] = [];
  return {
    objects,
    puts,
    async put(key, bytes, contentType) {
      puts.push(key);
      if (key === failOnKey) throw new Error('stratus upload failed: 503');
      if (objects.has(key)) return 'exists';
      objects.set(key, { bytes: new TextDecoder().decode(bytes), type: contentType });
      return 'created';
    },
  };
}

const downloads: string[] = [];
const download: BytesFetch = async (url) => {
  downloads.push(url);
  const id = /\/(\d+)\/Photo\/download/.exec(url)?.[1] ?? '';
  return id === '104' ? bytesResponse(404) : bytesResponse(200, `bytes-of-${id}`);
};

const base = {
  dc: 'in',
  creatorBase: 'https://www.zohoapis.in',
  owner: 'owner',
  appLink: 'demo',
  tables: [{ report: 'All_Orders', form: 'Order', table: 'Order', columns: ['Photo', 'Scan'] }],
  fetch: pages,
  download,
};

test('the schema names the Stratus-key columns the mover rewrites', () => {
  const field = (name: string, type: string) => `\t\t${name}\n\t\t(\n\t\t\ttype = ${type}\n\t\t)`;
  const app = deriveIr(parse(`application "Demo"\n{\n\tform Order\n\t{\n${field('Name', 'text')}\n${field('Photo', 'image')}\n${field('Sign', 'signature')}\n\t}\n}\n`));
  assert.deepEqual(fileColumnsOf(generateSchema(app)), { Order: { form: 'Order', role: 'form', columns: ['Photo', 'Sign'] } });
});

test('migrateData writes a file cell as its migrated Stratus key, not the Creator download path', async () => {
  const posted: Record<string, unknown>[] = [];
  // The /row endpoint takes a JSON array; rowEndpoint hands this fake the { rows: [{ id, columns }] } view.
  const fetch: FetchLike = rowEndpoint(async (url, init) => {
    if (new URL(url).pathname.endsWith('/baas/v1/query')) return response({ rows: [] });
    if ((init?.method ?? 'GET') === 'GET') return response({ data: [{ ID: '101', Name: 'x', Photo: PATH('101', 'a.png') }, { ID: '102', Name: 'y', Photo: '' }] });
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, unknown> }[] };
    posted.push(...body.rows.map((row) => row.columns));
    return response({ ids: body.rows.map((row) => row.id) });
  });
  const result = await migrateData({
    dc: 'in',
    creatorBase: 'https://www.zohoapis.in',
    catalystBase: 'https://api.catalyst.zoho.in',
    owner: 'owner',
    appLink: 'demo',
    tables: [{ report: 'All_Orders', table: 'Order', files: { form: 'Order', columns: ['Photo'] } }],
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
  });
  assert.equal(result.ok, true);
  assert.equal(posted[0].Photo, 'migrated/Order/Photo/101/a.png');
  assert.equal(posted[1].Photo, null);
  assert.equal(posted[0].Name, 'x');
});

test('migrateFileBytes copies each value to its key, lists Creator 404s, and counts only what Stratus acknowledged', async () => {
  downloads.length = 0;
  const sink = memorySink();
  const checkpoint = emptyFileCheckpoint();
  const result = await migrateFileBytes({ ...base, sink, checkpoint, dryRun: false });
  assert.equal(result.ok, true);
  assert.deepEqual([...sink.objects.keys()], ['migrated/Order/Photo/101/a.png', 'migrated/Order/Photo/103/c.png']);
  assert.deepEqual(sink.objects.get('migrated/Order/Photo/101/a.png'), { bytes: 'bytes-of-101', type: 'image/png' });
  assert.equal(downloads[0], 'https://www.zohoapis.in/creator/v2.1/data/owner/demo/report/All_Orders/101/Photo/download?filepath=a.png');
  const table = result.tables[0];
  assert.equal(table.uploaded, 2);
  assert.equal(table.existing, 0);
  assert.equal(table.empty, 5, "blank, null, and absent cells are empty");
  assert.deepEqual(table.missing, [{ sourceId: '104', field: 'Photo', key: 'migrated/Order/Photo/104/d.png' }]);
  assert.equal(checkpoint.tables.Order.done, true);
  assert.equal(JSON.stringify(checkpoint).includes('bytes-of'), false);
  // A finished table is not read again.
  downloads.length = 0;
  const again = await migrateFileBytes({ ...base, sink, checkpoint, dryRun: false });
  assert.equal(downloads.length, 0);
  assert.equal(again.tables[0].uploaded, 0);
});

test('a failed upload stops the table at that row; the rerun resumes there and uploads nothing twice', async () => {
  const saved: string[] = [];
  const checkpoint = emptyFileCheckpoint();
  const failing = memorySink('migrated/Order/Photo/103/c.png');
  const first = await migrateFileBytes({ ...base, sink: failing, checkpoint, dryRun: false, saveCheckpoint: (cp) => saved.push(JSON.stringify(cp)) });
  assert.equal(first.ok, false);
  assert.match(first.tables[0].error ?? '', /stratus upload failed: 503/);
  assert.deepEqual(checkpoint.tables.Order, { requestCursor: null, rowIndex: 2, uploaded: 1, existing: 0, empty: 3, done: false });
  assert.ok(saved.length >= 2);

  const healthy = memorySink();
  for (const [key, value] of failing.objects) healthy.objects.set(key, value);
  const second = await migrateFileBytes({ ...base, sink: healthy, checkpoint, dryRun: false });
  assert.equal(second.ok, true);
  // Row 101 was finished; the rerun starts at row 103 on the same page.
  assert.deepEqual(healthy.puts, ['migrated/Order/Photo/103/c.png']);
  assert.equal(checkpoint.tables.Order.uploaded, 2);
  assert.equal(checkpoint.tables.Order.done, true);
});

test('a dry run plans keys and neither downloads nor uploads nor saves a checkpoint', async () => {
  downloads.length = 0;
  const sink = memorySink();
  const checkpoint = emptyFileCheckpoint();
  const result = await migrateFileBytes({ ...base, sink, checkpoint, dryRun: true });
  assert.equal(result.tables[0].planned, 3);
  assert.equal(downloads.length, 0);
  assert.equal(sink.puts.length, 0);
  assert.deepEqual(checkpoint.tables, {});
});

test('downloads stay on the DC host and a Creator 500 fails closed', async () => {
  const sink = memorySink();
  const failing: BytesFetch = async () => bytesResponse(500);
  const out = await migrateFileBytes({ ...base, download: failing, sink, checkpoint: emptyFileCheckpoint(), dryRun: false });
  assert.match(out.tables[0].error ?? '', /creator download failed: 500/);
  assert.equal(sink.puts.length, 0);
  const foreign = await migrateFileBytes({ ...base, creatorBase: 'https://evil.example', sink, checkpoint: emptyFileCheckpoint(), dryRun: false });
  assert.equal(foreign.ok, false);
  assert.equal(creatorDownloadUrl('https://www.zohoapis.in/', 'o', 'a', 'R', '1', 'F', 'plain.txt'), 'https://www.zohoapis.in/creator/v2.1/data/o/a/report/R/1/F/download');
});

test('a value over the size cap fails closed instead of buffering it', async () => {
  const sink = memorySink();
  const out = await migrateFileBytes({ ...base, sink, checkpoint: emptyFileCheckpoint(), dryRun: false, maxBytes: 4 });
  assert.match(out.tables[0].error ?? '', /over 4 bytes/);
  assert.equal(sink.puts.length, 0);
});

test('the Stratus REST sink PUTs without overwrite and treats 409 as an existing object', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  let status = 200;
  const fetch: BytesFetch = async (url, init) => {
    seen.push({ url, headers: init?.headers ?? {} });
    return bytesResponse(status);
  };
  const sink = stratusRestSink({ bucket: 'c2c-demo', dc: 'in', environment: 'development', token: 't0k', fetch });
  assert.equal(await sink.put('migrated/Order/Photo/1/a b.png', new Uint8Array([1, 2]), 'image/png'), 'created');
  assert.equal(seen[0].url, 'https://c2c-demo-development.zohostratus.in/migrated/Order/Photo/1/a%20b.png');
  assert.deepEqual(seen[0].headers, { Authorization: 'Zoho-oauthtoken t0k', 'Content-Type': 'image/png', 'Content-Length': '2' });
  status = 409;
  assert.equal(await sink.put('k', new Uint8Array(), 'image/png'), 'exists');
  status = 403;
  await assert.rejects(sink.put('k', new Uint8Array(), 'image/png'), /stratus upload failed: 403/);
  assert.equal(stratusObjectUrl('c2c-demo', 'com', 'production', 'a/b'), 'https://c2c-demo.zohostratus.com/a/b');
  assert.throws(() => stratusObjectUrl('Bad_Bucket', 'in', 'production', 'a'), /bucket name/);
  assert.throws(() => stratusObjectUrl('c2c-demo', 'xx', 'production', 'a'), /no Stratus host/);
});

test('an object Stratus already holds counts as existing, not uploaded, and is not overwritten', async () => {
  const sink = memorySink();
  sink.objects.set('migrated/Order/Photo/101/a.png', { bytes: 'earlier-copy', type: 'image/png' });
  const checkpoint = emptyFileCheckpoint();
  const result = await migrateFileBytes({ ...base, sink, checkpoint, dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(result.tables[0].uploaded, 1);
  assert.equal(result.tables[0].existing, 1);
  assert.equal(checkpoint.tables.Order.uploaded, 1);
  assert.equal(checkpoint.tables.Order.existing, 1);
  assert.deepEqual(sink.objects.get('migrated/Order/Photo/101/a.png'), { bytes: 'earlier-copy', type: 'image/png' });
});
