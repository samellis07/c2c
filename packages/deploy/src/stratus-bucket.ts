/**
 * The Stratus bucket a seed load's file columns write to.
 *
 * A confirmed load verifies the bucket before the first row write: read the
 * bucket, create it only when it is absent, and stop with a guided console
 * step when the project has never opened Stratus — never a bare 404 halfway
 * through a load.
 *
 * Documented shapes (Cloud Scale > Stratus):
 * - Get Specific Bucket: GET /baas/v1/project/<id>/bucket/<bucket_name>,
 *   scope ZohoCatalyst.buckets.READ, 200 with the bucket row, 404 when absent.
 *   https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/stratus/get-bucket/
 * - Get All Buckets: GET /baas/v1/project/<id>/bucket, same scope.
 *   https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/stratus/get-all-buckets/
 * - Create: the public reference lists no create page (console Create Bucket or
 *   the IaC import's Stratus item are the documented paths). The POST body
 *   below is the console create shape, the same shape the Catalyst
 *   Create_Bucket connector schema declares.
 *   https://docs.catalyst.zoho.com/en/cloud-scale/help/stratus/buckets/create-bucket/
 */
import { listBucketNames, readBucketList, type RestFn } from './tables.js';

export type SeedBucketEnsure =
  | { outcome: 'exists' }
  | { outcome: 'created' }
  /** The project must open Stratus (or create the bucket) in the console first. */
  | { outcome: 'console-step'; httpStatus: number; detail: string }
  | { outcome: 'failed'; httpStatus: number; detail: string };

/** The console create body: Authenticated (protected) policy, every option off. */
export function bucketCreateBody(name: string): Record<string, unknown> {
  return {
    bucket_name: name,
    bucket_meta: { type: 'protected', versioning: false, caching: { status: false }, encryption: false, audit_consent: false },
  };
}

/** First-use activation answers like Slate's "access the service in the console" 400 and the first-session refusal. */
const SERVICE_CLOSED = /access the Stratus service|in session when accessing Stratus/i;

function detailOf(body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Read the bucket through the paginated list route. Create only after every
 * page proves the exact bucket name is absent; any list error is unverifiable.
 */
export async function ensureSeedBucket(rest: RestFn, projectId: string, bucket: string): Promise<SeedBucketEnsure> {
  const read = await readBucketList(rest, projectId, bucket);
  if (read.status === 'found') return { outcome: 'exists' };
  if (read.status === 'unverifiable') {
    if (read.httpStatus !== undefined && (read.httpStatus === 400 || read.httpStatus === 405) && SERVICE_CLOSED.test(read.detail)) {
      return { outcome: 'console-step', httpStatus: read.httpStatus, detail: read.detail };
    }
    return { outcome: 'failed', httpStatus: read.httpStatus ?? 0, detail: read.detail };
  }
  const created = await rest({ method: 'POST', path: `/baas/v1/project/${projectId}/bucket`, body: bucketCreateBody(bucket) });
  if (created.status >= 200 && created.status < 300) return { outcome: 'created' };
  if ((created.status === 400 || created.status === 405) && SERVICE_CLOSED.test(detailOf(created.body))) {
    return { outcome: 'console-step', httpStatus: created.status, detail: detailOf(created.body) };
  }
  return { outcome: 'failed', httpStatus: created.status, detail: detailOf(created.body) };
}

export type AppBucketResolve = { outcome: 'resolved'; name: string } | { outcome: 'refused'; message: string };

/**
 * The bucket this app actually has in this project. The import may create
 * the planned bucket under another name (the planned name is taken by an
 * older project of the same app), so the project's bucket list is the truth:
 * exactly one bucket named `<planned prefix><hex>`, never the doctor's
 * c2cprobe bucket and never a bucket of another project.
 */
export async function resolveAppBucket(rest: RestFn, projectId: string, planned: string): Promise<AppBucketResolve> {
  const listed = await listBucketNames(rest, projectId);
  if (listed.status === 'unverifiable') {
    return { outcome: 'refused', message: `refusing: the Stratus bucket list of project ${projectId} could not be read (${listed.detail}); open Stratus on the project, then re-run` };
  }
  const suffix = /-([0-9a-f]+)$/.exec(planned)?.[1] ?? '';
  const prefix = planned.slice(0, planned.length - suffix.length);
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The seed and plan namers differ in hash length (8 and 10), so any 8+ hex tail.
  const shape = new RegExp(`^${escaped}${suffix ? '[0-9a-f]{8,}' : ''}$`);
  const matches = listed.names.filter((name) => !name.startsWith('c2cprobe') && shape.test(name));
  if (matches.length === 1) return { outcome: 'resolved', name: matches[0] };
  return {
    outcome: 'refused',
    message: `refusing: no unique Stratus bucket for this app in project ${projectId} (found: ${matches.length ? matches.join(', ') : 'none'}); keep exactly one ${prefix}* bucket in this project (Catalyst console → Stratus), or run c2c provision step bucket, then re-run`,
  };
}
