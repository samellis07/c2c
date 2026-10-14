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
import type { RestFn } from './tables.js';

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
 * GET the bucket, then POST the create only on 404. A bucket that already
 * exists takes no write, so a re-run is safe. A 403 on the read means the
 * project answered but the caller cannot see the bucket — that is a failure,
 * not a create.
 */
export async function ensureSeedBucket(rest: RestFn, projectId: string, bucket: string): Promise<SeedBucketEnsure> {
  const read = await rest({ method: 'GET', path: `/baas/v1/project/${projectId}/bucket/${encodeURIComponent(bucket)}` });
  if (read.status >= 200 && read.status < 300) return { outcome: 'exists' };
  if ((read.status === 400 || read.status === 405) && SERVICE_CLOSED.test(detailOf(read.body))) {
    return { outcome: 'console-step', httpStatus: read.status, detail: detailOf(read.body) };
  }
  if (read.status !== 404) return { outcome: 'failed', httpStatus: read.status, detail: detailOf(read.body) };
  const created = await rest({ method: 'POST', path: `/baas/v1/project/${projectId}/bucket`, body: bucketCreateBody(bucket) });
  if (created.status >= 200 && created.status < 300) return { outcome: 'created' };
  if ((created.status === 400 || created.status === 405) && SERVICE_CLOSED.test(detailOf(created.body))) {
    return { outcome: 'console-step', httpStatus: created.status, detail: detailOf(created.body) };
  }
  return { outcome: 'failed', httpStatus: created.status, detail: detailOf(created.body) };
}
