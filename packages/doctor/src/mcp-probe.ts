/**
 * The server-side binding probe for observed MCP evidence. Submitted JSON is
 * caller-controlled, so the nonce never counts when it is only echoed back:
 * the request asks the host to WRITE it into the selected project through the
 * MCP connector — a short-lived Stratus bucket named after the request id —
 * and the doctor then reads it back over the Catalyst REST API with the
 * user's own CLI credential. The bucket name is deterministic per project, so
 * a pre-created bucket is not proof: each run also writes a fresh 32-hex
 * nonce object into that bucket and the doctor requires that exact key.
 * Only the connector that really is bound to the same org/DC/project can
 * place this run's object where that read finds it.
 *
 * Documented pair (facts ledger):
 *   - `Create_Bucket` is an MCP-only write — the CLI token answers
 *     `POST /bucket` with `401 OAUTH_SCOPE_MISMATCH` (jobs-and-files.md,
 *     surface-decision-table.md).
 *   - `GET /baas/v1/project/<project-id>/bucket` (the bucket list) with the
 *     CLI token returns every bucket inside the Catalyst `data` envelope —
 *     `{ data: [{ bucket_name, bucket_url, ... }] }`. The specific-bucket
 *     route `GET .../bucket/<name>` is not used: it answered
 *     `404 INVALID_URL_PATTERN` in one DC while the list route worked
 *     (jobs-and-files.md, [UNVERIFIED]).
 *   - The Stratus REST reference documents no bucket-delete route, so the
 *     doctor itself removes only this run's nonce object (`PUT
 *     .../bucket/object`). A probe bucket this run created stays tracked:
 *     cleanup is `CatalystbyZoho_Delete_Bucket` by `query_params.bucket_name`
 *     (errors.md) or the console step, instructed for the session and
 *     re-printed while a pending cleanup record exists.
 *
 * The probe bucket name is deterministic per scope — one bucket per project
 * (`c2cprobe-p<project-id>`), one per org before the project exists
 * (`c2cprobe-o<org-id>`) — so repeated doctor runs reuse the same bucket
 * instead of leaking a new random bucket every run. A scope the doctor
 * cannot pin to an org or project keeps the legacy request-id name. A
 * project-scoped run proves the binding by reading back this run's nonce
 * object (`GET .../bucket/objects`, exact `key`), not by the bucket's
 * existence. Callers that pass no nonce (the in-project re-check before a
 * project exists is handled separately, and leftover-bucket cleanup) still
 * match the bucket list only. A repeated run reuses the one bucket.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUCKET_LIST_MAX_PAGES, readBucketList, type RestFn } from '../../deploy/src/tables.js';

export const PROBE_PREFIX = 'c2cprobe';
/**
 * The detail an org-scoped verified probe carries: the org read proved the
 * binding is reachable, but the nonce bucket probe inside the project is
 * still owed once the project exists. Only the project-creating step may
 * treat this status as green — deploy, smoke and every project-scoped verb
 * stay strict.
 */
export const IN_PROJECT_PROBE_REQUIRED = 'in-project-probe-required';
export const PROBE_CREATE_CALL = 'CatalystbyZoho_Create_Bucket';
export const PROBE_DELETE_CALL = 'CatalystbyZoho_Delete_Bucket';
/** Signing call the agent uses to PUT this run's nonce object. Not required in the observation. */
export const PROBE_OBJECT_CALL = 'CatalystbyZoho_Create_Upload_Signature';
/** A per-run object key: 16 crypto-random bytes, hex. */
const NONCE_RE = /^[0-9a-f]{32}$/;

/**
 * The deterministic probe bucket for a scope: one bucket per project, one
 * per org while there is no project yet. Project ids are unique per org, so
 * the name is unique per project; the `p`/`o` infix keeps the two shapes
 * apart. Scopes without a numeric org or project id have no deterministic
 * name (undefined) and keep the legacy request-id name.
 */
export function probeNameFor(target: ProbeTarget): string | undefined {
  if (target.project !== undefined && /^[0-9]+$/.test(target.project)) return `${PROBE_PREFIX}-p${target.project}`;
  if (target.org !== undefined && /^[0-9]+$/.test(target.org)) return `${PROBE_PREFIX}-o${target.org}`;
  return undefined;
}

/**
 * The probe bucket name: the deterministic per-scope name when the scope
 * pins it, else the legacy request-id name (a name the caller cannot choose).
 */
export function probeNameOf(request: string, target: ProbeTarget = {}): string {
  return probeNameFor(target) ?? `${PROBE_PREFIX}${request}`;
}

/**
 * A name this doctor treats as one of its probe buckets: the deterministic
 * per-project/per-org names and the legacy request-id names. Anything else
 * is never tracked for cleanup.
 */
export function isProbeName(name: string): boolean {
  return /^c2cprobe(?:[0-9a-f]{32}|-p[0-9]+|-o[0-9]+)$/.test(name);
}

/**
 * The scope a probe request was opened under: the scope kind ('project',
 * 'org', or the unscoped legacy 'request') and the exact target ids. A run
 * verifies a probe only in the same scope it was begun in: an org-scoped
 * begin must never be completed by a project-scoped binding that creates the
 * org-named bucket inside the project.
 */
export interface ProbeScope {
  kind: 'project' | 'org' | 'request';
  org?: string;
  project?: string;
}

/** The scope of a target, normalized the same way the probe name is derived. */
export function probeScopeOf(target: ProbeTarget): ProbeScope {
  if (target.project !== undefined && /^[0-9]+$/.test(target.project)) {
    return { kind: 'project', ...(target.org !== undefined ? { org: target.org } : {}), project: target.project };
  }
  if (target.org !== undefined && /^[0-9]+$/.test(target.org)) return { kind: 'org', org: target.org };
  return { kind: 'request' };
}

/** The scope a deterministic probe name pins; legacy request-id names pin none. */
export function probeScopeOfName(name: string): ProbeScope {
  const project = /^c2cprobe-p([0-9]+)$/.exec(name);
  if (project) return { kind: 'project', project: project[1]! };
  const org = /^c2cprobe-o([0-9]+)$/.exec(name);
  if (org) return { kind: 'org', org: org[1]! };
  return { kind: 'request' };
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

/**
 * The Create_Upload_Signature arguments that name this run's nonce object.
 * The agent PUTs the nonce text to the signed URL; the doctor never trusts
 * that call's result — it lists objects and matches `key` exactly.
 */
export function probeObjectCall(bucket: string, nonce: string, target: ProbeTarget): Record<string, unknown> {
  return {
    tool: PROBE_OBJECT_CALL,
    path_variables: { projectId: target.project ?? '<project-id>' },
    headers: { 'Catalyst-org': orgHeader(target.org), Environment: 'Development' },
    query_params: { bucket_name: bucket, object_key: nonce },
  };
}

/** PUT that deletes one nonce object and leaves the reusable probe bucket. [DOC] object delete; CLI token scope [UNVERIFIED]. */
export interface ProbeNonceCleanup {
  method: 'PUT';
  path: string;
  bucket: string;
  nonce: string;
  body: { objects: { key: string }[] };
}

export function probeNonceCleanup(bucket: string, nonce: string, project: string): ProbeNonceCleanup {
  return {
    method: 'PUT',
    path: `/baas/v1/project/${project}/bucket/object?bucket_name=${encodeURIComponent(bucket)}`,
    bucket,
    nonce,
    body: { objects: [{ key: nonce }] },
  };
}

/**
 * Best-effort delete of this run's nonce object. The CLI token's
 * buckets.objects.DELETE scope is not proven, so a refusal is ignored and
 * the caller still prints {@link probeNonceCleanup}. The probe bucket itself
 * is never deleted over REST — no bucket-delete route is documented
 * ({@link cleanUpProbe} leaves it tracked when this run created it).
 */
export async function deleteProbeNonce(rest: RestFn, project: string, bucket: string, nonce: string): Promise<boolean> {
  if (!/^[0-9]+$/.test(project) || !NONCE_RE.test(nonce)) return false;
  try {
    const instruction = probeNonceCleanup(bucket, nonce, project);
    const res = await rest({ method: 'PUT', path: instruction.path, body: instruction.body });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/**
 * Whether the probe bucket already existed when --mcp-begin ran, from the
 * same REST bucket list the read-back uses. Only a project-scoped begin
 * reads it; any read that cannot answer yields undefined, which never
 * counts as "created by this run".
 */
export async function probeBucketBefore(rest: RestFn, target: ProbeTarget, name: string): Promise<'present' | 'absent' | undefined> {
  if (target.project === undefined || !/^[0-9]+$/.test(target.project) || name !== probeNameFor(target)) return undefined;
  const read = await readBucketList(rest, target.project, name);
  return read.status === 'found' ? 'present' : read.status === 'absent' ? 'absent' : undefined;
}

/** The console steps that remove what an automatic cleanup left behind. */
export function probeConsoleCleanup(bucket: string, nonce?: string): string {
  return nonce
    ? `in the Catalyst console open the project → Cloud Scale → Stratus → bucket ${bucket}, delete the object ${nonce}, then delete the bucket ${bucket}`
    : `in the Catalyst console open the project → Cloud Scale → Stratus, select the bucket ${bucket} and delete it`;
}

export interface ProbeCleanupResult {
  /** This run's nonce object was deleted (confirmed by the delete answer). */
  nonceRemoved: boolean;
  /** 'kept': not created by this run, so never touched. 'left': this run created it and it stays for the caller to remove. */
  bucket: 'kept' | 'left';
}

/**
 * Clean up after a verified project-scoped probe: delete this run's nonce
 * object, then report the probe bucket — 'kept' when this run did not
 * create it (`createdThisRun` false: the bucket was in the project at
 * --mcp-begin or the Create_Bucket answer was already-exists), 'left' when
 * it did. The Stratus REST reference documents no bucket-delete route, so
 * the doctor never sends one: a bucket this run created is reported for
 * the caller to remove (the console step or `CatalystbyZoho_Delete_Bucket`
 * it prints under cleanup), never to fail on.
 * Only the exact `c2cprobe-p<project-id>` name of THIS project is ever
 * touched — a different project's probe, an org probe, a legacy request-id
 * name or any other bucket gets no call at all.
 */
export async function cleanUpProbe(rest: RestFn, project: string, bucket: string, nonce: string, createdThisRun: boolean): Promise<ProbeCleanupResult> {
  if (bucket !== probeNameFor({ project })) return { nonceRemoved: false, bucket: 'kept' };
  const nonceRemoved = await deleteProbeNonce(rest, project, bucket, nonce);
  return { nonceRemoved, bucket: createdThisRun ? 'left' : 'kept' };
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
  /** HTTP status of the failed read-back, when there was one. */
  httpStatus?: number;
}

const OBJECT_PAGE_TOKEN_KEYS = ['next_continuation_token', 'continuation_token', 'next_token'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function objectPageToken(record: Record<string, unknown> | undefined): { key: (typeof OBJECT_PAGE_TOKEN_KEYS)[number]; token: string } | undefined {
  if (!record) return undefined;
  for (const key of OBJECT_PAGE_TOKEN_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return { key, token: value };
  }
  return undefined;
}

/** `truncated` / `is_truncated` are the documented object-list flags; `more_records` matches the bucket list. */
function objectListContinues(record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  return record.more_records === true || record.truncated === true || record.is_truncated === true;
}

function objectsPath(project: string, bucket: string, nonce: string, token?: { key: string; token: string }): string {
  const query = `bucket_name=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(nonce)}&max_keys=50`;
  const page = token ? `&${token.key}=${encodeURIComponent(token.token)}` : '';
  return `/baas/v1/project/${project}/bucket/objects?${query}${page}`;
}

/**
 * List objects in the probe bucket and require a `contents` entry whose `key`
 * is exactly this run's nonce. A prefix or superstring does not count. An
 * empty list is absent. A list error, a malformed page, or a truncated page
 * with no token is unverifiable — never treated as "the object is missing".
 * [DOC] GET .../bucket/objects (`data.contents[].key`, `next_continuation_token`).
 */
async function readNonceObject(rest: RestFn, project: string, bucket: string, nonce: string): Promise<Pick<ProbeResult, 'status' | 'detail' | 'httpStatus'>> {
  const seen = new Set<string>();
  let token: { key: string; token: string } | undefined;
  for (let page = 0; page < BUCKET_LIST_MAX_PAGES; page++) {
    let res: { status: number; body: unknown };
    try {
      res = await rest({ method: 'GET', path: objectsPath(project, bucket, nonce, token) });
    } catch (err) {
      return { status: 'unverifiable', detail: `the REST object list failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (res.status < 200 || res.status >= 300) {
      return { status: 'unverifiable', httpStatus: res.status, detail: `the REST object list answered HTTP ${res.status}; this run's nonce object could not be verified` };
    }
    let body: unknown = res.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body) as unknown;
      } catch {
        return { status: 'unverifiable', detail: 'the REST object list returned malformed JSON; this run\'s nonce object could not be verified' };
      }
    }
    const record = asRecord(body);
    const data = asRecord(record?.data);
    const contents = data?.contents;
    if (!Array.isArray(contents)) {
      return { status: 'unverifiable', detail: 'the REST object list did not return contents; this run\'s nonce object could not be verified' };
    }
    for (let index = 0; index < contents.length; index++) {
      const row = asRecord(contents[index]);
      const key = row?.key;
      if (!row || typeof key !== 'string' || key.trim() === '') {
        return { status: 'unverifiable', detail: `the REST object list returned a malformed row at index ${index}; this run's nonce object could not be verified` };
      }
      if (key === nonce) {
        return { status: 'verified', detail: `probe nonce object ${nonce} read back from bucket ${bucket} in project ${project} over the Catalyst REST API` };
      }
    }
    const next = objectPageToken(data) ?? objectPageToken(record);
    const more = objectListContinues(data) || objectListContinues(record);
    if (!next) {
      if (more) return { status: 'unverifiable', detail: 'the REST object list has more rows but no page token; this run\'s nonce object could not be ruled out' };
      return { status: 'absent', detail: `this run's nonce object was not read back from bucket ${bucket} in project ${project}` };
    }
    if (seen.has(next.token)) {
      return { status: 'unverifiable', detail: 'the REST object list repeated a page token; this run\'s nonce object could not be verified' };
    }
    seen.add(next.token);
    token = next;
  }
  return { status: 'unverifiable', detail: `the REST object list ran past ${BUCKET_LIST_MAX_PAGES} pages; this run's nonce object could not be verified` };
}

/**
 * Read the probe back through the Catalyst REST API. With no `nonce`, `verified`
 * means the selected project lists the probe bucket (the in-project re-check
 * and leftover-bucket cleanup). With a 32-hex `nonce`, the bucket must exist
 * and the object list must contain that exact key — a pre-created bucket, or
 * a key left by an earlier run, does not count. Anything else never counts
 * the submitted call result.
 *
 * The bucket read uses the shared paginated LIST reader and matches
 * `bucket_name` exactly. The per-bucket route is not used. A list error or
 * incomplete pagination cannot prove absence.
 */
export async function verifyProbe(rest: RestFn, target: ProbeTarget, name: string, nonce?: string): Promise<ProbeResult> {
  const base = { kind: 'bucket' as const, name };
  if (!target.org || !/^[0-9]+$/.test(target.org)) return { ...base, status: 'unresolved', detail: 'no org is selected, so the REST read-back has no target' };
  // Import is the one legitimate project-less probe: the project does not
  // exist until the org-scoped import completes.  A successful org-level
  // project-list read proves that the explicit Catalyst-org binding is
  // reachable; the nonce bucket probe is repeated once the project exists.
  // A nonce on this path is ignored: no project holds the object yet.
  if (!target.project) {
    try {
      const read = await rest({ method: 'GET', path: '/baas/v1/project' });
      if (read.status >= 200 && read.status < 300) return { ...base, status: 'verified', detail: IN_PROJECT_PROBE_REQUIRED };
      return { ...base, status: 'unverifiable', httpStatus: read.status, detail: `the REST org project list answered HTTP ${read.status}` };
    } catch (err) {
      return { ...base, status: 'unverifiable', detail: `the REST org read-back failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (!/^[0-9]+$/.test(target.project)) return { ...base, status: 'unresolved', detail: 'the selected project id is invalid' };
  if (nonce !== undefined && !NONCE_RE.test(nonce)) {
    return { ...base, status: 'unverifiable', detail: 'the MCP request nonce is not a 32-hex value, so the probe cannot be verified' };
  }
  const read = await readBucketList(rest, target.project, name);
  if (nonce === undefined) {
    if (read.status === 'found') return { ...base, status: 'verified', detail: `probe bucket ${name} found in project ${target.project} over the Catalyst REST API` };
    if (read.status === 'absent') return { ...base, status: 'absent', detail: `probe bucket ${name} is not in project ${target.project}: the MCP write never landed in the selected org/DC/project` };
    const detail = read.httpStatus === undefined
      ? read.detail
      : `the REST bucket list answered HTTP ${read.httpStatus}; Stratus may never have been opened in this project — in the Catalyst console open the project → Cloud Scale → Stratus → Start Exploring, then on Create your First Bucket create one bucket (any name) and wait until it shows in the bucket list`;
    return { ...base, status: 'unverifiable', detail };
  }
  if (read.status === 'absent') return { ...base, status: 'absent', detail: `probe bucket ${name} is not in project ${target.project}: the MCP write never landed in the selected org/DC/project` };
  if (read.status !== 'found') {
    const detail = read.httpStatus === undefined
      ? read.detail
      : `the REST bucket list answered HTTP ${read.httpStatus}; Stratus may never have been opened in this project — in the Catalyst console open the project → Cloud Scale → Stratus → Start Exploring, then on Create your First Bucket create one bucket (any name) and wait until it shows in the bucket list`;
    return { ...base, status: 'unverifiable', detail };
  }
  const object = await readNonceObject(rest, target.project, name, nonce);
  return { ...base, ...object };
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
