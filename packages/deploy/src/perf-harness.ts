/**
 * Offline volume run: load a perf seed through the generated c2c_api and time
 * report pages, report search and the import, all in one process against the
 * fake Catalyst SDK (tools/catalyst-harness). OFFLINE NUMBERS ARE NOT CATALYST
 * NUMBERS: the fake Data Store is an in-memory array, so the times measure the
 * generated handlers and the shims, not Data Store or network latency. The
 * per-request Data Store call counts are the part that carries over: each call
 * is one round trip on Catalyst, and the 30 s request cap divided by the call
 * count is the per-call latency a request can afford.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../../core/src/ir.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { catalystLimit } from '../../schema/src/limits.js';
import { LIMITS } from '../../shims/src/runtime.js';
import { deployFiles, writeDeployTree } from './plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from './guards.js';
import { childIndex, deferredPatch, perfSeed, recordPlan, seedRecord, type PerfSize } from './perf-seed.js';

export const OFFLINE_NOTE =
  'Offline in-process numbers (fake in-memory Data Store, no network). They are NOT Catalyst numbers; only the Data Store call counts per request carry over.';

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
  initialize(req: unknown): {
    datastore(): {
      table(name: string): {
        insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
        updateRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
      };
    };
  };
}

export interface Timing {
  n: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Data Store calls (ZCQL plus row calls) per request: the most any sampled request made. */
  maxStoreCalls: number;
  statuses: Record<string, number>;
}

export interface ImportRow {
  form: string;
  route: string | null;
  rows: number;
  viaApi: number;
  viaStore: number;
  apiMs: number;
  apiRowsPerSec: number | null;
  storeMs: number;
  refused: number;
  firstRefusal?: string;
  storeCallsPerApiRow: number | null;
}

export interface ReportRow {
  report: string;
  form: string;
  rows: number;
  firstPage: Timing;
  pagedLoad: Timing;
  searchBroad: Timing;
  searchSelective: Timing;
  searchNone: Timing;
}

export interface PerfRun {
  app: string;
  size: PerfSize;
  seed: string;
  seedSha256: string;
  note: string;
  pageSize: number;
  imports: ImportRow[];
  /** Second pass: rows whose self or cyclic lookups were set by row update after every insert. */
  deferred: { form: string; columns: string[]; rows: number; ms: number }[];
  /** Counted seed warnings (a mandatory lookup a cycle forced to post empty, a subform lookup left empty). */
  warnings: string[];
  reports: ReportRow[];
  timeoutRisk: { report: string; probe: string; storeCalls: number; budgetMsPerCall: number | null; status: string }[];
}

/** Import rows whose Data Store calls are counted (the first rows of each table). */
const CALL_SAMPLE = 100;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const round = (ms: number) => Math.round(ms * 100) / 100;

function timing(samples: { ms: number; calls: number; status: number }[]): Timing {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  for (const s of samples) statuses[String(s.status)] = (statuses[String(s.status)] ?? 0) + 1;
  return {
    n: samples.length,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    maxStoreCalls: Math.max(0, ...samples.map((s) => s.calls)),
    statuses,
  };
}

function guardFor(app: App): GuardOk {
  const org = '10000000000';
  return {
    org,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: { org, env: 'Development', projects: {}, dc: 'in' },
  };
}

export interface PerfOptions {
  size: PerfSize;
  seed?: string;
  /** Rows per table posted through the c2c_api route; the rest are stored with insertRows (200 per call). Default: all. */
  apiRowsPerTable?: number;
  /** Report pages sampled per report (evenly spaced, deterministic). */
  pageSamples?: number;
  /** Repeats per search probe. */
  searchRepeats?: number;
  log?: (line: string) => void;
}

export async function runPerf(app: App, opts: PerfOptions): Promise<PerfRun> {
  const log = opts.log ?? (() => {});
  const seed = perfSeed(app, opts.size, opts.seed);
  const pageSize = LIMITS.zcqlRowsPerQuery;
  const fake = join(repoRoot(), 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'c2c-perf-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  let server: Server | undefined;
  try {
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const require = createRequire(import.meta.url);
    const sdk = require(fake) as FakeSdk;
    // One module-level store per process: start empty.
    for (const rows of Object.values(sdk.state().tables)) rows.splice(0);
    sdk.setSession('perf-admin', { user_id: '1001', email_id: 'admin@example.com', role_details: { role_name: 'App Administrator' } });
    const routes = require(join(dir, 'functions/c2c_api/routes.json')) as Record<string, string>;
    const entry = require(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const callCount = () => sdk.state().calls.length;
    const post = async (path: string, body: unknown, count = true) => {
      // state() copies the whole call log, so counting is skipped on bulk import rows.
      const before = count ? callCount() : 0;
      const start = performance.now();
      const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=perf-admin' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      const ms = performance.now() - start;
      return { status: res.status, text, ms, calls: count ? callCount() - before : 0 };
    };

    // ---- import ----
    const plan = recordPlan(app, seed.result);
    const children = childIndex(seed.result, plan);
    const rowIds = new Map<string, string>();
    const imports: ImportRow[] = [];
    for (const warning of plan.warnings) log(`seed warning: ${warning}`);
    const store = sdk.initialize({}).datastore();
    const limit = opts.apiRowsPerTable ?? Number.POSITIVE_INFINITY;
    for (const form of plan.forms) {
      const table = seed.result.tables.find((t) => t.form === form)!;
      const route = [`/forms/${form}/success`, `/forms/${form}/submit`].find((path) => routes[`POST ${path}`]) ?? null;
      const row: ImportRow = { form, route, rows: table.rows.length, viaApi: 0, viaStore: 0, apiMs: 0, apiRowsPerSec: null, storeMs: 0, refused: 0, storeCallsPerApiRow: null };
      let apiCalls = 0;
      let countedRows = 0;
      const pending: { id: string; record: Record<string, unknown> }[] = [];
      for (const [i, seedRow] of table.rows.entries()) {
        const record = seedRecord(form, seedRow, plan, rowIds, children);
        if (!route || i >= limit) {
          pending.push({ id: seedRow.id, record });
          continue;
        }
        const counted = i < CALL_SAMPLE;
        const res = await post(route, { record }, counted);
        row.apiMs += res.ms;
        apiCalls += res.calls;
        if (counted) countedRows += 1;
        if (res.status !== 200) {
          row.refused += 1;
          row.firstRefusal ??= `${res.status} ${res.text.slice(0, 200)}`;
          // The table still reaches its size for the report timings.
          pending.push({ id: seedRow.id, record });
          continue;
        }
        const body = JSON.parse(res.text) as { values?: { ROWID?: string } };
        if (body.values?.ROWID) rowIds.set(seedRow.id, String(body.values.ROWID));
        row.viaApi += 1;
      }
      // Rows past the API sample, refused rows, or a form with no write route go in as the mover
      // writes them: insertRows, 200 per call. Subform values are not stored this way.
      const start = performance.now();
      for (let i = 0; i < pending.length; i += LIMITS.insertRowsPerCall) {
        const batch = pending.slice(i, i + LIMITS.insertRowsPerCall);
        const flat = batch.map(({ record }) =>
          Object.fromEntries(
            Object.entries(record)
              .filter(([, v]) => !Array.isArray(v) || v.every((x) => typeof x !== 'object'))
              .map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : v]),
          ),
        );
        const stored = await store.table(form).insertRows(flat);
        stored.forEach((r, j) => rowIds.set(batch[j]!.id, String(r.ROWID)));
        row.viaStore += batch.length;
      }
      row.storeMs = round(performance.now() - start);
      row.apiMs = round(row.apiMs);
      if (row.viaApi) {
        row.apiRowsPerSec = Math.round((row.viaApi / row.apiMs) * 1000);
        row.storeCallsPerApiRow = countedRows ? round(apiCalls / countedRows) : null;
      }
      imports.push(row);
      log(`import ${form}: ${row.viaApi} via ${route ?? 'no route'}, ${row.viaStore} via insertRows, ${row.refused} refused`);
    }
    // Second pass: the lookups posted empty, now that every row has a ROWID.
    const deferred: PerfRun['deferred'] = [];
    for (const form of plan.forms) {
      const columns = plan.deferred.get(form);
      if (!columns?.size) continue;
      const table = seed.result.tables.find((t) => t.form === form)!;
      const start = performance.now();
      const updates: Record<string, unknown>[] = [];
      for (const seedRow of table.rows) {
        const patch = deferredPatch(form, seedRow, plan, rowIds, children);
        const rowid = rowIds.get(seedRow.id);
        if (!patch || !rowid) continue;
        updates.push({ ROWID: rowid, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, Array.isArray(v) ? JSON.stringify(v) : v])) });
      }
      for (let i = 0; i < updates.length; i += LIMITS.insertRowsPerCall) await store.table(form).updateRows(updates.slice(i, i + LIMITS.insertRowsPerCall));
      deferred.push({ form, columns: [...columns].sort(), rows: updates.length, ms: round(performance.now() - start) });
      log(`deferred ${form}: ${updates.length} rows updated (${[...columns].sort().join(', ')})`);
    }

    // ---- reports ----
    const reports: ReportRow[] = [];
    const samples = opts.pageSamples ?? 20;
    const repeats = opts.searchRepeats ?? 5;
    const timeoutRisk: PerfRun['timeoutRisk'] = [];
    const capMs = (catalystLimit('function.timeout_seconds').value ?? 0) * 1000;
    for (const report of app.reports) {
      const path = `/reports/${report.name}`;
      if (!routes[`POST ${path}`] || !report.form) continue;
      const rows = sdk.state().tables[report.form]?.length ?? 0;
      const pages = Math.max(1, Math.ceil(rows / pageSize));
      const query = async (extra: Record<string, unknown>) => {
        const res = await post(path, { op: 'query', pageSize, ...extra });
        return { ms: res.ms, calls: res.calls, status: res.status };
      };
      const first = [];
      for (let i = 0; i < repeats; i++) first.push(await query({ page: 0 }));
      const paged = [];
      for (let i = 0; i < samples; i++) paged.push(await query({ page: Math.floor((i * (pages - 1)) / Math.max(1, samples - 1)) }));
      const lastRow = seed.result.tables.find((t) => t.form === report.form)?.rows.at(-1);
      const text = Object.values(lastRow?.columns ?? {}).find((v) => /-value-\d+$/.test(v)) ?? Object.values(lastRow?.columns ?? {}).find((v) => v.includes('-value')) ?? '';
      const broadTerm = text.replace(/-\d+$/, '').replace(/-value.*$/, '-value');
      const probe = async (q: string) => {
        const out = [];
        for (let i = 0; i < repeats; i++) out.push(await query({ page: 0, q }));
        return timing(out);
      };
      const result: ReportRow = {
        report: report.name,
        form: report.form,
        rows,
        firstPage: timing(first),
        pagedLoad: timing(paged),
        searchBroad: await probe(broadTerm || 'value'),
        searchSelective: await probe(text || 'value'),
        searchNone: await probe('zz-no-match'),
      };
      reports.push(result);
      for (const [name, t] of [['paged load', result.pagedLoad], ['search, no match', result.searchNone], ['search, selective', result.searchSelective]] as const) {
        const budget = t.maxStoreCalls ? Math.floor(capMs / t.maxStoreCalls) : null;
        const failed = Object.keys(t.statuses).some((s) => s !== '200');
        timeoutRisk.push({
          report: report.name,
          probe: name,
          storeCalls: t.maxStoreCalls,
          budgetMsPerCall: budget,
          status: failed ? `FAIL offline (status ${Object.keys(t.statuses).join('/')})` : budget === null ? 'no store call' : `each call must average under ${budget} ms on Catalyst [UNVERIFIED latency]`,
        });
      }
      log(`report ${report.name}: ${rows} rows, paged p95 ${result.pagedLoad.p95Ms} ms`);
    }
    return { app: seed.app, size: opts.size, seed: seed.seed, seedSha256: seed.sha256, note: OFFLINE_NOTE, pageSize, imports, deferred, warnings: plan.warnings, reports, timeoutRisk };
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
}
