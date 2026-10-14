/**
 * The REST side of a bulk load (data/src/bulk-load.ts) against the Data Store API.
 *
 *   POST {base}/baas/v1/project/{project}/bulk/write          create a write job
 *   GET  {base}/baas/v1/project/{project}/bulk/write/{job_id} job status
 *   POST {base}/baas/v1/project/{project}/query               source id → ROWID (ZCQL IN, ≤300 ids)
 *   PUT  {base}/baas/v1/project/{project}/table/{table}/row    row update (≤200 rows)
 *
 * The job reply wraps the job in `data` ({ status: "success", data: { job_id,
 * status: "In-Progress" | "Completed" | "Failed", results } }). Bulk write needs
 * admin scope and reads its CSV from a Stratus bucket, so the object upload is
 * injected by the caller (`putObject`); this module never handles a bucket
 * credential. Every URL goes through the data-centre host check.
 */
import {
  assertAllowedHost,
  catalystAuthHeaders,
  catalystWriteUrl,
  catalystErrorDetail,
  type CatalystScope,
  type FetchLike,
} from '../../data/src/migrate.js';
import type { BulkJobStatus, BulkStore, BulkWriteJobRequest } from '../../data/src/bulk-load.js';
import { exactId, parseJsonExact } from './json-exact.js';
import { loadRowIds } from './remap.js';

export function bulkWriteUrl(base: string, scope: CatalystScope, jobId?: string): string {
  const root = `${base.replace(/\/$/, '')}/baas/v1/project/${encodeURIComponent(scope.projectId)}/bulk/write`;
  return jobId === undefined ? root : `${root}/${encodeURIComponent(jobId)}`;
}

function jobOf(body: unknown): Record<string, unknown> {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  if (!data || typeof data !== 'object') throw new Error('bulk write reply has no data');
  return data as Record<string, unknown>;
}

/** Status of a bulk write job reply. records_processed is summed over the result details. */
export function bulkJobStatus(body: unknown): BulkJobStatus {
  const job = jobOf(body);
  const results = (job.results && typeof job.results === 'object' ? job.results : {}) as { description?: unknown; details?: unknown };
  if (job.status === 'Completed') {
    const details = Array.isArray(results.details) ? results.details : [];
    const processed = details.reduce((n: number, item: unknown) => n + Number((item as { records_processed?: unknown })?.records_processed ?? 0), 0);
    return { status: 'Completed', processed };
  }
  if (job.status === 'Failed') return { status: 'Failed', description: typeof results.description === 'string' ? results.description : 'bulk write job failed' };
  if (job.status === 'In-Progress') return { status: 'In-Progress' };
  throw new Error(`bulk write job status is not known: ${String(job.status)}`);
}

export function restBulkStore(opts: {
  fetch: FetchLike;
  base: string;
  dc: string;
  scope: CatalystScope;
  putObject: BulkStore['putObject'];
}): BulkStore {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...catalystAuthHeaders(opts.scope) };
  const call = async (url: string, method: string, body?: unknown): Promise<unknown> => {
    assertAllowedHost(url, opts.dc);
    const response = await opts.fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    if (response.status >= 400) throw new Error(`${method} ${new URL(url).pathname} failed: ${response.status}${catalystErrorDetail(text)}`);
    return parseJsonExact(text);
  };
  return {
    putObject: opts.putObject,
    async createWriteJob(request: BulkWriteJobRequest) {
      const job = jobOf(await call(bulkWriteUrl(opts.base, opts.scope), 'POST', request));
      return { jobId: exactId(job.job_id as string | number, 'job_id') };
    },
    async writeJobStatus(jobId: string) {
      return bulkJobStatus(await call(bulkWriteUrl(opts.base, opts.scope, jobId), 'GET'));
    },
    async rowIdsBySourceId(table: string, ids: readonly string[]) {
      return loadRowIds(opts.fetch, opts.base, opts.dc, table, ids, opts.scope);
    },
    async updateRows(table: string, rows: readonly Record<string, string>[]) {
      const body = await call(catalystWriteUrl(opts.base, table, opts.scope), 'PUT', rows);
      const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
      const list = Array.isArray(data) ? data : [];
      return list
        .map((row: unknown) => (row as { ROWID?: unknown })?.ROWID)
        .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
        .map((id) => exactId(id, 'ROWID'));
    },
  };
}
