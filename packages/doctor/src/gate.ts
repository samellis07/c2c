/**
 * The exit-5 gate. `provision`, `deploy --confirm`, `migrate-data --confirm`,
 * `edit --apply --confirm`, `verify --confirm`, `probe` and `cutover` refuse unless doctor.json is
 * green, ≤ 12 h old, from the same c2c version, names the same DC/org/project
 * and holds a D-B (MCP) record less than 12 h old. `precheck`, `analyze` and
 * `plan` never refuse; they stamp `doctor: {status, at, scope, c2c}` into reports.
 *
 * The gate fails closed: a scope that cannot be resolved, a missing
 * dc/org/project on either side, a checks list that does not recompute green,
 * or an MCP record bound to another scope are all refusals — never skipped
 * comparisons.
 */
import { existsSync, readFileSync } from 'node:fs';
import { c2cVersion, doctorJsonPath } from './report.js';
import type { CheckResult, DoctorFile } from './types.js';

export const DOCTOR_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const GATE_EXIT = 5;

/**
 * The checks a gate-green doctor.json must contain with status pass or warn.
 * `green` is recomputed from this list plus "no fail anywhere"; a hand-edited
 * or partially written file cannot pass on the boolean alone.
 */
export const GATE_REQUIRED_CHECKS = ['D-C1', 'D-C3', 'D-C5', 'D-E1', 'D-B1', 'D-B3', 'D-B5', 'D-B7', 'D-V1', 'D-V2'] as const;

const SCOPE_KEYS = ['dc', 'org', 'project'] as const;
const CHECK_STATUSES = new Set<CheckResult['status']>(['pass', 'warn', 'fail', 'skip']);

export interface GateScope {
  dc?: string;
  org?: string;
  project?: string;
}

export type GateStatus =
  | 'green'
  | 'not-run'
  | 'invalid'
  | 'red'
  | 'stale'
  | 'version'
  | 'scope-error'
  | 'scope-missing'
  | 'scope-mismatch'
  | 'checks'
  | 'no-mcp'
  | 'mcp-scope'
  | 'stale-mcp';

export interface GateVerdict {
  ok: boolean;
  status: GateStatus;
  /** doctor.json `at` when it exists. */
  lastAt?: string;
  /** doctor.json `green` when it exists. */
  lastGreen?: boolean;
  file?: DoctorFile;
  /** Why scope resolution failed, when it did (fail closed). */
  scopeError?: string;
  /** The dc/org/project fields the command could not resolve. */
  missingScope?: string[];
  /** An extra refusal detail appended to the refusal line (e.g. unbound mcp). */
  reason?: string;
}

function readGateFile(workspace: string): DoctorFile | 'invalid' | undefined {
  const path = doctorJsonPath(workspace);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as DoctorFile;
    if (!parsed || typeof parsed !== 'object') return 'invalid';
    return parsed;
  } catch {
    return 'invalid';
  }
}

function missingScopeFields(scope: GateScope): string[] {
  return SCOPE_KEYS.filter((key) => typeof scope[key] !== 'string' || scope[key] === '');
}

/**
 * Recompute what `green` should be: a non-empty checks list with no `fail`,
 * no unknown status, and every required id present and only ever pass or
 * warn (a required check that was skipped is not evidence).
 */
function checksRecomputeGreen(checks: DoctorFile['checks']): boolean {
  if (!Array.isArray(checks) || checks.length === 0) return false;
  for (const c of checks) {
    if (!c || typeof c.id !== 'string' || typeof c.status !== 'string' || !CHECK_STATUSES.has(c.status)) return false;
    if (c.status === 'fail') return false;
  }
  for (const id of GATE_REQUIRED_CHECKS) {
    const entries = checks.filter((c) => c.id === id);
    if (entries.length === 0 || entries.some((e) => e.status !== 'pass' && e.status !== 'warn')) return false;
  }
  return true;
}

/** The required check ids that are missing or not pass/warn. */
function requiredCheckGaps(checks: DoctorFile['checks']): string[] {
  return GATE_REQUIRED_CHECKS.filter((id) => {
    const entries = checks.filter((c) => c?.id === id);
    return entries.length === 0 || entries.some((e) => e.status !== 'pass' && e.status !== 'warn');
  });
}

/** Exact dc/org/project equality: a missing field never matches a present one. */
function scopeEquals(a: GateScope, b: GateScope): boolean {
  return SCOPE_KEYS.every((key) => a[key] === b[key]);
}

/**
 * Evaluate the gate. The command must resolve all of dc/org/project and the
 * doctor file must name the same three; a field either side cannot name is a
 * refusal, never a skipped comparison. `allowPartialScope` is only for the
 * advisory report stamp (scope-free), never for the real gate.
 */
export function evaluateGate(input: {
  workspace: string;
  scope: GateScope;
  version?: string;
  now?: Date;
  /** Set when resolveScope threw; the gate refuses with this reason. */
  scopeError?: string;
  /** Advisory-stamp mode: compare only the scope fields the caller names. */
  allowPartialScope?: boolean;
  /**
   * The command creates the project (`provision --run import`), so no project
   * id can exist yet. Only then may `project` be absent — and it must be absent
   * on BOTH sides: the doctor run and its MCP record must be org-scoped
   * (dc + org, no project). dc and org stay required, and a doctor.json or MCP
   * record that names a project is a scope mismatch, never a pass.
   */
  createsProject?: boolean;
}): GateVerdict {
  const now = input.now ?? new Date();
  const version = input.version ?? c2cVersion();
  const file = readGateFile(input.workspace);
  if (file === undefined) return { ok: false, status: 'not-run' };
  if (file === 'invalid') return { ok: false, status: 'invalid' };
  const base = { lastAt: file.at, lastGreen: file.green, file };
  if (file.green !== true) return { ok: false, status: 'red', ...base };
  const age = now.getTime() - Date.parse(file.at);
  if (!Number.isFinite(age) || age < 0 || age > DOCTOR_MAX_AGE_MS) return { ok: false, status: 'stale', ...base };
  if (file.c2c !== version) return { ok: false, status: 'version', ...base };
  if (input.scopeError !== undefined) return { ok: false, status: 'scope-error', scopeError: input.scopeError, ...base };
  const fileScope = file.scope ?? {};
  if (input.allowPartialScope) {
    for (const key of SCOPE_KEYS) {
      const wanted = input.scope[key];
      if (wanted !== undefined && fileScope[key] !== wanted) return { ok: false, status: 'scope-mismatch', ...base };
    }
  } else {
    const missing = missingScopeFields(input.scope).filter((key) => !(input.createsProject && key === 'project' && input.scope.project === undefined));
    if (missing.length) return { ok: false, status: 'scope-missing', missingScope: missing, ...base };
    if (!scopeEquals(fileScope, input.scope)) return { ok: false, status: 'scope-mismatch', ...base };
  }
  if (!checksRecomputeGreen(file.checks)) {
    const gaps = Array.isArray(file.checks) ? requiredCheckGaps(file.checks) : [...GATE_REQUIRED_CHECKS];
    return { ok: false, status: 'checks', ...(gaps.length ? { reason: `required checks not pass/warn: ${gaps.join(', ')}` } : {}), ...base };
  }
  if (!file.mcp) return { ok: false, status: 'no-mcp', ...base };
  // The D-B record is bound to the scope it was recorded for. A record with
  // no scope — a pre-binding file, or one edited by hand — is a refusal,
  // never an assumption: nothing else can stand in for the binding.
  const bound = file.mcp.scope;
  if (bound === undefined || bound === null || typeof bound !== 'object') {
    return {
      ok: false,
      status: 'mcp-scope',
      reason: 'mcp record is not bound to a scope; re-record the MCP evidence (c2c doctor --mcp-begin)',
      ...base,
    };
  }
  const wanted = input.allowPartialScope ? fileScope : input.scope;
  if (!scopeEquals(bound, wanted)) return { ok: false, status: 'mcp-scope', ...base };
  const mcpAt = Date.parse(file.mcp.at ?? '');
  if (!Number.isFinite(mcpAt) || now.getTime() - mcpAt > DOCTOR_MAX_AGE_MS || now.getTime() - mcpAt < 0) {
    return { ok: false, status: 'stale-mcp', ...base };
  }
  return { ok: true, status: 'green', ...base };
}

const STATUS_LABEL: Record<GateStatus, string> = {
  'green': 'green',
  'not-run': 'not-run',
  'invalid': 'unreadable',
  'red': 'red',
  'stale': 'stale',
  'version': 'different c2c version',
  'scope-error': 'scope error',
  'scope-missing': 'scope unresolved',
  'scope-mismatch': 'different scope',
  'checks': 'checks failing or incomplete',
  'no-mcp': 'no MCP record',
  'mcp-scope': 'MCP record for another scope',
  'stale-mcp': 'stale MCP record',
};

/** The refusal line, spec-shaped: names the command scope and the last doctor state. */
export function gateRefusalMessage(verdict: GateVerdict, scope: GateScope): string {
  const where = `${scope.dc ?? '?'}/${scope.org ?? '?'}/${scope.project ?? '?'}`;
  // The verdict's own status, never the stored boolean: a file that says
  // green but fails the gate must not be reported as "last: green".
  const last = verdict.lastAt ? `${verdict.lastAt} ${STATUS_LABEL[verdict.status]}` : 'never run';
  const reason = verdict.scopeError
    ? `: ${verdict.scopeError}`
    : verdict.missingScope?.length
      ? `: missing ${verdict.missingScope.join('/')}`
      : verdict.reason
        ? `: ${verdict.reason}`
        : '';
  return `c2c: doctor is not green for ${where} (run c2c doctor; last: ${last})${reason}`;
}

/** What `precheck`/`analyze`/`plan` stamp into reports. */
export interface DoctorStamp {
  status: 'green' | 'red' | 'not-run';
  /** Provenance of the doctor.json the status came from (absent when not-run). */
  at?: string;
  scope?: { dc?: string; org?: string; project?: string };
  c2c?: string;
}

/**
 * The stamp: green only when the gate would pass, and it always carries the
 * file's `at`, scope and c2c version so a report shows which doctor it quotes.
 */
export function doctorStamp(input: { workspace: string; version?: string; now?: Date }): DoctorStamp {
  const verdict = evaluateGate({
    workspace: input.workspace,
    scope: {},
    allowPartialScope: true,
    ...(input.version ? { version: input.version } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const file = verdict.file;
  if (verdict.ok && file) {
    const scope = file.scope ?? {};
    return {
      status: 'green',
      at: file.at,
      scope: { ...(scope.dc !== undefined ? { dc: scope.dc } : {}), ...(scope.org !== undefined ? { org: scope.org } : {}), ...(scope.project !== undefined ? { project: scope.project } : {}) },
      c2c: file.c2c,
    };
  }
  if (verdict.status === 'not-run' || verdict.status === 'invalid') return { status: 'not-run' };
  const scope = file?.scope ?? {};
  return {
    status: 'red',
    ...(file ? { at: file.at, c2c: file.c2c } : {}),
    scope: { ...(scope.dc !== undefined ? { dc: scope.dc } : {}), ...(scope.org !== undefined ? { org: scope.org } : {}), ...(scope.project !== undefined ? { project: scope.project } : {}) },
  };
}

/** The doctor.json rows that come from the MCP record (agent half): D-A3, D-B*, D-V*. */
export function isMcpCheckId(id: string): boolean {
  return id === 'D-A3' || id.startsWith('D-B') || id.startsWith('D-V');
}

/**
 * The MCP record a run without new evidence carries forward, so a bare
 * `c2c doctor` shows the same D-B verdict the gate reads: a failed
 * observation stays red until a new one is recorded, and a verified one
 * keeps the gate open until it ages out. Only a record from the same c2c
 * version, bound to exactly this dc/org/project and less than 12 h old is
 * carried; anything else is dropped and D-B reports not recorded.
 */
export function carriedMcpRecord(input: { workspace: string; scope: GateScope; version?: string; now?: Date }): { mcp: NonNullable<DoctorFile['mcp']>; checks: CheckResult[] } | undefined {
  const file = readGateFile(input.workspace);
  if (file === undefined || file === 'invalid' || !file.mcp || !Array.isArray(file.checks)) return undefined;
  if (file.c2c !== (input.version ?? c2cVersion())) return undefined;
  const bound = file.mcp.scope;
  if (!bound || typeof bound !== 'object' || missingScopeFields(input.scope).some((key) => key !== 'project') || !scopeEquals(bound, input.scope)) return undefined;
  const now = (input.now ?? new Date()).getTime();
  const mcpAt = Date.parse(file.mcp.at ?? '');
  if (!Number.isFinite(mcpAt) || now - mcpAt > DOCTOR_MAX_AGE_MS || now - mcpAt < 0) return undefined;
  const checks = file.checks.filter((c) => c && typeof c.id === 'string' && isMcpCheckId(c.id) && CHECK_STATUSES.has(c.status));
  if (!checks.some((c) => c.id.startsWith('D-B'))) return undefined;
  return { mcp: file.mcp, checks: checks.map(({ id, status, detail, fix }) => ({ id, status, detail, fix })) };
}
