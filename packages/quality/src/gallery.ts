#!/usr/bin/env node
/**
 * Q2 + Q4 over every app under the gallery, plus the prefetch read-only
 * gate: an app whose generated prefetch endpoints perform a non-read fails as
 * an app failure (`prefetch-non-reads=<n>`). Not part of npm test.
 * Prints counts only: no app names, no source text. Identifier names and
 * normalized error signatures are generated-code facts, not app data.
 *
 *   C2C_FIXTURES_DIR=path npm run smoke:gallery            (uses <dir>/gallery)
 *   C2C_GALLERY_DIR=path npm run smoke:gallery -- --json
 *   ... -- --markdown        the docs/quality-gate.md summary table
 *   ... -- --iterations N    Q4 iterations per handler (default GALLERY_ITERATIONS)
 *
 * Each app runs in its own process (fresh module cache, hang containment).
 * An app whose process fails for an environmental reason (timed out, killed
 * by a signal, could not be spawned, out of memory) is retried after the
 * parallel pass; a failure the app itself raises is not. If any app still
 * fails, the sweep exits 1 and prints no summary. Attempt, retry and
 * timeout counts go to stderr, so the summary is the same on a busy machine
 * as on a quiet one.
 */
// First: in an app process the heartbeat starts before the other modules load.
import { PROGRESS } from './heartbeat.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryKind } from '../../core/src/index.js';
import { digestOf, loadApp, manifestFor } from '../../determinism/src/tree.js';
import { qualityGate } from './index.js';
import type { CompilesReport } from './static.js';
import type { SmokeCleanReport } from './smoke.js';
import { DEFAULT_SEED } from './smoke.js';
import { REPO_ROOT, sortedCounts } from './static.js';

export const GALLERY_ITERATIONS = 24;
/**
 * Hang containment, not a perf bound. While an app process runs, a worker
 * thread in it reports the process CPU time on stderr every HEARTBEAT_MS
 * (the worker keeps reporting while the main thread is busy in synchronous
 * work), with the count of finished subprocess work. A beat counts as
 * progress when the CPU time rose by at least PROGRESS_FLOOR of the beat
 * interval, or the count rose. The idle clock starts at the first report,
 * so a slow start on a busy machine is not charged to the idle budget. The
 * process is killed when no beat has counted for APP_IDLE_MS (blocked,
 * stopped, or a heartbeat that stops reporting), when it has used
 * APP_CPU_MS of CPU (a busy loop), or, whatever else happens, after
 * APP_WALL_MS of wall-clock time — the backstop also bounds a process that
 * never reports at all. An app that is slow on its own, or slow because the
 * machine is busy, keeps running as long as it makes progress, up to that
 * backstop.
 */
export const APP_IDLE_MS = 600_000;
export const APP_CPU_MS = 3_600_000;
/** Wall-clock backstop for one app process: well above the slowest app on a machine that halves its speed. */
export const APP_WALL_MS = 2_700_000;
export const HEARTBEAT_MS = 5_000;
/**
 * Share of the beat interval the CPU time must rise by for a beat to count
 * as progress: 1% of one core, 50 ms per 5 s beat. The reported CPU time is
 * the whole process's, heartbeat thread included, so it rises on every beat
 * even while the main thread is blocked; the heartbeat's own cost is well
 * under 1 ms a beat, and a main thread doing work adds close to the whole
 * interval.
 */
export const PROGRESS_FLOOR = 0.01;
const WATCH_MS = 1_000;

/** Upper bound on app processes at once; the load-adjusted bound is concurrencyFor. */
export const MAX_PARALLEL = 4;
/** Further attempts for an app that failed for an environmental reason. */
export const ENV_RETRIES = 2;

function emit(text: string, code = 0): never {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) off += writeSync(1, buf, off);
  process.exit(code);
}

export function listTargets(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((ent) => !ent.name.startsWith('.'));
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[] = [];
  for (const ent of entries) {
    const path = join(dir, ent.name);
    // The entry kind comes from the directory read; a symlink is skipped.
    if (ent.isSymbolicLink()) continue;
    if (entryKind(ent) === 'directory') {
      if (readdirSync(path).some((child) => child.toLowerCase().endsWith('.ds'))) out.push(path);
    } else if (ent.name.toLowerCase().endsWith('.ds')) out.push(path);
  }
  return out;
}

const SOURCE_DIRS = ['packages/quality/src', 'packages/shims/src'];

/**
 * What the committed summary was measured from: every generated tree in the
 * gallery (determinism manifests), the gate source and the shim source. A
 * change to any of them makes docs/quality-gate.md stale.
 */
export function inputsDigest(galleryDir: string, root = REPO_ROOT): string {
  const h = createHash('sha256');
  for (const target of listTargets(galleryDir)) h.update(`tree ${digestOf(manifestFor(target))}\n`);
  for (const rel of SOURCE_DIRS) {
    const names = readdirSync(join(root, rel))
      .filter((n) => n.endsWith('.ts'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const text = readFileSync(join(root, rel, name), 'utf8');
      h.update(`src ${rel}/${name} ${createHash('sha256').update(text).digest('hex')}\n`);
    }
  }
  return h.digest('hex');
}

export const DOC_BEGIN = '<!-- quality-gallery:begin';
export const DOC_END = '<!-- quality-gallery:end -->';

/** sha256 of the table body, recorded in the begin marker so a hand-edited count is stale. */
export function tableDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * The whole committed block: begin marker (table digest only), table, end
 * marker. The inputs digest is deliberately not committed: it changes on any
 * measured-input edit, so committing it would rewrite the marker line on
 * every regeneration. It still keys the local measurement cache.
 */
export function docBlock(body: string): string {
  return `${DOC_BEGIN} table=${tableDigest(body)} -->\n${body}${DOC_END}\n`;
}

/** One app's counts, as the child prints them. */
export interface AppRow {
  compiles: CompilesReport;
  smokeClean: SmokeCleanReport;
  /** Prefetch read-only gate: endpoint modules scanned and the non-read calls found. */
  prefetch: { modules: number; nonReads: number; byOp: Record<string, number> };
  /** Crash signature → handlers that hit it. */
  crashSignatures: Record<string, number>;
  /** Crash signature → handlers that hit it on the all-valid input. */
  crashOnValidSignatures: Record<string, number>;
  /** Unmapped-error signature → calls. */
  unmappedSignatures: Record<string, number>;
  /** Type-error message (normalized) → diagnostics inside handler bodies. */
  typeMessages: Record<string, number>;
}

/**
 * Type message with app names removed and shim type names kept: the name in
 * "Cannot find name" and the member in "Property … does not exist on type T"
 * become …; the types in an argument mismatch stay.
 */
export function typeBucket(message: string): string {
  const first = message.split('\n')[0]!;
  const prop = /^Property '[^']*' does not exist on type '([^']*)'/.exec(first);
  if (prop) return `Property '…' does not exist on type '${prop[1]!.length > 40 ? '…' : prop[1]}'.`;
  if (/^Argument of type/.test(first)) return first.replace(/"[^"]*"/g, '"…"').slice(0, 160);
  return first.replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"').slice(0, 160);
}

async function runOne(target: string, iterations: number): Promise<AppRow> {
  const app = loadApp(target);
  const q = await qualityGate(app, { iterations, seed: DEFAULT_SEED });
  const crash = new Map<string, Set<string>>();
  const onValid = new Map<string, Set<string>>();
  const unmapped: Record<string, number> = {};
  for (const d of q.details.smoke) {
    if (d.outcome === 'crash') {
      const key = d.signature;
      if (!crash.has(key)) crash.set(key, new Set());
      crash.get(key)!.add(`${d.path}#${d.handler}`);
      if (d.mode === 'valid' || d.mode === 'import') {
        if (!onValid.has(key)) onValid.set(key, new Set());
        onValid.get(key)!.add(`${d.path}#${d.handler}`);
      }
    } else if (d.outcome === 'unmapped') unmapped[d.signature] = (unmapped[d.signature] ?? 0) + 1;
  }
  const crashSignatures: Record<string, number> = {};
  for (const [k, v] of crash) crashSignatures[k] = v.size;
  const crashOnValidSignatures: Record<string, number> = {};
  for (const [k, v] of onValid) crashOnValidSignatures[k] = v.size;
  const typeMessages: Record<string, number> = {};
  for (const d of q.details.compiles) {
    if (d.check !== 'type') continue;
    const key = `${d.key} ${typeBucket(d.message ?? '')}`;
    typeMessages[key] = (typeMessages[key] ?? 0) + 1;
  }
  return {
    compiles: q.compiles,
    smokeClean: q.smokeClean,
    prefetch: { modules: q.prefetchReads.modules, nonReads: q.prefetchReads.nonReads, byOp: q.prefetchReads.byOp },
    crashSignatures: sortedCounts(crashSignatures),
    crashOnValidSignatures: sortedCounts(crashOnValidSignatures),
    unmappedSignatures: sortedCounts(unmapped),
    typeMessages: sortedCounts(typeMessages),
  };
}

/** An app whose prefetch endpoints perform non-reads fails as an `app` failure: `prefetch-non-reads=<n>` on the failure line. */
export function prefetchFailure(row: AppRow): AppFailure | null {
  return row.prefetch.nonReads ? { error: `prefetch-non-reads=${row.prefetch.nonReads}`, kind: 'app', cause: 'error' } : null;
}

/** A failed app: `environment` failures are retried, `app` failures are not. */
export interface AppFailure {
  error: string;
  kind: 'environment' | 'app';
  /** What ended the process, for the stderr counts. */
  cause: 'timeout' | 'signal' | 'spawn' | 'resource' | 'error';
}
export type AppResult = AppRow | AppFailure;

/** Node error codes and messages that mean the machine ran short, not that the app is wrong. */
const RESOURCE_CODES = new Set(['ENOMEM', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOSPC', 'EBUSY']);
const RESOURCE_TEXT = /\b(?:ENOMEM|EAGAIN|EMFILE|ENFILE|ENOSPC)\b|heap out of memory|Cannot allocate memory|Resource temporarily unavailable/;

export function isResourceError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && RESOURCE_CODES.has(code)) return true;
  return RESOURCE_TEXT.test(err instanceof Error ? err.message : String(err));
}

/** One-minute load average and core count, read when a decision is made. */
export interface LoadSample {
  cores: number;
  load1: number;
}

export function sampleLoad(): LoadSample {
  return { cores: availableParallelism(), load1: loadavg()[0] ?? 0 };
}

/**
 * App processes allowed at once: the cores not taken by other work, between
 * 1 and `max`. `running` sweep processes are already in the load average and
 * are not counted against the sweep.
 */
export function concurrencyFor(sample: LoadSample, running: number, max = MAX_PARALLEL): number {
  const other = Math.max(0, sample.load1 - running);
  return Math.min(max, Math.max(1, Math.floor(sample.cores - other)));
}

export interface Watchdog {
  idleMs: number;
  cpuMs: number;
  wallMs: number;
  /** CPU time (microseconds) a beat must add to count as progress. */
  floorMicros: number;
}

/** Progress of one app process, fed with its heartbeats. */
export class AppProgress {
  private lastProgressAt: number | undefined;
  private cpu = 0;
  private marks = 0;

  constructor(
    private readonly startedAt: number,
    private readonly limits: Watchdog,
  ) {}

  /**
   * A heartbeat at `now` reporting `cpuMicros` of process CPU time and `marks` finished pieces of subprocess work.
   * Returns whether the beat counted as progress, restarting the idle clock.
   */
  beat(now: number, cpuMicros: number, marks = 0): boolean {
    // The first report anchors the idle clock: start-up before it, however
    // slow, is not charged to the idle budget.
    const counted = this.lastProgressAt === undefined || cpuMicros - this.cpu >= this.limits.floorMicros || marks > this.marks;
    if (counted) this.lastProgressAt = now;
    this.cpu = Math.max(this.cpu, cpuMicros);
    this.marks = Math.max(this.marks, marks);
    return counted;
  }

  /**
   * Whether to kill the process: no progress for `idleMs` since the last
   * counted beat (the clock starts at the first report), `cpuMs` of CPU
   * used, or `wallMs` since the start — also the bound for a process that
   * never reports.
   */
  expired(now: number): boolean {
    return (this.lastProgressAt !== undefined && now - this.lastProgressAt > this.limits.idleMs) || this.cpu / 1000 > this.limits.cpuMs || now - this.startedAt > this.limits.wallMs;
  }
}

export interface RunAppOptions {
  /** No-progress limit (default APP_IDLE_MS). */
  idleMs?: number;
  /** CPU-time limit (default APP_CPU_MS). */
  cpuMs?: number;
  /** Wall-clock backstop (default APP_WALL_MS). */
  wallMs?: number;
  /** Heartbeat interval in the child (default HEARTBEAT_MS). */
  heartbeatMs?: number;
  /** Called for each heartbeat the child reports, with whether it counted as progress. */
  onBeat?: (beat: { at: number; cpuMicros: number; marks: number; counted: boolean }) => void;
  /** Test-only child preload for verifying idle watchdog termination. */
  testOnlyStallIdle?: boolean;
}

/** Watchdog limits for one app process. */
export function watchdogFor(opts: RunAppOptions = {}): Watchdog {
  const heartbeat = opts.heartbeatMs ?? HEARTBEAT_MS;
  return { idleMs: opts.idleMs ?? APP_IDLE_MS, cpuMs: opts.cpuMs ?? APP_CPU_MS, wallMs: opts.wallMs ?? APP_WALL_MS, floorMicros: heartbeat * 1000 * PROGRESS_FLOOR };
}

function reportedFailure(out: string): { error?: unknown; resource?: unknown } | undefined {
  try {
    return (JSON.parse(out) as { failure?: { error?: unknown; resource?: unknown } } | null)?.failure;
  } catch {
    return undefined;
  }
}

/** One app in its own process. Never rejects: a failure comes back classified. */
export function runApp(target: string, iterations: number, opts: RunAppOptions = {}): Promise<AppResult> {
  const limits = watchdogFor(opts);
  const heartbeat = opts.heartbeatMs ?? HEARTBEAT_MS;
  return new Promise((resolve) => {
    const script = fileURLToPath(import.meta.url);
    const progress = new AppProgress(Date.now(), limits);
    let timedOut = false;
    let done = false;
    const finish = (r: AppResult) => {
      if (done) return;
      done = true;
      clearInterval(watch);
      resolve(r);
    };
    const args = [
      ...(opts.testOnlyStallIdle ? ['--import', fileURLToPath(new URL('../test/stall-idle-preload.js', import.meta.url))] : []),
      script,
      '--once',
      target,
      '--iterations',
      String(iterations),
      '--heartbeat-ms',
      String(heartbeat),
    ];
    const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let partial = '';
    proc.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')));
    proc.stderr?.on('data', (b: Buffer) => {
      const lines = (partial + b.toString('utf8')).split('\n');
      partial = lines.pop()!;
      for (const line of lines) {
        const [cpu, marks] = line.startsWith(`${PROGRESS} `) ? line.slice(PROGRESS.length + 1).split(' ').map(Number) : [];
        if (Number.isFinite(cpu) && Number.isFinite(marks)) {
          const at = Date.now();
          const counted = progress.beat(at, cpu!, marks);
          opts.onBeat?.({ at, cpuMicros: cpu!, marks: marks!, counted });
        } else err += `${line}\n`;
      }
    });
    const watch = setInterval(() => {
      if (!progress.expired(Date.now())) return;
      timedOut = true;
      proc.kill('SIGKILL');
    }, Math.min(WATCH_MS, limits.idleMs));
    proc.on('error', (e) => finish({ error: `spawn failed: ${(e as NodeJS.ErrnoException).code ?? e.message}`.slice(0, 200), kind: 'environment', cause: 'spawn' }));
    proc.on('close', (code, signal) => {
      if (timedOut) return finish({ error: 'timed out', kind: 'environment', cause: 'timeout' });
      if (signal) return finish({ error: `killed by ${signal}`, kind: 'environment', cause: 'signal' });
      if (code === 0) {
        try {
          return finish(JSON.parse(out) as AppRow);
        } catch {
          return finish({ error: 'unparseable child output', kind: 'app', cause: 'error' });
        }
      }
      // The child reports a failure it caught as JSON on stdout (see main).
      const failure = reportedFailure(out);
      if (failure && typeof failure.error === 'string') {
        return finish(failure.resource === true ? { error: failure.error, kind: 'environment', cause: 'resource' } : { error: failure.error, kind: 'app', cause: 'error' });
      }
      err += partial;
      const line = (err.split('\n').find((l) => /Error/.test(l)) ?? `exit ${code}`).slice(0, 200);
      // No report: the process died before main could catch anything.
      return finish(RESOURCE_TEXT.test(err) ? { error: line, kind: 'environment', cause: 'resource' } : { error: line, kind: 'app', cause: 'error' });
    });
  });
}

function add(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

function addApps(into: Record<string, number>, from: Record<string, number>): void {
  for (const k of Object.keys(from)) into[k] = (into[k] ?? 0) + 1;
}

export interface GallerySummary {
  apps: number;
  appErrors: number;
  iterations: number;
  seed: string;
  q2: {
    appsCompile: number;
    modules: number;
    nodeCheckFailures: number;
    scanned: number;
    freeIdentifiers: number;
    modulesWithFreeIdentifiers: number;
    appsWithFreeIdentifiers: number;
    freeByName: Record<string, number>;
    freeAppsByName: Record<string, number>;
    appsWithUnboundRow: number;
    typeChecked: number;
    typeErrors: number;
    typeByCode: Record<string, number>;
    typeMessages: Record<string, number>;
    typeAppsByMessage: Record<string, number>;
    typeAdvisories: number;
    templateTypeErrors: number;
  };
  q4: {
    appsSmokeClean: number;
    handlers: number;
    calls: number;
    handlersWithCrash: number;
    handlersCrashOnValid: number;
    crashByClass: Record<string, number>;
    crashSignatures: Record<string, number>;
    crashOnValidSignatures: Record<string, number>;
    crashAppsBySignature: Record<string, number>;
    delugeByClass: Record<string, number>;
    unmappedByClass: Record<string, number>;
    unmappedSignatures: Record<string, number>;
    importFailures: number;
  };
  /** Prefetch read-only gate over every app's generated prefetch endpoints. */
  prefetch: {
    modules: number;
    nonReads: number;
    appsWithNonReads: number;
    byOp: Record<string, number>;
  };
  /** Per app, in sorted target order (index only). */
  perApp: { index: number; compiles: boolean; smokeClean: boolean; prefetchNonReads: number; error?: string }[];
}

/** The last measured table body, cached under the repo and gitignored. */
export interface GalleryCache {
  inputs: string;
  iterations: number;
  body: string;
}

export const GALLERY_CACHE = '.cache/quality-gallery.json';

export function readGalleryCache(root = REPO_ROOT): GalleryCache | null {
  try {
    const cached = JSON.parse(readFileSync(join(root, GALLERY_CACHE), 'utf8')) as Partial<GalleryCache>;
    if (typeof cached.inputs === 'string' && typeof cached.iterations === 'number' && typeof cached.body === 'string') {
      return { inputs: cached.inputs, iterations: cached.iterations, body: cached.body };
    }
  } catch {
    // missing or malformed: a miss
  }
  return null;
}

export function writeGalleryCache(entry: GalleryCache, root = REPO_ROOT): void {
  const path = join(root, GALLERY_CACHE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry)}\n`);
}

/** What the sweep did to get every app measured; printed on stderr, never in the summary. */
export interface SweepStats {
  apps: number;
  attempts: number;
  retries: number;
  /** Environmental failures by cause, over every attempt. */
  timeouts: number;
  signals: number;
  spawnFailures: number;
  resourceErrors: number;
  /** Apps that failed for an environmental reason and then completed. */
  recovered: number;
  /** Apps still failing after the retries. */
  failed: number;
  /** Lowest and highest number of app processes allowed at once, as the load changed. */
  minParallel: number;
  maxParallel: number;
}

export interface SweepOptions {
  /** Runs one attempt of one app (default runApp). `attempt` is 0 on the parallel pass. */
  run?: (target: string, iterations: number, attempt: number) => Promise<AppResult>;
  retries?: number;
  maxParallel?: number;
  load?: () => LoadSample;
}

export interface Sweep {
  rows: AppResult[];
  stats: SweepStats;
}

export function isFailure(r: AppResult): r is AppFailure {
  return 'error' in r;
}

/**
 * Every app in its own process, as many at once as the load allows, then a
 * sequential retry of each app that failed for an environmental reason. Rows
 * stay in target order, so the result does not depend on scheduling.
 */
export async function sweepGallery(dir: string, iterations: number, opts: SweepOptions = {}): Promise<Sweep> {
  const targets = listTargets(dir);
  const load = opts.load ?? sampleLoad;
  const run = opts.run ?? ((target: string, n: number) => runApp(target, n));
  const retries = opts.retries ?? ENV_RETRIES;
  const max = opts.maxParallel ?? MAX_PARALLEL;
  const stats: SweepStats = { apps: targets.length, attempts: 0, retries: 0, timeouts: 0, signals: 0, spawnFailures: 0, resourceErrors: 0, recovered: 0, failed: 0, minParallel: 0, maxParallel: 0 };
  const note = (r: AppResult) => {
    stats.attempts++;
    if (!isFailure(r) || r.kind !== 'environment') return;
    if (r.cause === 'timeout') stats.timeouts++;
    else if (r.cause === 'signal') stats.signals++;
    else if (r.cause === 'spawn') stats.spawnFailures++;
    else stats.resourceErrors++;
  };
  const attempt = async (i: number, n: number): Promise<AppResult> => {
    let r: AppResult;
    try {
      r = await run(targets[i]!, iterations, n);
      if (!isFailure(r)) r = prefetchFailure(r) ?? r;
    } catch (err) {
      r = { error: String(err instanceof Error ? err.message : err).slice(0, 200), kind: isResourceError(err) ? 'environment' : 'app', cause: isResourceError(err) ? 'resource' : 'error' };
    }
    note(r);
    return r;
  };
  const rows: AppResult[] = new Array(targets.length);
  let next = 0;
  let running = 0;
  const pending = new Set<Promise<void>>();
  while (next < targets.length || pending.size) {
    const allowed = concurrencyFor(load(), running, max);
    while (next < targets.length && running < allowed) {
      const i = next++;
      running++;
      stats.maxParallel = Math.max(stats.maxParallel, allowed);
      stats.minParallel = stats.minParallel ? Math.min(stats.minParallel, allowed) : allowed;
      const p: Promise<void> = attempt(i, 0).then((r) => {
        rows[i] = r;
        running--;
        pending.delete(p);
      });
      pending.add(p);
    }
    let timer: NodeJS.Timeout | undefined;
    // Wake on a finished app, or after a while to re-read the load.
    await Promise.race([...pending, new Promise<void>((r) => (timer = setTimeout(r, 5_000)))]);
    clearTimeout(timer);
  }
  for (let i = 0; i < rows.length; i++) {
    let r = rows[i]!;
    if (!isFailure(r) || r.kind !== 'environment') continue;
    for (let n = 1; n <= retries && isFailure(r) && r.kind === 'environment'; n++) {
      stats.retries++;
      r = await attempt(i, n);
    }
    if (!isFailure(r)) stats.recovered++;
    rows[i] = r;
  }
  stats.failed = rows.filter(isFailure).length;
  return { rows, stats };
}

export function statsLine(st: SweepStats): string {
  return `smoke:gallery: apps=${st.apps} attempts=${st.attempts} retries=${st.retries} timeouts=${st.timeouts} signals=${st.signals} spawn-failures=${st.spawnFailures} resource-errors=${st.resourceErrors} recovered=${st.recovered} failed=${st.failed} parallel=${st.minParallel}..${st.maxParallel}`;
}

/** Thrown when an app still fails after the retries: no summary is produced from a partial sweep. */
export class GalleryIncomplete extends Error {
  constructor(
    readonly sweep: Sweep,
  ) {
    const failures = sweep.rows.flatMap((r, i) => (isFailure(r) ? [`app ${i + 1}: ${r.kind} ${r.error}`] : []));
    super(`${failures.length} app(s) failed; no summary was produced:\n${failures.join('\n')}`);
    this.name = 'GalleryIncomplete';
  }
}

/** The gallery sweep, summarized. Rejects with GalleryIncomplete when any app failed. */
export async function runGallery(dir: string, iterations: number, opts: SweepOptions & { onStats?: (stats: SweepStats) => void } = {}): Promise<GallerySummary> {
  const sweep = await sweepGallery(dir, iterations, opts);
  opts.onStats?.(sweep.stats);
  if (sweep.stats.failed) throw new GalleryIncomplete(sweep);
  return summarize(sweep.rows, iterations);
}

/**
 * The gallery markdown table for `dir`. An unchanged tree (same inputs digest
 * and iteration count) is served from the cache instead of a fresh sweep.
 */
export async function galleryTable(dir: string, iterations: number, root = REPO_ROOT): Promise<{ body: string; cached: boolean }> {
  const inputs = inputsDigest(dir, root);
  const hit = readGalleryCache(root);
  if (hit && hit.inputs === inputs && hit.iterations === iterations) return { body: hit.body, cached: true };
  const body = asMarkdown(await runGallery(dir, iterations));
  writeGalleryCache({ inputs, iterations, body }, root);
  return { body, cached: false };
}

export function summarize(rows: (AppRow | { error: string })[], iterations: number): GallerySummary {
  const s: GallerySummary = {
    apps: rows.length,
    appErrors: 0,
    iterations,
    seed: DEFAULT_SEED,
    q2: {
      appsCompile: 0,
      modules: 0,
      nodeCheckFailures: 0,
      scanned: 0,
      freeIdentifiers: 0,
      modulesWithFreeIdentifiers: 0,
      appsWithFreeIdentifiers: 0,
      freeByName: {},
      freeAppsByName: {},
      appsWithUnboundRow: 0,
      typeChecked: 0,
      typeErrors: 0,
      typeByCode: {},
      typeMessages: {},
      typeAppsByMessage: {},
      typeAdvisories: 0,
      templateTypeErrors: 0,
    },
    q4: {
      appsSmokeClean: 0,
      handlers: 0,
      calls: 0,
      handlersWithCrash: 0,
      handlersCrashOnValid: 0,
      crashByClass: {},
      crashSignatures: {},
      crashOnValidSignatures: {},
      crashAppsBySignature: {},
      delugeByClass: {},
      unmappedByClass: {},
      unmappedSignatures: {},
      importFailures: 0,
    },
    prefetch: { modules: 0, nonReads: 0, appsWithNonReads: 0, byOp: {} },
    perApp: [],
  };
  rows.forEach((row, i) => {
    if ('error' in row) {
      s.appErrors++;
      s.perApp.push({ index: i + 1, compiles: false, smokeClean: false, prefetchNonReads: 0, error: row.error });
      return;
    }
    const c = row.compiles;
    const k = row.smokeClean;
    s.perApp.push({ index: i + 1, compiles: c.ok, smokeClean: k.ok, prefetchNonReads: row.prefetch.nonReads });
    s.prefetch.modules += row.prefetch.modules;
    s.prefetch.nonReads += row.prefetch.nonReads;
    if (row.prefetch.nonReads) s.prefetch.appsWithNonReads++;
    add(s.prefetch.byOp, row.prefetch.byOp);
    if (c.ok) s.q2.appsCompile++;
    s.q2.modules += c.modules;
    s.q2.nodeCheckFailures += c.nodeCheckFailures;
    s.q2.scanned += c.scanned;
    s.q2.freeIdentifiers += c.freeIdentifiers;
    s.q2.modulesWithFreeIdentifiers += c.modulesWithFreeIdentifiers;
    if (c.freeIdentifiers) s.q2.appsWithFreeIdentifiers++;
    add(s.q2.freeByName, c.freeByName);
    addApps(s.q2.freeAppsByName, c.freeByName);
    if (c.freeByName.row) s.q2.appsWithUnboundRow++;
    s.q2.typeChecked += c.typeChecked;
    s.q2.typeErrors += c.typeErrors;
    add(s.q2.typeByCode, c.typeByCode);
    add(s.q2.typeMessages, row.typeMessages);
    addApps(s.q2.typeAppsByMessage, row.typeMessages);
    s.q2.typeAdvisories += c.typeAdvisories;
    s.q2.templateTypeErrors += c.templateTypeErrors;
    if (k.ok) s.q4.appsSmokeClean++;
    s.q4.handlers += k.handlers;
    s.q4.calls += k.calls;
    s.q4.handlersWithCrash += k.handlersWithCrash;
    s.q4.handlersCrashOnValid += k.handlersCrashOnValid;
    add(s.q4.crashOnValidSignatures, row.crashOnValidSignatures);
    add(s.q4.crashByClass, k.crashByClass);
    add(s.q4.crashSignatures, row.crashSignatures);
    addApps(s.q4.crashAppsBySignature, row.crashSignatures);
    add(s.q4.delugeByClass, k.delugeByClass);
    add(s.q4.unmappedByClass, k.unmappedByClass);
    add(s.q4.unmappedSignatures, row.unmappedSignatures);
    s.q4.importFailures += k.importFailures;
  });
  for (const rec of [s.q2.freeByName, s.q2.freeAppsByName, s.q2.typeByCode, s.q2.typeMessages, s.q2.typeAppsByMessage, s.q4.crashByClass, s.q4.crashSignatures, s.q4.crashOnValidSignatures, s.q4.crashAppsBySignature, s.q4.delugeByClass, s.q4.unmappedByClass, s.q4.unmappedSignatures, s.prefetch.byOp]) {
    const sorted = sortedCounts(rec);
    for (const key of Object.keys(rec)) delete rec[key];
    Object.assign(rec, sorted);
  }
  return s;
}

function top(rec: Record<string, number>, n: number): [string, number][] {
  return Object.entries(rec).slice(0, n);
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/`/g, "'");

/** The summary table committed in docs/quality-gate.md (between the gallery markers). */
export function asMarkdown(s: GallerySummary): string {
  const lines = [
    `Apps: ${s.apps} (errors ${s.appErrors}). Q4 iterations per handler: ${s.iterations}, seed \`${s.seed}\`.`,
    '',
    '| Layer | Measure | Count |',
    '| --- | --- | ---: |',
    `| Q2 | apps passing (compiles) | ${s.q2.appsCompile} / ${s.apps} |`,
    `| Q2 | generated .mjs/.js modules | ${s.q2.modules} |`,
    `| Q2 | \`node --check\` failures | ${s.q2.nodeCheckFailures} |`,
    `| Q2 | modules scanned for free identifiers | ${s.q2.scanned} |`,
    `| Q2 | free identifier references | ${s.q2.freeIdentifiers} |`,
    `| Q2 | modules with a free identifier | ${s.q2.modulesWithFreeIdentifiers} |`,
    `| Q2 | apps with a free identifier | ${s.q2.appsWithFreeIdentifiers} |`,
    `| Q2 | apps with an unbound \`row\` | ${s.q2.appsWithUnboundRow} |`,
    `| Q2 | modules type-checked (checkJs) | ${s.q2.typeChecked} |`,
    `| Q2 | type errors in handler bodies | ${s.q2.typeErrors} |`,
    `| Q2 | type advisories in handler bodies (not gating) | ${s.q2.typeAdvisories} |`,
    `| Q2 | type errors in template code (not gating) | ${s.q2.templateTypeErrors} |`,
    `| Q4 | apps passing (smokeClean) | ${s.q4.appsSmokeClean} / ${s.apps} |`,
    `| Q4 | handlers exercised | ${s.q4.handlers} |`,
    `| Q4 | calls | ${s.q4.calls} |`,
    `| Q4 | handlers with an uncaught error | ${s.q4.handlersWithCrash} |`,
    `| Q4 | handlers with an uncaught error on all-valid input | ${s.q4.handlersCrashOnValid} |`,
    ...Object.entries(s.q4.crashByClass).map(([k, v]) => `| Q4 | handlers crashing with ${k} | ${v} |`),
    `| Q4 | handler modules failing to import | ${s.q4.importFailures} |`,
    ...Object.entries(s.q4.delugeByClass).map(([k, v]) => `| Q4 | calls ending in allowed ${k} | ${v} |`),
    ...Object.entries(s.q4.unmappedByClass).map(([k, v]) => `| Q4 | calls ending in unmapped ${k} | ${v} |`),
    `| Prefetch | endpoint modules scanned | ${s.prefetch.modules} |`,
    `| Prefetch | non-read calls in prefetch endpoints | ${s.prefetch.nonReads} |`,
    `| Prefetch | apps with a prefetch non-read | ${s.prefetch.appsWithNonReads} |`,
    ...Object.entries(s.prefetch.byOp).map(([k, v]) => `| Prefetch | prefetch calls to ${k} | ${v} |`),
    '',
    'Top free identifiers (references, apps):',
    '',
    '| Identifier | References | Apps |',
    '| --- | ---: | ---: |',
    ...top(s.q2.freeByName, 10).map(([k, v]) => `| \`${cell(k)}\` | ${v} | ${s.q2.freeAppsByName[k]} |`),
    '',
    'Top Q4 crash signatures (handlers, apps):',
    '',
    '| Signature | Handlers | On valid input | Apps |',
    '| --- | ---: | ---: | ---: |',
    ...top(s.q4.crashSignatures, 10).map(([k, v]) => `| \`${cell(k)}\` | ${v} | ${s.q4.crashOnValidSignatures[k] ?? 0} | ${s.q4.crashAppsBySignature[k]} |`),
  ];
  return `${lines.join('\n')}\n`;
}

export function asText(s: GallerySummary): string {
  const kv = (rec: Record<string, number>, n: number, apps?: Record<string, number>) =>
    top(rec, n)
      .map(([k, v]) => `    ${v}${apps ? ` (apps ${apps[k]})` : ''}  ${k}`)
      .join('\n');
  return [
    `smoke:gallery apps=${s.apps} app-errors=${s.appErrors} iterations=${s.iterations} seed=${s.seed}`,
    `Q2 compiles: apps-pass=${s.q2.appsCompile} modules=${s.q2.modules} node-check-failures=${s.q2.nodeCheckFailures} scanned=${s.q2.scanned} free-identifiers=${s.q2.freeIdentifiers} modules-with-free=${s.q2.modulesWithFreeIdentifiers} apps-with-free=${s.q2.appsWithFreeIdentifiers} apps-with-unbound-row=${s.q2.appsWithUnboundRow}`,
    `  top free identifiers:\n${kv(s.q2.freeByName, 10, s.q2.freeAppsByName)}`,
    `  type: checked=${s.q2.typeChecked} handler-errors=${s.q2.typeErrors} advisories=${s.q2.typeAdvisories} template-errors=${s.q2.templateTypeErrors} by-code=${JSON.stringify(s.q2.typeByCode)}`,
    `  top type messages:\n${kv(s.q2.typeMessages, 15, s.q2.typeAppsByMessage)}`,
    `Q4 smoke: apps-pass=${s.q4.appsSmokeClean} handlers=${s.q4.handlers} calls=${s.q4.calls} handlers-with-crash=${s.q4.handlersWithCrash} crash-on-valid=${s.q4.handlersCrashOnValid} import-failures=${s.q4.importFailures}`,
    `  crash by class (handlers): ${JSON.stringify(s.q4.crashByClass)}`,
    `  allowed deluge (calls): ${JSON.stringify(s.q4.delugeByClass)}`,
    `  unmapped (calls): ${JSON.stringify(s.q4.unmappedByClass)}`,
    `  top crash signatures:\n${kv(s.q4.crashSignatures, 15, s.q4.crashAppsBySignature)}`,
    `  top crash signatures on all-valid input (handlers):\n${kv(s.q4.crashOnValidSignatures, 15)}`,
    `  top unmapped signatures:\n${kv(s.q4.unmappedSignatures, 10)}`,
    `prefetch: modules=${s.prefetch.modules} non-reads=${s.prefetch.nonReads} apps-with-non-reads=${s.prefetch.appsWithNonReads} by-op=${JSON.stringify(s.prefetch.byOp)}`,
    `per-app: ${s.perApp.map((p) => `${p.index}:${p.compiles ? 'C' : 'c'}${p.smokeClean ? 'S' : 's'}${p.error ? '!' : ''} prefetch-non-reads=${p.prefetchNonReads}`).join(' ')}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--iterations');
  const iterations = at >= 0 ? Number(argv[at + 1]) : GALLERY_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) emit('smoke:gallery --iterations must be a positive integer\n', 2);
  const once = argv.indexOf('--once');
  if (once >= 0) {
    const target = argv[once + 1];
    if (!target) emit('smoke:gallery --once <path>\n', 2);
    let row: AppRow;
    try {
      row = await runOne(target, iterations);
    } catch (err) {
      const error = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).split('\n')[0]!.slice(0, 200);
      emit(JSON.stringify({ failure: { error, resource: isResourceError(err) } }), 1);
    }
    const gate = prefetchFailure(row);
    if (gate) emit(JSON.stringify({ failure: { error: gate.error, resource: false } }), 1);
    emit(JSON.stringify(row));
  }
  const dir = process.env.C2C_GALLERY_DIR || (process.env.C2C_FIXTURES_DIR ? join(process.env.C2C_FIXTURES_DIR, 'gallery') : '');
  if (!dir) emit('smoke:gallery requires C2C_GALLERY_DIR or C2C_FIXTURES_DIR\n', 2);
  const s = await runGallery(dir, iterations, { onStats: (st) => process.stderr.write(`${statsLine(st)}\n`) });
  if (argv.includes('--json')) emit(`${JSON.stringify(s, null, 2)}\n`);
  if (argv.includes('--markdown')) {
    const body = asMarkdown(s);
    writeGalleryCache({ inputs: inputsDigest(dir), iterations, body });
    emit(docBlock(body));
  }
  emit(`${asText(s)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Failures go to stderr: stdout carries a summary or nothing.
  main().catch((err: unknown) => {
    process.stderr.write(`smoke:gallery: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
