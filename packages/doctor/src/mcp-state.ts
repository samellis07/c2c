/**
 * The last accepted MCP evidence, kept in the project's doctor state
 * (`c2c-out/.c2c/mcp-state.json`) so a later plain `c2c doctor` run can
 * re-run the D-B and D-V checks instead of reporting them unproven again.
 *
 * Only the validated record is kept — connector server/host/transport, the
 * DC/org/project it was bound to, the tool list, the tool schemas (names
 * only) and their digests, the org ids, the probe read-back and when it was
 * observed. No raw call result, no URL path, no email.
 *
 * The file is in the workspace, so its contents are never trusted on their
 * own: the doctor signs each record it writes with an HMAC-SHA256 key kept
 * per user outside the workspace (`$XDG_CONFIG_HOME/c2c/mcp-state.key`,
 * default `~/.config/c2c`, created 0600 in a 0700 directory). On read a
 * record whose signature does not match — hand-written, edited (scope,
 * source, binding, `at`, anything), copied from another workspace, or
 * synced or committed from another machine — is rejected whole: nothing
 * from it is used, so it can never raise trust. A signed record is then
 * validated again exactly like a supplied evidence file. This stops
 * workspace-only writers and accidental edits; it does not stop a process
 * running as the same user that reads the key file.
 *
 * Reuse is bounded by one rule, shared with every carry of an MCP record
 * across runs (mcpCarryRefusal): the same c2c version, exactly the same
 * dc/org/project, and observed no more than MCP_EVIDENCE_MAX_AGE_HOURS ago
 * (the same window D-V2 and the exit-5 gate apply), never in the future.
 * After that the doctor asks for a new observation (`c2c doctor --mcp-begin`).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { EvidenceRejected, parseEvidence, schemaDigest, type McpEvidence } from './evidence.js';
import { NO_FOLLOW_READ_FLAGS, isSymlinkRefusedError, isUnopenableError } from '../../core/src/fs-kind.js';
import type { Observed } from './observed.js';
import { c2cVersion } from './report.js';

/** Reused evidence expires this many hours after it was observed; then a re-check is required. */
export const MCP_EVIDENCE_MAX_AGE_HOURS = 12;
export const MCP_EVIDENCE_MAX_AGE_MS = MCP_EVIDENCE_MAX_AGE_HOURS * 60 * 60 * 1000;
/** 2: signed (`mac`), bound to the workspace and c2c version. Unsigned schema-1 files are ignored. */
const STATE_SCHEMA = 2;
const KEY_BYTES = 32;

type Scope = { dc?: string; org?: string; project?: string };
type Origin = { source: 'observed'; observed: Observed } | { source: 'operator' };
type Env = NodeJS.ProcessEnv;

interface StateFile {
  scope: Scope;
  source: 'observed' | 'operator';
  evidence: McpEvidence;
  observed?: Observed;
}

export type McpEvidenceReuse =
  | { status: 'none' }
  | { status: 'rejected'; reason: string }
  | { status: 'other-scope'; reason: string }
  | { status: 'expired'; at: string; ageMs: number }
  | { status: 'reused'; evidence: McpEvidence; origin: Origin; at: string; ageMs: number; expires: string };

export function mcpStatePath(workspace: string): string {
  return join(workspace, 'c2c-out', '.c2c', 'mcp-state.json');
}

/** The per-user signing key: `$XDG_CONFIG_HOME/c2c/mcp-state.key`, default `~/.config/c2c`. */
export function mcpStateKeyPath(env: Env): string {
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), '.config');
  return join(config, 'c2c', 'mcp-state.key');
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The signing key, or a reason there is none. The key must live outside the
 * workspace, be a regular file (not a link) owned by this user and readable
 * by nobody else. `create` makes it once (0600, directory 0700).
 */
function stateKey(env: Env, workspace: string, create: boolean): { key: Buffer } | { refused: string } {
  const path = mcpStateKeyPath(env);
  if (inside(realOr(dirname(path)), realOr(workspace)) || inside(resolve(dirname(path)), resolve(workspace))) {
    return { refused: 'the signing key directory is inside the workspace' };
  }
  if (create) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { refused: `cannot create the signing key (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
    }
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, NO_FOLLOW_READ_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { refused: 'the signing key is not a regular file' };
    if ((stat.mode & 0o077) !== 0) return { refused: 'the signing key is readable by other users' };
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return { refused: 'the signing key is owned by another user' };
    if (stat.size !== KEY_BYTES) return { refused: 'the signing key has the wrong length' };
    const key = Buffer.alloc(KEY_BYTES);
    if (readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES) return { refused: 'the signing key has the wrong length' };
    return { key };
  } catch (err) {
    if (isSymlinkRefusedError(err) || isUnopenableError(err)) return { refused: 'the signing key is not a regular file' };
    return { refused: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no signing key' : 'the signing key cannot be read' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** JSON with sorted object keys, so the signature does not depend on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function macOf(key: Buffer, body: Record<string, unknown>): string {
  return `hmac-sha256:${createHmac('sha256', key).update(canonical(body)).digest('hex')}`;
}

function workspaceId(workspace: string): string {
  return realOr(workspace);
}

function scopeOf(scope: Scope): Scope {
  return {
    ...(scope.dc !== undefined ? { dc: scope.dc } : {}),
    ...(scope.org !== undefined ? { org: scope.org } : {}),
    ...(scope.project !== undefined ? { project: scope.project } : {}),
  };
}

/**
 * The one rule for carrying an MCP record into a later run: same c2c
 * version, the dc and org present and every one of dc/org/project exactly
 * equal, and `at` no more than MCP_EVIDENCE_MAX_AGE_HOURS old (never in the
 * future). Returns why the record may not be carried, or undefined when it
 * may. `at` must come from an authenticated record, never a workspace file
 * read on trust.
 */
export function mcpCarryRefusal(
  record: { c2c?: string; scope?: Scope; at?: string },
  wanted: { version: string; scope: Scope; now: Date },
): { status: 'other-scope' | 'expired'; reason: string; ageMs?: number } | undefined {
  if (record.c2c !== wanted.version) return { status: 'other-scope', reason: `recorded by c2c ${record.c2c ?? '?'}, this is ${wanted.version}` };
  const want = scopeOf(wanted.scope);
  const have = scopeOf(record.scope ?? {});
  if (want.dc === undefined || want.org === undefined) return { status: 'other-scope', reason: 'the dc/org of this run is not known' };
  if (!(['dc', 'org', 'project'] as const).every((key) => have[key] === want[key])) return { status: 'other-scope', reason: 'recorded for another dc/org/project' };
  const ageMs = wanted.now.getTime() - Date.parse(record.at ?? '');
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MCP_EVIDENCE_MAX_AGE_MS) return { status: 'expired', reason: 'older than the window, undated or dated in the future', ageMs };
  return undefined;
}

/**
 * Persist the evidence a run accepted, bound to that run's scope, workspace
 * and c2c version, and signed. Returns the path, or `{refused}` when there is
 * no usable key (then nothing is stored and later runs ask for a new
 * observation).
 */
export function writeMcpEvidence(
  workspace: string,
  evidence: McpEvidence,
  scope: Scope,
  origin: Origin,
  opts: { env: Env; version?: string },
): string | { refused: string } {
  const signer = stateKey(opts.env, workspace, true);
  if ('refused' in signer) return signer;
  const digest: Record<string, string> = {};
  for (const [tool, entry] of Object.entries(evidence.schemas ?? {})) digest[tool] = schemaDigest(entry);
  // A per-project table listing is stored in the shape parseEvidence reads back.
  const { projectTables, ...kept } = evidence;
  const stored: Record<string, unknown> = { ...kept, ...(projectTables ? { tables: Object.entries(projectTables).map(([project_id, tables]) => ({ project_id, tables })) } : {}) };
  const body: Record<string, unknown> = {
    schema: STATE_SCHEMA,
    c2c: opts.version ?? c2cVersion(),
    workspace: workspaceId(workspace),
    scope: scopeOf(scope),
    source: origin.source,
    evidence: JSON.parse(JSON.stringify(stored)) as unknown,
    ...(Object.keys(digest).length ? { schemaDigest: digest } : {}),
    ...(origin.source === 'observed' ? { observed: origin.observed } : {}),
  };
  const path = mcpStatePath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...body, mac: macOf(signer.key, body) }, null, 2)}\n`);
  return path;
}

const BINDING_STATUSES = new Set(['verified', 'absent', 'unverifiable', 'unresolved']);

function bindingOf(value: unknown): McpEvidence['binding'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  if (b.kind !== 'bucket' || typeof b.name !== 'string' || !/^c2cprobe[0-9a-f]{32}$/.test(b.name)) return undefined;
  if (typeof b.status !== 'string' || !BINDING_STATUSES.has(b.status) || typeof b.detail !== 'string' || b.detail.length > 400) return undefined;
  return { kind: 'bucket', name: b.name, status: b.status as NonNullable<McpEvidence['binding']>['status'], detail: b.detail };
}

function observedOf(value: unknown): Observed | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.request !== 'string' || !/^[0-9a-f]{32}$/.test(o.request)) return undefined;
  if (!Array.isArray(o.orgs) || !o.orgs.every((id) => typeof id === 'string' && /^[0-9]+$/.test(id))) return undefined;
  if (!Array.isArray(o.calls)) return undefined;
  const calls: Observed['calls'] = [];
  for (const call of o.calls as unknown[]) {
    const c = call as Record<string, unknown> | null;
    if (!c || typeof c.tool !== 'string' || !/^[A-Za-z_]+$/.test(c.tool) || typeof c.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(c.digest)) return undefined;
    calls.push({ tool: c.tool, digest: c.digest });
  }
  return { request: o.request, orgs: [...(o.orgs as string[])], calls };
}

type Read = { state: StateFile & { c2c: string; at: string } } | { status: 'none' } | { status: 'rejected'; reason: string };

/** The stored record, authenticated and validated again. */
function readState(workspace: string, env: Env): Read {
  let text: string;
  try {
    text = readFileSync(mcpStatePath(workspace), 'utf8');
  } catch {
    return { status: 'none' };
  }
  const rejected = (reason: string): Read => ({ status: 'rejected', reason });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return rejected('not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rejected('not a record');
  const { mac, ...body } = raw as Record<string, unknown>;
  if (body.schema !== STATE_SCHEMA || typeof mac !== 'string') return rejected('not signed by this doctor');
  // Authenticate before reading anything from the file.
  const signer = stateKey(env, workspace, false);
  if ('refused' in signer) return rejected(signer.refused);
  const want = Buffer.from(macOf(signer.key, body));
  const got = Buffer.from(mac);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return rejected('signature mismatch (edited, hand-written or copied)');
  if (body.workspace !== workspaceId(workspace)) return rejected('recorded for another workspace');
  if (typeof body.c2c !== 'string') return rejected('malformed');
  const state = body;
  if (state.source !== 'observed' && state.source !== 'operator') return rejected('malformed');
  const scope = state.scope as Record<string, unknown> | undefined;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return rejected('malformed');
  for (const key of ['dc', 'org', 'project'] as const) {
    if (scope[key] !== undefined && typeof scope[key] !== 'string') return rejected('malformed');
  }
  const stored = state.evidence as Record<string, unknown> | undefined;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return rejected('malformed');
  const { binding, ...rest } = stored;
  let evidence: McpEvidence;
  try {
    evidence = parseEvidence(JSON.stringify(rest));
  } catch (err) {
    if (err instanceof EvidenceRejected) return rejected('malformed');
    throw err;
  }
  if (binding !== undefined) {
    const checked = bindingOf(binding);
    if (!checked) return rejected('malformed');
    evidence.binding = checked;
  }
  const digest: Record<string, string> = {};
  for (const [tool, entry] of Object.entries(evidence.schemas ?? {})) digest[tool] = schemaDigest(entry);
  if (canonical(digest) !== canonical(state.schemaDigest ?? {})) return rejected('schema digests do not match the schemas');
  let observed: Observed | undefined;
  if (state.source === 'observed') {
    observed = observedOf(state.observed);
    if (!observed) return rejected('malformed');
  }
  return { state: { c2c: body.c2c, at: evidence.at ?? '', scope: scopeOf(scope as Scope), source: state.source, evidence, ...(observed ? { observed } : {}) } };
}

/**
 * The stored evidence for this scope, when it may still be reused: only a
 * record this doctor signed, for this workspace, that passes
 * mcpCarryRefusal. Anything else is reported (rejected, other-scope or
 * expired) and never used.
 */
export function loadMcpEvidence(workspace: string, scope: Scope, opts: { env: Env; version?: string; now?: Date }): McpEvidenceReuse {
  const read = readState(workspace, opts.env);
  if (!('state' in read)) return read;
  const { state } = read;
  const now = opts.now ?? new Date();
  const refusal = mcpCarryRefusal(state, { version: opts.version ?? c2cVersion(), scope, now });
  if (refusal?.status === 'expired') return { status: 'expired', at: state.at, ageMs: refusal.ageMs ?? Number.NaN };
  if (refusal) return { status: 'other-scope', reason: refusal.reason };
  const ageMs = now.getTime() - Date.parse(state.at);
  const origin: Origin = state.source === 'observed' ? { source: 'observed', observed: state.observed! } : { source: 'operator' };
  return { status: 'reused', evidence: state.evidence, origin, at: state.at, ageMs, expires: new Date(Date.parse(state.at) + MCP_EVIDENCE_MAX_AGE_MS).toISOString() };
}

/** A short human age: `less than a minute`, `25 min`, `3 h 5 min`. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
