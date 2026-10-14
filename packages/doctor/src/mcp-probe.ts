/**
 * The server-side binding probe for observed MCP evidence. Submitted JSON is
 * caller-controlled, so the nonce never counts when it is only echoed back:
 * the request asks the host to WRITE it into the selected project through the
 * MCP connector — a short-lived Stratus bucket named after the request id —
 * and the doctor then reads it back over the Catalyst REST API with the
 * user's own CLI credential. Only the connector that really is bound to the
 * same org/DC/project can place the bucket where that read finds it.
 *
 * Documented pair (facts ledger):
 *   - `Create_Bucket` is an MCP-only write — the CLI token answers
 *     `POST /bucket` with `401 OAUTH_SCOPE_MISMATCH` (jobs-and-files.md,
 *     surface-decision-table.md).
 *   - `GET /baas/v1/project/<project-id>/bucket/<name>` with the CLI token
 *     returns the bucket row or 404 (stratus-bucket.ts).
 *   - There is no documented token delete: cleanup is
 *     `CatalystbyZoho_Delete_Bucket` by `query_params.bucket_name`
 *     (errors.md), instructed for the session and re-printed while a pending
 *     cleanup record exists.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RestFn } from '../../deploy/src/tables.js';

export const PROBE_PREFIX = 'c2cprobe';
export const PROBE_CREATE_CALL = 'CatalystbyZoho_Create_Bucket';
export const PROBE_DELETE_CALL = 'CatalystbyZoho_Delete_Bucket';

/** The probe name is the request id itself — a name the caller cannot choose. */
export function probeNameOf(request: string): string {
  return `${PROBE_PREFIX}${request}`;
}

export interface ProbeTarget {
  org?: string;
  project?: string;
}

/** The Catalyst-org header is an integer in the connector schema. */
function orgHeader(org: string | undefined): unknown {
  return org !== undefined && /^[0-9]+$/.test(org) ? Number(org) : (org ?? '<org-id>');
}

/** The exact Create_Bucket arguments the request names (a protected, unversioned probe bucket). */
export function probeCreateCall(name: string, target: ProbeTarget): Record<string, unknown> {
  return {
    tool: PROBE_CREATE_CALL,
    path_variables: { projectId: target.project ?? '<project-id>' },
    headers: { 'Catalyst-org': orgHeader(target.org), Environment: 'Development' },
    body: {
      bucket_name: name,
      bucket_meta: { type: 'protected', versioning: false, caching: { status: false }, encryption: false, audit_consent: false },
    },
  };
}

/** The exact Delete_Bucket arguments for cleanup (by bucket name, not an id — errors.md). */
export function probeDeleteCall(name: string, target: ProbeTarget): Record<string, unknown> {
  return {
    tool: PROBE_DELETE_CALL,
    path_variables: { projectId: target.project ?? '<project-id>' },
    headers: { 'Catalyst-org': orgHeader(target.org), Environment: 'Development' },
    query_params: { bucket_name: name },
  };
}

export type ProbeStatus = 'verified' | 'absent' | 'unverifiable' | 'unresolved';

export interface ProbeResult {
  kind: 'bucket';
  name: string;
  status: ProbeStatus;
  detail: string;
}

/**
 * Read the probe bucket back through the Catalyst REST API. `verified` means
 * the selected project really holds the nonce-named bucket — the connector
 * that wrote it is bound to the CLI's org/DC/project. Anything else never
 * counts the submitted call result.
 */
export async function verifyProbe(rest: RestFn, target: ProbeTarget, name: string): Promise<ProbeResult> {
  const base = { kind: 'bucket' as const, name };
  if (!target.org || !/^[0-9]+$/.test(target.org) || !target.project || !/^[0-9]+$/.test(target.project)) {
    return { ...base, status: 'unresolved', detail: 'no org/project is selected, so the REST read-back has no target' };
  }
  let res;
  try {
    res = await rest({ method: 'GET', path: `/baas/v1/project/${target.project}/bucket/${encodeURIComponent(name)}` });
  } catch (err) {
    return { ...base, status: 'unverifiable', detail: `the REST read-back failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status >= 200 && res.status < 300) {
    let body: unknown = res.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body) as unknown;
      } catch {
        return { ...base, status: 'unverifiable', detail: `the REST read-back returned malformed JSON; bucket ${name} could not be verified` };
      }
    }
    if (typeof body !== 'object' || body === null || !('bucket_name' in body) || typeof body.bucket_name !== 'string') {
      return { ...base, status: 'unverifiable', detail: `the REST read-back did not contain a bucket_name; bucket ${name} could not be verified` };
    }
    if (body.bucket_name !== name) {
      return { ...base, status: 'unverifiable', detail: `the REST read-back returned bucket_name ${body.bucket_name}, not the expected probe bucket ${name}` };
    }
    return { ...base, status: 'verified', detail: `probe bucket ${name} found in project ${target.project} over the Catalyst REST API` };
  }
  if (res.status === 404) {
    return { ...base, status: 'absent', detail: `probe bucket ${name} is not in project ${target.project}: the MCP write never landed in the selected org/DC/project` };
  }
  return { ...base, status: 'unverifiable', detail: `the REST read-back answered HTTP ${res.status}; Stratus may not be enabled in this project` };
}

export interface PendingCleanup {
  name: string;
  org?: string;
  project?: string;
  at: string;
}

function cleanupPath(workspace: string): string {
  return join(workspace, 'c2c-out', '.c2c', 'mcp-cleanup.json');
}

/**
 * Every probe bucket the doctor saw (or could not rule out) and still owes a
 * delete instruction for, keyed by bucket name. A later probe never overwrites
 * an earlier one: entries are removed one at a time, only after a REST
 * read-back shows that bucket is gone. A bare single-record file written by an
 * older build reads back as a one-element list.
 */
export function readPendingCleanups(workspace: string): PendingCleanup[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cleanupPath(workspace), 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const pending: PendingCleanup[] = [];
    for (const entry of entries as Partial<PendingCleanup>[]) {
      if (typeof entry?.name === 'string' && entry.name.startsWith(PROBE_PREFIX)) {
        pending.push({
          name: entry.name,
          ...(typeof entry.org === 'string' ? { org: entry.org } : {}),
          ...(typeof entry.project === 'string' ? { project: entry.project } : {}),
          at: String(entry.at ?? ''),
        });
      }
    }
    return pending;
  } catch {
    /* none pending */
  }
  return [];
}

function writePendingCleanups(workspace: string, pending: PendingCleanup[]): void {
  if (pending.length === 0) rmSync(cleanupPath(workspace), { force: true });
  else writeFileSync(cleanupPath(workspace), `${JSON.stringify(pending, null, 2)}\n`);
}

/** Add (or refresh) a pending record; existing records for other probes are kept. */
export function writePendingCleanup(workspace: string, name: string, target: ProbeTarget): void {
  const record: PendingCleanup = {
    name,
    ...(target.org !== undefined ? { org: target.org } : {}),
    ...(target.project !== undefined ? { project: target.project } : {}),
    at: new Date().toISOString(),
  };
  writePendingCleanups(workspace, [...readPendingCleanups(workspace).filter((p) => p.name !== name), record]);
}

/** Drop one pending record once the REST read-back shows that probe is gone. */
export function clearPendingCleanup(workspace: string, name: string): void {
  writePendingCleanups(workspace, readPendingCleanups(workspace).filter((p) => p.name !== name));
}
