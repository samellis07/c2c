/**
 * Aggregate deterministic-migration report over a directory of apps.
 *
 * One entry per app (each sub-folder with .ds files, or each .ds file) with
 * the deterministic flag from `analyze`: true only when the app has zero
 * residual TODO items and no fill-todos lock entries applied to it.
 *
 * The aggregate counts ONLY deterministic apps toward the 95%/100% migration
 * targets. Both numbers are shown: total apps and deterministic apps.
 *
 * Counts and construct names only — no source text. Per-app names are folder
 * or file names; do not commit this report when it names private exports.
 */

import { closeSync, constants, fstatSync, openSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { listDsFiles, parseFileOrProjectWithSidecars, type App } from '../../core/src/index.js';
import { compareEnUs } from '../../core/src/order.js';
import { readLockIfPresent, type FillLock, type LockFileFs } from '../../deluge/src/index.js';
import { analyze, type TodoKind } from './analyze.js';
import { MATRIX_SNAPSHOT, type MatrixSnapshot } from './feature-matrix.js';

export interface MigrationAppEntry {
  app: string;
  deterministic: boolean;
  todoCount: number;
  fillLockEntries: number;
  todoKinds: TodoKind[];
  /** UI stubs still marked TODO. Each one is included in `todoCount`. */
  uiTodoCount: number;
  readiness: number;
  band: 'ready' | 'needs-work' | 'blocked';
}

export interface MigrationTarget {
  /** Apps needed to meet the target. */
  required: number;
  met: boolean;
}

export interface MigrationReport {
  schema: 'c2c-migration-report/1';
  label: string;
  matrix: MatrixSnapshot;
  apps: MigrationAppEntry[];
  aggregate: {
    totalApps: number;
    deterministicApps: number;
    /** Deterministic share of total apps, 0..100, rounded to one decimal. */
    deterministicShare: number;
    /** Only deterministic apps count toward these. */
    targets: { p95: MigrationTarget; p100: MigrationTarget };
    todoTotal: number;
    distinctTodoKinds: number;
    todoKinds: TodoKind[];
    /** Deterministic apps that still have UI TODO stubs. A stub is a residual hole, so this stays zero. */
    deterministicWithUiTodos: { apps: number; uiTodos: number };
  };
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * What a symlink resolves to, from one O_NONBLOCK open and an fstat of that
 * descriptor. A dangling link is `undefined`. A socket cannot be opened but
 * exists, so it is `other`.
 */
function linkTargetKind(path: string): 'directory' | 'other' | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    if (code === 'ENXIO' || code === 'EOPNOTSUPP') return 'other';
    throw err;
  }
  try {
    return fstatSync(fd).isDirectory() ? 'directory' : 'other';
  } finally {
    closeSync(fd);
  }
}

/** Apps under a directory: each sub-folder with .ds files, or each .ds file. Sorted by name. */
export function listReportApps(dir: string): { name: string; target: string }[] {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareEnUs(a.name, b.name));
  const out: { name: string; target: string }[] = [];
  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.')) continue;
    const target = join(dir, name);
    // The entry kind comes from the directory read; only a symlink is resolved.
    const kind = ent.isSymbolicLink() ? linkTargetKind(target) : ent.isDirectory() ? 'directory' : 'other';
    if (!kind) continue;
    if (kind === 'directory') {
      if (listDsFiles(target).length) out.push({ name, target });
    } else if (name.toLowerCase().endsWith('.ds')) {
      out.push({ name: basename(name), target });
    }
  }
  return out;
}

/**
 * The app's c2c.lock.json, opened once. The read decides: a missing target
 * (ENOENT), a file target (ENOTDIR) or a lock that is not a regular file is
 * no lock.
 */
export function lockFor(target: string, fsImpl?: LockFileFs): FillLock | undefined {
  return readLockIfPresent(join(target, 'c2c.lock.json'), fsImpl);
}

/** A project directory or one `.ds` file with its widget sidecars, classified by the opened target. */
export function loadIr(target: string): App {
  return parseFileOrProjectWithSidecars(target).ir;
}

const byKind = (a: TodoKind, b: TodoKind) => b.count - a.count || compareEnUs(a.construct, b.construct);

export function buildMigrationReport(entries: { name: string; ir: App; lock?: FillLock }[], label: string): MigrationReport {
  const apps: MigrationAppEntry[] = entries.map((entry) => {
    const report = analyze(entry.ir, entry.lock ? { lock: entry.lock } : undefined);
    return {
      app: entry.name,
      deterministic: report.determinism.deterministic,
      todoCount: report.determinism.todoCount,
      fillLockEntries: report.determinism.fillLockEntries,
      todoKinds: report.determinism.todoKinds,
      uiTodoCount: report.determinism.uiTodoCount,
      readiness: report.score.readiness,
      band: report.score.band,
    };
  });
  apps.sort((a, b) => compareEnUs(a.app, b.app));

  const deterministicApps = apps.filter((app) => app.deterministic).length;
  const withUi = apps.filter((app) => app.deterministic && app.uiTodoCount > 0);
  const kindCounts = new Map<string, number>();
  let todoTotal = 0;
  for (const app of apps) {
    todoTotal += app.todoCount;
    for (const kind of app.todoKinds) kindCounts.set(kind.construct, (kindCounts.get(kind.construct) ?? 0) + kind.count);
  }
  const todoKinds: TodoKind[] = [...kindCounts.entries()]
    .map(([construct, count]) => ({ construct, count }))
    .sort(byKind);
  const target = (share: number): MigrationTarget => {
    const required = Math.ceil(share * apps.length);
    return { required, met: deterministicApps >= required };
  };
  return {
    schema: 'c2c-migration-report/1',
    label,
    matrix: MATRIX_SNAPSHOT,
    apps,
    aggregate: {
      totalApps: apps.length,
      deterministicApps,
      deterministicShare: apps.length ? Math.round((deterministicApps / apps.length) * 1000) / 10 : 100,
      targets: { p95: target(0.95), p100: target(1) },
      todoTotal,
      distinctTodoKinds: todoKinds.length,
      todoKinds,
      deterministicWithUiTodos: { apps: withUi.length, uiTodos: withUi.reduce((sum, app) => sum + app.uiTodoCount, 0) },
    },
  };
}

/** Build a report for every app under a directory, picking up per-app c2c.lock.json files. */
export function migrationReportForDir(dir: string, label: string): MigrationReport {
  return buildMigrationReport(
    listReportApps(dir).map((app) => ({ name: app.name, ir: loadIr(app.target), lock: lockFor(app.target) })),
    label,
  );
}

export function migrationReportAsJson(report: MigrationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function migrationReportAsText(report: MigrationReport): string {
  const a = report.aggregate;
  return [
    `migration report: ${report.label}  apps ${a.totalApps}  deterministic ${a.deterministicApps} (${a.deterministicShare}%)`,
    `targets (deterministic apps only): 95% needs ${a.targets.p95.required} — ${a.targets.p95.met ? 'met' : 'NOT met'}; 100% needs ${a.targets.p100.required} — ${a.targets.p100.met ? 'met' : 'NOT met'}`,
    `residual TODO items: ${a.todoTotal} across ${a.distinctTodoKinds} kinds`,
    `UI TODO stubs on deterministic apps: ${a.deterministicWithUiTodos.uiTodos} in ${a.deterministicWithUiTodos.apps} of the ${a.deterministicApps} deterministic apps`,
    ...a.todoKinds.slice(0, 20).map((kind) => `  ${kind.count} ${kind.construct}`),
  ].join('\n');
}
