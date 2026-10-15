/**
 * The last accepted MCP evidence, kept in the project's doctor state
 * (`c2c-out/.c2c/mcp-state.json`) so a later plain `c2c doctor` run can
 * re-run the D-B and D-V checks instead of reporting them unproven again.
 *
 * Only the validated record is kept — connector server/host/transport, the
 * DC/org/project it was bound to, the tool list, the tool schemas (names
 * only) and their digests, the org ids, the probe read-back and when it was
 * observed. No raw call result, no URL path, no email. On read the record is
 * validated again exactly like a supplied evidence file; anything malformed
 * is ignored, never trusted.
 *
 * Reuse is bounded: a record is reused only for the same dc/org/project and
 * only for MCP_EVIDENCE_MAX_AGE_HOURS after it was observed (the same window
 * D-V2 and the exit-5 gate apply). After that the doctor asks for a new
 * observation (`c2c doctor --mcp-begin`).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EvidenceRejected, parseEvidence, schemaDigest, type McpEvidence } from './evidence.js';
import type { Observed } from './observed.js';

/** Reused evidence expires this many hours after it was observed; then a re-check is required. */
export const MCP_EVIDENCE_MAX_AGE_HOURS = 12;
export const MCP_EVIDENCE_MAX_AGE_MS = MCP_EVIDENCE_MAX_AGE_HOURS * 60 * 60 * 1000;
const STATE_SCHEMA = 1;

type Scope = { dc?: string; org?: string; project?: string };
type Origin = { source: 'observed'; observed: Observed } | { source: 'operator' };

interface StateFile {
  schema: number;
  scope: Scope;
  source: 'observed' | 'operator';
  evidence: McpEvidence;
  schemaDigest?: Record<string, string>;
  observed?: Observed;
}

export type McpEvidenceReuse =
  | { status: 'none' }
  | { status: 'other-scope' }
  | { status: 'expired'; at: string; ageMs: number }
  | { status: 'reused'; evidence: McpEvidence; origin: Origin; at: string; ageMs: number; expires: string };

export function mcpStatePath(workspace: string): string {
  return join(workspace, 'c2c-out', '.c2c', 'mcp-state.json');
}

function scopeOf(scope: Scope): Scope {
  return {
    ...(scope.dc !== undefined ? { dc: scope.dc } : {}),
    ...(scope.org !== undefined ? { org: scope.org } : {}),
    ...(scope.project !== undefined ? { project: scope.project } : {}),
  };
}

/** Persist the evidence a run accepted, bound to that run's scope. */
export function writeMcpEvidence(workspace: string, evidence: McpEvidence, scope: Scope, origin: Origin): string {
  const digest: Record<string, string> = {};
  for (const [tool, entry] of Object.entries(evidence.schemas ?? {})) digest[tool] = schemaDigest(entry);
  // A per-project table listing is stored in the shape parseEvidence reads back.
  const { projectTables, ...kept } = evidence;
  const stored: Record<string, unknown> = { ...kept, ...(projectTables ? { tables: Object.entries(projectTables).map(([project_id, tables]) => ({ project_id, tables })) } : {}) };
  const state = {
    schema: STATE_SCHEMA,
    scope: scopeOf(scope),
    source: origin.source,
    evidence: stored,
    ...(Object.keys(digest).length ? { schemaDigest: digest } : {}),
    ...(origin.source === 'observed' ? { observed: origin.observed } : {}),
  };
  const path = mcpStatePath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
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

/** The stored record, validated again; undefined when absent or malformed. */
function readState(workspace: string): StateFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(mcpStatePath(workspace), 'utf8'));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const state = raw as Record<string, unknown>;
  if (state.schema !== STATE_SCHEMA || (state.source !== 'observed' && state.source !== 'operator')) return undefined;
  const scope = state.scope as Record<string, unknown> | undefined;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return undefined;
  for (const key of ['dc', 'org', 'project'] as const) {
    if (scope[key] !== undefined && typeof scope[key] !== 'string') return undefined;
  }
  const stored = state.evidence as Record<string, unknown> | undefined;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  const { binding, ...rest } = stored;
  let evidence: McpEvidence;
  try {
    evidence = parseEvidence(JSON.stringify(rest));
  } catch (err) {
    if (err instanceof EvidenceRejected) return undefined;
    throw err;
  }
  if (binding !== undefined) {
    const checked = bindingOf(binding);
    if (!checked) return undefined;
    evidence.binding = checked;
  }
  let observed: Observed | undefined;
  if (state.source === 'observed') {
    observed = observedOf(state.observed);
    if (!observed) return undefined;
  }
  return { schema: STATE_SCHEMA, scope: scopeOf(scope as Scope), source: state.source, evidence, ...(observed ? { observed } : {}) };
}

/**
 * The stored evidence for this scope, when it may still be reused. A record
 * for another dc/org/project is never reused; one older than the window (or
 * dated in the future) is reported as expired.
 */
export function loadMcpEvidence(workspace: string, scope: Scope, now: Date = new Date()): McpEvidenceReuse {
  const state = readState(workspace);
  if (!state) return { status: 'none' };
  const wanted = scopeOf(scope);
  if (!(['dc', 'org', 'project'] as const).every((key) => state.scope[key] === wanted[key])) return { status: 'other-scope' };
  const at = state.evidence.at ?? '';
  const ageMs = now.getTime() - Date.parse(at);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MCP_EVIDENCE_MAX_AGE_MS) return { status: 'expired', at, ageMs };
  const origin: Origin = state.source === 'observed' ? { source: 'observed', observed: state.observed! } : { source: 'operator' };
  return { status: 'reused', evidence: state.evidence, origin, at, ageMs, expires: new Date(Date.parse(at) + MCP_EVIDENCE_MAX_AGE_MS).toISOString() };
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
