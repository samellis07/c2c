import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MigrateResponse } from '../../data/src/migrate.js';
import { bulkJobStatus, bulkWriteUrl, restBulkStore } from '../src/bulk-store.js';

const scope = { org: '<org-id>', projectId: '<project-id>', token: 'test-token' };
const BASE = 'https://api.catalyst.zoho.in';

function reply(body: unknown, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

const job = (status: string, results?: unknown) => ({
  status: 'success',
  data: { job_id: 2000000000001, status, operation: 'insert', ...(results ? { results } : {}) },
});

test('bulk write job replies map to In-Progress, Completed (records processed) and Failed (description)', () => {
  assert.deepEqual(bulkJobStatus(job('In-Progress')), { status: 'In-Progress' });
  assert.deepEqual(
    bulkJobStatus(job('Completed', { description: 'Bulk WRITE job completed. ', details: [{ table_id: 1, records_processed: 176 }] })),
    { status: 'Completed', processed: 176 },
  );
  assert.deepEqual(
    bulkJobStatus(job('Failed', { description: "The reference_column 'DeptID' in fk_mapping of table 3376 is not a unique column", details: [] })),
    { status: 'Failed', description: "The reference_column 'DeptID' in fk_mapping of table 3376 is not a unique column" },
  );
  assert.throws(() => bulkJobStatus(job('Queued')), /not known/);
});

test('the REST store posts the documented create body and reads the job by id', async () => {
  const seen: { url: string; method?: string; body?: string }[] = [];
  const store = restBulkStore({
    base: BASE,
    dc: 'in',
    scope,
    putObject: async () => {},
    fetch: async (url, init) => {
      seen.push({ url, method: init?.method, body: init?.body });
      if (init?.method === 'POST' && url.endsWith('/bulk/write')) return reply(job('In-Progress'));
      if (init?.method === 'GET') return reply(job('Completed', { details: [{ records_processed: 3 }] }));
      if (url.endsWith('/query')) return reply({ status: 'success', data: [{ Orders: { ROWID: '4000000000000001', c2c_source_id: 'O1' } }] });
      return reply({ status: 'success', data: [{ ROWID: '4000000000000001' }] });
    },
  });
  const request = {
    table_identifier: 'Orders',
    operation: 'insert' as const,
    object_details: { bucket_name: 'c2c-load', object_key: 'run/Orders/chunk-00000.csv' },
    fk_mapping: [{ local_column: 'Customer', reference_column: 'Code' }],
  };
  assert.deepEqual(await store.createWriteJob(request), { jobId: '2000000000001' });
  assert.equal(seen[0]!.url, `${BASE}/baas/v1/project/%3Cproject-id%3E/bulk/write`);
  assert.deepEqual(JSON.parse(seen[0]!.body!), request);
  assert.deepEqual(await store.writeJobStatus('2000000000001'), { status: 'Completed', processed: 3 });
  assert.equal(seen[1]!.url, bulkWriteUrl(BASE, scope, '2000000000001'));
  assert.deepEqual([...(await store.rowIdsBySourceId('Orders', ['O1']))], [['O1', '4000000000000001']]);
  assert.match(JSON.parse(seen[2]!.body!).query, /WHERE c2c_source_id IN \('O1'\)/);
  assert.deepEqual(await store.updateRows('Orders', [{ ROWID: '4000000000000001', Previous: '4000000000000002' }, { ROWID: '4000000000000009' }]), ['4000000000000001']);
});

test('a refused create names the store code; a host outside the data centre is refused', async () => {
  const store = restBulkStore({
    base: BASE,
    dc: 'in',
    scope,
    putObject: async () => {},
    fetch: async () => reply({ status: 'failure', data: { message: 'You have reached the max limit of your current API Limit for table', error_code: 'API_LIMIT_REACHED' } }, 403),
  });
  await assert.rejects(
    store.createWriteJob({ table_identifier: 'T', operation: 'insert', object_details: { bucket_name: 'b', object_key: 'k' } }),
    /403 API_LIMIT_REACHED/,
  );
  const wrong = restBulkStore({ base: 'https://api.catalyst.zoho.com', dc: 'in', scope, putObject: async () => {}, fetch: async () => reply({}) });
  await assert.rejects(wrong.writeJobStatus('1'), /not on the allow-list/);
});
