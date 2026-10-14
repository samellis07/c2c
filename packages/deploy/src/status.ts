/**
 * `c2c status --project <id>`: read-only project health.
 *
 * Sections, each from one GET (never a write):
 * - functions: `GET /baas/v1/project/<id>/function` names each deployed
 *   function with its last deploy time when the answer carries one.
 * - slate: the Slate app list (`GET /slate/v1/project/<id>/app`, the same
 *   read-back deploy uses) with each app's served URL.
 * - tables: `GET /baas/v1/project/<id>/table` counts this project's tables.
 *   The table-create limit is org-wide and Catalyst doesn't publish the
 *   number, so no budget is assumed: pass --table-budget <n> to compare the
 *   count against one (OVER BUDGET above it).
 * - logs: `GET /baas/v1/project/<id>/logs?logType=application` surfaces
 *   recent error lines when that read answers with parseable lines.
 *
 * A read that fails, answers empty, or carries no usable shape is not an
 * error: the section reports unknown with a one-line console checklist step
 * (the console page that does carry it). `--fake` runs the same path
 * against a built-in fake, so offline runs and tests need no login.
 */
import { restWithRetry } from './retry.js';
import { slateApps, slateUrlOf } from './slate.js';
import { assertLiveProject, flag, type Io } from './cli.js';
import type { RestCall, RestFn, RestResult } from './tables.js';

export interface StatusFunction {
  name: string;
  id?: string;
  /** The last deploy time, exactly as the answer reported it. */
  deployedAt?: string;
}

export interface StatusSlateApp {
  name: string;
  url?: string;
}

export interface StatusLogError {
  severity: string;
  message: string;
}

export interface StatusReport {
  projectId: string;
  projectName?: string;
  environment?: string;
  /** True when the report came from the built-in demo instead of live reads. */
  fake: boolean;
  functions: { items: StatusFunction[]; note?: string };
  /** budget is present only when the user passed --table-budget <n>. */
  tables: { projectTables?: number; budget?: number; note?: string };
  slate: { apps: StatusSlateApp[]; note?: string };
  logs: { errors: StatusLogError[]; note?: string };
  /** Plain-language console steps for every section no read could answer. */
  guidance: string[];
  /** True when every section answered with usable data. */
  ok: boolean;
}

/** `statusCli` argument refusal, or undefined when the args can run. */
export function statusArgsProblem(args: readonly string[]): string | undefined {
  if (!flag(args, '--project')) return 'c2c status: --project <project-id> is required';
  if (!args.includes('--fake') && !flag(args, '--org')) return 'c2c status: --org <org-id> is required (or run with --fake)';
  const budget = flag(args, '--table-budget');
  if (budget !== undefined && (!/^[0-9]+$/.test(budget) || Number(budget) < 1)) return 'c2c status: --table-budget <n> must be a positive integer';
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function arrayOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const root = asRecord(body);
  if (!root) return [];
  for (const key of ['data', 'functions', 'tables', 'logs', 'records', 'content']) {
    if (Array.isArray(root[key])) return root[key] as unknown[];
  }
  return [];
}

/** Project details unwrap: `{data: {...}}` or the bare record. */
function projectData(body: unknown): Record<string, unknown> {
  const root = asRecord(body) ?? {};
  return asRecord(root.data) ?? root;
}

const FUNCTION_TIME_KEYS = ['last_deployed', 'deployed_time', 'deployed_at', 'last_deployed_time', 'modified_time', 'updated_time', 'updated_at', 'created_time', 'created_at'];

/** One function row from a tolerant set of answer shapes. */
export function statusFunctionOf(item: unknown): StatusFunction | undefined {
  const record = asRecord(item);
  if (!record) return undefined;
  const name = stringOf(record.function_name ?? record.name);
  if (!name) return undefined;
  const out: StatusFunction = { name };
  const id = stringOf(record.function_id ?? record.id);
  if (id) out.id = id;
  for (const key of FUNCTION_TIME_KEYS) {
    const at = stringOf(record[key]);
    if (at) {
      out.deployedAt = at;
      break;
    }
  }
  return out;
}

const LOG_SEVERITY_KEYS = ['severity', 'level', 'log_level'];
const LOG_MESSAGE_KEYS = ['message', 'log', 'text', 'error'];

/** Error-severity lines of a tolerant set of log answer shapes. */
export function statusLogErrorsOf(body: unknown): StatusLogError[] {
  const out: StatusLogError[] = [];
  for (const item of arrayOf(body)) {
    const record = asRecord(item);
    if (!record) continue;
    const severity = LOG_SEVERITY_KEYS.map((key) => stringOf(record[key])).find((value) => value !== undefined) ?? 'unknown';
    if (!/error|fail|exception|fatal/i.test(severity)) continue;
    const message = LOG_MESSAGE_KEYS.map((key) => stringOf(record[key])).find((value) => value !== undefined);
    if (message) out.push({ severity, message: message.length > 300 ? `${message.slice(0, 300)}…` : message });
  }
  return out;
}

/**
 * Table names of the table-list answer (`table_name`, else `name`). A row
 * without either still counts as a table under a synthetic name, so a
 * different key shape never reports 0 for a non-empty list.
 */
export function statusTableNamesOf(body: unknown): string[] {
  const names: string[] = [];
  let unnamed = 0;
  for (const item of arrayOf(body)) {
    const record = asRecord(item);
    if (!record) continue;
    const name = stringOf(record.table_name ?? record.name);
    if (name) {
      names.push(name);
      continue;
    }
    unnamed += 1;
    names.push(`unnamed table ${unnamed}`);
  }
  return names;
}

async function get(rest: RestFn, path: string): Promise<RestResult> {
  return (await restWithRetry(rest, { method: 'GET', path })).result;
}

/**
 * Read every status section. Only GETs; a failed or unusable answer leaves
 * the section unknown with a console checklist step.
 */
export async function readStatus(
  rest: RestFn,
  projectId: string,
  opts: { slateApp?: string; tableBudget?: number; fake?: boolean } = {},
): Promise<StatusReport> {
  const guidance: string[] = [];
  // Project: name and environment when the details answer carries them.
  let projectName: string | undefined;
  let environment: string | undefined;
  const details = await get(rest, `/baas/v1/project/${projectId}`);
  if (details.status >= 200 && details.status < 300) {
    const data = projectData(details.body);
    projectName = stringOf(data.project_name ?? data.name);
    environment = stringOf(data.environment ?? data.env);
  } else {
    guidance.push(`console: open the project ${projectId} once and confirm it loads (project details answered HTTP ${details.status})`);
  }
  // Functions: deployed names with their last deploy time.
  const functions: StatusFunction[] = [];
  let functionsNote: string | undefined;
  const listed = await get(rest, `/baas/v1/project/${projectId}/function`);
  if (listed.status >= 200 && listed.status < 300) {
    for (const item of arrayOf(listed.body)) {
      const fn = statusFunctionOf(item);
      if (fn) functions.push(fn);
    }
    if (!functions.length) functionsNote = 'the function list answered but named no functions';
  } else {
    functionsNote = `the function list answered HTTP ${listed.status}`;
  }
  if (functionsNote) guidance.push(`console: open Functions in project ${projectId} to see deployed functions and their last deploy time (${functionsNote})`);
  // Tables: this project's count against the org-wide budget.
  let projectTables: number | undefined;
  let tablesNote: string | undefined;
  const tableList = await get(rest, `/baas/v1/project/${projectId}/table`);
  if (tableList.status >= 200 && tableList.status < 300) {
    projectTables = statusTableNamesOf(tableList.body).length;
  } else {
    tablesNote = `the table list answered HTTP ${tableList.status}`;
    guidance.push(`console: open Data Store in project ${projectId} to count tables (${tablesNote})`);
  }
  // Slate: every app with its served URL; --app keeps one name.
  const slate: StatusSlateApp[] = [];
  let slateNote: string | undefined;
  const apps = await get(rest, `/slate/v1/project/${projectId}/app`);
  if (apps.status >= 200 && apps.status < 300) {
    const rows = slateApps(apps.body);
    const wanted = opts.slateApp ? rows.filter((row) => row.name === opts.slateApp) : rows;
    if (opts.slateApp && !wanted.length) slateNote = `no Slate app named "${opts.slateApp}"`;
    for (const row of wanted) {
      const app: StatusSlateApp = { name: row.name };
      const url = slateUrlOf(row.domain);
      if (url) app.url = url;
      slate.push(app);
    }
    if (!slateNote && slate.every((app) => !app.url)) {
      slateNote = slate.length ? 'the Slate apps report no served domain yet' : 'the project lists no Slate apps';
    }
  } else {
    slateNote = `the Slate app list answered HTTP ${apps.status}`;
  }
  if (slateNote) guidance.push(`console: open Web Client Hosting (Slate) in project ${projectId} for the served URL (${slateNote})`);
  // Logs: recent error lines when the log read answers with parseable lines.
  const errors: StatusLogError[] = [];
  let logsNote: string | undefined;
  const firstFunction = functions.find((fn) => fn.id)?.id;
  if (firstFunction) {
    const logs = await get(rest, `/baas/v1/project/${projectId}/logs?logType=application&resource_list=${encodeURIComponent(firstFunction)}`);
    if (logs.status >= 200 && logs.status < 300) {
      errors.push(...statusLogErrorsOf(logs.body));
      // A log read that answers with no error lines is healthy: no note, no checklist step.
    } else {
      logsNote = `the log read answered HTTP ${logs.status}`;
    }
  } else {
    logsNote = 'no function id to read logs for';
  }
  if (logsNote) guidance.push(`console: open DevOps → Logs → Application in project ${projectId} for recent function errors (${logsNote}; logs keep 7 days in Development, 14 in Production)`);
  const ok =
    functionsNote === undefined && tablesNote === undefined && slateNote === undefined && projectTables !== undefined && !logsNote;
  return {
    projectId,
    ...(projectName ? { projectName } : {}),
    ...(environment ? { environment } : {}),
    fake: opts.fake === true,
    functions: { items: functions, ...(functionsNote ? { note: functionsNote } : {}) },
    tables: {
      ...(projectTables !== undefined ? { projectTables } : {}),
      ...(opts.tableBudget !== undefined ? { budget: opts.tableBudget } : {}),
      ...(tablesNote ? { note: tablesNote } : {}),
    },
    slate: { apps: slate, ...(slateNote ? { note: slateNote } : {}) },
    logs: { errors, ...(logsNote ? { note: logsNote } : {}) },
    guidance,
    ok,
  };
}

/** Human report: one section per line block, then the console checklist. */
export function formatStatus(report: StatusReport): string {
  const lines = [
    ...(report.fake ? ['FAKE DATA (demo mode): not your project'] : []),
    `status: project ${report.projectId}${report.projectName ? ` (${report.projectName})` : ''}${report.environment ? ` [${report.environment}]` : ''}`,
  ];
  if (report.functions.items.length) {
    lines.push('functions:');
    for (const fn of report.functions.items) lines.push(`- ${fn.name}${fn.deployedAt ? ` last deployed ${fn.deployedAt}` : ' (last deploy time unknown)'}`);
  } else {
    lines.push(`functions: unknown${report.functions.note ? ` (${report.functions.note})` : ''}`);
  }
  if (report.tables.projectTables !== undefined) {
    const limit = "org-wide table-create limit; Catalyst doesn't publish the number";
    if (report.tables.budget !== undefined) {
      const over = report.tables.projectTables > report.tables.budget ? ' OVER BUDGET' : '';
      lines.push(`tables: ${report.tables.projectTables} of ${report.tables.budget} org tables${over} (${limit})`);
    } else {
      lines.push(`tables: ${report.tables.projectTables} org tables (${limit})`);
    }
  } else {
    lines.push(`tables: unknown${report.tables.note ? ` (${report.tables.note})` : ''}`);
  }
  if (report.slate.apps.length) {
    lines.push('slate:');
    for (const app of report.slate.apps) lines.push(`- ${app.name}: ${app.url ?? '(no served URL yet)'}`);
  } else {
    lines.push(`slate: unknown${report.slate.note ? ` (${report.slate.note})` : ''}`);
  }
  if (report.logs.errors.length) {
    lines.push('recent errors:');
    for (const error of report.logs.errors) lines.push(`- [${error.severity}] ${error.message}`);
  } else {
    lines.push(`recent errors: none reported${report.logs.note ? ` (${report.logs.note})` : ''}`);
  }
  if (report.guidance.length) {
    lines.push('checklist (console steps c2c cannot do):');
    for (const step of report.guidance) lines.push(`- ${step}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Machine report: the status report as indented JSON. */
export function statusAsJson(report: StatusReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** The built-in offline fake: fixed fixture bodies on the status paths for any project id. */
export function fakeStatusRest(projectId = '1000000000000123'): RestFn {
  const bodies: Record<string, unknown> = {
    [`/baas/v1/project/${projectId}`]: { data: { id: projectId, project_name: 'c2c-widget', environment: 'Development' } },
    [`/baas/v1/project/${projectId}/function`]: {
      data: [
        { function_id: '2000000000000101', function_name: 'c2c_api', last_deployed: '2026-10-08T09:15:00Z' },
        { function_id: '2000000000000102', function_name: 'c2c_job', modified_time: '2026-10-07T14:00:00Z' },
      ],
    },
    [`/baas/v1/project/${projectId}/table`]: { data: [{ table_name: 'Vendor' }, { table_name: 'Product' }, { table_name: 'Purchase_Order' }] },
    [`/slate/v1/project/${projectId}/app`]: { data: [{ id: '3000000000000123', name: 'c2c-widget', domain: 'c2c-widget-abc123.onslate.in' }] },
    [`/baas/v1/project/${projectId}/logs?logType=application&resource_list=2000000000000101`]: {
      data: [
        { severity: 'info', message: 'Execution started at 2026-10-08T09:20:00Z' },
        { severity: 'error', message: 'DUPLICATE_VALUE: Duplicate value for SKU. Please give a different value' },
      ],
    },
  };
  return async (call: RestCall) => {
    const body = bodies[call.path];
    return body === undefined ? { status: 404, body: {} } : { status: 200, body };
  };
}

/**
 * `c2c status --project <id> [--org <id>] [--app <name>] [--json] [--fake] [--table-budget <n>]`.
 * Read-only: every live call is a GET. The live path binds --project to
 * --org through the same project-details guard the other live commands use,
 * so a project outside the org is refused instead of degrading section by
 * section. Exit 0 when every section answered, 1 when a section fell back
 * to the console checklist, 2 on usage.
 */
export async function statusCli(args: readonly string[], io: Io): Promise<number> {
  const problem = statusArgsProblem(args);
  if (problem) {
    io.stderr(`${problem}\n`);
    return 2;
  }
  const projectId = flag(args, '--project') as string;
  const fake = args.includes('--fake');
  const budgetRaw = flag(args, '--table-budget');
  const rest: RestFn = fake
    ? (io.rest ?? fakeStatusRest(projectId))
    : await assertLiveProject(io, flag(args, '--org') as string, projectId);
  const report = await readStatus(rest, projectId, {
    ...(flag(args, '--app') ? { slateApp: flag(args, '--app') as string } : {}),
    ...(budgetRaw !== undefined ? { tableBudget: Number(budgetRaw) } : {}),
    ...(fake ? { fake: true } : {}),
  });
  io.stdout(args.includes('--json') ? statusAsJson(report) : formatStatus(report));
  return report.ok ? 0 : 1;
}
