/**
 * Aggregate deterministic-migration report over a directory of apps.
 *
 * One entry per app (each sub-folder with .ds files, or each .ds file) with
 * the deterministic flag from `analyze`: true only when the app has zero
 * residual TODO items, no fill-todos lock entries applied to it, and no
 * silent drops. `noTodoApps` counts the same apps without the silent-drop
 * condition, so the gap between the two numbers is the apps held back only by
 * silent drops.
 *
 * The aggregate counts ONLY deterministic apps toward the 95%/100% migration
 * targets. Both numbers are shown: total apps and deterministic apps.
 *
 * Counts and construct names only — no source text. Per-app names are folder
 * or file names; do not commit this report when it names private exports.
 */

import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { entryKind, listDsFiles, parseFileOrProjectWithSidecars, type App } from '../../core/src/index.js';
import { compareEnUs } from '../../core/src/order.js';
import { readLockIfPresent, type FillLock, type LockFileFs } from '../../deluge/src/index.js';
import { analyze, type TodoKind } from './analyze.js';
import type { FieldGap } from '../../schema/src/generator.js';
import type { HiddenPart } from '../../ui-react/src/index.js';
import type { GuidedResidual } from './guided-residual.js';
import { MATRIX_SNAPSHOT, type MatrixSnapshot } from './feature-matrix.js';

export interface MigrationAppEntry {
  app: string;
  deterministic: boolean;
  todoCount: number;
  fillLockEntries: number;
  todoKinds: TodoKind[];
  fieldGaps: FieldGap[];
  /** Parts the generated app does not show to end users, with the reason each is hidden. */
  hiddenParts: HiddenPart[];
  /** UI stubs still marked TODO. Each one is included in `todoCount`. */
  uiTodoCount: number;
  /** Coverage-ledger violations: constructs neither emitted nor counted. Any one disqualifies the app. */
  silentDrops: number;
  /** Silent drops by construct kind (public kind names only). */
  silentDropKinds: TodoKind[];
  /** One guided item per silent drop (what, why, the customer's step, a stable id). The drops stay counted. */
  residuals: GuidedResidual[];
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
    /**
     * Apps with zero residual TODO items and no fill-todos lock entries. Silent
     * drops are not considered, so this is at least `deterministicApps`.
     */
    noTodoApps: number;
    deterministicApps: number;
    /** Deterministic share of total apps, 0..100, rounded to one decimal. */
    deterministicShare: number;
    /** Only deterministic apps count toward these. */
    targets: { p95: MigrationTarget; p100: MigrationTarget };
    todoTotal: number;
    distinctTodoKinds: number;
    todoKinds: TodoKind[];
    fieldGaps: FieldGap[];
    fieldGapTotal: number;
    /** Every part, across the apps, that the generated app does not show to end users. */
    hiddenPartTotal: number;
    /** Deterministic apps that still have UI TODO stubs. A stub is a residual hole, so this stays zero. */
    deterministicWithUiTodos: { apps: number; uiTodos: number };
    /** Coverage-ledger violations across the corpus (constructs neither emitted nor counted). */
    silentDrops: number;
    /** Silent drops by construct kind across the corpus, count desc then kind asc. */
    silentDropKinds: TodoKind[];
    /** Guided residual items across the corpus: one per silent drop, so this equals `silentDrops`. */
    guidedResiduals: number;
    /** Guided residual items whose step is the generic manual step (no workaround text exists). */
    genericResidualSteps: number;
    /** Silent drops with no guided residual item. Stays zero. */
    unguidedSilentDrops: number;
  };
}

/** Apps under a directory: each sub-folder with .ds files, or each .ds file. Sorted by name. Symlinks are not followed. */
export function listReportApps(dir: string): { name: string; target: string }[] {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareEnUs(a.name, b.name));
  const out: { name: string; target: string }[] = [];
  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.')) continue;
    const target = join(dir, name);
    // The entry kind comes from the directory read; a symlink is skipped.
    if (ent.isSymbolicLink()) continue;
    if (entryKind(ent) === 'directory') {
      if (listDsFiles(target).length) out.push({ name, target });
    } else if (name.toLowerCase().endsWith('.ds')) {
      out.push({ name: basename(name), target });
    }
  }
  return out;
}

/**
 * The app's c2c.lock.json, opened once without following a symlink. The read
 * decides: a missing target (ENOENT), a file target (ENOTDIR), a symlinked
 * lock or a lock that is not a regular file is no lock.
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
      fieldGaps: report.fieldGaps,
      hiddenParts: report.hiddenParts,
      uiTodoCount: report.determinism.uiTodoCount,
      silentDrops: report.determinism.silentDrops,
      silentDropKinds: report.determinism.silentDropKinds,
      residuals: report.residuals,
      readiness: report.score.readiness,
      band: report.score.band,
    };
  });
  apps.sort((a, b) => compareEnUs(a.app, b.app));

  const deterministicApps = apps.filter((app) => app.deterministic).length;
  const withUi = apps.filter((app) => app.deterministic && app.uiTodoCount > 0);
  const noTodoApps = apps.filter((app) => app.todoCount === 0 && app.fillLockEntries === 0).length;
  const kindCounts = new Map<string, number>();
  const dropCounts = new Map<string, number>();
  const fieldGapCounts = new Map<string, FieldGap>();
  let todoTotal = 0;
  for (const app of apps) {
    todoTotal += app.todoCount;
    for (const kind of app.todoKinds) kindCounts.set(kind.construct, (kindCounts.get(kind.construct) ?? 0) + kind.count);
    for (const kind of app.silentDropKinds) dropCounts.set(kind.construct, (dropCounts.get(kind.construct) ?? 0) + kind.count);
    for (const gap of app.fieldGaps) {
      const existing = fieldGapCounts.get(gap.matrixId);
      if (existing) {
        existing.count += gap.count;
        existing.fields.push(...gap.fields);
      } else fieldGapCounts.set(gap.matrixId, { ...gap, fields: [...gap.fields] });
    }
  }
  const todoKinds: TodoKind[] = [...kindCounts.entries()]
    .map(([construct, count]) => ({ construct, count }))
    .sort(byKind);
  const silentDropKinds: TodoKind[] = [...dropCounts.entries()]
    .map(([construct, count]) => ({ construct, count }))
    .sort(byKind);
  const fieldGaps = [...fieldGapCounts.values()].sort((a, b) => compareEnUs(a.matrixId, b.matrixId));
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
      noTodoApps,
      deterministicApps,
      deterministicShare: apps.length ? Math.round((deterministicApps / apps.length) * 1000) / 10 : 100,
      targets: { p95: target(0.95), p100: target(1) },
      todoTotal,
      distinctTodoKinds: todoKinds.length,
      todoKinds,
      fieldGaps,
      fieldGapTotal: fieldGaps.reduce((total, gap) => total + gap.count, 0),
      hiddenPartTotal: apps.reduce((total, app) => total + app.hiddenParts.length, 0),
      deterministicWithUiTodos: { apps: withUi.length, uiTodos: withUi.reduce((sum, app) => sum + app.uiTodoCount, 0) },
      silentDrops: apps.reduce((sum, app) => sum + app.silentDrops, 0),
      silentDropKinds,
      guidedResiduals: apps.reduce((sum, app) => sum + app.residuals.length, 0),
      genericResidualSteps: apps.reduce((sum, app) => sum + app.residuals.filter((item) => item.stepSource === 'generic').length, 0),
      unguidedSilentDrops: apps.reduce((sum, app) => sum + Math.max(0, app.silentDrops - app.residuals.filter((item) => item.step.trim()).length), 0),
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
    `apps with no residual todos: ${a.noTodoApps}/${a.totalApps}`,
    `apps with no residual todos and no silent drops (deterministic): ${a.deterministicApps}/${a.totalApps}`,
    `silent drops (total): ${a.silentDrops}`,
    ...a.silentDropKinds.slice(0, 10).map((kind) => `  ${kind.count} ${kind.construct}`),
    `guided residual items: ${a.guidedResiduals} (${a.genericResidualSteps} with a generic manual step); unguided silent drops: ${a.unguidedSilentDrops}`,
    `residual TODO items: ${a.todoTotal} across ${a.distinctTodoKinds} kinds`,
    `field gaps: ${a.fieldGapTotal} across ${a.fieldGaps.length} kinds`,
    ...a.fieldGaps.map((gap) => `  ${gap.matrixId}: ${gap.count} (${gap.fields.map((field) => `${field.form}.${field.field}`).join(', ')}) — ${gap.reason}`),
    `hidden from end users: ${a.hiddenPartTotal}`,
    ...report.apps.flatMap((app) => app.hiddenParts.map((part) => `  ${app.app}: ${part.location}: ${part.reason}`)),
    `UI TODO stubs on deterministic apps: ${a.deterministicWithUiTodos.uiTodos} in ${a.deterministicWithUiTodos.apps} of the ${a.deterministicApps} deterministic apps`,
    ...a.todoKinds.slice(0, 20).map((kind) => `  ${kind.count} ${kind.construct}`),
  ].join('\n');
}
