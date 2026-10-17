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
import { appTimeZone } from '../../ui/src/generate.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from './guards.js';
import { deployFiles, writeDeployTree } from './plan.js';
import { emptyRegistry } from './registry.js';
import { tableCreatePlan, type TableCreateStep } from './tables.js';
import { comparisonZone, temporalEqual } from './temporal.js';

// ---------- golden schema ----------

export const GOLDEN_VERSION = 'c2c-behavior-golden/2';
export const REPORT_VERSION = 'c2c-behavior-report/1';

/** Normalization markers an expected value may use (tests/behavior/SCHEMA.md). */
export const MARKERS = ['<any>', '<id>', '<timestamp>'] as const;

/** Status classes a step may expect instead of an exact code. */
export const STATUS_CLASSES = ['2xx', '4xx', '5xx'] as const;

/**
 * Outcome classes a step may expect instead of an exact body — the shape a
 * captured Creator reply maps to without pinning the c2c reply text:
 * `saved` (2xx, wrote, no warning), `saved-with-warning` (2xx, wrote, a
 * warning — Creator's code 3000 with an on-success error array), `refused`
 * (4xx, nothing written), `rows` (2xx report rows; `count` pins how many).
 */
export const OUTCOMES = ['saved', 'saved-with-warning', 'refused', 'rows'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Case/step tags the runner acts on; other tags are carried into findings. */
export const ENV_ARTIFACT_TAG = /^env-artifact:/;

/**
 * Step tag for a write the Creator REST API accepted but the Creator form
 * would block: the record sets a field a field rule hides or disables. c2c
 * refuses that client input by design; the step lists the fields in `apiOnly`.
 */
export const API_ONLY_TAG = 'api-only-acceptance';

/** `<ref:name>` — a value an earlier step bound with `bind`. */
const REF = /<ref:([A-Za-z0-9_.-]+)>/g;

export interface GoldenStepExpect {
  /** Exact HTTP status, or a class (`2xx`, `4xx`, `5xx`). */
  status?: number | (typeof STATUS_CLASSES)[number];
  /** Outcome class (OUTCOMES); checked in addition to `status`. */
  outcome?: Outcome;
  /** With outcome `rows`: the number of report rows. */
  count?: number;
  /** Compare `body` objects as subsets: unlisted actual keys are not findings. */
  partial?: boolean;
  /**
   * Recursive match against the JSON response body. Arrays compare in order;
   * set `unordered: true` to match them as multisets instead.
   */
  body?: unknown;
  /** Match arrays in `body` as multisets (opt-in; default is ordered). */
  unordered?: boolean;
}

/** Fields every step may carry besides its op. */
export interface GoldenStepCommon {
  expect?: GoldenStepExpect;
  /** name -> pointer into the reply (`body.values.ROWID`); later steps use `<ref:name>`. */
  bind?: Record<string, string>;
  /** A prerequisite: replayed and bound, its reply is not compared. */
  setup?: boolean;
  /** Tags carried into findings; `env-artifact:*` skips comparing this step's reply. */
  tags?: string[];
  /** The captured Creator reply (code, message, error) — documentation, not compared. */
  creator?: Record<string, unknown>;
  /**
   * With tag `api-only-acceptance`: the record's fields (`Sub.Field` for a
   * subform column) a form field rule hides or disables. The record as
   * captured must be refused; the step is then replayed without them, as the
   * form submits it, and that reply is the one compared.
   */
  apiOnly?: string[];
}

export type GoldenStep = GoldenStepCommon &
  (
    | { op: 'submit'; form: string; record: Record<string, unknown> }
    | { op: 'report'; report: string; body?: Record<string, unknown> }
    | { op: 'call'; function: string; args?: Record<string, unknown> }
    | { op: 'request'; method: string; path: string; body?: unknown }
    /**
     * Creator's update-by-criteria: read the report, keep the rows whose
     * fields equal every `where` value, and submit `record` as an edit of
     * each. The reply compared is `{matched, updated, refused}`.
     */
    | { op: 'update'; report: string; where: Record<string, unknown>; record: Record<string, unknown> }
  );

export interface GoldenCase {
  id: string;
  name?: string;
  /** Tags carried into this case's findings. */
  tags?: string[];
  /** Why this case is not replayed (e.g. unreachable via API); reported as skipped, never as a pass. */
  skip?: string;
  /** Free-text notes (lookup substitutions, capture caveats) — documentation. */
  notes?: string[];
  steps: GoldenStep[];
  expect?: {
    /** Compare `tables` rows as subsets: unlisted stored columns are not findings. */
    partial?: boolean;
    /** Catalyst table -> complete expected contents; rows match in order unless `unordered`. */
    tables?: Record<string, Record<string, unknown>[]>;
    /** Match `tables` rows as multisets (opt-in; default is ordered). */
    unordered?: boolean;
  };
}

export interface GoldenFile {
  version: string;
  app?: string;
  /**
   * The Creator export the golden was captured against, when it is not
   * committed as app.ds beside creator/ (not redistributable).
   */
  source?: { file: string; origin?: string; redistributable?: boolean; note?: string };
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
      if (step.op === 'update' && (typeof step.report !== 'string' || !isObject(step.where) || !isObject(step.record))) throw new Error(`${at2}: update needs report + where + record`);
      if (!['submit', 'report', 'call', 'request', 'update'].includes(step.op)) throw new Error(`${at2}: unknown op ${step.op}`);
      const stepExpect = (step as { expect?: GoldenStepExpect }).expect;
      if (stepExpect?.unordered !== undefined && typeof stepExpect.unordered !== 'boolean') {
        throw new Error(`${at2}.expect.unordered must be a boolean`);
      }
      if (stepExpect?.partial !== undefined && typeof stepExpect.partial !== 'boolean') throw new Error(`${at2}.expect.partial must be a boolean`);
      const status = stepExpect?.status;
      if (status !== undefined && !(Number.isInteger(status) || (STATUS_CLASSES as readonly unknown[]).includes(status))) {
        throw new Error(`${at2}.expect.status must be an integer or one of ${STATUS_CLASSES.join(', ')}`);
      }
      if (stepExpect?.outcome !== undefined && !(OUTCOMES as readonly unknown[]).includes(stepExpect.outcome)) {
        throw new Error(`${at2}.expect.outcome must be one of ${OUTCOMES.join(', ')}`);
      }
      if (stepExpect?.count !== undefined && (!Number.isInteger(stepExpect.count) || stepExpect.outcome !== 'rows')) {
        throw new Error(`${at2}.expect.count must be an integer and needs outcome rows`);
      }
      if (step.bind !== undefined && (!isObject(step.bind) || !Object.values(step.bind).every((v) => typeof v === 'string' && /^body(\.|$)/.test(v)))) {
        throw new Error(`${at2}.bind must map names to body pointers (body.values.ROWID)`);
      }
      if (step.setup !== undefined && typeof step.setup !== 'boolean') throw new Error(`${at2}.setup must be a boolean`);
      assertTags(step.tags, `${at2}.tags`);
      const apiOnly = step.apiOnly;
      const apiTagged = Array.isArray(step.tags) && step.tags.includes(API_ONLY_TAG);
      if (apiOnly !== undefined && !(Array.isArray(apiOnly) && apiOnly.length > 0 && apiOnly.every((f) => typeof f === 'string' && f.length > 0))) {
        throw new Error(`${at2}.apiOnly must be non-empty field names`);
      }
      if (apiTagged !== (apiOnly !== undefined)) throw new Error(`${at2}: tag ${API_ONLY_TAG} and apiOnly go together`);
      if (apiOnly !== undefined && step.op !== 'submit' && step.op !== 'update') throw new Error(`${at2}.apiOnly needs a submit or update step`);
      if (step.creator !== undefined && !isObject(step.creator)) throw new Error(`${at2}.creator must be an object`);
    }
    const expect = (entry as unknown as GoldenCase).expect;
    if (expect?.tables !== undefined && !isObject(expect.tables)) throw new Error(`${at}.expect.tables must be an object`);
    if (expect?.unordered !== undefined && typeof expect.unordered !== 'boolean') throw new Error(`${at}.expect.unordered must be a boolean`);
    if (expect?.partial !== undefined && typeof expect.partial !== 'boolean') throw new Error(`${at}.expect.partial must be a boolean`);
    assertTags(entry.tags, `${at}.tags`);
    if (entry.skip !== undefined && (typeof entry.skip !== 'string' || !entry.skip)) throw new Error(`${at}.skip must be a non-empty reason`);
    if (entry.notes !== undefined && !(Array.isArray(entry.notes) && entry.notes.every((n) => typeof n === 'string'))) throw new Error(`${at}.notes must be strings`);
  }
  const source = parsed.source;
  if (source !== undefined && (!isObject(source) || typeof source.file !== 'string' || !source.file)) throw new Error('golden source must name the Creator export file');
  return parsed as unknown as GoldenFile;
}

function assertTags(tags: unknown, at: string): void {
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === 'string' && t.length > 0))) throw new Error(`${at} must be non-empty strings`);
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
  /** The case's and step's tags, when the golden declares any. */
  tags?: string[];
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
function matchValue(expected: unknown, actual: unknown, pointer: string, findings: Omit<BehaviorFinding, 'case'>[], unordered: boolean, partial = false, zone?: string): boolean {
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
        const at = actual.findIndex((got, j) => !used.has(j) && matchSilent(want, got, unordered, partial, zone));
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
        if (!matchValue(expected[i], actual[i], `${pointer}[${i}]`, findings, unordered, partial, zone)) ok = false;
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
      } else if (!matchValue(want, actual[key], `${pointer}.${key}`, findings, unordered, partial, zone)) {
        ok = false;
      }
    }
    for (const [key, got] of Object.entries(actual)) {
      if (!partial && !(key in expected) && !isVolatile(got)) {
        findings.push({ pointer: `${pointer}.${key}`, expected: '(absent)', actual: got });
        ok = false;
      }
    }
    return ok;
  }
  if (Object.is(expected, actual)) return true;
  // Normalization: a numeric cell compares equal across the text/number
  // boundary — Creator stores and exports text; Catalyst columns are typed.
  // A date or date-time compares in one normal form (Creator `dd-MMM-yyyy`, Catalyst ISO).
  if (textBoundaryEqual(expected, actual, zone)) return true;
  findings.push({ pointer, expected, actual });
  return false;
}

const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * Creator cells are text; Catalyst columns are typed. A number equals its
 * numeric text by value (`2` = `"2"`, `947` = `"947.00"`), and a boolean
 * equals `"true"`/`"false"`. Two date or date-time strings compare in the
 * {@link temporalEqual} normal form, date-times in the app zone `zone`. Other
 * strings and two numbers still compare strictly.
 */
export function textBoundaryEqual(expected: unknown, actual: unknown, zone?: string): boolean {
  if (temporalEqual(expected, actual, zone)) return true;
  const pair = [expected, actual];
  const text = pair.find((v) => typeof v === 'string') as string | undefined;
  if (text === undefined) return false;
  const other = pair.find((v) => typeof v !== 'string');
  if (typeof other === 'number') return NUMERIC_TEXT.test(text) && Number(text) === other;
  if (typeof other === 'boolean') return text === String(other);
  return false;
}

/** Diff-free probe used by multiset array matching. */
function matchSilent(expected: unknown, actual: unknown, unordered: boolean, partial = false, zone?: string): boolean {
  const scratch: Omit<BehaviorFinding, 'case'>[] = [];
  return matchValue(expected, actual, '', scratch, unordered, partial, zone);
}

function matchRows(expectedRows: Record<string, unknown>[], actualRows: Record<string, unknown>[], pointer: string, findings: Omit<BehaviorFinding, 'case'>[], unordered: boolean, partial = false, zone?: string): void {
  if (unordered) {
    const used = new Set<number>();
    expectedRows.forEach((want, i) => {
      const at = actualRows.findIndex((got, j) => !used.has(j) && matchSilent(want, got, unordered, partial, zone));
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
    matchValue(expectedRows[i], actualRows[i], `${pointer}[${i}]`, findings, unordered, partial, zone);
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
  /** Write rows straight into a Data Store table, the way the data loader lands them (offline only). */
  insertRows?(table: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export interface OfflineHarnessOptions {
  /** Deploy mode baked into the generated tree; 'live' writes through the fake SDK. */
  mode?: 'live' | 'dry-run';
  /** Override the fake SDK path (tests). Defaults to tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs. */
  fakeSdk?: string;
}

interface FakeSdk {
  initialize(req: unknown, opts?: { scope?: string }): { datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> } } };
  setSession(token: string, user: unknown): void;
  /** Columns the table plan creates is_unique, enforced as Data Store does. */
  setUnique?(declared: Record<string, string[]>): void;
  state(): { tables: Record<string, Record<string, unknown>[]> };
  executeZCQLQuery(sql: string): Promise<unknown>;
}

/** table → the columns its create step marks is_unique (the store enforces only these). */
export function uniqueByTable(steps: readonly TableCreateStep[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const step of steps) {
    for (const column of step.columns) {
      if (column.is_unique) (out[step.table] ??= []).push(column.column_name);
    }
  }
  return out;
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
    const generated = deployFiles(app, offlineGuard(app), false, { mode: opts.mode ?? 'live' });
    writeDeployTree(dir, generated.files);
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
    sdk.setUnique?.(uniqueByTable(tableCreatePlan(generated.schema)));
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
      insertRows(table, rows) {
        return sdk.initialize(undefined, { scope: 'admin' }).datastore().table(table).insertRows(rows);
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

function stepEndpoint(step: Exclude<GoldenStep, { op: 'update' }>, model: UiModel): { method: string; path: string; body: unknown } {
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
  if (step.op === 'update') return `update ${step.report}`;
  if (step.op === 'report') return `report ${step.report}`;
  if (step.op === 'call') return `call ${step.function}`;
  return `${step.method} ${step.path}`;
}

export interface BehaviorRunResult {
  report: BehaviorReport;
  findings: BehaviorFinding[];
}

export type BehaviorStatus = 'equivalent' | 'not-equivalent' | 'not-run';

export interface BehaviorReport {
  version: typeof REPORT_VERSION;
  app: string;
  mode: 'offline' | 'live';
  /**
   * `equivalent`: every case replayed with no finding. `not-equivalent`: a
   * finding, or any skipped case (a skip is never a pass). `not-run`: no case
   * was replayed (every case skipped, or none at all).
   */
  status: BehaviorStatus;
  ok: boolean;
  behaviorEquivalentApps: 0 | 1;
  summary: { cases: number; steps: number; findings: number; skipped: number; replayed: number; equivalentCases: number; equivalentByDesign: number };
  findings: BehaviorFinding[];
  /** Cases the golden marks `skip` (not replayed, never counted as passing). */
  skipped?: { case: string; reason: string }[];
  /** Steps tagged `env-artifact:*`: replayed, reply not compared. */
  envArtifacts?: { case: string; step: number; tags: string[] }[];
  /**
   * Equivalent by design: the captured record was refused for client input
   * (`api-only-acceptance`). Neither a finding nor a pass.
   */
  equivalentByDesign?: { case: string; step: number; class: typeof API_ONLY_TAG; fields: string[]; actual: string }[];
}

/**
 * Replace every `<ref:name>` with the value an earlier step bound. A value
 * that is exactly one ref takes the bound value as is (number, string);
 * a ref inside a longer string is spliced in as text. An unbound ref is
 * left in place and reported once.
 */
function resolveRefs(value: unknown, refs: Map<string, unknown>, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    const whole = /^<ref:([A-Za-z0-9_.-]+)>$/.exec(value);
    if (whole) {
      if (refs.has(whole[1]!)) return refs.get(whole[1]!);
      missing.add(whole[1]!);
      return value;
    }
    return value.replace(REF, (text, name: string) => {
      if (refs.has(name)) return String(refs.get(name));
      missing.add(name);
      return text;
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, refs, missing));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, refs, missing)]));
  return value;
}

/** Read `body.values.ROWID`-style pointers out of a reply. */
function readPointer(res: BehaviorCall, pointer: string): unknown {
  let at: unknown = { body: res.body };
  for (const part of pointer.split('.')) {
    if (!isObject(at) && !Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

function statusMatches(want: number | string, actual: number): boolean {
  if (typeof want === 'number') return want === actual;
  return String(Math.floor(actual / 100)) === want[0];
}

/** Outcome diff: undefined when the reply has the expected outcome class. */
function outcomeDiff(want: Outcome, count: number | undefined, res: BehaviorCall): unknown {
  const body = isObject(res.body) ? res.body : {};
  const ok2xx = res.status >= 200 && res.status < 300;
  const said = [body.code, body.message ?? body.error].filter((part) => typeof part === 'string').join(' ');
  const seen = `${res.status}${body.wrote === true ? ' wrote' : ''}${body.warning !== undefined ? ' warning' : ''}${Array.isArray(body.rows) ? ` rows:${body.rows.length}` : ''}${said ? ` (${said})` : ''}`;
  let ok: boolean;
  if (want === 'saved') ok = ok2xx && body.wrote === true && body.warning === undefined;
  else if (want === 'saved-with-warning') ok = ok2xx && body.wrote === true && body.warning !== undefined;
  else if (want === 'refused') ok = res.status >= 400 && res.status < 500 && body.wrote !== true;
  else ok = ok2xx && Array.isArray(body.rows) && (count === undefined || body.rows.length === count);
  return ok ? undefined : seen;
}

/** True when a report row's field equals the `where` value (text/number boundary, date normal form, display objects). */
export function whereMatches(row: Record<string, unknown>, where: Record<string, unknown>, zone?: string): boolean {
  return Object.entries(where).every(([field, want]) => {
    const got = row[field];
    if (got === want) return true;
    if (got !== null && got !== undefined && want !== null && typeof got !== 'object' && String(got) === String(want)) return true;
    if (temporalEqual(got, want, zone)) return true;
    return isObject(got) && (got.display_value === want || got.zc_display_value === want);
  });
}

/** The record without the `apiOnly` fields: what the form submits. `Sub.Field` drops the column from every row. */
function withoutApiOnly(record: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  for (const field of fields) {
    const [top, column] = field.split('.', 2) as [string, string | undefined];
    if (column === undefined) {
      delete out[top];
      continue;
    }
    const rows = out[top];
    if (Array.isArray(rows)) out[top] = rows.map((row) => (isObject(row) ? Object.fromEntries(Object.entries(row).filter(([k]) => k !== column)) : row));
  }
  return out;
}

/** True when the reply refused the write: a 4xx submit with nothing written, or an update that changed no matched row. */
function refusedClientInput(step: GoldenStep, res: BehaviorCall): boolean {
  const body = isObject(res.body) ? res.body : {};
  if (step.op === 'update') return typeof body.matched === 'number' && body.matched > 0 && body.updated === 0;
  return res.status >= 400 && res.status < 500 && body.wrote !== true;
}

/**
 * True when Creator stored the captured write: a saved outcome, an update that
 * changed rows, or a 3000 reply (an env-artifact step's reply is not compared).
 */
function creatorAccepted(step: GoldenStep): boolean {
  const want = step.expect;
  if (want?.outcome === 'saved' || want?.outcome === 'saved-with-warning') return true;
  if (step.op === 'update' && isObject(want?.body) && typeof want.body.updated === 'number' && want.body.updated > 0) return true;
  const codes = step.creator ? [step.creator.code, ...(Array.isArray(step.creator.codes) ? step.creator.codes : [])] : [];
  return codes.includes(3000);
}

async function runUpdate(step: Extract<GoldenStep, { op: 'update' }>, model: UiModel, backend: BehaviorBackend, zone?: string): Promise<BehaviorCall> {
  const report = model.reports.find((r) => r.name === step.report);
  if (!report) throw new Error(`no report ${step.report} in the migrated app`);
  const form = model.forms.find((f) => f.name === report.form);
  if (!form) throw new Error(`report ${step.report} has no form to edit`);
  const read = await backend.call('POST', report.queryEndpoint, { op: 'query', page: 0, pageSize: 300 });
  const rows = isObject(read.body) && Array.isArray(read.body.rows) ? (read.body.rows as unknown[]).filter(isObject) : null;
  if (read.status !== 200 || !rows) return { status: read.status, body: { error: 'report read failed', reply: read.body } };
  const matched = rows.filter((row) => whereMatches(row, step.where, zone));
  let updated = 0;
  let refused = 0;
  for (const row of matched) {
    const res = await backend.call('POST', form.editSubmitEndpoint ?? form.submitEndpoint, { ROWID: row.ROWID, record: step.record });
    if (res.status >= 200 && res.status < 300 && isObject(res.body) && res.body.wrote === true) updated += 1;
    else refused += 1;
  }
  return { status: 200, body: { matched: matched.length, updated, refused } };
}

export async function runBehavior(app: App, golden: GoldenFile, backend: BehaviorBackend, mode: 'offline' | 'live'): Promise<BehaviorRunResult> {
  const model = generateUi(app).model;
  // Date-times compare in the app zone the generated app runs in: `C2C_APP_TIMEZONE`, else the app setting.
  const zone = comparisonZone(process.env.C2C_APP_TIMEZONE?.trim() || appTimeZone(app));
  const findings: BehaviorFinding[] = [];
  const skipped: { case: string; reason: string }[] = [];
  const envArtifacts: { case: string; step: number; tags: string[] }[] = [];
  const equivalentByDesign: NonNullable<BehaviorReport['equivalentByDesign']> = [];
  let stepCount = 0;
  let equivalentCases = 0;
  for (const kase of golden.cases) {
    if (kase.skip) {
      skipped.push({ case: kase.id, reason: kase.skip });
      continue;
    }
    const findingsBefore = findings.length;
    const caseTags = kase.tags ?? [];
    const at = (f: Omit<BehaviorFinding, 'case'>, stepTags: string[] = []) => {
      const tags = [...new Set([...caseTags, ...stepTags])];
      findings.push({ case: kase.id, ...f, ...(tags.length ? { tags } : {}) });
    };
    const refs = new Map<string, unknown>();
    // Client-sent values of apiOnly fields, per form: Creator stored them, the
    // form could not have sent them, so a table column holding exactly that
    // value is not compared. A different stored value (set by the app's own
    // workflow) still is.
    const apiOnlySent = new Map<string, Map<string, unknown[]>>();
    await backend.reset?.();
    for (const [i, raw] of kase.steps.entries()) {
      stepCount += 1;
      const stepNo = i + 1;
      const stepTags = raw.tags ?? [];
      const missing = new Set<string>();
      const step = resolveRefs(raw, refs, missing) as GoldenStep;
      const want = (resolveRefs(raw.expect ?? {}, refs, missing) as GoldenStepExpect);
      for (const name of [...missing].sort()) at({ step: stepNo, pointer: `<ref:${name}>`, expected: 'a value bound by an earlier step', actual: '(unbound)' }, stepTags);
      let res: BehaviorCall;
      let path: string;
      const send = async (sent: GoldenStep): Promise<BehaviorCall> => {
        if (sent.op === 'update') return runUpdate(sent, model, backend, zone);
        const endpoint = stepEndpoint(sent, model);
        return backend.call(endpoint.method, endpoint.path, endpoint.body);
      };
      try {
        path = step.op === 'update' ? `update ${step.report}` : stepEndpoint(step, model).path;
        let sent = step;
        if (raw.apiOnly && (step.op === 'submit' || step.op === 'update')) {
          const fields = raw.apiOnly;
          const form = step.op === 'submit' ? step.form : model.reports.find((r) => r.name === step.report)?.form ?? step.report;
          const byField = apiOnlySent.get(form) ?? new Map<string, unknown[]>();
          apiOnlySent.set(form, byField);
          for (const field of fields) {
            const value = step.record[field];
            if (value !== null && value !== undefined && typeof value !== 'object') byField.set(field, [...(byField.get(field) ?? []), value]);
          }
          // Only a write Creator stored is api-only acceptance; a setup step or
          // a write Creator refused anyway is replayed as the form sends it.
          if (!raw.setup && creatorAccepted(raw)) {
            const captured = await send(step);
            const seen = outcomeDiff('refused', undefined, captured) ?? `${captured.status} refused`;
            if (refusedClientInput(step, captured)) {
              const body = isObject(captured.body) ? captured.body : {};
              const text = [body.code, body.message ?? body.error].filter((part) => typeof part === 'string').join(' ');
              const said = text ? ` (${text})` : '';
              equivalentByDesign.push({ case: kase.id, step: stepNo, class: API_ONLY_TAG, fields: [...fields], actual: step.op === 'update' ? `update refused ${String(body.refused)} of ${String(body.matched)}` : `${captured.status}${said}` });
            } else {
              at({ step: stepNo, pointer: `${path} client input ${fields.join(', ')}`, expected: 'refused for client input', actual: seen }, stepTags);
            }
          }
          sent = { ...step, record: withoutApiOnly(step.record, fields) } as GoldenStep;
        }
        res = await send(sent);
      } catch (err) {
        at({ step: stepNo, pointer: stepLabel(step), expected: 'a generated endpoint', actual: err instanceof Error ? err.message : 'unresolvable' }, stepTags);
        continue;
      }
      for (const [name, pointer] of Object.entries(raw.bind ?? {})) {
        const value = readPointer(res, pointer);
        if (value === undefined || value === null) at({ step: stepNo, pointer: `bind ${name} <- ${pointer}`, expected: 'a value', actual: '(absent)' }, stepTags);
        else refs.set(name, value);
      }
      if (raw.setup) continue;
      if (stepTags.some((tag) => ENV_ARTIFACT_TAG.test(tag))) {
        envArtifacts.push({ case: kase.id, step: stepNo, tags: stepTags.filter((tag) => ENV_ARTIFACT_TAG.test(tag)) });
        continue;
      }
      const wantStatus = want.status ?? (want.outcome ? undefined : 200);
      if (wantStatus !== undefined && !statusMatches(wantStatus, res.status)) at({ step: stepNo, pointer: `${path} status`, expected: wantStatus, actual: res.status }, stepTags);
      if (want.outcome) {
        const seen = outcomeDiff(want.outcome, want.count, res);
        if (seen !== undefined) at({ step: stepNo, pointer: `${path} outcome`, expected: want.count === undefined ? want.outcome : `${want.outcome}:${want.count}`, actual: seen }, stepTags);
      }
      if (want.body !== undefined) {
        const diffs: Omit<BehaviorFinding, 'case'>[] = [];
        matchValue(want.body, res.body, 'body', diffs, want.unordered === true, want.partial === true, zone);
        for (const d of diffs) at({ step: stepNo, ...d }, stepTags);
      }
    }
    const missing = new Set<string>();
    const tables = resolveRefs(kase.expect?.tables ?? {}, refs, missing) as Record<string, Record<string, unknown>[]>;
    for (const name of [...missing].sort()) at({ pointer: `tables <ref:${name}>`, expected: 'a value bound by an earlier step', actual: '(unbound)' });
    for (const [table, listed] of Object.entries(tables)) {
      const sentBy = apiOnlySent.get(table);
      const expectedRows = sentBy
        ? listed.map((row) => Object.fromEntries(Object.entries(row).filter(([column, value]) => !sentBy.get(column)?.some((sent) => sent === value || textBoundaryEqual(value, sent, zone)))))
        : listed;
      const actualRows = await backend.tableRows(table);
      const diffs: Omit<BehaviorFinding, 'case'>[] = [];
      matchRows(expectedRows, actualRows, `tables.${table}`, diffs, kase.expect?.unordered === true, kase.expect?.partial === true, zone);
      for (const d of diffs) at(d);
    }
    if (findings.length === findingsBefore) equivalentCases += 1;
  }
  const replayed = golden.cases.length - skipped.length;
  const status: BehaviorStatus = replayed === 0 ? 'not-run' : findings.length === 0 && skipped.length === 0 ? 'equivalent' : 'not-equivalent';
  const equivalentByDesignCases = new Set(equivalentByDesign.map((e) => e.case));
  const report: BehaviorReport = {
    version: REPORT_VERSION,
    app: app.name || 'app',
    mode,
    status,
    ok: status === 'equivalent',
    behaviorEquivalentApps: status === 'equivalent' ? 1 : 0,
    summary: { cases: golden.cases.length, steps: stepCount, findings: findings.length, skipped: skipped.length, replayed, equivalentCases: equivalentCases - equivalentByDesignCases.size, equivalentByDesign: equivalentByDesign.length },
    findings,
    ...(skipped.length ? { skipped } : {}),
    ...(envArtifacts.length ? { envArtifacts } : {}),
    ...(equivalentByDesign.length ? { equivalentByDesign } : {}),
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
    `cases: ${report.summary.cases} · steps: ${report.summary.steps} · findings: ${report.summary.findings} · skipped: ${report.summary.skipped} · equivalent by design: ${report.summary.equivalentByDesign}`,
    `status: ${report.status} — equivalent on ${report.summary.equivalentCases} of ${report.summary.cases} cases, ${report.summary.skipped} skipped`,
    '',
  ];
  if (report.findings.length) {
    lines.push('| case | step | at | expected | actual |', '| --- | --- | --- | --- | --- |');
    for (const f of report.findings) {
      lines.push(`| ${f.case}${f.tags ? ` (${f.tags.join(', ')})` : ''} | ${f.step ?? '—'} | ${f.pointer} | ${show(f.expected)} | ${show(f.actual)} |`);
    }
    lines.push('');
  } else {
    lines.push('No differences.', '');
  }
  if (report.skipped?.length) {
    lines.push('Skipped (not replayed, not a pass):', '');
    for (const s of report.skipped) lines.push(`- ${s.case}: ${s.reason}`);
    lines.push('');
  }
  if (report.envArtifacts?.length) {
    lines.push('Environment-artifact steps (replayed, reply not compared):', '');
    for (const e of report.envArtifacts) lines.push(`- ${e.case} step ${e.step}: ${e.tags.join(', ')}`);
    lines.push('');
  }
  if (report.equivalentByDesign?.length) {
    lines.push('Equivalent by design (refused for client input; not a finding, not a pass):', '');
    for (const e of report.equivalentByDesign) lines.push(`- ${e.case} step ${e.step}: ${e.class} ${e.fields.join(', ')} — ${e.actual}`);
    lines.push('');
  }
  lines.push(`behavior-equivalent apps: ${report.behaviorEquivalentApps}`);
  return `${lines.join('\n')}\n`;
}

export function formatBehaviorJson(report: BehaviorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
