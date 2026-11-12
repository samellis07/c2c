/**
 * Aggregate UI and auth counts for a local corpus.
 * The report names apps by folder and never includes field values or scripts.
 */

import { authPlan } from '../../auth/src/plan.js';
import { compareEnUs } from '../../core/src/order.js';
import { loadCorpusApps } from '../../schema/src/corpus.js';
import { buildUi } from './generate.js';
import type { UiSummary, UiTodo } from './model.js';

export interface AppNumbers {
  link: string;
  formsGenerated: number;
  formsTodo: number;
  fieldsGenerated: number;
  fieldsTodo: number;
  reportsGenerated: number;
  reportsTodo: number;
  pagesGenerated: number;
  pagesTodo: number;
  build: 'ok' | 'fail';
}

export interface UiCorpusNumbers {
  apps: number;
  failed: number;
  buildOk: number;
  buildFail: number;
  formsGenerated: number;
  formsTodo: number;
  fieldsGenerated: number;
  fieldsTodo: number;
  reportsGenerated: number;
  reportsTodo: number;
  pagesGenerated: number;
  pagesTodo: number;
  pageElements: number;
  pageElementsTodo: number;
  handlers: number;
  customActions: number;
  uploads: number;
  roles: number;
  portalProfiles: number;
  tablePermissions: number;
  accessProfiles: number;
  todoBuckets: { bucket: string; count: number }[];
  perApp: AppNumbers[];
}

export function uiCorpus(dir: string): UiCorpusNumbers {
  const totals = empty();
  const buckets = new Map<string, number>();
  const perApp: AppNumbers[] = [];
  let failed = 0;
  const apps = loadCorpusApps(dir);
  for (const app of apps) {
    try {
      const built = buildUi(app.ir);
      const auth = authPlan(app.ir);
      add(totals, built.summary, auth);
      for (const todo of built.summary.todos) buckets.set(bucket(todo), (buckets.get(bucket(todo)) ?? 0) + 1);
      perApp.push({ link: app.link, ...row(built.summary), build: 'ok' });
      totals.buildOk++;
    } catch {
      failed++;
      totals.buildFail++;
      perApp.push({
        link: app.link,
        formsGenerated: 0,
        formsTodo: 0,
        fieldsGenerated: 0,
        fieldsTodo: 0,
        reportsGenerated: 0,
        reportsTodo: 0,
        pagesGenerated: 0,
        pagesTodo: 0,
        build: 'fail',
      });
    }
  }
  perApp.sort((a, b) => compareEnUs(a.link, b.link));
  return {
    ...totals,
    apps: perApp.length,
    failed,
    todoBuckets: [...buckets.entries()]
      .map(([bucketName, count]) => ({ bucket: bucketName, count }))
      .sort((a, b) => b.count - a.count || compareEnUs(a.bucket, b.bucket)),
    perApp,
  };
}

function empty(): Omit<UiCorpusNumbers, 'apps' | 'failed' | 'todoBuckets' | 'perApp'> {
  return {
    buildOk: 0,
    buildFail: 0,
    formsGenerated: 0,
    formsTodo: 0,
    fieldsGenerated: 0,
    fieldsTodo: 0,
    reportsGenerated: 0,
    reportsTodo: 0,
    pagesGenerated: 0,
    pagesTodo: 0,
    pageElements: 0,
    pageElementsTodo: 0,
    handlers: 0,
    customActions: 0,
    uploads: 0,
    roles: 0,
    portalProfiles: 0,
    tablePermissions: 0,
    accessProfiles: 0,
  };
}

function add(totals: ReturnType<typeof empty>, summary: UiSummary, auth: ReturnType<typeof authPlan>): void {
  totals.formsGenerated += summary.formsGenerated;
  totals.formsTodo += summary.formsTodo;
  totals.fieldsGenerated += summary.fieldsGenerated;
  totals.fieldsTodo += summary.fieldsTodo;
  totals.reportsGenerated += summary.reportsGenerated;
  totals.reportsTodo += summary.reportsTodo;
  totals.pagesGenerated += summary.pagesGenerated;
  totals.pagesTodo += summary.pagesTodo;
  totals.pageElements += summary.pageElements;
  totals.pageElementsTodo += summary.pageElementsTodo;
  totals.handlers += summary.handlers;
  totals.customActions += summary.customActions;
  totals.uploads += summary.uploads;
  totals.roles += auth.roles.length;
  totals.portalProfiles += auth.portalUsers.length;
  totals.tablePermissions += auth.tablePermissions.length;
  totals.accessProfiles += Object.keys(auth.accessPolicy.profiles).length;
}

function row(summary: UiSummary): Omit<AppNumbers, 'link' | 'build'> {
  return {
    formsGenerated: summary.formsGenerated,
    formsTodo: summary.formsTodo,
    fieldsGenerated: summary.fieldsGenerated,
    fieldsTodo: summary.fieldsTodo,
    reportsGenerated: summary.reportsGenerated,
    reportsTodo: summary.reportsTodo,
    pagesGenerated: summary.pagesGenerated,
    pagesTodo: summary.pagesTodo,
  };
}

function bucket(todo: UiTodo): string {
  const reason = todo.reason;
  if (todo.area === 'zml') return 'zml element not generated';
  if (reason.startsWith('Report type')) return 'report type not generated';
  if (reason.startsWith('Kanban')) return 'kanban needs a group';
  if (reason.startsWith('calendar') || reason.startsWith('timeline')) return 'calendar or timeline needs a date';
  if (reason.startsWith('Map')) return 'map needs latitude and longitude';
  if (reason.startsWith('pivot') || reason.startsWith('chart')) return 'pivot or chart needs a group';
  if (reason.includes('regex')) return 'field regex did not compile';
  if (reason.startsWith('No schema mapping')) return 'field type has no mapping';
  if (reason.startsWith('Inline subform')) return 'inline subform has no fields';
  if (reason.includes('trained Zia') || reason.includes('Prediction')) return 'prediction field';
  if (reason.includes('Geolocation') || reason.includes('geolocation') || reason.includes('latitude and longitude exist only')) return 'geolocation field';
  return todo.area;
}

export function formatUiReport(numbers: UiCorpusNumbers, opts?: { label?: string; date?: string }): string {
  const label = opts?.label ?? 'corpus';
  const date = opts?.date ?? '';
  const lines: string[] = [];
  lines.push(`# UI report: ${label}`);
  lines.push('');
  lines.push(
    date
      ? `Generated ${date}. Counts come from the UI and auth generators. No field values or scripts are included.`
      : 'Counts come from the UI and auth generators. No field values or scripts are included.',
  );
  lines.push('');
  lines.push('## Counting');
  lines.push('');
  lines.push('- One app is one sub-folder (or one loose .ds file). The link is that name.');
  lines.push('- A form is generated unless every field on it, including subform, name, and address parts, is a TODO. An empty form is generated.');
  lines.push('- Field counts include those parts. A part with no schema type is a field TODO, not a silent skip.');
  lines.push('- A report is generated for list, grid, kanban, calendar, timeline, map, pivot, chart, spreadsheet, and summary. Gantt and unknown types are TODO. Kanban, calendar, timeline, map, pivot, and chart are TODO when the field they need is missing.');
  lines.push('- A page is TODO only when it has elements and every one of them is a TODO. Layout wrappers are not elements.');
  lines.push('- Build success means the hashed Slate graph resolved (no missing asset token). It does not deploy.');
  lines.push('- Auth counts are a dry run. No role, user, or permission is created.');
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`- Apps measured: ${numbers.apps}`);
  lines.push(`- Apps that failed to generate: ${numbers.failed}`);
  lines.push(`- Build success: ${numbers.buildOk}`);
  lines.push(`- Build failure: ${numbers.buildFail}`);
  lines.push(`- Forms generated: ${numbers.formsGenerated}`);
  lines.push(`- Forms TODO: ${numbers.formsTodo}`);
  lines.push(`- Fields generated: ${numbers.fieldsGenerated}`);
  lines.push(`- Fields TODO: ${numbers.fieldsTodo}`);
  lines.push(`- Reports generated: ${numbers.reportsGenerated}`);
  lines.push(`- Reports TODO: ${numbers.reportsTodo}`);
  lines.push(`- Pages generated: ${numbers.pagesGenerated}`);
  lines.push(`- Pages TODO: ${numbers.pagesTodo}`);
  lines.push(`- Page elements: ${numbers.pageElements}`);
  lines.push(`- Page elements TODO: ${numbers.pageElementsTodo}`);
  lines.push(`- Client handlers wired: ${numbers.handlers}`);
  lines.push(`- Custom actions: ${numbers.customActions}`);
  lines.push(`- Upload fields: ${numbers.uploads}`);
  lines.push('');
  lines.push('## Auth (dry run)');
  lines.push('');
  lines.push(`- Catalyst roles planned: ${numbers.roles}`);
  lines.push(`- Portal profiles (app users, not invited): ${numbers.portalProfiles}`);
  lines.push(`- Table permission rows: ${numbers.tablePermissions}`);
  lines.push(`- Access-policy profiles: ${numbers.accessProfiles}`);
  lines.push('');
  lines.push('## TODO buckets');
  lines.push('');
  if (!numbers.todoBuckets.length) lines.push('None.');
  for (const item of numbers.todoBuckets) lines.push(`- ${item.bucket}: ${item.count}`);
  lines.push('');
  lines.push('## Per app (counts only)');
  lines.push('');
  lines.push('| App | Forms | Form TODO | Fields | Field TODO | Reports | Report TODO | Pages | Page TODO | Build |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const app of numbers.perApp) {
    lines.push(
      `| ${app.link} | ${app.formsGenerated} | ${app.formsTodo} | ${app.fieldsGenerated} | ${app.fieldsTodo} | ${app.reportsGenerated} | ${app.reportsTodo} | ${app.pagesGenerated} | ${app.pagesTodo} | ${app.build} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
