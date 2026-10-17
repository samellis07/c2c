/**
 * Per-fixture migration report: manual steps, TODO counts, and owner-scope
 * labels. Committed as markdown + JSON so a change to any of the three
 * shows up in review.
 *
 * Regenerate with packages/cli/scripts/update-fixture-migration-reports.mjs
 * after `npm run build`.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { listDsFiles, parseFileWithSidecars, widgetManualItems } from '../../core/src/index.js';
import { compareEnUs } from '../../core/src/order.js';
import { decode } from '../../core/src/source.js';
import { CUSTOMER_STEPS } from '../../deploy/src/customer-steps.js';
import type { FieldGap } from '../../schema/src/index.js';
import { analyze, guidedTodoSteps, type GuidedTodoStep } from './analyze.js';
import type { GuidedResidual } from './guided-residual.js';
import { precheck, type Severity } from './precheck.js';
import { ownerScope, type ScopeEntry } from './scope-labels.js';

export interface ManualStep {
  severity: Severity;
  check: string;
  count: number;
  workaround?: string;
}

export interface ConvertedInventory {
  forms: number;
  reports: number;
  pages: number;
  functions: number;
}

export interface FixtureMigrationReport {
  schema: 'c2c-fixture-migration-report/1';
  /** Path under fixtures/, without the .ds suffix. */
  fixture: string;
  app: string | null;
  scope: ScopeEntry[];
  converted: ConvertedInventory;
  todoCount: number;
  todoKinds: { construct: string; count: number }[];
  fieldGaps: FieldGap[];
  manualSteps: ManualStep[];
  /** Parts the generated app does not show to end users, with the reason each is hidden. */
  hiddenParts: { location: string; reason: string }[];
  humanSteps: string[];
  /** Residual TODO holes that carry a guided step: where the Creator code is and the manual step. Still counted in `todoCount`. */
  todoSteps?: GuidedTodoStep[];
  /** Constructs the converter drops (still counted as silent drops), each with its reason and guided step. */
  silentDrops?: number;
  residuals?: GuidedResidual[];
}

export interface InRepoFixture {
  id: string;
  file: string;
}

export function fixturesDir(repoRoot: string): string {
  return join(repoRoot, 'fixtures');
}

export function migrationReportGoldenDir(repoRoot: string): string {
  return join(repoRoot, 'packages/cli/test/golden/migration-reports');
}

/** Every `.ds` export committed under fixtures/, in en-US path order. */
export function listInRepoFixtures(repoRoot: string): InRepoFixture[] {
  const root = fixturesDir(repoRoot);
  return listDsFiles(root)
    .map((file) => {
      const rel = relative(root, file).split(sep).join('/');
      const id = rel.toLowerCase().endsWith('.ds') ? rel.slice(0, -3) : rel;
      return { id, file };
    })
    .sort((a, b) => compareEnUs(a.id, b.id));
}

function manualStepsOf(ir: ReturnType<typeof parseFileWithSidecars>['ir'], source: string): ManualStep[] {
  const checked = precheck(ir, source);
  const rows = new Map<string, ManualStep>();
  for (const finding of checked.findings) {
    const key = `${finding.severity}\0${finding.check}`;
    const row = rows.get(key);
    if (row) row.count += 1;
    else rows.set(key, { severity: finding.severity, check: finding.check, count: 1, workaround: finding.fix });
  }
  for (const widget of widgetManualItems(ir.widgets)) {
    const severity: Severity = widget.status === 'missing' ? 'blocker' : 'warning';
    const check = `widget-package:${widget.name}`;
    rows.set(`${severity}\0${check}`, { severity, check, count: 1, workaround: widget.detail });
  }
  return [...rows.values()].sort((a, b) => (a.severity === b.severity ? compareEnUs(a.check, b.check) : a.severity === 'blocker' ? -1 : 1));
}

export function buildFixtureMigrationReport(fixture: InRepoFixture): FixtureMigrationReport {
  const ir = parseFileWithSidecars(fixture.file).ir;
  const source = decode(readFileSync(fixture.file)).text;
  const analysis = analyze(ir);
  const isEmpty = ir.forms.length === 0 && ir.reports.length === 0 && ir.pages.length === 0 && ir.functions.length === 0;
  return {
    schema: 'c2c-fixture-migration-report/1',
    fixture: fixture.id,
    app: ir.name ?? null,
    scope: ownerScope(),
    converted: {
      forms: ir.forms.length,
      reports: ir.reports.length,
      pages: ir.pages.length,
      functions: ir.functions.length,
    },
    todoCount: analysis.determinism.todoCount,
    todoKinds: analysis.determinism.todoKinds.map((kind) => ({ construct: kind.construct, count: kind.count })),
    fieldGaps: analysis.fieldGaps,
    manualSteps: manualStepsOf(ir, source),
    hiddenParts: analysis.hiddenParts.map((part) => ({ location: part.location, reason: part.reason })),
    todoSteps: guidedTodoSteps(analysis),
    humanSteps: isEmpty ? [] : [...CUSTOMER_STEPS],
    silentDrops: analysis.determinism.silentDrops,
    residuals: analysis.residuals,
  };
}

export function fixtureMigrationReportAsJson(report: FixtureMigrationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function convertedLinesOf(converted: ConvertedInventory): string[] {
  const items: string[] = [];
  if (converted.forms > 0) items.push(`- ${converted.forms} form${converted.forms === 1 ? '' : 's'}`);
  if (converted.reports > 0) items.push(`- ${converted.reports} report${converted.reports === 1 ? '' : 's'}`);
  if (converted.pages > 0) items.push(`- ${converted.pages} page${converted.pages === 1 ? '' : 's'}`);
  if (converted.functions > 0) items.push(`- ${converted.functions} function${converted.functions === 1 ? '' : 's'}`);
  return items.length ? items : ['- none'];
}

function fieldGapLinesOf(gaps: readonly FieldGap[]): string[] {
  if (!gaps.length) return ['- none'];
  return gaps.map((gap) => {
    const fields = gap.fields.length ? ` (${gap.fields.map((f) => `${f.form}.${f.field}`).join(', ')})` : '';
    return `- ${gap.matrixId}: ${gap.count}${fields} — ${gap.reason}`;
  });
}

function manualStepLinesOf(steps: readonly ManualStep[]): string[] {
  if (!steps.length) return ['- none'];
  return steps.map((step) => {
    const fix = step.workaround ? ` — ${step.workaround}` : '';
    return `- ${step.count} ${step.severity} ${step.check}${fix}`;
  });
}

function humanStepLinesOf(steps: readonly string[]): string[] {
  if (!steps.length) return ['- none'];
  return steps.map((step) => `- ${step}`);
}

export function fixtureMigrationReportAsMarkdown(report: FixtureMigrationReport): string {
  const scope = report.scope.length ? report.scope.map((item) => `- ${item.feature} — ${item.label}`) : ['- none'];
  const converted = convertedLinesOf(report.converted);
  const todos = report.todoKinds.length ? report.todoKinds.map((kind) => `- ${kind.count} ${kind.construct}`) : ['- none'];
  const gaps = fieldGapLinesOf(report.fieldGaps);
  const manual = manualStepLinesOf(report.manualSteps);
  const hidden = report.hiddenParts.length ? report.hiddenParts.map((part) => `- ${part.location}: ${part.reason}`) : ['- none'];
  const human = humanStepLinesOf(report.humanSteps);
  const residuals = report.residuals?.length
    ? report.residuals.flatMap((item) => [`- \`${item.id}\` — not converted. ${item.reason}`, `  - Step: ${item.step}`])
    : ['- none'];
  const todoSteps = report.todoSteps?.length
    ? report.todoSteps.flatMap((item) => [`- \`${item.location}\` — ${item.construct}`, `  - Step: ${item.step}`])
    : ['- none'];
  return [
    `# Migration report: ${report.fixture}`,
    '',
    `App: ${report.app ?? '(none)'}`,
    '',
    '## Scope',
    '',
    ...scope,
    '',
    '## Converted inventory',
    '',
    ...converted,
    '',
    '## TODO counts',
    '',
    String(report.todoCount),
    '',
    ...todos,
    '',
    '## Field gaps',
    '',
    ...gaps,
    '',
    '## Manual steps',
    '',
    ...manual,
    '',
    '## Residual TODO steps',
    '',
    ...todoSteps,
    '',
    '## Hidden from end users',
    '',
    String(report.hiddenParts.length),
    '',
    ...hidden,
    '',
    '## Human steps',
    '',
    ...human,
    '',
    '## Not converted',
    '',
    `Silent drops: ${report.silentDrops ?? 0} (still counted; each has a guided step below)`,
    '',
    ...residuals,
    '',
  ].join('\n');
}

function relFiles(dir: string, prefix: string, out: string[]): void {
  const st = statSync(dir, { throwIfNoEntry: false });
  if (!st) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const child = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const info = statSync(child);
    if (info.isDirectory()) relFiles(child, rel, out);
    else if (info.isFile()) out.push(rel);
  }
}

/** Rewrite the committed markdown and JSON goldens. Returns the fixture ids written. */
export function writeFixtureMigrationReports(repoRoot: string): string[] {
  const outDir = migrationReportGoldenDir(repoRoot);
  mkdirSync(outDir, { recursive: true });
  const fixtures = listInRepoFixtures(repoRoot);
  const keep = new Set<string>();
  for (const fixture of fixtures) {
    const report = buildFixtureMigrationReport(fixture);
    const base = join(outDir, fixture.id);
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(`${base}.json`, fixtureMigrationReportAsJson(report));
    writeFileSync(`${base}.md`, fixtureMigrationReportAsMarkdown(report));
    keep.add(`${fixture.id}.json`);
    keep.add(`${fixture.id}.md`);
  }
  const existing: string[] = [];
  relFiles(outDir, '', existing);
  for (const rel of existing) {
    if (keep.has(rel)) continue;
    rmSync(join(outDir, rel));
  }
  return fixtures.map((fixture) => fixture.id);
}
