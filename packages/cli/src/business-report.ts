/**
 * Business-facing per-app migration report.
 *
 * Reuses the existing analyze, plan and UI TODO data; it never runs a second
 * analysis pass and never names internals the business owner does not need.
 * Output is deterministic: no wall-clock time, environment values or machine
 * paths are written.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import { flag, loadApp, type Io } from '../../deploy/src/cli.js';
import { hasReportJson, readSourceCsv, readSourceJson } from '../../deploy/src/csv.js';
import { readSourceBackup } from '../../deploy/src/backup.js';
import { buildOfflinePlan, resolveDc, type OfflinePlan } from '../../deploy/src/offline-plan.js';
import type { SourceTableData } from '../../schema/src/generator.js';
import { buildUi, formStatus, type UiModel } from '../../ui/src/index.js';
import { analyze, type AnalyzeReport, type DelugeLocation } from './analyze.js';
import {
  connectionSecretsWording,
  featureName,
  featureNotice,
  fieldGapWording,
  scrubBusiness,
  serviceStartSentence,
  todoNotice,
  uiReasonNotice,
  widgetWording,
} from './report-wording.js';

export interface ReportSection {
  count: number;
  names: string[];
}

export interface GuidedStep {
  id: 'start-services' | 'accept-invite' | 'sign-in' | 'verify-sender';
  title: string;
  instruction: string;
}

export interface AttentionItem {
  area: string;
  name: string;
  detail: string;
  workaround: string;
  /** Internal reason or construct, kept for the appendix JSON only. */
  technical?: string;
}

export interface BusinessMigrationReport {
  schema: 'c2c-business-migration-report/1';
  app: string;
  dataCentre: string;
  converted: {
    forms: ReportSection;
    reports: ReportSection;
    pages: ReportSection;
    workflows: ReportSection;
    schedules: ReportSection;
    functions: ReportSection;
    roles: ReportSection;
  };
  guidedSteps: GuidedStep[];
  appSpecificSteps: AttentionItem[];
  unsupported: AttentionItem[];
  data: {
    tables: { name: string; source: string; columns: number; sourceRows?: number; storage: 'table' | 'collection' }[];
    verification: string[];
  };
  goLiveChecklist: string[];
}

export interface BusinessReportOptions {
  dc: string;
  mail?: boolean;
  source?: readonly SourceTableData[];
}

const sorted = (names: readonly string[]): string[] => [...names].sort(compareEnUs);
const section = (names: readonly string[]): ReportSection => ({ count: names.length, names: sorted(names) });
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const names = (items: readonly string[]): string => (items.length ? items.join(', ') : 'none');

function featureWorkaround(name: string): string {
  if (/payment/i.test(name)) return 'Keep payment capture in the original app or connect a reviewed payment provider after launch; the generated app does not take payment.';
  if (/offline/i.test(name)) return 'Use the generated web app while online; add a reviewed offline process only if the business still needs one.';
  if (/form email/i.test(name)) return 'Keep the form-address email route in the original app, or replace it with a reviewed integration before go-live.';
  if (/cliq/i.test(name)) return 'Keep the chat bot where it is, or replace its action with a reviewed webhook or integration.';
  if (/native mobile|mdm/i.test(name)) return 'Use the generated web app in mobile browsers; plan a separate native/mobile-device project if required.';
  if (/c8 dialect/i.test(name)) return 'Re-export or adjust the app so it uses a supported source format before migration.';
  return 'Keep this behaviour in the original app as the fallback, or add the named replacement and verify it once before relying on it.';
}

function todoWorkaround(item: DelugeLocation): string {
  if (item.manualStep) return scrubBusiness(item.manualStep);
  return `Open ${item.location} in the generated app, complete the marked item, and verify the affected flow once before go-live.`;
}

function unsupportedItems(analysis: AnalyzeReport, manualUiLocations: ReadonlySet<string>): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const feature of analysis.features.used) {
    if (feature.verdict !== 'gap' && feature.verdict !== 'blocker' && feature.verdict !== 'needs-assessment') continue;
    const name = featureName(feature.area, feature.feature);
    items.push({
      area: 'feature',
      name,
      detail: featureNotice(feature.uses),
      workaround: feature.verdict === 'needs-assessment' ? 'Verify this path in the migrated app before relying on it; keep the current process as the fallback until then.' : featureWorkaround(name),
      technical: `${feature.area}|${feature.feature} (status ${feature.status})`,
    });
  }
  for (const gap of analysis.fieldGaps) {
    for (const field of gap.fields) {
      const label = `${field.form}.${field.field}`;
      const wording = fieldGapWording(gap.matrixId, label);
      items.push({
        area: 'field',
        name: label,
        detail: wording.notice,
        workaround: wording.workaround,
        technical: `${gap.matrixId}: ${gap.reason}`,
      });
    }
  }
  const coveredFields = new Set(analysis.fieldGaps.flatMap((gap) => gap.fields.map((field) => `${field.form}.${field.field}`)));
  for (const todo of analysis.deluge.todoLocations) {
    const fieldName = todo.scope === 'ui' && todo.location.startsWith('field ') ? todo.location.slice('field '.length) : undefined;
    if (fieldName && coveredFields.has(fieldName)) continue;
    // A generated UI stub with a guided step is already an app-specific item.
    if (todo.scope === 'ui' && manualUiLocations.has(todo.location)) continue;
    items.push({
      area: todo.scope === 'ui' ? 'screen' : todo.scope,
      name: todo.location,
      detail: todo.scope === 'ui' ? uiReasonNotice(todo.location.split(' ')[0] ?? '', todo.location.replace(/^[a-z]+ /, ''), todo.construct) : todoNotice(todo.scope, todo.location, todo.construct),
      workaround: todoWorkaround(todo),
      technical: todo.construct,
    });
  }
  items.sort((a, b) => compareEnUs(a.area, b.area) || compareEnUs(a.name, b.name) || compareEnUs(a.detail, b.detail));
  return items;
}

function guidedSteps(plan: OfflinePlan): GuidedStep[] {
  const steps: GuidedStep[] = [];
  const serviceIds = new Set(plan.steps.map((step) => step.id));
  const pending: string[] = [];
  // Slate no longer needs a console activation in the supported CLI flow; its
  // plan step remains a c2c verification detail, not a customer checklist item.
  for (const stepId of ['stratus-enable', 'smartbrowz-enable']) {
    if (!serviceIds.has(stepId)) continue;
    const sentence = serviceStartSentence(stepId);
    if (sentence) pending.push(sentence);
  }
  if (pending.length) {
    steps.push({
      id: 'start-services',
      title: 'Start the used services',
      instruction: `In the Catalyst console, ${pending.join('; ')}.`,
    });
  }
  steps.push(
    {
      id: 'accept-invite',
      title: 'Accept the admin invite',
      instruction: 'Open the app invite email sent to the admin address and set the password.',
    },
    {
      id: 'sign-in',
      title: 'Sign in once',
      instruction: 'Open the deployed app URL and sign in once so the first login completes activation.',
    },
  );
  if (serviceIds.has('mail-sender')) {
    steps.push({
      id: 'verify-sender',
      title: 'Verify the sender email',
      instruction: 'In Catalyst Mail settings, add the sender address, enter the verification code sent to it, and keep the verified address in the migration settings.',
    });
  }
  return steps;
}

function appSpecificSteps(app: App, ui: UiModel, plan: OfflinePlan): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const todo of ui.todos) {
    if (!todo.manualStep) continue;
    items.push({
      area: todo.area === 'zml' ? 'page' : todo.area,
      name: todo.name,
      detail: uiReasonNotice(todo.area, todo.name, todo.reason),
      workaround: scrubBusiness(todo.manualStep),
      technical: todo.reason,
    });
  }
  for (const manual of plan.manual ?? []) {
    const wording = widgetWording(manual.name);
    items.push({ area: 'widget', name: manual.name, detail: wording.notice, workaround: wording.workaround, technical: manual.detail });
  }
  const secrets = plan.connectionSecretKeys ?? [];
  if (secrets.length) {
    items.push({ area: 'connections', name: 'connection credentials', detail: 'Passwords and keys for connected third-party accounts are not carried into the generated app.', workaround: connectionSecretsWording(secrets), technical: `connection secret keys: ${secrets.join(', ')}` });
  }
  for (const workflow of app.workflows.filter((item) => (item.container ?? '').toLowerCase() === 'schedule')) {
    items.push({ area: 'schedule', name: workflow.name, detail: 'The schedule is created disabled for review.', workaround: 'Enable this schedule in Job Scheduling after checking its first run time.' });
  }
  items.sort((a, b) => compareEnUs(a.area, b.area) || compareEnUs(a.name, b.name));
  return items;
}

function convertedSections(app: App, ui: UiModel): BusinessMigrationReport['converted'] {
  const workflows = app.workflows.filter((item) => (item.container ?? '').toLowerCase() !== 'schedule').map((item) => item.name);
  const schedules = app.workflows.filter((item) => (item.container ?? '').toLowerCase() === 'schedule').map((item) => item.name);
  return {
    forms: section(ui.forms.filter((form) => formStatus(form) === 'generated').map((form) => form.name)),
    reports: section(ui.reports.filter((report) => report.status === 'generated').map((report) => report.name)),
    pages: section(ui.pages.filter((page) => page.status === 'generated').map((page) => page.name)),
    workflows: section(workflows),
    schedules: section(schedules),
    functions: section(app.functions.map((item) => item.name)),
    roles: section(app.roles.map((item) => item.name)),
  };
}

function dataSection(plan: OfflinePlan, source: readonly SourceTableData[] | undefined): BusinessMigrationReport['data'] {
  const sourceRows = new Map((source ?? []).map((table) => [table.table, table.rows.length]));
  return {
    tables: plan.tables.map((table) => ({
      name: table.name,
      source: table.form,
      columns: table.columns,
      ...(sourceRows.has(table.name) ? { sourceRows: sourceRows.get(table.name) } : {}),
      storage: table.nosql ? 'collection' : 'table',
    })),
    verification: [
      'Run the guided data load, then compare each migrated table count with the source export count.',
      'When automated record verification is available, run it to compare row counts and checksums and keep the result with the migration files.',
      'Check one parent row and its related child or lookup rows before sign-off.',
    ],
  };
}

function goLiveChecklist(report: Omit<BusinessMigrationReport, 'goLiveChecklist'>): string[] {
  return [
    ...report.guidedSteps.map((step) => `Complete guided step: ${step.title}.`),
    ...(report.appSpecificSteps.length ? ['Finish every app-specific manual item listed in this report.'] : []),
    'Load the source data and confirm every table count matches the source count.',
    'Run record verification when it is available, then keep the counts/checksum report with the migration files.',
    'Sign in as one user in each role and open the pages and reports that role should see.',
    'Submit one test record through each converted form and confirm it appears in the expected report.',
    ...(report.converted.schedules.count ? ['Enable each migrated schedule and confirm the first run completes.'] : []),
    'Promote the reviewed project to Production, switch business links, and keep Creator read-only until final sign-off.',
  ];
}

export function buildBusinessMigrationReport(app: App, opts: BusinessReportOptions): BusinessMigrationReport {
  const analysis = analyze(app);
  const ui = buildUi(app);
  const { plan } = buildOfflinePlan(app, { dc: opts.dc, dcSource: '--dc', mail: opts.mail === true, ...(opts.source ? { source: opts.source } : {}) });
  const manualUiLocations = new Set(
    ui.model.todos
      .filter((todo) => todo.manualStep)
      .map((todo) => (todo.area === 'field' ? `field ${todo.name}` : todo.area === 'report' ? `report ${todo.name}` : `page ${todo.name}`)),
  );
  const base = {
    schema: 'c2c-business-migration-report/1' as const,
    app: app.name ?? 'app',
    dataCentre: opts.dc,
    converted: convertedSections(app, ui.model),
    guidedSteps: guidedSteps(plan),
    appSpecificSteps: appSpecificSteps(app, ui.model, plan),
    unsupported: unsupportedItems(analysis, manualUiLocations),
    data: dataSection(plan, opts.source),
  };
  return { ...base, goLiveChecklist: goLiveChecklist(base) };
}

/** The business report never serializes `technical`; it is appendix-only. */
function withoutTechnical(key: string, value: unknown): unknown {
  return key === 'technical' ? undefined : value;
}

export function businessReportAsJson(report: BusinessMigrationReport): string {
  return `${JSON.stringify(report, withoutTechnical, 2)}\n`;
}

export interface ReportAppendix {
  schema: 'c2c-business-migration-report-appendix/1';
  app: string;
  items: { section: 'appSpecificSteps' | 'unsupported'; area: string; name: string; technical: string }[];
}

/** Internal detail for developers: raw reasons and construct names. */
export function businessReportAppendix(report: BusinessMigrationReport): ReportAppendix {
  const items: ReportAppendix['items'] = [];
  for (const section of ['appSpecificSteps', 'unsupported'] as const) {
    for (const item of report[section]) {
      if (item.technical !== undefined) items.push({ section, area: item.area, name: item.name, technical: item.technical });
    }
  }
  return { schema: 'c2c-business-migration-report-appendix/1', app: report.app, items };
}

export function businessReportAppendixAsJson(report: BusinessMigrationReport): string {
  return `${JSON.stringify(businessReportAppendix(report), null, 2)}\n`;
}

function sectionLines(title: string, item: ReportSection): string[] {
  return [`- ${title}: ${item.count}${item.names.length ? ` — ${names(item.names)}` : ''}`];
}

function attentionLines(items: readonly AttentionItem[], empty: string): string[] {
  if (!items.length) return [`- ${empty}`];
  return items.flatMap((item) => [`- ${item.name} — ${item.detail}`, `  - What to do: ${item.workaround}`]);
}

export function businessReportAsMarkdown(report: BusinessMigrationReport): string {
  const lines = [
    `# Migration report for ${report.app}`,
    '',
    `This report explains what will move to Catalyst, what needs a person, and what to check before go-live. Data centre: ${report.dataCentre}.`,
    '',
    '## What will be converted',
    '',
    ...sectionLines('Forms', report.converted.forms),
    ...sectionLines('Reports', report.converted.reports),
    ...sectionLines('Pages', report.converted.pages),
    ...sectionLines('Workflows', report.converted.workflows),
    ...sectionLines('Schedules', report.converted.schedules),
    ...sectionLines('Functions', report.converted.functions),
    ...sectionLines('Roles', report.converted.roles),
    '',
    '## Guided steps for a person',
    '',
    ...(report.guidedSteps.length
      ? report.guidedSteps.map((step, index) => `${index + 1}. **${step.title}** — ${step.instruction}`)
      : ['- none']),
    '',
    '## App-specific manual work',
    '',
    ...attentionLines(report.appSpecificSteps, 'none'),
    '',
    '## Unsupported or needs review',
    '',
    'This list covers everything the converter can see in the export. A check inside the running app may surface more; open each converted screen once before sign-off.',
    '',
    ...attentionLines(report.unsupported, 'none'),
    '',
    '## Data migration',
    '',
    'The following source data is planned for migration:',
    '',
    ...report.data.tables.map((table) => `- ${table.name} (${table.storage}, ${plural(table.columns, 'column')}${table.sourceRows === undefined ? '' : `, ${plural(table.sourceRows, 'source row')}`})`),
    '',
    'How to verify it:',
    '',
    ...report.data.verification.map((item) => `- ${item}`),
    '',
    '## Go-live checklist',
    '',
    ...report.goLiveChecklist.map((item) => `- [ ] ${item}`),
    '',
  ];
  return `${lines.join('\n').replace(/\n+$/, '\n')}`;
}

function sourceFor(app: App, args: readonly string[]): readonly SourceTableData[] | undefined {
  const backup = flag(args, '--source-backup');
  const csv = flag(args, '--source-csv');
  const json = flag(args, '--source-json');
  if ([backup, csv, json].filter((item) => item !== undefined).length > 1) throw new Error('pass at most one of --source-backup, --source-csv, or --source-json');
  const allowEmpty = args.includes('--allow-empty');
  if (backup !== undefined) return readSourceBackup(backup, app, allowEmpty).sourceData;
  if (csv !== undefined) return (hasReportJson(csv, app) ? readSourceJson(csv, app, allowEmpty) : readSourceCsv(csv, app, allowEmpty)).sourceData;
  if (json !== undefined) return readSourceJson(json, app, allowEmpty).sourceData;
  return undefined;
}

export async function businessReportCli(args: readonly string[], io: Io): Promise<number> {
  const target = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const rest = target ? args.slice(1) : args;
  const out = flag(rest, '--out');
  if (!target) {
    io.stderr('usage: c2c report <file|dir> [--dc <dc>] [--out <dir>] [--json] [--mail] [--source-backup <zip|dir>|--source-csv <dir>|--source-json <dir>] [--allow-empty]\n');
    return 2;
  }
  try {
    const dc = resolveDc(rest, process.cwd());
    const app = loadApp(target);
    const source = sourceFor(app, rest);
    const report = buildBusinessMigrationReport(app, { dc: dc.dc, mail: rest.includes('--mail'), ...(source ? { source } : {}) });
    const json = businessReportAsJson(report);
    const markdown = businessReportAsMarkdown(report);
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'migration-report.json'), json);
      writeFileSync(join(out, 'migration-report.md'), markdown);
      writeFileSync(join(out, 'migration-report.appendix.json'), businessReportAppendixAsJson(report));
      io.stdout(`report: ${join(out, 'migration-report.md')}\n`);
    } else {
      io.stdout(rest.includes('--json') ? json : markdown);
    }
    return 0;
  } catch (err) {
    io.stderr(`c2c report: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
