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
import { readBucketList, type RestFn } from './tables.js';

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
