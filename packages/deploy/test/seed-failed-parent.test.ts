import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCheckpoint, type FetchLike, type MigrateResponse } from '../../data/src/migrate.js';
import { migrateSeed } from '../src/seed.js';

const SCOPE = { org: '10000000000', projectId: '1001', token: 'test-cli-token' };

function response(body: unknown, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

const SOURCE: Record<string, Array<Record<string, string>>> = {
  Parent: [{ ID: 'p1', Name: 'P' }],
  Child: [{ ID: 'c1', Title: 'C', Author: 'p1' }],
  Grandchild: [{ ID: 'g1', Note: 'G', Owner: 'c1' }],
  Third: [{ ID: 't1', Name: 'T' }],
};

function storeRefusing(refused: string) {
  const stored = new Map<string, Map<string, { rowid: string; columns: Record<string, string> }>>();
  const writes: string[] = [];
  let seq = 1;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    if (method === 'GET') {
      return response({ data: SOURCE[decodeURIComponent(path.split('/').pop() ?? '')] ?? [] });
    }
    if (path.endsWith('/query')) {
      const sql = String(JSON.parse(String(init?.body ?? '{}')).query);
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
      const rows = stored.get(table) ?? new Map();
      return response({
        data: [...rows].map(([source, row]) => ({ ...row.columns, c2c_source_id: source, ROWID: row.rowid })),
      });
    }
    const table = decodeURIComponent(path.split('/').at(-2) ?? '');
    writes.push(table);
    if (table === refused) {
      return response(
        { status: 'failure', data: { error_code: 'INVALID_INPUT', message: 'Invalid input value for When. date value expected' } },
        400,
      );
    }
    const parsed = JSON.parse(String(init?.body ?? '[]')) as unknown;
    const records = (Array.isArray(parsed) ? parsed : ((parsed as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, unknown>>;
    const bucket = stored.get(table) ?? new Map();
    const acked: Array<{ c2c_source_id: string }> = [];
    for (const record of records) {
      const columns: Record<string, string> = {};
      for (const [key, value] of Object.entries((record.columns ?? record) as Record<string, unknown>)) {
        if (typeof value === 'string') columns[key] = value;
      }
      const source = columns.c2c_source_id ?? String(record.id ?? '');
      bucket.set(source, { rowid: `rowid-${table}-${seq++}`, columns });
      acked.push({ c2c_source_id: source });
    }
    stored.set(table, bucket);
    return response({ data: acked });
  };
  return { fetch, stored, writes };
}

test('a refused parent skips its lookup children and the run still loads independent tables and reports every table', async () => {
  const store = storeRefusing('Parent');
  const result = await migrateSeed({
    tables: [
      { table: 'Parent', rows: [{ id: 'p1', columns: { Name: 'P' } }] },
      { table: 'Child', rows: [{ id: 'c1', columns: { Title: 'C', Author: 'p1' } }] },
      { table: 'Grandchild', rows: [{ id: 'g1', columns: { Note: 'G', Owner: 'c1' } }] },
      { table: 'Third', rows: [{ id: 't1', columns: { Name: 'T' } }] },
    ],
    foreignKeys: [
      { table: 'Child', column: 'Author', parent: 'Parent' },
      { table: 'Grandchild', column: 'Owner', parent: 'Child' },
    ],
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, false);
  const byTable = new Map(result.tables.map((table) => [table.table, table]));
  assert.deepEqual([...byTable.keys()].sort(), ['Child', 'Grandchild', 'Parent', 'Third']);
  assert.equal(byTable.get('Parent')?.mismatch, true);
  assert.equal(byTable.get('Child')?.mismatch, true);
  assert.equal(byTable.get('Child')?.writtenCount, 0);
  assert.match(byTable.get('Child')?.error ?? '', /parent Parent not loaded/);
  assert.match(byTable.get('Grandchild')?.error ?? '', /parent Child not loaded/);
  assert.equal(byTable.get('Third')?.mismatch, false);
  assert.equal(store.stored.get('Third')?.size, 1, 'the independent table loads');
  assert.ok(!store.writes.includes('Child'), 'a child of a refused parent is never written');
  assert.ok(!store.writes.includes('Grandchild'), 'a grandchild of a refused parent is never written');
});

test('a loaded parent still resolves its children (no false skip)', async () => {
  const store = storeRefusing('Third');
  const result = await migrateSeed({
    tables: [
      { table: 'Parent', rows: [{ id: 'p1', columns: { Name: 'P' } }] },
      { table: 'Child', rows: [{ id: 'c1', columns: { Title: 'C', Author: 'p1' } }] },
      { table: 'Third', rows: [{ id: 't1', columns: { Name: 'T' } }] },
    ],
    foreignKeys: [{ table: 'Child', column: 'Author', parent: 'Parent' }],
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, false);
  const child = result.tables.find((table) => table.table === 'Child');
  assert.equal(child?.mismatch, false);
  assert.equal(store.stored.get('Child')?.get('c1')?.columns.Author, 'rowid-Parent-1');
});
