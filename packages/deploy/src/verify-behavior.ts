/**
 * `c2c verify-behavior` — differential replay of a captured Creator golden
 * (tests/behavior/<app>/creator/, schema in tests/behavior/SCHEMA.md) against
 * the migrated app.
 *
 * Offline (default, CI): the deploy tree is generated into a temp directory,
 * functions/c2c_api is loaded in-process the way the Catalyst Advanced I/O
 * runtime loads it (tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs stands
 * in for zcatalyst-sdk-node — the same in-process Catalyst harness
 * tools/catalyst-harness/serve.mjs uses), and the golden's steps are replayed
 * over loopback HTTP. Stored rows are read from the in-memory datastore.
 *
 * --live: the same steps run against the deployed function over HTTPS, bound
 * by the deploy report the way `c2c smoke` binds its function origin, and
 * stored rows are read back through the admin ZCQL surface with the CLI
 * credential — the same credential binding rules as the smoke run.
 *
 * Every difference becomes a finding (case id + pointer + expected vs actual)
 * in a deterministic JSON report and a markdown report; the command exits
 * non-zero on any finding and prints the KPI line
 * `behavior-equivalent apps: N`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../../core/src/ir.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { slug } from '../../deluge/src/generate.js';
import { generateUi, type UiModel } from '../../ui/src/index.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from './guards.js';
import { deployFiles, writeDeployTree } from './plan.js';
import { emptyRegistry } from './registry.js';

// ---------- golden schema ----------

export const GOLDEN_VERSION = 'c2c-behavior-golden/2';
export const REPORT_VERSION = 'c2c-behavior-report/1';

/** Normalization markers an expected value may use (tests/behavior/SCHEMA.md). */
export const MARKERS = ['<any>', '<id>', '<timestamp>'] as const;

export interface GoldenStepExpect {
  status?: number;
  /**
   * Recursive match against the JSON response body. Arrays compare in order;
   * set `unordered: true` to match them as multisets instead.
   */
  body?: unknown;
  /** Match arrays in `body` as multisets (opt-in; default is ordered). */
  unordered?: boolean;
}

export type GoldenStep =
  | { op: 'submit'; form: string; record: Record<string, unknown>; expect?: GoldenStepExpect }
  | { op: 'report'; report: string; body?: Record<string, unknown>; expect?: GoldenStepExpect }
  | { op: 'call'; function: string; args?: Record<string, unknown>; expect?: GoldenStepExpect }
  | { op: 'request'; method: string; path: string; body?: unknown; expect?: GoldenStepExpect };

export interface GoldenCase {
  id: string;
  name?: string;
  steps: GoldenStep[];
  expect?: {
    /** Catalyst table -> complete expected contents; rows match in order unless `unordered`. */
    tables?: Record<string, Record<string, unknown>[]>;
    /** Match `tables` rows as multisets (opt-in; default is ordered). */
    unordered?: boolean;
  };
}

export interface GoldenFile {
  version: string;
  app?: string;
  cases: GoldenCase[];
}

export function loadGoldens(dir: string): GoldenFile {
  const file = join(dir, 'cases.json');
  if (!existsSync(file)) throw new Error(`no cases.json in ${dir} — a golden directory holds one cases.json (tests/behavior/SCHEMA.md)`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not JSON: ${err instanceof Error ? err.message : 'parse failed'}`);
  }
  return assertGolden(parsed);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertGolden(parsed: unknown): GoldenFile {
  if (!isObject(parsed)) throw new Error('golden cases.json must be a JSON object');
  if (parsed.version !== GOLDEN_VERSION) throw new Error(`golden version must be ${GOLDEN_VERSION} (got ${JSON.stringify(parsed.version)})`);
  if (!Array.isArray(parsed.cases)) throw new Error('golden cases must be an array');
  const ids = new Set<string>();
  for (const [i, entry] of parsed.cases.entries()) {
    const at = `cases[${i}]`;
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id) throw new Error(`${at}.id must be a non-empty string`);
    if (ids.has(entry.id)) throw new Error(`duplicate case id ${entry.id}`);
    ids.add(entry.id);
    if (!Array.isArray(entry.steps)) throw new Error(`${at}.steps must be an array`);
    for (const [j, step] of (entry.steps as unknown[]).entries()) {
      const at2 = `${at}.steps[${j}]`;
      if (!isObject(step) || typeof step.op !== 'string') throw new Error(`${at2}.op missing`);
      if (step.op === 'submit' && (typeof step.form !== 'string' || !isObject(step.record))) throw new Error(`${at2}: submit needs form + record`);
      if (step.op === 'report' && typeof step.report !== 'string') throw new Error(`${at2}: report needs report`);
      if (step.op === 'call' && typeof step.function !== 'string') throw new Error(`${at2}: call needs function`);
      if (step.op === 'request' && (typeof step.method !== 'string' || typeof step.path !== 'string')) throw new Error(`${at2}: request needs method + path`);
      if (!['submit', 'report', 'call', 'request'].includes(step.op)) throw new Error(`${at2}: unknown op ${step.op}`);
      const stepExpect = (step as { expect?: GoldenStepExpect }).expect;
      if (stepExpect?.unordered !== undefined && typeof stepExpect.unordered !== 'boolean') {
        throw new Error(`${at2}.expect.unordered must be a boolean`);
      }
    }
    const expect = (entry as unknown as GoldenCase).expect;
    if (expect?.tables !== undefined && !isObject(expect.tables)) throw new Error(`${at}.expect.tables must be an object`);
    if (expect?.unordered !== undefined && typeof expect.unordered !== 'boolean') throw new Error(`${at}.expect.unordered must be a boolean`);
  }
  return parsed as unknown as GoldenFile;
}

// ---------- normalized comparison ----------

const ID_SHAPE = /^\d{15,20}$/;
const TS_SHAPE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function markerMatches(marker: string, actual: unknown): boolean {
  if (marker === '<any>') return true;
  if (marker === '<id>') return (typeof actual === 'string' && ID_SHAPE.test(actual)) || (typeof actual === 'number' && actual >= 1e14);
  if (marker === '<timestamp>') return typeof actual === 'string' && TS_SHAPE.test(actual);
  return false;
}

export interface BehaviorFinding {
  case: string;
  /** 1-based step index when the diff is a step response; absent for table diffs. */
  step?: number;
  /** JSON-path-ish pointer: body.values.Title, tables.Book[2].Title, status. */
  pointer: string;
  expected: unknown;
  actual: unknown;
}

/**
 * Volatile system values — ids and timestamps — are the only extra object
 * keys an actual value may carry unlisted: they are generated per run, so the
 * golden names them with markers when it asserts them, and they are ignored
 * otherwise. Any other extra or missing key is a finding.
 */
function isVolatile(value: unknown): boolean {
  return markerMatches('<id>', value) || markerMatches('<timestamp>', value);
}

/**
 * Recursive match with exact key sets: every expected key/element must exist
 * in actual and match, and every actual key must be expected unless its value
 * is volatile (id/timestamp-shaped). Arrays compare in order; `unordered`
 * opts into multiset matching for the golden that declares it. Scalar
 * equality is strict; expected marker strings match a value class instead of
 * a literal. Returns true when actual satisfies expected; findings are
 * appended.
 */
function matchValue(expected: unknown, actual: unknown, pointer: string, findings: Omit<BehaviorFinding, 'case'>[], unordered: boolean): boolean {
  if (typeof expected === 'string' && (MARKERS as readonly string[]).includes(expected)) {
    if (markerMatches(expected, actual)) return true;
    findings.push({ pointer, expected, actual });
    return false;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      findings.push({ pointer, expected: `array[${expected.length}]`, actual });
      return false;
    }
    let ok = true;
    if (unordered) {
      const used = new Set<number>();
      expected.forEach((want, i) => {
        const at = actual.findIndex((got, j) => !used.has(j) && matchSilent(want, got, unordered));
        if (at < 0) {
          findings.push({ pointer: `${pointer}[${i}]`, expected: want, actual: 'no matching element' });
          ok = false;
        } else {
          used.add(at);
        }
      });
    } else {
      const count = Math.min(expected.length, actual.length);
      for (let i = 0; i < count; i++) {
        if (!matchValue(expected[i], actual[i], `${pointer}[${i}]`, findings, unordered)) ok = false;
      }
      for (let i = count; i < expected.length; i++) {
        findings.push({ pointer: `${pointer}[${i}]`, expected: expected[i], actual: '(absent)' });
        ok = false;
      }
    }
    if (actual.length > expected.length) {
      findings.push({ pointer, expected: `${expected.length} elements`, actual: `${actual.length} elements` });
      ok = false;
    }
    return ok;
  }
  if (isObject(expected)) {
    if (!isObject(actual)) {
      findings.push({ pointer, expected, actual });
      return false;
    }
    let ok = true;
    for (const [key, want] of Object.entries(expected)) {
      if (!(key in actual)) {
        findings.push({ pointer: `${pointer}.${key}`, expected: want, actual: '(absent)' });
        ok = false;
      } else if (!matchValue(want, actual[key], `${pointer}.${key}`, findings, unordered)) {
        ok = false;
      }
    }
    for (const [key, got] of Object.entries(actual)) {
      if (!(key in expected) && !isVolatile(got)) {
        findings.push({ pointer: `${pointer}.${key}`, expected: '(absent)', actual: got });
        ok = false;
      }
    }
    return ok;
  }
  if (Object.is(expected, actual)) return true;
  // Normalization: a numeric cell compares equal across the text/number
  // boundary — Creator stores and exports text; Catalyst columns are typed.
  if (typeof expected === 'string' && typeof actual === 'number' && expected === String(actual)) return true;
  if (typeof expected === 'number' && typeof actual === 'string' && String(expected) === actual) return true;
  findings.push({ pointer, expected, actual });
  return false;
}

/** Diff-free probe used by multiset array matching. */
function matchSilent(expected: unknown, actual: unknown, unordered: boolean): boolean {
  const scratch: Omit<BehaviorFinding, 'case'>[] = [];
  return matchValue(expected, actual, '', scratch, unordered);
}

function matchRows(expectedRows: Record<string, unknown>[], actualRows: Record<string, unknown>[], pointer: string, findings: Omit<BehaviorFinding, 'case'>[], unordered: boolean): void {
  if (unordered) {
    const used = new Set<number>();
    expectedRows.forEach((want, i) => {
      const at = actualRows.findIndex((got, j) => !used.has(j) && matchSilent(want, got, unordered));
      if (at < 0) {
        findings.push({ pointer: `${pointer}[${i}]`, expected: want, actual: 'no matching row' });
      } else {
        used.add(at);
      }
    });
    const extra = actualRows.length - used.size;
    if (extra > 0) {
      findings.push({ pointer, expected: `${expectedRows.length} rows`, actual: `${actualRows.length} rows (${extra} unexpected)` });
    }
    return;
  }
  const count = Math.min(expectedRows.length, actualRows.length);
  for (let i = 0; i < count; i++) {
    matchValue(expectedRows[i], actualRows[i], `${pointer}[${i}]`, findings, unordered);
  }
  for (let i = count; i < expectedRows.length; i++) {
    findings.push({ pointer: `${pointer}[${i}]`, expected: expectedRows[i], actual: '(absent)' });
  }
  if (actualRows.length > expectedRows.length) {
    findings.push({ pointer, expected: `${expectedRows.length} rows`, actual: `${actualRows.length} rows` });
  }
}

// ---------- backends ----------

export interface BehaviorCall {
  status: number;
  body: unknown;
}

export interface BehaviorBackend {
  /** POST/GET a path under the function base; returns the JSON reply. */
  call(method: string, path: string, body: unknown): Promise<BehaviorCall>;
  /** All stored rows of a Catalyst table, for expect.tables comparison. */
  tableRows(table: string): Promise<Record<string, unknown>[]>;
  /** Clear stored state between golden cases. */
  reset?(): Promise<void>;
  close(): Promise<void>;
}

export interface OfflineHarnessOptions {
  /** Deploy mode baked into the generated tree; 'live' writes through the fake SDK. */
  mode?: 'live' | 'dry-run';
  /** Override the fake SDK path (tests). Defaults to tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs. */
  fakeSdk?: string;
}

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]> };
  executeZCQLQuery(sql: string): Promise<unknown>;
}

function offlineGuard(app: App): GuardOk {
  return {
    org: '0',
    projectId: '0',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: emptyRegistry(),
  };
}

/**
 * Generate the deploy tree into a temp dir and serve functions/c2c_api on
 * loopback, loading `zcatalyst-sdk-node` as the in-process fake SDK — the same
 * load path tools/catalyst-harness/serve.mjs uses. Nothing is written outside
 * the temp dir; close() removes it.
 */
export async function startOfflineBackend(app: App, opts: OfflineHarnessOptions = {}): Promise<BehaviorBackend> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-behavior-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  const fake = opts.fakeSdk ?? join(repoRoot(), 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
  const savedEnv = new Map<string, string | undefined>();
  let server: Server | undefined;
  try {
    writeDeployTree(dir, deployFiles(app, offlineGuard(app), false, { mode: opts.mode ?? 'live' }).files);
    const fnDir = join(dir, 'functions/c2c_api');
    const config = JSON.parse(readFileSync(join(fnDir, 'catalyst-config.json'), 'utf8')) as { deployment?: { env_variables?: Record<string, string> } };
    for (const [key, value] of Object.entries(config.deployment?.env_variables ?? {})) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = String(value);
    }
    savedEnv.set('C2C_DEPLOY_MODE', process.env.C2C_DEPLOY_MODE);
    process.env.C2C_DEPLOY_MODE = opts.mode ?? 'live';
    moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
      if (request === 'zcatalyst-sdk-node') return fake;
      return original.call(this, request, ...rest);
    };
    const req = createRequire(import.meta.url);
    const sdk = req(fake) as FakeSdk;
    const token = 'c2c-behavior';
    sdk.setSession(token, { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });
    const entry = req(join(fnDir, 'index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { 'content-type': 'application/json', cookie: `c2c-harness-session=${token}` };
    return {
      async call(method, path, body) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text.slice(0, 300) };
        }
        return { status: res.status, body: parsed };
      },
      async tableRows(table) {
        return sdk.state().tables[table] ?? [];
      },
      async reset() {
        for (const table of Object.keys(sdk.state().tables)) await sdk.executeZCQLQuery(`DELETE FROM ${table}`);
      },
      async close() {
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
        moduleAny._resolveFilename = original;
        for (const [key, value] of savedEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    moduleAny._resolveFilename = original;
    if (server) server.close();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Live backend: the deployed function over HTTPS plus an admin ZCQL read-back (smoke's binding). */
export function liveBackend(opts: {
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;
  base: string;
  auth: { token?: string; cookie?: string };
  query: (table: string) => Promise<Record<string, unknown>[]>;
}): BehaviorBackend {
  const base = opts.base.replace(/\/+$/, '');
  return {
    async call(method, path, body) {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (opts.auth.token) headers.authorization = opts.auth.token;
      if (opts.auth.cookie) headers.cookie = opts.auth.cookie;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await opts.fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 300) };
      }
      return { status: res.status, body: parsed };
    },
    tableRows: (table) => opts.query(table),
    async close() {},
  };
}

// ---------- runner ----------

function stepEndpoint(step: GoldenStep, model: UiModel): { method: string; path: string; body: unknown } {
  if (step.op === 'submit') {
    const form = model.forms.find((f) => f.name === step.form);
    if (!form) throw new Error(`no form ${step.form} in the migrated app`);
    return { method: 'POST', path: form.submitEndpoint, body: { record: step.record } };
  }
  if (step.op === 'report') {
    const report = model.reports.find((r) => r.name === step.report);
    if (!report) throw new Error(`no report ${step.report} in the migrated app`);
    return { method: 'POST', path: report.queryEndpoint, body: { op: 'query', page: 0, pageSize: 300, ...step.body } };
  }
  if (step.op === 'call') {
    return { method: 'POST', path: `/functions/${slug(step.function)}`, body: { args: step.args ?? {} } };
  }
  return { method: step.method, path: step.path, body: step.body };
}

function stepLabel(step: GoldenStep): string {
  if (step.op === 'submit') return `submit ${step.form}`;
  if (step.op === 'report') return `report ${step.report}`;
  if (step.op === 'call') return `call ${step.function}`;
  return `${step.method} ${step.path}`;
}

export interface BehaviorRunResult {
  report: BehaviorReport;
  findings: BehaviorFinding[];
}

export interface BehaviorReport {
  version: typeof REPORT_VERSION;
  app: string;
  mode: 'offline' | 'live';
  ok: boolean;
  behaviorEquivalentApps: 0 | 1;
  summary: { cases: number; steps: number; findings: number };
  findings: BehaviorFinding[];
}

export async function runBehavior(app: App, golden: GoldenFile, backend: BehaviorBackend, mode: 'offline' | 'live'): Promise<BehaviorRunResult> {
  const model = generateUi(app).model;
  const findings: BehaviorFinding[] = [];
  let stepCount = 0;
  for (const kase of golden.cases) {
    const at = (f: Omit<BehaviorFinding, 'case'>) => findings.push({ case: kase.id, ...f });
    await backend.reset?.();
    for (const [i, step] of kase.steps.entries()) {
      stepCount += 1;
      const stepNo = i + 1;
      let endpoint: { method: string; path: string; body: unknown };
      try {
        endpoint = stepEndpoint(step, model);
      } catch (err) {
        at({ step: stepNo, pointer: stepLabel(step), expected: 'a generated endpoint', actual: err instanceof Error ? err.message : 'unresolvable' });
        continue;
      }
      const res = await backend.call(endpoint.method, endpoint.path, endpoint.body);
      const want = step.expect ?? {};
      const wantStatus = want.status ?? 200;
      if (res.status !== wantStatus) at({ step: stepNo, pointer: `${endpoint.path} status`, expected: wantStatus, actual: res.status });
      if (want.body !== undefined) {
        const diffs: Omit<BehaviorFinding, 'case'>[] = [];
        matchValue(want.body, res.body, 'body', diffs, want.unordered === true);
        for (const d of diffs) at({ step: stepNo, ...d });
      }
    }
    for (const [table, expectedRows] of Object.entries(kase.expect?.tables ?? {})) {
      const actualRows = await backend.tableRows(table);
      const diffs: Omit<BehaviorFinding, 'case'>[] = [];
      matchRows(expectedRows, actualRows, `tables.${table}`, diffs, kase.expect?.unordered === true);
      for (const d of diffs) at(d);
    }
  }
  const report: BehaviorReport = {
    version: REPORT_VERSION,
    app: app.name || 'app',
    mode,
    ok: findings.length === 0,
    behaviorEquivalentApps: findings.length === 0 ? 1 : 0,
    summary: { cases: golden.cases.length, steps: stepCount, findings: findings.length },
    findings,
  };
  return { report, findings };
}

// ---------- reports ----------

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value);
}

export function formatBehaviorMarkdown(report: BehaviorReport, goldenDir?: string): string {
  const lines = [
    `# c2c verify-behavior — ${report.app}`,
    '',
    `mode: ${report.mode}${goldenDir ? ` · goldens: ${goldenDir}` : ''}`,
    `cases: ${report.summary.cases} · steps: ${report.summary.steps} · findings: ${report.summary.findings}`,
    '',
  ];
  if (report.findings.length) {
    lines.push('| case | step | at | expected | actual |', '| --- | --- | --- | --- | --- |');
    for (const f of report.findings) {
      lines.push(`| ${f.case} | ${f.step ?? '—'} | ${f.pointer} | ${show(f.expected)} | ${show(f.actual)} |`);
    }
    lines.push('');
  } else {
    lines.push('No differences.', '');
  }
  lines.push(`behavior-equivalent apps: ${report.behaviorEquivalentApps}`);
  return `${lines.join('\n')}\n`;
}

export function formatBehaviorJson(report: BehaviorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
