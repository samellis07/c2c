import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HostNotAllowedError,
  SOURCE_ID_MAX_LENGTH,
  TABLE_LOCK_TTL_MS,
  TableLockedError,
  assertAllowedHost,
  catalystErrorDetail,
  ZCQL_IN_LIMIT,
  emptyCheckpoint,
  migrateData as migrateDataReal,
  zcqlSourceIdQueries,
  type Checkpoint,
  type FetchLike,
  type MigrateResponse,
  type TableCheckpoint,
} from '../src/index.js';
import { catalystFailure, quirkRowServer, rowEndpoint } from './catalyst-row-fake.js';

/** These fakes model writes as { rows } → { ids }; rowEndpoint checks the real /row shape around them. */
const migrateData: typeof migrateDataReal = (opts) => migrateDataReal({ ...opts, fetch: rowEndpoint(opts.fetch) });

const SECRET = 'super-secret-token';

function response(body: unknown, headers: Record<string, string> = {}, status = 200): MigrateResponse {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    text: async () => JSON.stringify(body),
  };
}

function rows(count: number, start = 0): { ID: string; Name: string }[] {
  return Array.from({ length: count }, (_, index) => ({ ID: `r${start + index}`, Name: SECRET }));
}

/** Live writes now reconcile first. These fakes only model row POSTs. */
function skipReconcileQuery(inner: FetchLike): FetchLike {
  return async (url, init) => {
    if (new URL(url).pathname.endsWith('/baas/v1/query')) return response({ rows: [] });
    return inner(url, init);
  };
}

const bases = {
  dc: 'in',
  creatorBase: 'https://www.zohoapis.in',
  catalystBase: 'https://api.catalyst.zoho.in',
  owner: 'owner',
  appLink: 'demo',
  tables: [{ report: 'Book_Report', table: 'Book' }],
};

test('batches writes at 200', async () => {
  const posts: number[] = [];
  const fetch: FetchLike = async (url, init) => {
    assert.equal(new URL(url).protocol, 'https:');
    if ((init?.method ?? 'GET') === 'GET') return response({ data: rows(450) });
    const body = JSON.parse(init?.body ?? '{}') as { rows: unknown[] };
    posts.push(body.rows.length);
    return response({ ids: body.rows.map((row) => (row as { id: string }).id) });
  };
  const checkpoint = emptyCheckpoint();
  const result = await migrateData({ ...bases, dryRun: false, fetch: skipReconcileQuery(fetch), checkpoint, saveCheckpoint: () => undefined });
  assert.deepEqual(posts, [200, 200, 50]);
  assert.deepEqual(result.tables[0].batches, [200, 200, 50]);
  assert.equal(result.ok, true);
  assert.equal(result.tables[0].sourceCount, 450);
  assert.equal(result.tables[0].writtenCount, 450);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(checkpoint).includes(SECRET), false);
  assert.equal(checkpoint.tables.Book.count, 450);
  assert.equal(checkpoint.tables.Book.done, true);
});

test('a batch size above 200 is clamped', async () => {
  const posts: number[] = [];
  const fetch: FetchLike = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return response({ data: rows(250) });
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string }[] };
    posts.push(body.rows.length);
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const result = await migrateData({ ...bases, dryRun: false, fetch: skipReconcileQuery(fetch), checkpoint: emptyCheckpoint(), batchSize: 1000 });
  assert.deepEqual(posts, [200, 50]);
  assert.equal(result.ok, true);
});

test('resume continues after a mid-run write failure without repeating ids', async () => {
  let attempts = 0;
  const written: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return response({ data: rows(450) });
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string }[] };
    attempts += 1;
    if (attempts === 2) throw new Error('mid-run');
    written.push(...body.rows.map((row) => row.id));
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const checkpoint = emptyCheckpoint();
  await assert.rejects(
    () => migrateData({ ...bases, dryRun: false, fetch: skipReconcileQuery(fetch), checkpoint }),
    /mid-run/,
  );
  assert.equal(checkpoint.tables.Book.count, 200);
  assert.equal(checkpoint.tables.Book.lastId, 'r199');
  assert.equal(JSON.stringify(checkpoint).includes(SECRET), false);
  const second = await migrateData({ ...bases, dryRun: false, fetch: skipReconcileQuery(fetch), checkpoint });
  assert.equal(second.ok, true);
  assert.equal(second.tables[0].writtenCount, 450);
  assert.equal(new Set(written).size, 450);
  assert.deepEqual(written.slice(0, 3), ['r0', 'r1', 'r2']);
  assert.equal(written.includes('r199'), true);
  assert.equal(written.filter((id) => id === 'r0').length, 1);
});

test('resume after a mid-run failure fails verification when a destination id was corrupted', async () => {
  let posts = 0;
  const fetch: FetchLike = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return response({ data: rows(450) });
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string }[] };
    posts += 1;
    if (posts === 1) {
      const ids = body.rows.map((row) => row.id);
      ids[0] = 'corrupt';
      return response({ ids });
    }
    if (posts === 2) throw new Error('mid-run');
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const checkpoint = emptyCheckpoint();
  await assert.rejects(
    () => migrateData({ ...bases, dryRun: false, fetch: skipReconcileQuery(fetch), checkpoint }),
    /mid-run/,
  );
  const second = await migrateData({ ...bases, dryRun: false, fetch: skipReconcileQuery(fetch), checkpoint });
  assert.equal(second.ok, false);
  assert.equal(second.tables[0].mismatch, true);
  assert.notEqual(second.tables[0].sourceChecksum, second.tables[0].writtenChecksum);
  assert.equal(JSON.stringify(second).includes(SECRET), false);
  assert.equal(JSON.stringify(checkpoint).includes(SECRET), false);
});

test('a partial acknowledgement of 150 of 200 does not skip the rest', async () => {
  const confirmed = new Set<string>();
  const fetch: FetchLike = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return response({ data: rows(200) });
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string }[] };
    const ids = body.rows.slice(0, 150).map((row) => row.id);
    for (const id of ids) confirmed.add(id);
    return response({ ids });
  };
  const checkpoint = emptyCheckpoint();
  const result = await migrateData({ ...bases, dryRun: false, fetch: skipReconcileQuery(fetch), checkpoint });
  assert.equal(result.ok, true);
  assert.equal(result.tables[0].sourceCount, 200);
  assert.equal(result.tables[0].writtenCount, 200);
  assert.equal(confirmed.size, 200);
  assert.equal(checkpoint.tables.Book.done, true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('rows that stay unacknowledged are listed and are not marked done', async () => {
  const fetch: FetchLike = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return response({ data: rows(200) });
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string }[] };
    const ids = body.rows.map((row) => row.id).filter((id) => Number(id.slice(1)) < 150);
    return response({ ids });
  };
  const checkpoint = emptyCheckpoint();
  const result = await migrateData({ ...bases, dryRun: false, fetch: skipReconcileQuery(fetch), checkpoint });
  const missing = result.tables[0].missingIds ?? [];
  assert.equal(result.ok, false);
  assert.equal(result.tables[0].mismatch, true);
  assert.equal(missing.includes('r150'), true);
  assert.equal(missing.includes('r199'), true);
  assert.equal(checkpoint.tables.Book.done, false);
  assert.equal(checkpoint.tables.Book.lastId, 'r149');
  assert.equal(checkpoint.tables.Book.count, 150);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(checkpoint).includes(SECRET), false);
});

test('verify reports a checksum mismatch and does not log field values', async () => {
  const fetch: FetchLike = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return response({ data: rows(3) });
    return response({ ids: ['not-the-source-id'] });
  };
  const checkpoint = emptyCheckpoint();
  const result = await migrateData({ ...bases, dryRun: false, fetch: skipReconcileQuery(fetch), checkpoint });
  assert.equal(result.ok, false);
  assert.equal(result.tables[0].mismatch, true);
  assert.notEqual(result.tables[0].sourceChecksum, result.tables[0].writtenChecksum);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(checkpoint).includes(SECRET), false);
});

test('a non-allow-listed host is refused before fetch', async () => {
  let called = false;
  const fetch: FetchLike = async () => {
    called = true;
    throw new Error('fetch should not run');
  };
  await assert.rejects(
    () => migrateData({ ...bases, creatorBase: 'https://evil.example.test', dryRun: true, fetch, checkpoint: emptyCheckpoint() }),
    (err: unknown) => err instanceof HostNotAllowedError && err.host === 'evil.example.test',
  );
  await assert.rejects(
    () => migrateData({ ...bases, creatorBase: 'https://www.zohoapis.com', dryRun: true, fetch, checkpoint: emptyCheckpoint() }),
    HostNotAllowedError,
  );
  await assert.rejects(
    () => migrateData({ ...bases, catalystBase: 'http://api.catalyst.zoho.in', dryRun: true, fetch, checkpoint: emptyCheckpoint() }),
    HostNotAllowedError,
  );
  assert.equal(called, false);
});

test('a successful POST then a checkpoint failure does not duplicate rows on restart', async () => {
  const inserted: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return response({ data: rows(4) });
    if (new URL(url).pathname.endsWith('/baas/v1/query')) {
      const query = (JSON.parse(init?.body ?? '{}') as { query?: string }).query ?? '';
      const present = [...new Set(inserted)].filter((id) => query.includes(`'${id}'`));
      return response({ rows: present.map((id) => ({ c2c_source_id: id })) });
    }
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns?: Record<string, unknown> }[] };
    for (const row of body.rows) {
      assert.equal(row.columns?.c2c_source_id, row.id);
      inserted.push(row.id);
    }
    return response({ ids: body.rows.map((row) => row.id) });
  };
  let persisted = emptyCheckpoint();
  let armCheckpointFailure = true;
  const saveCheckpoint = (next: Checkpoint) => {
    if (armCheckpointFailure) {
      armCheckpointFailure = false;
      throw new Error('checkpoint failed');
    }
    persisted = JSON.parse(JSON.stringify(next)) as Checkpoint;
  };
  await assert.rejects(
    () => migrateData({ ...bases, dryRun: false, fetch, checkpoint: emptyCheckpoint(), saveCheckpoint, batchSize: 2 }),
    /checkpoint failed/,
  );
  assert.equal(persisted.tables.Book, undefined);
  assert.deepEqual(inserted, ['r0', 'r1']);
  const second = await migrateData({ ...bases, dryRun: false, fetch, checkpoint: persisted, saveCheckpoint, batchSize: 2 });
  assert.equal(second.ok, true);
  assert.equal(second.tables[0].sourceCount, 4);
  assert.equal(second.tables[0].writtenCount, 4);
  assert.equal(second.tables[0].mismatch, false);
  assert.deepEqual(inserted, ['r0', 'r1', 'r2', 'r3']);
  for (const id of ['r0', 'r1', 'r2', 'r3']) assert.equal(inserted.filter((row) => row === id).length, 1);
});

test('ZCQL reconciliation queries hold at most 300 ids and escape quotes', () => {
  const ids = Array.from({ length: ZCQL_IN_LIMIT + 1 }, (_, index) => `r${index}`);
  ids[0] = "o'brien";
  const queries = zcqlSourceIdQueries('Book', ids);
  assert.equal(queries.length, 2);
  assert.match(queries[0], /^SELECT c2c_source_id FROM Book WHERE c2c_source_id IN \('o''brien', 'r1',/);
  assert.match(queries[0], /'r299'\)$/);
  assert.doesNotMatch(queries[0], /'r300'/);
  assert.equal(queries[1], "SELECT c2c_source_id FROM Book WHERE c2c_source_id IN ('r300')");
  assert.throws(() => zcqlSourceIdQueries('Book Name', ['r0']), /not a ZCQL identifier/);
});

test('concurrent runs that both miss on reconcile re-query after a unique violation and do not duplicate or abort', async () => {
  const inserted: string[] = [];
  let reconciles = 0;
  let releaseWrites: () => void = () => undefined;
  const writesOpen = new Promise<void>((resolve) => {
    releaseWrites = resolve;
  });
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return response({ data: rows(2) });
    if (new URL(url).pathname.endsWith('/baas/v1/query')) {
      reconciles += 1;
      if (reconciles === 2) releaseWrites();
      if (reconciles <= 2) return response({ rows: [] });
      const query = (JSON.parse(init?.body ?? '{}') as { query?: string }).query ?? '';
      const present = [...new Set(inserted)].filter((id) => query.includes(`'${id}'`));
      return response({ rows: present.map((id) => ({ c2c_source_id: id })) });
    }
    await writesOpen;
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns?: Record<string, unknown> }[] };
    for (const row of body.rows) assert.equal(row.columns?.c2c_source_id, row.id);
    if (body.rows.some((row) => inserted.includes(row.id))) {
      return response(
        {
          status: 'failure',
          data: {
            error_code: 'DUPLICATE_VALUE',
            message: 'Duplicate value for c2c_source_id. Please give a different value',
          },
        },
        {},
        409,
      );
    }
    for (const row of body.rows) inserted.push(row.id);
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const [left, right] = await Promise.all([
    migrateData({ ...bases, dryRun: false, fetch, checkpoint: emptyCheckpoint(), batchSize: 2 }),
    migrateData({ ...bases, dryRun: false, fetch, checkpoint: emptyCheckpoint(), batchSize: 2 }),
  ]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(left.tables[0].mismatch, false);
  assert.equal(right.tables[0].mismatch, false);
  assert.deepEqual(inserted, ['r0', 'r1']);
  assert.equal(JSON.stringify(left).includes(SECRET), false);
  assert.equal(JSON.stringify(right).includes(SECRET), false);
});

test('a source id longer than 255 fails the table before any query or POST', async () => {
  const tooLong = '9'.repeat(256);
  let queries = 0;
  let posts = 0;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return response({ data: [{ ID: 'r0', Name: SECRET }, { ID: tooLong, Name: SECRET }] });
    if (new URL(url).pathname.endsWith('/baas/v1/query')) {
      queries += 1;
      return response({ rows: [] });
    }
    posts += 1;
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string }[] };
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const checkpoint = emptyCheckpoint();
  const result = await migrateData({ ...bases, dryRun: false, fetch, checkpoint });
  assert.equal(result.ok, false);
  assert.equal(result.tables[0].mismatch, true);
  assert.match(JSON.stringify(result), /source id length 256 exceeds/);
  assert.equal(posts, 0);
  assert.equal(queries, 0);
  assert.notEqual(checkpoint.tables.Book?.done, true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(tooLong), false);
  assert.equal(JSON.stringify(checkpoint).includes(tooLong), false);
});

const FNV_OFFSET_HEX = 'cbf29ce484222325';

function openTable(lock?: TableCheckpoint['lock']): Checkpoint {
  const checkpoint = emptyCheckpoint();
  checkpoint.tables.Book = {
    requestCursor: null,
    count: 0,
    checksum: FNV_OFFSET_HEX,
    sourceCount: 0,
    sourceChecksum: FNV_OFFSET_HEX,
    done: false,
    lock,
  };
  return checkpoint;
}

test('a source id of exactly 255 characters is still written', async () => {
  const id = '9'.repeat(SOURCE_ID_MAX_LENGTH);
  assert.equal(id.length, 255);
  let posted = '';
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return response({ data: [{ ID: id, Name: SECRET }] });
    if (new URL(url).pathname.endsWith('/baas/v1/query')) return response({ rows: [] });
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns?: Record<string, unknown> }[] };
    posted = body.rows[0].id;
    assert.equal(body.rows[0].columns?.c2c_source_id, id);
    return response({ ids: [id] });
  };
  const result = await migrateData({ ...bases, dryRun: false, fetch, checkpoint: emptyCheckpoint() });
  assert.equal(result.ok, true);
  assert.equal(posted, id);
  assert.equal(result.tables[0].error, undefined);
});

test('a live per-table lease stops a second mover from writing', async () => {
  let posts = 0;
  const checkpoint = openTable({ owner: 'owner-a', expiresAt: 5_000 });
  const fetch: FetchLike = async (_url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return response({ data: rows(1) });
    posts += 1;
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string }[] };
    return response({ ids: body.rows.map((row) => row.id) });
  };
  await assert.rejects(
    () => migrateData({ ...bases, dryRun: false, fetch, checkpoint, runId: 'owner-b', now: () => 1_000, lockTtlMs: TABLE_LOCK_TTL_MS }),
    (err: unknown) => err instanceof TableLockedError && err.table === 'Book' && err.owner === 'owner-a' && err.expiresAt === 5_000,
  );
  assert.equal(posts, 0);
  assert.equal(checkpoint.tables.Book.lock?.owner, 'owner-a');
});

test('the holder stamps the lease before its first await, and an expired lease can be taken over', async () => {
  let posts = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const shared = emptyCheckpoint();
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return response({ data: rows(1) });
    if (new URL(url).pathname.endsWith('/baas/v1/query')) return response({ rows: [] });
    posts += 1;
    await gate;
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string }[] };
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const running = migrateData({ ...bases, dryRun: false, fetch, checkpoint: shared, runId: 'owner-a', now: () => 1_000, lockTtlMs: 60_000 });
  await assert.rejects(
    () => migrateData({ ...bases, dryRun: false, fetch, checkpoint: shared, runId: 'owner-b', now: () => 1_000, lockTtlMs: 60_000 }),
    (err: unknown) => err instanceof TableLockedError && err.owner === 'owner-a',
  );
  assert.equal(shared.tables.Book.lock?.owner, 'owner-a');
  release();
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(posts, 1);
  assert.equal(shared.tables.Book.done, true);
  assert.equal(shared.tables.Book.lock, undefined);

  const expired = openTable({ owner: 'stale', expiresAt: 1_000 });
  const again = await migrateData({
    ...bases,
    dryRun: false,
    fetch: async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return response({ data: rows(1) });
      if (new URL(url).pathname.endsWith('/baas/v1/query')) return response({ rows: [] });
      const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string }[] };
      return response({ ids: body.rows.map((row) => row.id) });
    },
    checkpoint: expired,
    runId: 'owner-b',
    now: () => 1_000,
  });
  assert.equal(again.ok, true);
  assert.equal(expired.tables.Book.lock, undefined);
  assert.equal(expired.tables.Book.done, true);
});

test('a unique violation that is not c2c_source_id fails closed', async () => {
  let posts = 0;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return response({ data: rows(1) });
    if (new URL(url).pathname.endsWith('/baas/v1/query')) return response({ rows: [] });
    posts += 1;
    return response(
      { status: 'failure', data: { error_code: 'DUPLICATE_VALUE', message: 'Duplicate value for name. Please give a different value' } },
      {},
      409,
    );
  };
  const checkpoint = emptyCheckpoint();
  await assert.rejects(
    () => migrateData({ ...bases, dryRun: false, fetch, checkpoint }),
    /catalyst unique violation: 409/,
  );
  assert.equal(posts, 1);
  assert.equal(checkpoint.tables.Book.lock, undefined);
  assert.notEqual(checkpoint.tables.Book.done, true);
});

test('a non-unique write error still aborts', async () => {
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return response({ data: rows(1) });
    if (new URL(url).pathname.endsWith('/baas/v1/query')) return response({ rows: [] });
    return response(
      { status: 'failure', data: { error_code: 'MANDATORY_MISSING', message: 'Column name is mandatory and cannot be empty' } },
      {},
      403,
    );
  };
  await assert.rejects(
    () => migrateData({ ...bases, dryRun: false, fetch, checkpoint: emptyCheckpoint() }),
    /catalyst write failed: 403/,
  );
});

test('dry-run does not POST, and the next page sends the cursor', async () => {
  const methods: string[] = [];
  const cursors: (string | undefined)[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const method = init?.method ?? 'GET';
    methods.push(method);
    if (method === 'GET') {
      cursors.push(init?.headers?.record_cursor);
      if (!init?.headers?.record_cursor) return response({ data: rows(1) }, { record_cursor: 'cursor-2' });
      return response({ data: rows(1, 1) });
    }
    return response({ ids: [] });
  };
  const result = await migrateData({ ...bases, dryRun: true, fetch, checkpoint: emptyCheckpoint() });
  assert.deepEqual(methods, ['GET', 'GET']);
  assert.deepEqual(cursors, [undefined, 'cursor-2']);
  assert.equal(result.ok, true);
  assert.equal(result.tables[0].writtenCount, 2);
  assert.equal(result.dryRun, true);
});

test('copies Creator system columns from the export and records a gap instead of stamping', async () => {
  const posts: { id: string; columns: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return response({
        data: [
          {
            ID: '10000000008009043',
            Name: 'kept',
            Added_User: 'ada',
            CREATEDTIME: '13-Apr-2023 17:21:24',
            Modified_User: 'ada',
            Modified_Time: '13-Apr-2023 17:21:24',
            test_ss: { ID: '9', Added_User: 'nested', Added_Time: '01-Jan-2000 00:00:00' },
          },
          { ID: '2', Name: 'bare' },
        ],
      });
    }
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, unknown> }[] };
    posts.push(...body.rows);
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const result = await migrateData({ ...bases, dryRun: false, fetch: skipReconcileQuery(fetch), checkpoint: emptyCheckpoint() });
  assert.equal(result.ok, true);
  const first = posts.find((row) => row.id === '10000000008009043');
  assert.equal(first?.columns.Added_User, 'ada');
  assert.equal(first?.columns.Added_Time, '13-Apr-2023 17:21:24');
  assert.equal(first?.columns.Modified_User, 'ada');
  assert.equal(first?.columns.Modified_Time, '13-Apr-2023 17:21:24');
  assert.equal(first?.columns.c2c_source_id, '10000000008009043');
  assert.equal(Object.hasOwn(first?.columns ?? {}, 'CREATEDTIME'), false);
  const nested = first?.columns.test_ss as { Added_User?: string };
  assert.equal(nested.Added_User, 'nested');
  const bare = posts.find((row) => row.id === '2');
  assert.equal(Object.hasOwn(bare?.columns ?? {}, 'Added_User'), false);
  assert.deepEqual(result.systemFieldGaps?.[0]?.missing, ['Added_User', 'Added_Time', 'Modified_User', 'Modified_Time']);
  assert.match(result.systemFieldGaps?.[0]?.detail ?? '', /get-records\.html/);
  assert.equal(JSON.stringify(result).includes('ada'), false);
});

test('a table with shadows writes the Double shadow of each exact-decimal column', async () => {
  const posted: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return response({ data: [{ ID: 'a', Price: '20.00' }, { ID: 'b', Price: '' }, { ID: 'c', Price: '1.50', Price__n: 9 }] });
    }
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, unknown> }[] };
    posted.push(...body.rows.map((row) => row.columns));
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const tables = [{ report: 'Book_Report', table: 'Book', shadows: { Price: 'Price__n' } }];
  const result = await migrateData({ ...bases, tables, dryRun: false, fetch: skipReconcileQuery(fetch), checkpoint: emptyCheckpoint() });
  assert.equal(result.ok, true);
  assert.deepEqual(
    posted.map((columns) => [columns.Price, columns.Price__n]),
    [
      ['20.00', 20],
      ['', null],
      ['1.50', 9],
    ],
  );
});

test('a store failure at the sixth table leaves no duplicates: the rerun stores exactly one copy of each row', async () => {
  const tables = [
    { report: 'T1_Report', table: 'T1' },
    { report: 'T2_Report', table: 'T2' },
    { report: 'T3_Report', table: 'T3' },
    { report: 'T4_Report', table: 'T4' },
    { report: 'T5_Report', table: 'T5' },
    { report: 'Create_BOM_Report', table: 'Create_BOM' },
  ];
  const source: Record<string, { ID: string }[]> = {};
  let serial = 0;
  for (const { report, table } of tables) {
    const count = table === 'Create_BOM' ? 2 : 3;
    source[report] = Array.from({ length: count }, () => ({ ID: String(1000000000100000000n + BigInt(serial++)) }));
  }
  const store = quirkRowServer();
  let failBom = true;
  const postsByTable: Record<string, number> = {};
  const getsByReport: Record<string, number> = {};
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    if (method === 'GET') {
      const report = decodeURIComponent(path.split('/').at(-1) ?? '');
      getsByReport[report] = (getsByReport[report] ?? 0) + 1;
      return response({ data: source[report] ?? [] });
    }
    if (failBom && method === 'POST' && path.includes('/table/Create_BOM/row')) {
      return catalystFailure(403, 'MANDATORY_MISSING', 'Column Created_Date is mandatory');
    }
    if (method === 'POST' && /\/table\/[^/]+\/row$/.test(path)) {
      const table = decodeURIComponent(path.split('/').at(-2) ?? '');
      postsByTable[table] = (postsByTable[table] ?? 0) + 1;
    }
    return store.fetch(url, init);
  };
  const checkpoint = emptyCheckpoint();
  // The store fake speaks the real /row shape, so this run bypasses the
  // legacy { rows }/{ ids } translation the other tests in this file use.
  await assert.rejects(migrateDataReal({ ...bases, tables, dryRun: false, fetch, checkpoint }), /catalyst write failed: 403.*MANDATORY_MISSING/);
  for (const { table } of tables.slice(0, 5)) assert.equal(checkpoint.tables[table]?.done, true);
  assert.notEqual(checkpoint.tables.Create_BOM?.done, true);

  failBom = false;
  // Count run-2 traffic only: a rerun that honours the stored checkpoint must
  // not read or write the five tables the first run already marked done.
  for (const key of Object.keys(getsByReport)) delete getsByReport[key];
  for (const key of Object.keys(postsByTable)) delete postsByTable[key];
  const second = await migrateDataReal({ ...bases, tables, dryRun: false, fetch, checkpoint });
  assert.equal(second.ok, true);
  assert.deepEqual(Object.keys(getsByReport), ['Create_BOM_Report'], 'run 2 reads only the table without a completed checkpoint');
  for (const { table, report } of tables) {
    const result = second.tables.find((entry) => entry.table === table);
    assert.equal(result?.mismatch, false, table);
    assert.equal(result?.sourceCount, source[report]!.length, table);
    assert.equal(result?.writtenCount, source[report]!.length, table);
  }
  assert.equal(postsByTable.Create_BOM, 1, 'run 2 posts the failed table once');
  for (const { table } of tables.slice(0, 5)) assert.equal(postsByTable[table] ?? 0, 0, `${table} gets 0 writes in run 2`);
  for (const { table, report } of tables) {
    for (const row of source[report]!) assert.equal(store.rowsFor(table, row.ID).length, 1, `${table}/${row.ID}`);
  }

  // A fresh checkpoint reconciles the same way: nothing is written twice.
  const third = await migrateDataReal({ ...bases, tables, dryRun: false, fetch, checkpoint: emptyCheckpoint() });
  assert.equal(third.ok, true);
  for (const { table, report } of tables) {
    for (const row of source[report]!) assert.equal(store.rowsFor(table, row.ID).length, 1, `${table}/${row.ID}`);
  }
});

test('assertAllowedHost refuses an unparseable URL, userinfo, an unknown DC and a look-alike suffix', () => {
  assert.doesNotThrow(() => assertAllowedHost('https://api.catalyst.zoho.in/baas/v1/query', 'in'));
  assert.doesNotThrow(() => assertAllowedHost('https://www.zohoapis.in', ' IN '));
  const refused = (url: string, dc: string, host: string) =>
    assert.throws(
      () => assertAllowedHost(url, dc),
      (err: unknown) => err instanceof HostNotAllowedError && err.host === host,
      `${url} for ${dc}`,
    );
  refused('not a url', 'in', 'not a url');
  refused('https://user:pass@api.catalyst.zoho.in', 'in', 'api.catalyst.zoho.in');
  refused('https://api.catalyst.zoho.in', 'mars', 'api.catalyst.zoho.in');
  refused('https://api.catalyst.zoho.in.evil.example.test', 'in', 'api.catalyst.zoho.in.evil.example.test');
  refused('https://evilzoho.in', 'in', 'evilzoho.in');
});

test('catalystErrorDetail reads code and message only from a failure object, and caps the message', () => {
  assert.equal(catalystErrorDetail('<html>gateway</html>'), '');
  assert.equal(catalystErrorDetail('null'), '');
  assert.equal(catalystErrorDetail(JSON.stringify({ data: [{ error_code: 'X' }] })), '');
  assert.equal(catalystErrorDetail(JSON.stringify({ data: { error_code: 7, message: null } })), '');
  assert.equal(catalystErrorDetail(JSON.stringify({ data: { error_code: 'INVALID_TOKEN' } })), ' INVALID_TOKEN');
  assert.equal(
    catalystErrorDetail(JSON.stringify({ data: { error_code: 'E', message: 'm'.repeat(500) } })),
    ` E: ${'m'.repeat(300)}`,
  );
});

test('a failed reconcile query stops the table before any row POST and names status, code and path only', async () => {
  let posts = 0;
  const fetch: FetchLike = async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return response({ data: rows(3) });
    if (new URL(url).pathname.endsWith('/query')) return catalystFailure(500, 'INTERNAL_SERVER_ERROR', 'query broke');
    posts += 1;
    return response({ ids: [] });
  };
  await assert.rejects(
    () => migrateData({ ...bases, dryRun: false, fetch, checkpoint: emptyCheckpoint(), scope: { org: '10000000000', projectId: '10000000000000001', token: SECRET } }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /^catalyst query failed: 500 INTERNAL_SERVER_ERROR: query broke \(POST \/baas\/v1\/project\/10000000000000001\/query, table Book\)$/);
      assert.equal(message.includes(SECRET), false);
      return true;
    },
  );
  assert.equal(posts, 0);
});
