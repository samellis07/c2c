/**
 * Per-fixture migration report: manual steps, TODO counts, and owner-scope
 * labels. Committed as markdown + JSON so a change to any of the three
 * shows up in review.
 *
 * Regenerate with packages/cli/scripts/update-fixture-migration-reports.mjs
 * after `npm run build`.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { listDsFiles, parseFileWithSidecars, widgetManualItems } from '../../core/src/index.js';
import { compareEnUs } from '../../core/src/order.js';
import { decode } from '../../core/src/source.js';
import { CUSTOMER_STEPS, planCustomerSteps } from '../../deploy/src/customer-steps.js';
import { planCli } from '../../deploy/src/index.js';
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
  /** The Catalyst resources the conversion generates. */
  catalyst: {
    tables: number;
    nosqlCollections: number;
    functions: number;
    cronJobs: number;
    slatePages: number;
  };
  /** Deluge statements: how many translated, how many run through a compatibility shim. */
  deluge: { statements: number; translated: number; shimmed: number };
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

export interface PlanStep {
  id: string;
  via: string;
  command?: string;
}

export interface PlanRun {
  code: number;
  files: string[];
  steps: PlanStep[];
  connectionSecretKeys: string[];
  stderr: string;
}

const refused = (what: string) => async (): Promise<never> => {
  throw new Error(`migration report is offline: ${what} refused`);
};

/** `c2c plan` in-process, with spawn and fetch refused. Returns the written files and the plan steps. */
export async function runOfflinePlan(file: string): Promise<PlanRun> {
  const out = mkdtempSync(join(tmpdir(), 'c2c-migration-report-plan-'));
  let stderr = '';
  try {
    const code = await planCli([file, '--out', out, '--dc', 'in'], {
      stdout() {},
      stderr: (text: string) => {
        stderr += text;
      },
      env: {},
      spawn: refused('spawn'),
      fetch: refused('fetch'),
    } as unknown as Parameters<typeof planCli>[1]);
    const files = readdirSync(out).sort(compareEnUs);
    let steps: PlanStep[] = [];
    let connectionSecretKeys: string[] = [];
    if (files.includes('plan.json')) {
      const plan = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8')) as { steps?: PlanStep[]; connectionSecretKeys?: string[] };
      steps = plan.steps ?? [];
      connectionSecretKeys = plan.connectionSecretKeys ?? [];
    }
    return { code, files, steps, connectionSecretKeys, stderr };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Console plan steps that are the same visit as a checklist item ("Sign in once", "Verify mail sender"), so they count once. */
const SAME_VISIT_AS_CUSTOMER_STEP = new Set(['sign-in-check', 'mail-sender']);

/** The customer's guided steps for a plan: the checklist items, then console steps that are a separate visit. */
export function humanSteps(plan: Pick<PlanRun, 'steps' | 'connectionSecretKeys'>): string[] {
  const checklist = planCustomerSteps(plan.steps, { connectionSecretKeys: plan.connectionSecretKeys });
  const consoleSteps = plan.steps
    .filter((step) => step.via === 'console' && !SAME_VISIT_AS_CUSTOMER_STEP.has(step.id))
    .map((step) => `console: ${step.id}`);
  return [...checklist, ...consoleSteps];
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

/** The customer's human steps for the report: checklist items, then console provision steps with the console text. */
function reportHumanSteps(plan: PlanRun): string[] {
  const commands = new Map(plan.steps.map((step) => [step.id, step.command ?? '']));
  return humanSteps(plan).map((step) => {
    if (!step.startsWith('console: ')) return step;
    const command = commands.get(step.slice('console: '.length));
    return command ? `${step} — ${command}` : step;
  });
}

export async function buildFixtureMigrationReport(fixture: InRepoFixture): Promise<FixtureMigrationReport> {
  const ir = parseFileWithSidecars(fixture.file).ir;
  const source = decode(readFileSync(fixture.file)).text;
  const analysis = analyze(ir);
  const isEmpty = ir.forms.length === 0 && ir.reports.length === 0 && ir.pages.length === 0 && ir.functions.length === 0;
  const plan = isEmpty ? null : await runOfflinePlan(fixture.file);
  const steps = plan?.code === 0 ? reportHumanSteps(plan) : [...CUSTOMER_STEPS];
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
      catalyst: {
        tables: analysis.catalyst.tables,
        nosqlCollections: analysis.catalyst.nosqlCollections,
        functions: analysis.catalyst.functions,
        cronJobs: analysis.catalyst.cronJobs,
        slatePages: analysis.catalyst.slatePages,
      },
      deluge: { statements: analysis.deluge.statements, translated: analysis.deluge.translated, shimmed: analysis.deluge.shimmed },
    },
    todoCount: analysis.determinism.todoCount,
    todoKinds: analysis.determinism.todoKinds.map((kind) => ({ construct: kind.construct, count: kind.count })),
    fieldGaps: analysis.fieldGaps,
    manualSteps: manualStepsOf(ir, source),
    hiddenParts: analysis.hiddenParts.map((part) => ({ location: part.location, reason: part.reason })),
    todoSteps: guidedTodoSteps(analysis),
    humanSteps: isEmpty ? [] : steps,
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
  if (!items.length) return ['- none'];
  const c = converted.catalyst;
  const parts = [`${c.tables} Data Store table${c.tables === 1 ? '' : 's'}`];
  if (c.nosqlCollections > 0) parts.push(`${c.nosqlCollections} NoSQL collection${c.nosqlCollections === 1 ? '' : 's'}`);
  parts.push(`${c.functions} Catalyst function${c.functions === 1 ? '' : 's'}`);
  parts.push(`${c.cronJobs} scheduled job${c.cronJobs === 1 ? '' : 's'}`);
  parts.push(`${c.slatePages} page${c.slatePages === 1 ? '' : 's'}`);
  items.push(`- The generated Catalyst app carries ${parts.join(', ')}`);
  if (converted.deluge.statements > 0) {
    items.push(
      `- Deluge: ${converted.deluge.translated} statement${converted.deluge.translated === 1 ? '' : 's'} translated, ${converted.deluge.shimmed} kept working through a compatibility shim, of ${converted.deluge.statements}`,
    );
  }
  return items;
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
export async function writeFixtureMigrationReports(repoRoot: string): Promise<string[]> {
  const outDir = migrationReportGoldenDir(repoRoot);
  mkdirSync(outDir, { recursive: true });
  const fixtures = listInRepoFixtures(repoRoot);
  const keep = new Set<string>();
  for (const fixture of fixtures) {
    const report = await buildFixtureMigrationReport(fixture);
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
