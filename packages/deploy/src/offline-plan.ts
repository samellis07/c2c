/**
 * Offline `c2c plan`: the full migration plan with no credentials and no
 * project id, so a customer can plan before a project exists.
 *
 * Nothing here spawns a process or fetches. Guards (org/project/credential)
 * never run. The data centre is never defaulted: `--dc`, else the `dc`
 * (or `zohoDc`) key of `./c2c-deploy.json`, else exit 2. Every report records
 * which source the DC came from.
 *
 * Outputs under `--out <dir>` (no timestamps, so two runs are byte-identical):
 *   plan.md, plan.json, provision/plan.json, c2c-manifest.json
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from '../../core/src/ir.js';
import { widgetCommandStatus, widgetManualItems, type WidgetManualItem } from '../../core/src/parse.js';
import { LockedExportError } from '../../core/src/source.js';
import { appFacts, integrationNamespaces } from '../../core/src/features.js';
import { authPlan } from '../../auth/src/plan.js';
import { constraintDecisionNote, generateSchema, type ConstraintDecision, type SchemaTable, type SourceTableData } from '../../schema/src/generator.js';
import { catalystLimit, limitValue, ORG_TABLE_LIMIT_RECOVERY } from '../../schema/src/limits.js';
import { fieldTypeRow, UNIQUE_VARCHAR_MAX_PER_TABLE } from '../../schema/src/mapping.js';
import { jobPoolName, LIMITS } from '../../shims/src/runtime.js';
import { buildUi } from '../../ui/src/generate.js';
import { principalRoleMap } from '../../auth/src/apply.js';
import { C2cError, coded, codedError } from '../../core/src/index.js';
import { flag, hasReportJson, loadApp, type Io } from './cli.js';
import { ZCQL_IN_LIMIT } from '../../data/src/migrate.js';
import { cyclicForeignKeys, foreignKeyId, tableCreatePlan } from './tables.js';
import { readSourceCsv, readSourceJson } from './csv.js';
import { readSourceBackup } from './backup.js';
import { API_FUNCTION, FUNCTION_DIR, columnTypes, functionDir } from './function-dir.js';
import { importTableGrants, importTemplateJson } from './iac.js';
import { zipStore } from './iac-import.js';
import { mailConfig } from './mail.js';
import { functionSources } from './plan.js';
import { readDeployConfig } from './provision-config.js';
import { FIRST_USE_GATES, type FirstUseGate } from './first-use.js';
import { buildFunctionEnv, extractConnectionSecrets, writeOrUpdateFunctionEnv } from './function-env.js';
import { isVerifiedMcpTool } from './mcp-registry.js';
import { MCP_TOOL_PREFIX, REQUIRED_MCP_TOOLS } from '../../doctor/src/required-tools.js';

/** Data centres the Catalyst MCP and CLI address (doctor D-B2/D-C5). No default. */
export const DC_TABLE = ['in', 'us', 'eu', 'au', 'ca', 'sa', 'jp', 'uae'] as const;

export type DcSource = '--dc' | 'c2c-deploy.json';

export interface DcResolution {
  dc: string;
  source: DcSource;
}

/**
 * MCP tool names the doctor checks (D-B5), without host prefix. Derived from the
 * one required-tool list (doctor/src/required-tools.ts); never list them here.
 */
export const PLAN_MCP_BASE: string[] = REQUIRED_MCP_TOOLS.base.map((name) => `${MCP_TOOL_PREFIX}${name}`);

export const PLAN_MCP_BY_FEATURE: Record<string, string[]> = Object.fromEntries(
  Object.entries(REQUIRED_MCP_TOOLS.byFeature).map(([group, names]) => [group, names.map((name) => `${MCP_TOOL_PREFIX}${name}`)]),
);

/**
 * Tool names `c2c plan` writes onto a provision step or its read-back.
 * Provision accepts a tool only when, after NFKC and trim, it equals one of these.
 */
export const PLAN_STEP_TOOL = {
  listTables: 'CatalystbyZoho_List_All_Tables',
  updateTablePermissions: 'CatalystbyZoho_Update_Table_Permissions',
  getTablePermissions: 'CatalystbyZoho_Get_Table_Permissions',
  updateTableScopes: 'CatalystbyZoho_Update_Table_Scopes',
  getTableScopes: 'CatalystbyZoho_Get_Table_Scopes',
  createJobPool: 'CatalystbyZoho_Create_Job_Pool',
  listJobpools: 'CatalystbyZoho_List_All_Jobpools',
  createBucket: 'CatalystbyZoho_Create_Bucket',
  getAllBuckets: 'CatalystbyZoho_Get_All_Buckets',
  getAuthConfigurations: 'CatalystbyZoho_Get_Authentication_Configurations',
  listRoles: 'CatalystbyZoho_List_All_Roles',
  listProjectUsers: 'CatalystbyZoho_List_All_Project_Users',
  listEmails: 'CatalystbyZoho_List_All_Emails_Configuration',
  configureApiRoute: 'CatalystbyZoho_Configure_API_Gateway_Route',
  listApiRoutes: 'CatalystbyZoho_List_All_API_route',
  listCorsDomains: 'CatalystbyZoho_List_All_CORS_Domains',
  listFunctions: 'CatalystbyZoho_List_All_Functions',
  listCrons: 'CatalystbyZoho_List_All_Crons',
  listSlateApps: 'CatalystbyZoho_List_All_Slate_Apps',
} as const;

/** The allowlist, derived from the names the plan generator writes. */
export const PLAN_STEP_TOOLS: readonly string[] = Object.values(PLAN_STEP_TOOL);

/**
 * REST path templates c2c fills with a project id.
 * A plan step may name only the templates `c2c plan` writes (`PLAN_EMITTED_CLI_PATHS`).
 * `projectUser` and `cron` are runner templates: provision lists and creates those
 * resources itself. A plan call never names them.
 */
export const PLAN_CLI_PATH = {
  authHosted: '/baas/v1/project/<project>/authentication/enable?auth_type=hosted',
  authEmbedded: '/baas/v1/project/<project>/authentication/enable?auth_type=embedded',
  corsDomain: '/baas/v1/project/<project>/cors-domain',
  connections: '/baas/v1/project/<project>/connections',
  projectUser: '/baas/v1/project/<project>/project-user',
  cron: '/baas/v1/project/<project>/job_scheduling/cron',
  environment: '/baas/v1/project/<project>/environment',
  // First-use gate probes (first-use.ts): documented reads c2c runs itself.
  gateCloudscale: FIRST_USE_GATES.cloudscale.probe,
  gateStratus: FIRST_USE_GATES.stratus.probe,
  gateSmartbrowz: FIRST_USE_GATES.smartbrowz.probe,
  gateSlate: FIRST_USE_GATES.slate.probe,
} as const;

export const PLAN_CLI_PATHS: readonly string[] = Object.values(PLAN_CLI_PATH);

export interface PlanProbe {
  id: string;
  measures: string;
  needed: boolean;
  reason: string;
}

const PROBE_CATALOG: { id: string; measures: string }[] = [
  { id: 'P-LIKE', measures: "LIKE '*x*' returns the row; '%x%' returns 0" },
  { id: 'P-OFFSET', measures: 'LIMIT a,b offset base' },
  { id: 'P-UPD300', measures: 'ZCQL UPDATE/DELETE statement cap' },
  { id: 'P-JOIN', measures: 'max joins (Development and Production)' },
  { id: 'P-WIDTH', measures: 'max select columns + exact error' },
  { id: 'P-COLS', measures: 'columns per table by type (scratch table)' },
  { id: 'P-401', measures: 'private route without auth returns 401' },
  { id: 'P-BULK', measures: 'bulk write job path with a Stratus CSV' },
  { id: 'P-RATE', measures: 'write rate before a large load' },
  { id: 'P-SVC', measures: 'enabled services (console first-use on a fresh project)' },
  { id: 'P-MAIL', measures: 'send from the verified sender (customer confirms receipt)' },
];

export interface PlanBudget {
  id: string;
  table?: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

/** Stable identifiers for every budget row emitted by the offline plan. */
export const PLAN_BUDGET_IDS = [
  'columns',
  'unique-varchar',
  'fk',
  'select-width',
  'joins',
  'org-tables',
  'dev-row-cap',
  'varchar-length',
  'dev-api-calls',
  'dev-write-rate',
] as const;

export interface StepEndpoint {
  via: 'cli' | 'mcp' | 'console';
  tool?: string;
  command?: string;
  /** For cli read-backs c2c can run itself ({call:{method,path}}), or mcp call args (path_variables/headers/calls). */
  args?: Record<string, unknown>;
  match?: Record<string, unknown>;
}

export interface ProvisionStep extends StepEndpoint {
  id: string;
  args: Record<string, unknown>;
  readBack: StepEndpoint & { match: Record<string, unknown> };
}

export interface OfflinePlan {
  version: 1;
  command: 'plan';
  c2c: string;
  app: string;
  dc: string;
  dcSource: DcSource;
  /** plan is offline: doctor never gates it, so the stamp is always not-run. */
  doctor: 'not-run';
  counts: {
    tables: number;
    /** SQL tables only; each counts toward the org-wide table-create limit. NoSQL tables are not created by c2c. */
    dataStoreTables: number;
    columns: number;
    nosqlTables: number;
    functions: number;
    schedules: number;
    reports: number;
    pages: number;
    roles: number;
    customApis: number;
  };
  tables: { name: string; form: string; role: string; nosql: boolean; columns: number; uniqueVarchar: number; fks: number; nosqlReason?: string }[];
  /** Store constraints the `--source-*` data disproved — the columns are provisioned without them. */
  constraints?: ConstraintDecision[];
  budgets: PlanBudget[];
  budgetsOk: boolean;
  steps: ProvisionStep[];
  mcpTools: { base: string[]; plan: string[] };
  probes: PlanProbe[];
  zcqlCaps: { rowsPerQuery: number; offsetBase: number; likeWildcard: string; maxJoins: number; selectWidthDoc: number; selectWidthUnverified: number };
  /**
   * Widget packages and any other construct the plan does not generate.
   * Omitted when empty, so a plan with no such construct keeps the same bytes.
   */
  manual?: WidgetManualItem[];
  connectionSecretKeys?: string[];
}

export interface PlanFile {
  path: string;
  data: string;
  /** Binary payload, written instead of `data` when set (the IaC code zip). */
  bytes?: Buffer;
}

function fail(message: string): never {
  throw new Error(message);
}

/** `--dc`, else `dc`/`zohoDc` in `<cwd>/c2c-deploy.json`, else an error naming both. */
export function resolveDc(args: readonly string[], cwd: string): DcResolution {
  const direct = flag(args, '--dc');
  if (direct !== undefined) {
    const dc = direct.toLowerCase();
    if (!(DC_TABLE as readonly string[]).includes(dc)) {
      fail(`c2c plan: unknown data centre "${direct}" (want one of ${DC_TABLE.join(', ')})`);
    }
    return { dc, source: '--dc' };
  }
  const configPath = join(cwd, 'c2c-deploy.json');
  if (statSync(configPath, { throwIfNoEntry: false })?.isFile()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      fail('c2c plan: c2c-deploy.json is not valid JSON');
    }
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    const raw = record ? (record.dc ?? record.zohoDc) : undefined;
    if (typeof raw === 'string' && raw.trim()) {
      const dc = raw.trim().toLowerCase();
      if (!(DC_TABLE as readonly string[]).includes(dc)) {
        fail(`c2c plan: unknown data centre "${raw.trim()}" in c2c-deploy.json (want one of ${DC_TABLE.join(', ')})`);
      }
      return { dc, source: 'c2c-deploy.json' };
    }
    fail('c2c plan: c2c-deploy.json has no "dc" (add "dc": "<us|eu|in|au|ca|sa|jp|uae>")');
  }
  fail('c2c plan: no data centre set (pass --dc <dc> or add "dc" to c2c-deploy.json)');
}

/** Nearest package.json named creator-to-catalyst above this file (the repo root when built). */
export function c2cVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json');
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        if (parsed.name === 'creator-to-catalyst' && typeof parsed.version === 'string') return parsed.version;
      } catch {
        // Keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}

/** sha256 hex of UTF-8 text or raw bytes (the IaC zips hash as bytes). */
export function sha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Bucket names are global: c2c-<link>-<h8>, lower-case, derived from the app link. */
export function bucketName(link: string): string {
  const slug = link.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  return `c2c-${slug}-${sha256(link).slice(0, 8)}`;
}

/** Catalyst project key for this app: the console project the customer creates. `c2c-` is not doubled. */
export function projectKey(link: string): string {
  const slug = link.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  return slug.startsWith('c2c-') ? slug : `c2c-${slug}`;
}

/** Canonical cron identifier: what Catalyst stores and lists as `cron_name` for a display name. */
export function cronName(display: string): string {
  return display.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/**
 * Creator unique text fields on this table. The schema keeps the first
 * UNIQUE_VARCHAR_MAX_PER_TABLE store-level (`unique`) and marks the rest
 * `appUnique` (`unique` false, checked by the handler). The store-level count
 * decides the fail; app-level extras warn — the handler check is advisory
 * (not atomic, and a CSV or seed import skips it).
 */
function uniqueVarchar(table: SchemaTable): { names: string[]; store: string[]; appLevel: string[] } {
  const store: string[] = [];
  const appLevel: string[] = [];
  for (const column of table.columns) {
    if (column.appUnique) appLevel.push(column.name);
    else if (column.unique && column.dataType === 'VarChar') store.push(column.name);
  }
  return { names: [...store, ...appLevel], store, appLevel };
}

function fkCount(table: SchemaTable): number {
  return table.columns.filter((column) => column.relation).length;
}

// Generation splits at the raised cap; the stated default is report-only, so
// over-default-but-under-cap warns rather than fails.
const MAX_COLUMNS = limitValue('datastore.columns_per_table');
const COLUMNS_DEFAULT = limitValue('datastore.columns_per_table_default');
const MAX_UNIQUE_VARCHAR = UNIQUE_VARCHAR_MAX_PER_TABLE;
const MAX_FK = 15;
const MAX_JOINS = 4;
const SELECT_WIDTH_DOC = 20;
const SELECT_WIDTH_UNVERIFIED = limitValue('zcql.select_columns');
/** Stated Development ceiling of API calls per application (docs figure, unverified). */
const DEV_API_CALLS = limitValue('api.calls_dev');
/** Stated Dev write rate per table (docs/self-reported figure, unverified). */
const DEV_WRITE_RATE = limitValue('datastore.write_requests_per_minute');
/** Rows per mover write batch; one reconcile read plus one insert call per batch. */
const MOVER_BATCH = LIMITS.insertRowsPerCall;
/** Ids per ZCQL IN-slice; verification, remap and count reads chunk here. */
const MOVER_ID_CHUNK = ZCQL_IN_LIMIT;
/** Conservative fixed-call allowance per non-empty table; a measured empty table is free. */
const MOVER_TABLE_FIXED_CALLS = 2;

/**
 * Dev write-rate budget: warn with the mover's per-table write-call estimate.
 * The mover sends one insert call per MOVER_BATCH rows of every Data Store
 * table it loads and does not pace them; extension tables load the base
 * form's rows, system tables are created empty. Fill-back updates, file
 * uploads and retries add calls on top, so the estimate is a floor, not a
 * bound. A table at or over the stated rate sustains a minute or more of
 * writes at that cap on its own (100 calls at 100/min is exactly a minute),
 * so the row warns. Missing source row counts are warned about once, by the
 * dev-api-calls budget; this row refers to it instead of warning twice for
 * the same missing input.
 */
function writeRateBudget(tables: SchemaTable[], source?: readonly SourceTableData[]): PlanBudget {
  const { rowsOf } = moverSourceModel(tables, source);
  const cap = `~${DEV_WRITE_RATE}`;
  if (!source) {
    return {
      id: 'dev-write-rate',
      status: 'pass',
      detail:
        `no source row counts — the dev-api-calls budget carries the missing-source warning; ` +
        `the stated Development write rate is ${cap} writes/min/table (datastore.write_requests_per_minute, unverified)`,
      fix: 're-run c2c plan with --source-backup, --source-csv or --source-json so both estimates count the mover calls; run c2c probe P-RATE before a large load',
    };
  }
  const calls = new Map<string, number>();
  const unmeasured: string[] = [];
  for (const table of tables) {
    if (table.nosql || table.role === 'system') continue;
    const rows = rowsOf(table);
    if (rows === undefined) unmeasured.push(table.name);
    else calls.set(table.name, Math.ceil(rows / MOVER_BATCH));
  }
  const atRate = [...calls.entries()].filter(([, count]) => count >= DEV_WRITE_RATE);
  const describe = (name: string, count: number) => `${name} ${count} insert call${count === 1 ? '' : 's'}`;
  if (atRate.length > 0) {
    const listed = atRate.map(([name, count]) => describe(name, count)).join(', ');
    const missingNote =
      unmeasured.length > 0 ? ` (no source rows for ${unmeasured.join(', ')} — counted in the dev-api-calls warning)` : '';
    return {
      id: 'dev-write-rate',
      status: 'warn',
      detail:
        `the mover sends ${listed} back-to-back — at the stated Development write rate of ${cap} writes/min/table ` +
        `(datastore.write_requests_per_minute, unverified) that is a minute or more at the cap per table${missingNote}; ` +
        `the mover does not pace writes and a refused batch stops the load`,
      fix: 'run c2c probe P-RATE before the load and re-run the mover on a refusal — it checkpoints, so a re-run resumes; pace or stage the load if 429s fire',
    };
  }
  const estimate = [...calls.entries()].map(([name, count]) => describe(name, count)).join(', ') || 'no measured tables';
  if (unmeasured.length > 0) {
    return {
      id: 'dev-write-rate',
      status: 'pass',
      detail: `${estimate}; no source rows for ${unmeasured.join(', ')} — counted in the dev-api-calls warning (the stated Development write rate is ${cap} writes/min/table, datastore.write_requests_per_minute, unverified)`,
      fix: 'export the missing tables under --source-* so the estimate counts them; run c2c probe P-RATE before a large load',
    };
  }
  return {
    id: 'dev-write-rate',
    status: 'pass',
    detail: `the mover sends ${estimate} (one insert per ${MOVER_BATCH} rows; fill-back updates, file uploads and retries are extra); the stated Development write rate is ${cap} writes/min/table (datastore.write_requests_per_minute, unverified)`,
  };
}

/**
 * Dev per-table row-cap budget: warn with the largest measured row counts.
 * Development's per-table row cap has no published value — a load refused
 * with 403 API_LIMIT_REACHED "API Limit for row" is the signal, not a number
 * — so a count cannot clear it and the row warns whenever there are rows to
 * load. The budget lists the largest measured Data Store tables (one insert
 * batch per MOVER_BATCH rows; extension tables load the base form's rows,
 * system tables are created empty). With no --source-* data the counts are
 * unknown and the row warns so the plan says so.
 */
function devRowCapBudget(tables: SchemaTable[], source?: readonly SourceTableData[]): PlanBudget {
  const limit = catalystLimit('datastore.rows_per_table_dev');
  const cap = `${limit.id}, the value is not published`;
  if (!source) {
    return {
      id: 'dev-row-cap',
      status: 'warn',
      detail: `the per-table row estimate needs source row counts; Development's per-table row cap is a hidden value (${cap}) — a load refused with 403 API_LIMIT_REACHED "API Limit for row" is the signal`,
      fix: 're-run c2c plan with --source-backup, --source-csv or --source-json so the budget lists the largest tables; rehearse a large load on a different environment before cutover',
    };
  }
  const rowsByTable = new Map(source.map((item) => [item.table, item.rows.length]));
  const rowsOf = (table: SchemaTable): number | undefined =>
    rowsByTable.get(table.name) ?? (table.extensionOf ? rowsByTable.get(table.extensionOf) : undefined);
  const measured: { name: string; rows: number }[] = [];
  const unmeasured: string[] = [];
  for (const table of tables) {
    if (table.nosql || table.role === 'system') continue;
    const rows = rowsOf(table);
    if (rows === undefined) unmeasured.push(table.name);
    else {
      const entry = rowsByTable.has(table.name)
        ? source.find((item) => item.table === table.name)
        : source.find((item) => item.table === table.extensionOf);
      if (entry?.complete !== true) unmeasured.push(table.name);
      if (rows > 0) measured.push({ name: table.name, rows });
    }
  }
  if (measured.length === 0 && unmeasured.length === 0) {
    return {
      id: 'dev-row-cap',
      status: 'pass',
      detail: `no source rows to load; Development's per-table row cap is a hidden value (${cap}) — a load refused with 403 API_LIMIT_REACHED "API Limit for row" is the signal`,
    };
  }
  const largest = measured
    .sort((a, b) => b.rows - a.rows)
    .slice(0, 3)
    .map((item) => {
      const batches = Math.ceil(item.rows / MOVER_BATCH);
      return `${item.name} ${item.rows} rows (${batches} insert batch${batches === 1 ? '' : 'es'} of up to ${MOVER_BATCH})`;
    })
    .join(', ');
  return {
    id: 'dev-row-cap',
    status: 'warn',
    detail:
      `${measured.length ? `largest measured table(s): ${largest}` : 'source row counts are unknown'}; Development's per-table row cap is a hidden value (${cap}), so a count cannot clear it — ` +
      `the refusal is 403 API_LIMIT_REACHED "API Limit for row"${unmeasured.length ? `; row counts are unknown for ${unmeasured.join(', ')}` : ''}`,
    fix: 'rehearse the load on a different environment before cutover; a refused insert stops that table and the mover checkpoints, so a re-run resumes',
  };
}

/** Measured varchar ceiling: a REST insert silently truncates past it. */
const VARCHAR_MEASURED = LIMITS.varcharMaxLength;
/**
 * Counts are JavaScript code points (`[...s].length`), not UTF-16 code units:
 * an emoji is one here, two there. Whether Catalyst's "characters" counts
 * emoji, other multibyte characters, or CRLF the same way is unverified, so
 * the warnings say so instead of implying the numbers predict acceptance.
 */
const codePoints = (value: string): number => [...value].length;
const CHAR_SEMANTICS =
  'counts are JavaScript code points — whether Catalyst counts emoji, multibyte characters or CRLF line endings the same way is unverified';

/**
 * Varchar-length budget: measure --source-* string values against the
 * generated VarChar column lengths. Field definitions over the measured 255
 * are already promoted to text by the mapper, so what remains is data: a
 * source value longer than its column is silently truncated by a REST
 * insert, and the mover only logs such values (VARCHAR_255). Warn-only: a
 * value longer than the column warns by name; values the source cannot prove
 * it holds every record of (`complete` unset) warn as not fully measured,
 * and unmeasured values warn as unknown. Never fails the plan.
 */
function varcharLengthBudget(tables: SchemaTable[], source?: readonly SourceTableData[]): PlanBudget {
  const hint =
    're-run c2c plan with --source-backup, --source-csv or --source-json so the budget measures source string values against varchar column lengths';
  if (!source) {
    return {
      id: 'varchar-length',
      status: 'warn',
      detail: `source string values are unmeasured; a REST insert silently truncates past a varchar column's length (measured ceiling ${VARCHAR_MEASURED}) — validate before write; ${CHAR_SEMANTICS}`,
      fix: hint,
    };
  }
  const byTable = new Map(source.map((item) => [item.table, item]));
  const offenders: { table: string; column: string; longest: number; cap: number; count: number }[] = [];
  const unmeasured: string[] = [];
  const partial: string[] = [];
  let rowsSeen = 0;
  for (const table of tables) {
    if (table.nosql || table.role === 'system') continue;
    const entry = byTable.get(table.name) ?? (table.extensionOf ? byTable.get(table.extensionOf) : undefined);
    if (entry === undefined) {
      unmeasured.push(table.name);
      continue;
    }
    if (entry.complete !== true) partial.push(table.name);
    rowsSeen += entry.rows.length;
    if (!Array.isArray(entry.rows)) {
      if (!partial.includes(table.name)) partial.push(table.name);
      continue;
    }
    for (const column of table.columns) {
      if (column.dataType !== 'VarChar') continue;
      const cap = column.length ?? VARCHAR_MEASURED;
      let longest = 0;
      let count = 0;
      for (const row of entry.rows) {
        const value = row.columns[column.name];
        if (typeof value !== 'string' || codePoints(value) <= cap) continue;
        count += 1;
        longest = Math.max(longest, codePoints(value));
      }
      if (count > 0) offenders.push({ table: table.name, column: column.name, longest, cap, count });
    }
  }
  const gaps =
    (unmeasured.length ? `; no source rows for ${unmeasured.join(', ')}` : '') +
    (partial.length ? `; source rows for ${partial.join(', ')} are not fully measured (the source cannot prove it holds every record)` : '');
  if (offenders.length > 0) {
    const worst = offenders
      .sort((a, b) => b.longest - a.longest)
      .slice(0, 3)
      .map((item) => `${item.table}.${item.column}: ${item.count} value(s) longest ${item.longest}/${item.cap}`)
      .join('; ');
    return {
      id: 'varchar-length',
      status: 'warn',
      detail:
        `source values over a varchar column's length: ${worst}; a REST insert silently truncates past the length (measured ceiling ${VARCHAR_MEASURED})` +
        (gaps ? `${gaps}, so the real figures are higher` : '') +
        `; ${CHAR_SEMANTICS}`,
      fix: 'shorten the source values to fit the varchar column, or confirm the column stores text; the mover only logs over-length values and Catalyst truncates silently',
    };
  }
  if (rowsSeen === 0 && !unmeasured.length && !partial.length) {
    return {
      id: 'varchar-length',
      status: 'pass',
      detail: `no source rows to load; a REST insert silently truncates past a varchar column's length (measured ceiling ${VARCHAR_MEASURED}); ${CHAR_SEMANTICS}`,
    };
  }
  if (unmeasured.length > 0 || partial.length > 0) {
    return {
      id: 'varchar-length',
      status: 'warn',
      detail:
        `measured source values fit their varchar columns${gaps}, so longer values may still truncate silently` +
        `; ${CHAR_SEMANTICS}`,
      fix: hint,
    };
  }
  return {
    id: 'varchar-length',
    status: 'pass',
    detail: `measured source string values fit their varchar columns (measured ceiling ${VARCHAR_MEASURED}); ${CHAR_SEMANTICS}`,
  };
}

function buildBudgets(tables: SchemaTable[], source?: readonly SourceTableData[]): { budgets: PlanBudget[]; ok: boolean } {
  const budgets: PlanBudget[] = [];
  for (const table of tables) {
    const unique = uniqueVarchar(table);
    budgets.push({
      id: PLAN_BUDGET_IDS[0],
      table: table.name,
      status: table.columns.length > MAX_COLUMNS ? 'fail' : table.columns.length > COLUMNS_DEFAULT ? 'warn' : 'pass',
      detail:
        `table ${table.name}: ${table.columns.length}/${MAX_COLUMNS} columns` +
        (table.columns.length > COLUMNS_DEFAULT
          ? ` (over the unverified default ${COLUMNS_DEFAULT}; relies on the raised cap — confirm with P-COLS)`
          : ''),
      ...(table.columns.length > MAX_COLUMNS
        ? { fix: `split ${table.name} (child tables for subforms, side tables for the rest); re-run c2c plan` }
        : {}),
    });
    budgets.push({
      id: PLAN_BUDGET_IDS[1],
      table: table.name,
      status:
        unique.store.length > MAX_UNIQUE_VARCHAR ? 'fail' : unique.names.length > MAX_UNIQUE_VARCHAR ? 'warn' : 'pass',
      detail:
        unique.names.length > MAX_UNIQUE_VARCHAR
          ? `table ${table.name} needs ${unique.names.length} unique varchar columns (${unique.names.join(', ')}); Catalyst allows ${MAX_UNIQUE_VARCHAR} at store level. Store-level unique: ${unique.store.join(', ') || 'none'}. Checked by the c2c handler instead: ${unique.appLevel.join(', ') || 'none'} (not atomic, and a CSV or seed import does not re-check them).`
          : `table ${table.name}: ${unique.names.length}/${MAX_UNIQUE_VARCHAR} unique varchar columns`,
      ...(unique.store.length > MAX_UNIQUE_VARCHAR
        ? {
            fix: `drop No Duplicate until ${MAX_UNIQUE_VARCHAR} store-level unique varchar columns remain on ${table.name}; re-run c2c plan`,
          }
        : unique.names.length > MAX_UNIQUE_VARCHAR
          ? {
              fix: `c2c keeps ${MAX_UNIQUE_VARCHAR} store-level and checks the rest in the handler before each insert and update (not atomic, and a CSV or seed import does not re-check them). To make them all store-level, drop No Duplicate until ${MAX_UNIQUE_VARCHAR} remain; re-run c2c plan`,
            }
          : {}),
    });
    const fks = fkCount(table);
    budgets.push({
      id: PLAN_BUDGET_IDS[2],
      table: table.name,
      status: fks > MAX_FK ? 'fail' : 'pass',
      detail: `table ${table.name}: ${fks}/${MAX_FK} foreign keys`,
      ...(fks > MAX_FK ? { fix: `replace ${table.name} lookups with plain fields plus app-layer checks; re-run c2c plan` } : {}),
    });
  }
  let widest: SchemaTable | undefined;
  for (const table of tables) {
    if (!widest || table.columns.length > widest.columns.length) widest = table;
  }
  const width = widest ? widest.columns.length : 0;
  // Generated reads are staged: planZcql and the SDK adapter chunk a select
  // list at SELECT_WIDTH_UNVERIFIED, so no emitted statement is wider than
  // that. Measure the widest emitted statement, not the table — the budget
  // can warn over the documented 20 but never fails on table width alone.
  const emittedWidth = Math.min(width, SELECT_WIDTH_UNVERIFIED);
  const overDoc = emittedWidth > SELECT_WIDTH_DOC;
  budgets.push({
    id: PLAN_BUDGET_IDS[3],
    ...(widest ? { table: widest.name } : {}),
    status: overDoc ? 'warn' : 'pass',
    detail: widest
      ? `widest generated read of ${widest.name} selects ${emittedWidth} columns per statement (docs ${SELECT_WIDTH_DOC}, unverified limit ${SELECT_WIDTH_UNVERIFIED}; confirm with P-WIDTH)` +
        (width > emittedWidth ? `; the ${width}-column table is staged into ${Math.ceil(width / SELECT_WIDTH_UNVERIFIED)} reads` : '')
      : `widest generated read selects ${emittedWidth} columns (docs ${SELECT_WIDTH_DOC}, unverified limit ${SELECT_WIDTH_UNVERIFIED}; confirm with P-WIDTH)`,
    ...(overDoc ? { fix: 'run c2c probe P-WIDTH before a wider single SELECT' } : {}),
  });
  budgets.push({
    id: PLAN_BUDGET_IDS[4],
    status: 'pass',
    detail: `generated reads are single-table (0/${MAX_JOINS} joins); lookup display needs one fetch per lookup (confirm with P-JOIN)`,
  });
  const store = tables.filter((table) => !table.nosql).length;
  const nosql = tables.length - store;
  budgets.push({
    id: PLAN_BUDGET_IDS[5],
    status: 'pass',
    detail:
      `this app creates ${store} Data Store table(s)${nosql ? ` (and ${nosql} NoSQL)` : ''}; an org-wide limit on table creates ` +
      `refuses a create with 403 API_LIMIT_REACHED "API Limit for table" — on that refusal ${ORG_TABLE_LIMIT_RECOVERY}`,
  });
  budgets.push({ ...devRowCapBudget(tables, source), id: PLAN_BUDGET_IDS[6] });
  budgets.push({ ...varcharLengthBudget(tables, source), id: PLAN_BUDGET_IDS[7] });
  budgets.push({ ...devApiCallsBudget(tables, source), id: PLAN_BUDGET_IDS[8] });
  budgets.push({ ...writeRateBudget(tables, source), id: PLAN_BUDGET_IDS[9] });
  return { budgets, ok: budgets.every((budget) => budget.status !== 'fail') };
}

/**
 * Dev API-call budget: warn with the mover's call estimate.
 * Per measured Data Store table with N rows (B 200-row batches, C 300-id
 * slices; extension tables load the base form's rows, system tables are
 * created empty) the live mover spends, in the normal path:
 * - 2 calls per batch: the reconcile read (`queryExistingSourceIds`) and the
 *   insert (`writeBatch`), packages/data/src/migrate.ts;
 * - 1 write-recount read per batch (`queryStoredRows` inside `writeBatch`,
 *   packages/data/src/migrate.ts);
 * - 1 end-of-table fidelity read-back per id slice (`queryStoredRows`,
 *   packages/data/src/migrate.ts);
 * - 1 source-id remap read per id slice (`loadRowIds`,
 *   packages/deploy/src/remap.ts, called once per loaded table by
 *   packages/deploy/src/csv.ts and packages/deploy/src/seed.ts);
 * - 1 row-count check per id slice (`loadCount` over `sourceIdCountQueries`,
 *   packages/deploy/src/csv.ts);
 * - MOVER_TABLE_FIXED_CALLS as a conservative allowance per non-empty table;
 *   measured empty tables have no batches or id slices, and the loader paths
 *   return before making any of these calls;
 * - 1 deferred-update write per batch for tables carrying a deferred
 *   (self/cyclic, via `cyclicForeignKeys`) lookup (`updateDeferredForeignKeys`,
 *   packages/deploy/src/remap.ts), worst case every row needs the update.
 * File uploads, fill-back updates, retries and the deployed app's runtime
 * calls are on top, so the estimate is a floor, not a bound. With no
 * --source-* data the estimate is unknown and the row warns so the plan
 * says so.
 */
function devApiCallsBudget(tables: SchemaTable[], source?: readonly SourceTableData[]): PlanBudget {
  const { rowsOf, deferredTables } = moverSourceModel(tables, source);
  let calls = 0;
  const unmeasured: string[] = [];
  for (const table of tables) {
    if (table.nosql || table.role === 'system') continue;
    const rows = rowsOf(table);
    if (rows === undefined) unmeasured.push(table.name);
    else {
      const batches = Math.ceil(rows / MOVER_BATCH);
      const slices = Math.ceil(rows / MOVER_ID_CHUNK);
      // Empty measured tables take no loader calls; the fixed allowance is
      // deliberately conservative for non-empty tables only.
      calls += 3 * batches + 3 * slices + (rows > 0 ? MOVER_TABLE_FIXED_CALLS : 0);
      if (deferredTables.has(table.name)) calls += batches;
    }
  }
  const cap = `${DEV_API_CALLS}`;
  if (!source) {
    return {
      id: 'dev-api-calls',
      status: 'warn',
      detail: `the mover's API-call estimate needs source row counts; Development allows ${cap} API calls per application (api.calls_dev, docs figure)`,
      fix: 're-run c2c plan with --source-backup, --source-csv or --source-json so the estimate counts the mover reads and writes',
    };
  }
  const deferredNote = deferredTables.size > 0 ? `; deferred-lookup updates on ${[...deferredTables].join(', ')}` : '';
  const unmeasuredNote = unmeasured.length > 0
    ? `; row counts are unknown for ${unmeasured.join(', ')} (Development allows ${cap} per application, api.calls_dev, docs figure)`
    : '';
  const estimate = `the mover makes about ${calls} API calls loading the measured rows (per ${MOVER_BATCH}-row batch: reconcile read plus insert plus write-recount; per ${MOVER_ID_CHUNK} ids: verification plus remap plus count reads; ${MOVER_TABLE_FIXED_CALLS} conservative fixed-call allowance per non-empty table${deferredNote}; file uploads, fill-back updates, retries and runtime calls are extra)`;
  if (calls >= DEV_API_CALLS) {
    return {
      id: 'dev-api-calls',
      status: 'warn',
      detail: `${estimate}${unmeasuredNote} — at or over the Development allowance of ${cap} per application (api.calls_dev, docs figure)`,
      fix: 'load the data in stages and watch API usage in the console; the figure is a docs ceiling, not a guarantee',
    };
  }
  if (unmeasured.length > 0) {
    return {
      id: 'dev-api-calls',
      status: 'warn',
      detail: `${estimate}${unmeasuredNote}`,
      fix: 'export the missing tables under --source-* so the estimate counts them',
    };
  }
  return {
    id: 'dev-api-calls',
    status: 'pass',
    detail: `${estimate} (Development allows ${cap} per application, api.calls_dev, docs figure)`,
  };
}

/**
 * Shared source-row model for the mover-call budgets: row counts by table
 * with the extension-table fallback to the base form's rows, plus the tables
 * carrying a deferred (self/cyclic) lookup under the loaders' own deferral
 * rule (`cyclicForeignKeys`, packages/deploy/src/tables.ts).
 */
function moverSourceModel(
  tables: SchemaTable[],
  source: readonly SourceTableData[] | undefined,
): { rowsOf: (table: SchemaTable) => number | undefined; deferredTables: ReadonlySet<string> } {
  const rowsByTable = new Map((source ?? []).map((item) => [item.table, item.rows.length]));
  const rowsOf = (table: SchemaTable): number | undefined =>
    rowsByTable.get(table.name) ?? (table.extensionOf ? rowsByTable.get(table.extensionOf) : undefined);
  const names = tables.filter((table) => !table.nosql && table.role !== 'system').map((table) => table.name);
  const keys = tables.flatMap((table) =>
    table.columns.flatMap((column) => (column.relation ? [{ table: table.name, column: column.name, parent: column.relation.table }] : [])),
  );
  const deferred = cyclicForeignKeys(names, keys);
  const deferredTables = new Set(keys.filter((key) => deferred.has(foreignKeyId(key))).map((key) => key.table));
  return { rowsOf, deferredTables };
}

export interface PlanSignals {
  schedules: number;
  files: string[];
  sendmail: boolean;
  invokeurl: boolean;
  integrations: string[];
  customApis: string[];
  /** The app renders PDF (a `pdf` identifier: convertToPDF, a sendmail attachment as pdf) — SmartBrowz. */
  pdf: boolean;
}

export function planSignals(app: App): PlanSignals {
  const facts = appFacts(app);
  const ident = (name: string): boolean => (facts.deluge.idents.get(name) ?? 0) > 0;
  const files: string[] = [];
  for (const form of app.forms) {
    const walk = (fields: App['forms'][number]['fields'], prefix: string) => {
      for (const field of fields) {
        if (fieldTypeRow(field.type)?.kind === 'stratus-key') files.push(`${prefix}${field.name}`);
        walk(field.subfields, `${prefix}${field.name}.`);
      }
    };
    walk(form.fields, `${form.name}.`);
  }
  return {
    schedules: app.workflows.filter((workflow) => (workflow.container ?? '').toLowerCase() === 'schedule').length,
    files: files.sort(),
    sendmail: ident('sendmail'),
    invokeurl: ident('invokeurl') || ident('geturl') || ident('posturl'),
    integrations: [...integrationNamespaces(facts).keys()].sort(),
    customApis: app.apis.map((api) => api.name).sort(),
    pdf: [...facts.deluge.idents].some(([name, count]) => count > 0 && name.toLowerCase().includes('pdf')),
  };
}

/** Roles Update_Table_Permissions/Scopes accept — every other role is a console step. */
const MCP_PERM_ROLES = new Set(['App Administrator', 'App User']);

/**
 * A console first-use gate as a plan step: one guided checklist line, and a
 * read-back c2c runs itself (`c2c provision --record <gate>-enable`). The step
 * closes only on an open answer; provision runs the same read before any later
 * cli step and stops there while the gate is closed.
 */
function gateStep(gate: FirstUseGate): ProvisionStep {
  return {
    id: gate.stepId,
    via: 'console',
    command: `${gate.console} — then c2c verifies it: c2c provision --record ${gate.stepId} (GET ${gate.probe})`,
    args: { service: gate.service },
    readBack: {
      via: 'cli',
      command: `c2c provision --record ${gate.stepId}`,
      args: { call: { method: 'GET', path: gate.probe } },
      match: { gate: 'open' },
    },
  };
}

/** The connector envelope every MCP call needs (schemas: path_variables.projectId + headers). */
function mcpArgs(extra?: Record<string, unknown>): Record<string, unknown> {
  return { path_variables: { projectId: '<project>' }, headers: { 'Catalyst-org': '<org>', Environment: 'Development' }, ...extra };
}

function buildSteps(opts: {
  app: string;
  link: string;
  tables: SchemaTable[];
  mail: boolean;
  sendmail: boolean;
  /** true when a sendmail ships a `template: … as pdf` attachment — the function calls SmartBrowz convertToPdf. */
  pdfMail?: boolean;
  schedules: { name: string; properties: { key: string; value: unknown }[] }[];
  files: string[];
  /** The app renders PDF through SmartBrowz. */
  pdf?: boolean;
  integrations: string[];
  customApis: string[];
  roles: { role_name: string; clone_role?: 'App User' | 'App Administrator' }[];
  portalUsers: number;
  tablePermissions: { table: string; role: string; permissions: string[]; scope: string }[];
  /** true when a Slate client ships — only then is there an App URL host to authorize. */
  client: boolean;
  /**
   * No configured project: the plan provisions by ONE IaC import — the import
   * step replaces project/custom-roles/grant-console/security-rule, and each
   * imported resource gets a verify-only step instead.
   */
  newProject: boolean;
  /** --production: a console promote step with an /environment read-back. */
  production?: boolean;
}): ProvisionStep[] {
  const key = projectKey(opts.link);
  const tableNames = opts.tables.filter((table) => !table.nosql).map((table) => table.name);
  const steps: ProvisionStep[] = [];
  if (opts.newProject) {
    // The whole project in one import: POST provision/iac to
    // /baas/v1/project/import. A taken name is retried as "<name>-2" … after
    // reporting the target org and next name; a stuck "Importing" keeps its
    // name blocked until Catalyst finishes it.
    steps.push({
      id: 'import',
      via: 'cli',
      command: 'c2c provision --confirm --run import',
      args: {
        name: key,
        environment: 'Development',
        app: opts.app,
        dir: 'provision/iac',
        note: 'the bundle ships the dry-run c2c_api without bundled dependencies — run c2c deploy --confirm after provisioning to install the live function',
      },
      // c2c reads the project back itself through the Catalyst CLI (one GET
      // /baas/v1/project, name and id only). The MCP project tools return
      // project secrets into the transcript and are never named.
      readBack: { via: 'cli', command: 'c2c provision --record import', match: { project_name: '<import-name>', id: '<project>' } },
    });
  } else {
    steps.push({
      id: 'project',
      via: 'console',
      command: `Create project "${key}" (Development) in the Catalyst console for app "${opts.app}" (or catalyst iac:import), then record its read-back`,
      args: { name: key, environment: 'Development', app: opts.app },
      // The Catalyst CLI project list (name and id only, never secrets) —
      // bind both the name and the configured project id.
      readBack: { via: 'cli', command: 'c2c provision --record project', match: { project_name: key, id: '<project>' } },
    });
  }
  steps.push(gateStep(FIRST_USE_GATES.cloudscale));
  steps.push({
    id: 'tables',
    via: 'cli',
    command: 'c2c provision --confirm --run tables',
    args: { plan: 'provision/tables.json', tables: tableNames },
    // Real List_All_Tables rows are {table_name, table_id, …} records.
    readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listTables, match: { table_name: tableNames } },
  });
  // Update_Table_Permissions/Scopes accept only the two built-in roles;
  // grants on custom roles are console work, after custom-roles.
  const mcpGrants = opts.tablePermissions.filter((grant) => MCP_PERM_ROLES.has(grant.role));
  const consoleGrants = opts.tablePermissions.filter((grant) => !MCP_PERM_ROLES.has(grant.role));
  // Get_Table_Permissions/Scopes return one row per table. The match is keyed
  // by the resolved table id with the exact role→set row inside: a grant on
  // another table never counts, and an over-grant mismatches — the update call
  // replaces the role's set, it does not union it.
  const matchByTable = (grants: typeof mcpGrants, pick: (grant: (typeof mcpGrants)[number]) => string[]): Record<string, Record<string, string[]>> => {
    const out: Record<string, Record<string, string[]>> = {};
    for (const grant of grants) (out[`<id:${grant.table}>`] ??= {})[grant.role] = pick(grant);
    return out;
  };
  if (opts.newProject && tableNames.length) {
    // The IaC template writes a tablePermission/tableScope row for every role
    // on every table — the auth plan's grant where it exists, the clone-base
    // default where not (importTableGrants is the same source the template
    // uses). These steps verify the full set: a grant the import dropped is a
    // mismatch, not a silent gap. They only read back; they never write.
    const grants = tableNames.flatMap((table) => importTableGrants(table, opts.roles, opts.tablePermissions));
    const calls = tableNames.map((table) => ({ path_variables: { id: `<id:${table}>` } }));
    steps.push(
      {
        id: 'import-table-permissions',
        via: 'mcp',
        tool: PLAN_STEP_TOOL.getTablePermissions,
        args: mcpArgs({ calls, note: 'the IaC import set these grants; this step only proves them — a mismatch means the import did not apply them' }),
        readBack: {
          via: 'mcp',
          tool: PLAN_STEP_TOOL.getTablePermissions,
          args: mcpArgs({ calls }),
          match: matchByTable(grants, (grant) => grant.permissions),
        },
      },
      {
        id: 'import-table-scopes',
        via: 'mcp',
        tool: PLAN_STEP_TOOL.getTableScopes,
        args: mcpArgs({ calls, note: 'the IaC import set these scopes; this step only proves them' }),
        readBack: {
          via: 'mcp',
          tool: PLAN_STEP_TOOL.getTableScopes,
          args: mcpArgs({ calls }),
          match: matchByTable(grants, (grant) => [grant.scope]),
        },
      },
    );
  }
  if (!opts.newProject && mcpGrants.length) {
    const grantTables = [...new Set(mcpGrants.map((grant) => grant.table))];
    steps.push(
      {
        id: 'table-permissions',
        via: 'mcp',
        tool: PLAN_STEP_TOOL.updateTablePermissions,
        args: mcpArgs({
          calls: mcpGrants.map((grant) => ({ path_variables: { id: `<id:${grant.table}>` }, body: { [grant.role]: grant.permissions } })),
        }),
        readBack: {
          via: 'mcp',
          tool: PLAN_STEP_TOOL.getTablePermissions,
          args: mcpArgs({ calls: grantTables.map((table) => ({ path_variables: { id: `<id:${table}>` } })) }),
          match: matchByTable(mcpGrants, (grant) => grant.permissions),
        },
      },
      {
        id: 'table-scopes',
        via: 'mcp',
        tool: PLAN_STEP_TOOL.updateTableScopes,
        args: mcpArgs({
          calls: mcpGrants.map((grant) => ({ path_variables: { id: `<id:${grant.table}>` }, body: { [grant.role]: [grant.scope] } })),
        }),
        readBack: {
          via: 'mcp',
          tool: PLAN_STEP_TOOL.getTableScopes,
          args: mcpArgs({ calls: grantTables.map((table) => ({ path_variables: { id: `<id:${table}>` } })) }),
          match: matchByTable(mcpGrants, (grant) => [grant.scope]),
        },
      },
    );
  }
  if (opts.schedules.length > 0) {
    const pool = jobPoolName(opts.link);
    steps.push({
      id: 'jobpool',
      via: 'mcp',
      tool: PLAN_STEP_TOOL.createJobPool,
      args: mcpArgs({ body: { name: pool, type: 'Function', capacity: { memory: '256' } } }),
      readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listJobpools, match: { name: pool } },
    });
  }
  if (opts.files.length > 0) {
    const bucket = bucketName(opts.link);
    steps.push(gateStep(FIRST_USE_GATES.stratus));
    steps.push({
      id: 'bucket',
      via: 'mcp',
      tool: PLAN_STEP_TOOL.createBucket,
      args: mcpArgs({ body: { bucket_name: bucket, bucket_meta: { type: 'protected' } } }),
      readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.getAllBuckets, match: { bucket_name: bucket } },
    });
  }
  if (opts.roles.length > 0) {
    steps.push(
      {
        id: 'auth-hosted',
        via: 'cli',
        command: 'c2c provision --confirm --run auth-hosted',
        args: { call: { method: 'POST', path: PLAN_CLI_PATH.authHosted, body: { public_signup: false } } },
        readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.getAuthConfigurations, match: { hosted_auth: true } },
      },
      {
        id: 'auth-embedded',
        via: 'cli',
        command: 'c2c provision --confirm --run auth-embedded',
        args: { call: { method: 'POST', path: PLAN_CLI_PATH.authEmbedded, body: { public_signup: false } } },
        readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.getAuthConfigurations, match: { embedded_auth: true } },
      },
    );
    const custom = opts.roles.filter((role) => role.role_name !== 'App Administrator' && role.role_name !== 'App User');
    if (custom.length > 0 && opts.newProject) {
      // The import clones each custom role from its built-in base; this step
      // only proves they exist.
      steps.push({
        id: 'import-roles',
        via: 'mcp',
        tool: PLAN_STEP_TOOL.listRoles,
        args: mcpArgs({ note: 'the IaC import created these roles; this step only proves them — a mismatch means the import did not apply them' }),
        readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listRoles, match: { role_name: custom.map((role) => role.role_name) } },
      });
    } else if (custom.length > 0) {
      steps.push({
        id: 'custom-roles',
        via: 'console',
        command: `Catalyst console → Authentication → User Management → Roles → Add Role (clone App User or App Administrator): ${custom.map((role) => role.role_name).join(', ')}`,
        args: { roles: custom.map((role) => role.role_name) },
        // Real List_All_Roles rows identify each role by `role_name`.
        readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listRoles, match: { role_name: custom.map((role) => role.role_name) } },
      });
    }
    if (opts.portalUsers > 0 && !opts.client) {
      steps.push({
        id: 'app-users',
        via: 'cli',
        command: 'c2c provision --confirm --run app-users',
        args: { invites: opts.portalUsers, spec: 'provision/inputs.json users[] ({email_id, role})' },
        readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listProjectUsers, match: { email_id: ['<user-emails>'] } },
      });
    }
  }
  if (!opts.newProject && consoleGrants.length) {
    const grantTables = [...new Set(consoleGrants.map((grant) => grant.table))];
    const calls = grantTables.map((table) => ({ path_variables: { id: `<id:${table}>` } }));
    const describe = consoleGrants.map((grant) => `${grant.table}: ${grant.permissions.join('/')} for ${grant.role}`).join('; ');
    steps.push(
      {
        id: 'table-permissions-console',
        via: 'console',
        command: `Catalyst console → Data Store → <table> → Permissions, for each grant: ${describe}`,
        args: { grants: consoleGrants.map((grant) => ({ table: grant.table, role: grant.role, permissions: grant.permissions })) },
        readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.getTablePermissions, args: mcpArgs({ calls }), match: matchByTable(consoleGrants, (grant) => grant.permissions) },
      },
      {
        id: 'table-scopes-console',
        via: 'console',
        command: `Catalyst console → Data Store → <table> → Permissions → row scope, for each grant: ${consoleGrants.map((grant) => `${grant.table}: ${grant.scope} for ${grant.role}`).join('; ')}`,
        args: { grants: consoleGrants.map((grant) => ({ table: grant.table, role: grant.role, scope: grant.scope })) },
        readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.getTableScopes, args: mcpArgs({ calls }), match: matchByTable(consoleGrants, (grant) => [grant.scope]) },
      },
    );
  }
  if (opts.mail || opts.sendmail) {
    // Create_Email_Configuration mails a verification code: the user owns that inbox,
    // so this is a console/user-code flow, not a blind MCP call.
    steps.push({
      id: 'mail-sender',
      via: 'console',
      command:
        'Catalyst console → Mail → add sender <sender-email> (or the host calls CatalystbyZoho_Create_Email_Configuration); the service mails a verification code — the user enters it',
      args: { sender_email: '<sender-email>', note: 'the verification code arrives by email; the user enters it' },
      readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listEmails, match: { email_address: '<sender-email>' } },
    });
  }
  // A pdf signal (a PDF call in the Deluge, or a mail template attached `as pdf`) needs SmartBrowz;
  // its first-use gate is the verified console enable.
  if (opts.pdf || opts.pdfMail) steps.push(gateStep(FIRST_USE_GATES.smartbrowz));
  if (opts.integrations.length > 0) {
    steps.push({
      id: 'connections',
      via: 'console',
      command: `Catalyst console → Connections: connect ${opts.integrations.join(', ')} (the user consents to each OAuth flow)`,
      args: { integrations: opts.integrations },
      readBack: {
        via: 'cli',
        command: 'c2c provision --record connections',
        args: { call: { method: 'GET', path: PLAN_CLI_PATH.connections } },
        // GET /connections returns [{ link_name, display_name, connected }] —
        // bind the match to the link_name key, not a generic "names".
        match: { link_name: opts.integrations },
      },
    });
  }
  if (opts.customApis.length > 0) {
    steps.push(
      {
        id: 'apig-enable',
        via: 'cli',
        command: 'catalyst apig:enable',
        args: { argv: ['apig:enable'] },
        readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listApiRoutes, match: { routes: opts.customApis } },
      },
      {
        id: 'apig-routes',
        via: 'mcp',
        tool: PLAN_STEP_TOOL.configureApiRoute,
        args: mcpArgs({ routes: opts.customApis, note: 'resolve the per-route body with ZohoMCP_getSchema before calling' }),
        readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listApiRoutes, match: { routes: opts.customApis } },
      },
    );
  }
  if (opts.client) {
    // A fresh project (IaC-imported or console-created) refuses the first
    // `deploy slate` with HTTP 400 until Slate is opened in the console once.
    steps.push(gateStep(FIRST_USE_GATES.slate));
    steps.push({
      id: 'authorized-domain',
      via: 'cli',
      // iFrame on at first create — the embedded sign-in frame cannot load
      // without it, and the flag cannot be set by this write on an existing
      // domain (then: Authentication > Whitelisting > the host > Edit > iFrame on).
      command: 'c2c provision --confirm --run authorized-domain (after the Slate deploy, when the App URL host is known)',
      args: { call: { method: 'POST', path: PLAN_CLI_PATH.corsDomain, body: { domain: '<slate-app-url-host>', cors: true, iframe: true } } },
      readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listCorsDomains, match: { '<slate-app-url-host>': { cors: true, iframe: true } } },
    });
    if (opts.roles.length > 0 && opts.portalUsers > 0) {
      steps.push({
        id: 'app-users',
        via: 'cli',
        // Invites go out only after the host is authorised — every invite
        // carries redirect_url = the Slate app URL.
        command: 'c2c provision --confirm --run app-users',
        args: { invites: opts.portalUsers, spec: 'provision/inputs.json users[] ({email_id, role})' },
        readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listProjectUsers, match: { email_id: ['<user-emails>'] } },
      });
    }
    // The sign-in check closes the chain for every client app — the generated
    // UI boots Catalyst auth whether or not the plan carries roles.
    steps.push({
      id: 'sign-in-check',
      via: 'console',
      command:
        'Open the Slate app URL — the sign-in box must show the Catalyst sign-in page, not the app itself or a blank box. A blank box means iFrame is off for the host: Authentication > Whitelisting > the Slate host > Edit > iFrame on, then reload.',
      args: {},
      readBack: {
        via: 'console',
        command: 'record the check: c2c provision --record sign-in-check --result <file> ({"sign_in_page": true} once the sign-in page shows)',
        match: { sign_in_page: true },
      },
    });
  }
  if (opts.newProject) {
    // The IaC SecurityRules item requires authentication for c2c_api; the
    // verify step reads the function flag — the rule body is not readable.
    steps.push({
      id: 'import-security-rule',
      via: 'mcp',
      tool: PLAN_STEP_TOOL.listFunctions,
      args: mcpArgs({ note: 'the IaC SecurityRules item requires authentication for c2c_api; List_All_Functions exposes is_authenticated — this step only proves the import applied it' }),
      readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listFunctions, match: { c2c_api: { is_authenticated: true } } },
    });
  } else {
    steps.push(
      {
        id: 'security-rule',
        via: 'console',
        command:
          'Catalyst console → Functions → c2c_api → Security Rules → "Authentication required" (IaC SecurityRules on greenfield). List_All_Functions cannot read the rule itself — it only exposes the function authentication flags',
        args: {
          rule: 'authentication required',
          function: 'c2c_api',
          note: 'the read-back verifies the function exists with is_authenticated true; the Security Rule itself is not readable through this tool — a later IaC/CLI deploy may set it',
        },
        readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listFunctions, match: { c2c_api: { is_authenticated: true } } },
      },
    );
  }
  if (opts.schedules.length > 0) {
    steps.push({
      id: 'crons',
      via: 'cli',
      command: 'c2c provision --confirm --run crons (crons are created disabled; the user enables each in the console)',
      args: { plan: 'provision/crons.json', schedules: opts.schedules.length, enabled: false },
      // List_All_Crons binds each cron to its cron_name key — match that, not
      // the display name (reruns must see the same identifier the POST used).
      readBack: { via: 'mcp', tool: PLAN_STEP_TOOL.listCrons, match: { cron_name: opts.schedules.map((schedule) => cronName(schedule.name)) } },
    });
  }
  if (opts.production) {
    // Development → Production is a console-only promote: the CLI token cannot
    // write /environment, so the step is guided and the read-back is a GET.
    steps.push({
      id: 'production',
      via: 'console',
      command:
        'Promote the project from Development to Production in the Catalyst console (Settings → Environments → promote; the first promote asks for a payment method). Then deploy again for Production.',
      args: { environment: 'Production' },
      readBack: {
        via: 'cli',
        command: 'c2c provision --record production',
        args: { call: { method: 'GET', path: PLAN_CLI_PATH.environment } },
        match: { env_name: ['Production'] },
      },
    });
  }
  return steps;
}

/**
 * One row per step id `c2c plan` can write. A provision plan is accepted only
 * when the step id matches a row, via/tool/read-back equal that row, and the
 * match passes the row's validator.
 */
export interface StepKind {
  id: string;
  /** Anchored to `id` — a step id matches at most one kind. */
  pattern: RegExp;
  via: 'cli' | 'mcp' | 'console';
  tool?: string;
  readBack: { via: 'cli' | 'mcp' | 'console'; tool?: string };
  validateMatch: (match: unknown) => boolean;
}

const GRANT_WORDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ORG', 'GLOBAL', 'USER']);
const GRANT_WORDS_CI = new Set([...GRANT_WORDS].map((word) => word.toLowerCase()));
const GRANT_STEP_TOOLS = new Set<string>([
  PLAN_STEP_TOOL.updateTablePermissions,
  PLAN_STEP_TOOL.getTablePermissions,
  PLAN_STEP_TOOL.updateTableScopes,
  PLAN_STEP_TOOL.getTableScopes,
]);

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A list of the grant words Update_Table_Permissions / Scopes write, exact case. */
export function isExactGrantList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((word) => typeof word === 'string' && GRANT_WORDS.has(word));
}

function grantWordText(value: string): boolean {
  return GRANT_WORDS_CI.has(value.trim().toLowerCase());
}

/** True when any key or string value, at any depth, is a grant word (any case, trimmed). */
function roleShaped(value: unknown): boolean {
  if (typeof value === 'string') return grantWordText(value);
  if (Array.isArray(value)) return value.some((item) => roleShaped(item));
  if (!plain(value)) return false;
  return Object.entries(value).some(([key, child]) => grantWordText(key) || roleShaped(child));
}

/** `<id:Table>` → `{ role: [grant, …] }`. A flat role map or a scalar is not this shape. */
export function isPerRowGrantMatch(match: unknown): boolean {
  if (!plain(match)) return false;
  const rows = Object.entries(match);
  if (!rows.length) return false;
  return rows.every(
    ([key, spec]) => /^<id:[^>]+>$/.test(key) && plain(spec) && Object.keys(spec).length > 0 && Object.values(spec).every(isExactGrantList),
  );
}

function oneKey(match: unknown, key: string): Record<string, unknown> | undefined {
  if (!plain(match)) return undefined;
  const keys = Object.keys(match);
  if (keys.length !== 1 || keys[0] !== key) return undefined;
  return match;
}

function matchString(match: unknown, key: string): boolean {
  const row = oneKey(match, key);
  if (!row) return false;
  const value = row[key];
  return typeof value === 'string' && value.length > 0 && !roleShaped(row);
}

function matchStrings(match: unknown, key: string): boolean {
  const row = oneKey(match, key);
  if (!row) return false;
  const value = row[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') && !roleShaped(row);
}

function matchTrue(match: unknown, key: string): boolean {
  const row = oneKey(match, key);
  return !!row && row[key] === true && !roleShaped(row);
}

/**
 * `{ project_name: <name>, id: '<project>' }` — the fields of the CLI project
 * list rows. The id stays the `<project>` token: it resolves to the configured
 * project id at record time, so a name hit for a different project fails.
 */
function matchProject(match: unknown): boolean {
  if (!plain(match)) return false;
  const keys = Object.keys(match).sort();
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'project_name') return false;
  const row = match as Record<string, unknown>;
  return row.id === '<project>' && typeof row.project_name === 'string' && row.project_name.length > 0 && !roleShaped(row);
}

/**
 * `{ role_name: [name, …] }` — the key is the field List_All_Roles rows carry.
 * Role names are the payload `c2c plan` writes, and one of those names is User
 * — the same spelling as the scope word. A name that is any other grant word
 * is a grant list, not a role name, and is refused.
 */
function matchRoleNames(match: unknown): boolean {
  const row = oneKey(match, 'role_name');
  if (!row) return false;
  const names = row.role_name;
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || name.length === 0)) return false;
  return names.every((name) => {
    const text = name.trim().toLowerCase();
    return text === 'user' || !GRANT_WORDS_CI.has(text);
  });
}

function matchExact(match: unknown, expected: Record<string, unknown>): boolean {
  if (!plain(match)) return false;
  const keys = Object.keys(match).sort();
  const want = Object.keys(expected).sort();
  if (keys.length !== want.length || keys.some((key, index) => key !== want[index])) return false;
  if (want.some((key) => JSON.stringify(match[key]) !== JSON.stringify(expected[key]))) return false;
  return !roleShaped(match);
}

/** Match shapes for steps whose read-back is not a per-row grant list. */
const MATCH_FOR: Record<string, (match: unknown) => boolean> = {
  project: matchProject,
  // The import's read-back names the project the import actually created —
  // `<import-name>` resolves to the name the run used (a "-2" suffix on a clash).
  import: matchProject,
  'import-roles': matchRoleNames,
  'import-security-rule': (match) => matchExact(match, { c2c_api: { is_authenticated: true } }),
  production: (match) => matchStrings(match, 'env_name'),
  tables: (match) => matchStrings(match, 'table_name'),
  jobpool: (match) => matchString(match, 'name'),
  bucket: (match) => matchString(match, 'bucket_name'),
  'auth-hosted': (match) => matchTrue(match, 'hosted_auth'),
  'auth-embedded': (match) => matchTrue(match, 'embedded_auth'),
  'custom-roles': matchRoleNames,
  'app-users': (match) => matchExact(match, { email_id: ['<user-emails>'] }),
  'mail-sender': (match) => matchExact(match, { email_address: '<sender-email>' }),
  connections: (match) => matchStrings(match, 'link_name'),
  'apig-enable': (match) => matchStrings(match, 'routes'),
  'apig-routes': (match) => matchStrings(match, 'routes'),
  'cloudscale-enable': (match) => matchExact(match, { gate: 'open' }),
  'stratus-enable': (match) => matchExact(match, { gate: 'open' }),
  'smartbrowz-enable': (match) => matchExact(match, { gate: 'open' }),
  'slate-enable': (match) => matchExact(match, { gate: 'open' }),
  // The row spec binds the domain's own row (its `domain` field is the id) —
  // a domain listed without iFrame on does not close the step.
  'authorized-domain': (match) => matchExact(match, { '<slate-app-url-host>': { cors: true, iframe: true } }),
  'sign-in-check': (match) => matchExact(match, { sign_in_page: true }),
  // The row spec binds the function row (name leaf = 'c2c_api') and checks the
  // authentication flag it exposes — the rule body itself is not readable.
  'security-rule': (match) => matchExact(match, { c2c_api: { is_authenticated: true } }),
  crons: (match) => matchStrings(match, 'cron_name'),
};

/** Every conditional step, so the kind table cannot miss an id the generator writes. */
function everyEmittedStep(): ProvisionStep[] {
  const table = { name: 'Item', form: 'Item', role: 'form', nosql: false, columns: [] } as SchemaTable;
  const base = {
    app: 'Sample',
    link: 'sample',
    tables: [table],
    mail: true,
    sendmail: true,
    pdfMail: true,
    schedules: [{ name: 'Daily', properties: [] }],
    files: ['notes.txt'],
    pdf: true,
    integrations: ['zcrm'],
    customApis: ['items'],
    roles: [{ role_name: 'App User' }, { role_name: 'Clerk' }],
    portalUsers: 1,
    tablePermissions: [
      { table: 'Item', role: 'App User', permissions: ['SELECT'], scope: 'ORG' },
      { table: 'Item', role: 'Clerk', permissions: ['SELECT'], scope: 'USER' },
    ],
    client: true,
  };
  const existing = buildSteps({ ...base, newProject: false });
  const seen = new Set(existing.map((step) => step.id));
  // A shared step (tables, auth, slate) is identical in both modes; only the
  // new-project ids (import + the verify steps + production) are extra rows.
  return [...existing, ...buildSteps({ ...base, newProject: true, production: true }).filter((step) => !seen.has(step.id))];
}

function kindFrom(step: ProvisionStep): StepKind {
  const grant = (!!step.tool && GRANT_STEP_TOOLS.has(step.tool)) || (!!step.readBack.tool && GRANT_STEP_TOOLS.has(step.readBack.tool));
  const validateMatch = grant ? isPerRowGrantMatch : MATCH_FOR[step.id];
  if (!validateMatch) throw new C2cError('C2C-DEPLOY-002', `c2c plan step ${step.id} has no match validator`);
  if (!validateMatch(step.readBack.match)) throw new C2cError('C2C-DEPLOY-002', `c2c plan step ${step.id} match does not pass its validator`);
  return {
    id: step.id,
    pattern: new RegExp(`^${step.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    via: step.via,
    ...(step.tool ? { tool: step.tool } : {}),
    readBack: { via: step.readBack.via, ...(step.readBack.tool ? { tool: step.readBack.tool } : {}) },
    validateMatch,
  };
}

const EMITTED_STEPS = everyEmittedStep();

export const STEP_KINDS: readonly StepKind[] = (() => {
  const ids = EMITTED_STEPS.map((step) => step.id);
  if (new Set(ids).size !== ids.length) throw new C2cError('C2C-DEPLOY-002', `c2c plan emitted a duplicate step id (${ids.join(', ')})`);
  return EMITTED_STEPS.map(kindFrom);
})();

/** Path templates that appear on a step `c2c plan` writes. Derived from those steps. */
export const PLAN_EMITTED_CLI_PATHS: readonly string[] = (() => {
  const into = new Set<string>();
  const known = new Set<string>(Object.values(PLAN_CLI_PATH));
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (known.has(value)) into.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const child of Object.values(value as Record<string, unknown>)) walk(child);
    }
  };
  for (const step of EMITTED_STEPS) {
    walk(step.args);
    walk(step.readBack);
  }
  return [...into];
})();

function buildProbes(signals: PlanSignals): PlanProbe[] {
  const mail = signals.sendmail;
  const svc = signals.files.length > 0;
  return PROBE_CATALOG.map((probe) => {
    switch (probe.id) {
      case 'P-MAIL':
        return { ...probe, needed: mail, reason: mail ? 'the app sends mail' : 'the app sends no mail' };
      case 'P-BULK':
      case 'P-RATE':
        return { ...probe, needed: true, reason: 'run before the data load' };
      case 'P-SVC':
        return { ...probe, needed: svc, reason: svc ? 'the plan uses Stratus' : 'no Job Scheduling, Stratus or Signals use planned' };
      default:
        return { ...probe, needed: true, reason: 'every migration verifies it' };
    }
  });
}

/**
 * The plan's extra MCP needs: only groups a signal fires, and only tools a
 * provision step or a shipped skill calls from the verified MCP tool registry.
 * Capabilities without a verified MCP tool map to CLI/IaC paths or manual items.
 */
function mcpPlanSet(signals: PlanSignals, roles: number, portalUsers: number, mailStep: boolean): string[] {
  const set = new Set<string>();
  if (signals.schedules > 0) for (const tool of PLAN_MCP_BY_FEATURE.schedules_or_long_work ?? []) if (isVerifiedMcpTool(tool)) set.add(tool);
  if (signals.files.length > 0) {
    for (const tool of PLAN_MCP_BY_FEATURE.files_or_bulk_load ?? []) if (isVerifiedMcpTool(tool)) set.add(tool);
  }
  if (signals.customApis.length > 0) for (const tool of PLAN_MCP_BY_FEATURE.custom_apis ?? []) if (isVerifiedMcpTool(tool)) set.add(tool);
  if (mailStep) for (const tool of PLAN_MCP_BY_FEATURE.sendmail ?? []) if (isVerifiedMcpTool(tool)) set.add(tool);
  if (portalUsers > 0) for (const tool of PLAN_MCP_BY_FEATURE.user_invites ?? []) if (isVerifiedMcpTool(tool)) set.add(tool);
  return [...set].sort();
}

export function buildOfflinePlan(app: App, opts: { dc: string; dcSource: DcSource; mail: boolean; source?: readonly SourceTableData[]; newProject?: boolean; production?: boolean; subsetShims?: boolean }): { files: PlanFile[]; plan: OfflinePlan } {
  const link = (app.name ?? '').trim() || 'app';
  const newProject = opts.newProject === true;
  const schema = generateSchema(app, opts.source ? { source: opts.source } : undefined);
  const auth = authPlan(app);
  const ui = buildUi(app, { schema });
  const signals = planSignals(app);
  const manual = widgetManualItems(app.widgets);
  const connectionSecrets = extractConnectionSecrets(app);
  const connectionSecretKeys = connectionSecrets.map((s) => s.envKey);
  const mailStep = opts.mail || signals.sendmail;
  const { budgets, ok } = buildBudgets(schema.tables, opts.source);
  const schedules = app.workflows
    .filter((workflow) => (workflow.container ?? '').toLowerCase() === 'schedule')
    .map((workflow) => ({ name: workflow.name ?? 'schedule', properties: workflow.properties.map((p) => ({ key: p.key, value: p.value })) }));
  // A sendmail `template: … as pdf` attachment translates to a rendered pdf
  // descriptor in the generated function sources; that is what makes the
  // SmartBrowz console enable a planned step.
  const pdfMail = ui.files.some((file) => file.path.startsWith('functions/') && typeof file.data === 'string' && file.data.includes('rendered: "pdf"'));
  const steps = buildSteps({
    app: app.name ?? link,
    link,
    tables: schema.tables,
    mail: opts.mail,
    sendmail: signals.sendmail,
    pdfMail,
    schedules,
    files: signals.files,
    pdf: signals.pdf,
    integrations: signals.integrations,
    customApis: signals.customApis,
    roles: auth.roles,
    portalUsers: auth.portalUsers.length,
    tablePermissions: auth.tablePermissions,
    client: ui.summary.pages > 0,
    newProject,
    ...(opts.production ? { production: true } : {}),
  });
  const columns = schema.tables.reduce((n, table) => n + table.columns.length, 0);
  const plan: OfflinePlan = {
    version: 1,
    command: 'plan',
    c2c: c2cVersion(),
    app: app.name ?? link,
    dc: opts.dc,
    dcSource: opts.dcSource,
    doctor: 'not-run',
    counts: {
      tables: schema.tables.length,
      dataStoreTables: schema.tables.filter((table) => !table.nosql).length,
      columns,
      nosqlTables: schema.tables.filter((table) => table.nosql).length,
      functions: app.functions.length,
      schedules: signals.schedules,
      reports: ui.summary.reports,
      pages: ui.summary.pages,
      roles: auth.roles.length,
      customApis: signals.customApis.length,
    },
    tables: schema.tables.map((table) => ({
      name: table.name,
      form: table.form,
      role: table.role,
      nosql: table.nosql,
      columns: table.columns.length,
      uniqueVarchar: uniqueVarchar(table).names.length,
      fks: fkCount(table),
      ...(table.nosqlReason ? { nosqlReason: table.nosqlReason } : {}),
    })),
    ...(schema.constraints?.length ? { constraints: schema.constraints } : {}),
    budgets,
    budgetsOk: ok,
    steps,
    mcpTools: { base: [...PLAN_MCP_BASE], plan: mcpPlanSet(signals, auth.roles.length, auth.portalUsers.length, mailStep) },
    probes: buildProbes({ ...signals, sendmail: mailStep }),
    zcqlCaps: {
      rowsPerQuery: LIMITS.zcqlRowsPerQuery,
      offsetBase: 1,
      likeWildcard: '*',
      maxJoins: MAX_JOINS,
      selectWidthDoc: SELECT_WIDTH_DOC,
      selectWidthUnverified: SELECT_WIDTH_UNVERIFIED,
    },
    ...(manual.length ? { manual } : {}),
    ...(connectionSecretKeys.length ? { connectionSecretKeys } : {}),
  };
  const planJson = `${JSON.stringify(plan, null, 2)}\n`;
  const provisionJson = `${JSON.stringify({ version: 1, app: plan.app, dc: plan.dc, steps, ...(connectionSecretKeys.length ? { connectionSecretKeys } : {}) }, null, 2)}\n`;
  const planMd = formatPlanMd(plan, { mail: opts.mail, sendmail: mailStep, integrations: signals.integrations, files: signals.files });
  const fenv = buildFunctionEnv({
    dc: opts.dc,
    env: opts.production ? 'Production' : 'Development',
    bucketName: signals.files.length ? bucketName(link) : undefined,
    tables: schema.tables.map((t) => ({ name: t.name })),
    connectionSecrets,
  });
  const files: PlanFile[] = [
    { path: 'plan.md', data: planMd },
    { path: 'plan.json', data: planJson },
    { path: 'provision/plan.json', data: provisionJson },
    { path: 'function-env.json', data: `${JSON.stringify(fenv, null, 2)}\n` },
    // Detail specs the cli steps execute; inputs.json is the file the customer fills.
    { path: 'provision/tables.json', data: `${JSON.stringify(tableCreatePlan(schema), null, 2)}\n` },
    { path: 'provision/inputs.json', data: `${JSON.stringify({ slateDomain: '', senderEmail: '', users: [], projectName: '' }, null, 2)}\n` },
  ];
  if (newProject) {
    // The single-import bundle: the full template plus the c2c_api code zip.
    // `provision --run import` packs both into the `code` multipart part — the
    // outer zip is built at run time from these files, so they stay reviewable.
    files.push({
      path: 'provision/iac/project-template-1.0.0.json',
      data: importTemplateJson({
        plan: schema,
        roles: auth.roles,
        tablePermissions: auth.tablePermissions,
        // The import creates the seed file-column bucket: an app with no
        // file fields emits the same empty Stratus component an export shows.
        ...(signals.files.length ? { bucket: bucketName(link) } : {}),
      }),
    });
    // mail.enabled follows --mail. sendmail in the app plans the sender step; it does not turn delivery on.
    const fnFiles = functionDir(functionSources(schema, ui, mailConfig(opts.mail), app), {
      mode: 'dry-run',
      columns: columnTypes(schema.tables),
      roleMap: principalRoleMap(auth),
      ...(opts.subsetShims !== undefined ? { subsetShims: opts.subsetShims } : {}),
    });
    const prefix = `${FUNCTION_DIR}/`;
    files.push({
      path: `provision/iac/functions/${API_FUNCTION}.zip`,
      data: '',
      bytes: zipStore(
        fnFiles.filter((file) => file.path.startsWith(prefix)).map((file) => ({ name: file.path.slice(prefix.length), data: file.data })),
      ),
    });
  }
  if (schedules.length > 0) {
    const pool = jobPoolName(link);
    const crons = schedules.map((schedule) => {
      const start = String(schedule.properties.find((p) => /^start$/i.test(p.key))?.value ?? '');
      const jobName = `job/${schedule.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'schedule'}`;
      return {
        name: schedule.name,
        jobModule: `functions/${jobName}.mjs`,
        pool,
        schedule: Object.fromEntries(schedule.properties.map((p) => [p.key, p.value])),
        // Only the OneTime shape is [TESTED] on the CLI token; a recurring
        // cron's cron_details differs per frequency — fill it before --run.
        ...(start ? {} : { unsupported: 'no start property; fill cron_details' }),
        body: {
          cron_name: cronName(schedule.name),
          cron_type: 'OneTime',
          cron_status: false,
          cron_details: { time_of_execution: start || '<fill>' },
          jobpool_id: `<id:${pool}>`,
          job_details: { job_name: jobName },
        },
      };
    });
    files.push({ path: 'provision/crons.json', data: `${JSON.stringify(crons, null, 2)}\n` });
  }
  const manifest = {
    c2c: plan.c2c,
    command: 'plan',
    app: plan.app,
    dc: plan.dc,
    dcSource: plan.dcSource,
    toolchain: { node: process.version },
    files: Object.fromEntries(files.map((file) => [file.path, `sha256:${sha256(file.bytes ?? file.data)}`])),
  };
  files.push({ path: 'c2c-manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` });
  return { files, plan };
}

function stepRef(step: StepEndpoint & { id?: string }): string {
  return step.tool ?? step.command ?? step.id ?? 'step';
}

function formatPlanMd(
  plan: OfflinePlan,
  opts: { mail: boolean; sendmail: boolean; integrations: string[]; files: string[] },
): string {
  const lines = [
    `# c2c plan for ${plan.app}`,
    '',
    `dc: ${plan.dc} (from ${plan.dcSource})`,
    'doctor: not-run (plan is offline; provision and deploy need a green doctor)',
    `budgets: ${plan.budgetsOk ? 'ok' : 'FAIL — resolve before provision'}`,
    '',
    `tables: ${plan.counts.tables} (${plan.counts.columns} columns${plan.counts.nosqlTables ? `, ${plan.counts.nosqlTables} NoSQL` : ''})  ` +
      `functions: ${plan.counts.functions}  schedules: ${plan.counts.schedules}  reports: ${plan.counts.reports}  ` +
      `pages: ${plan.counts.pages}  roles: ${plan.counts.roles}  custom APIs: ${plan.counts.customApis}`,
    opts.sendmail ? (opts.mail ? 'mail: sender step planned (--mail)' : 'mail: the app sends mail, so a sender step is planned') : 'mail: none',
    opts.integrations.length ? `integrations: ${opts.integrations.join(', ')}` : 'integrations: none',
    opts.files.length ? `files: ${opts.files.length} Stratus-backed fields` : 'files: none',
    plan.steps.some((step) => step.id === 'import')
      ? 'project: new — provision/plan.json creates it with one IaC import (provision/iac; a taken name retries as "<name>-2"; the imported c2c_api is the dry-run handler — c2c deploy --confirm installs the live function)'
      : 'project: configured — provision/plan.json provisions the existing project step by step',
    '',
    '## Budgets (D-F5)',
    '',
    ...plan.budgets.map(
      (budget) => `- [${budget.status.toUpperCase()}] (${budget.id}) ${budget.table ? `${budget.table}: ` : ''}${budget.detail}${budget.fix ? ` → ${budget.fix}` : ''}`,
    ),
  ];
  if (plan.manual?.length) {
    lines.push('', '## Manual', '');
    for (const item of plan.manual) lines.push(`- ${item.detail}`);
  }
  if (plan.constraints?.length) {
    lines.push('', '## Store constraints decided from source data', '');
    for (const decision of plan.constraints) lines.push(`- ${constraintDecisionNote(decision)}`);
  }
  const nosql = plan.tables.filter((table) => table.nosql);
  if (nosql.length > 0) {
    lines.push('', '## NoSQL tables (console only, no MCP create)', '');
    for (const table of nosql) lines.push(`- ${table.name}${table.nosqlReason ? `: ${table.nosqlReason}` : ''}`);
  }
  lines.push('', '## Provision steps (provision/plan.json)', '');
  for (const step of plan.steps) lines.push(`- ${step.id} [${step.via}] ${stepRef(step)} → read back ${stepRef(step.readBack)}`);
  lines.push('', '## Required MCP tools (doctor D-B5)', '', `- base (${plan.mcpTools.base.length}): ${plan.mcpTools.base.join(', ')}`);
  lines.push(`- plan (${plan.mcpTools.plan.length}): ${plan.mcpTools.plan.length ? plan.mcpTools.plan.join(', ') : 'none beyond base'}`);
  lines.push('', '## Probes (scratch resources prefixed c2c_probe_, deleted afterwards)', '');
  for (const probe of plan.probes) lines.push(`- ${probe.id} [${probe.needed ? 'needed' : 'skip'}] ${probe.measures} — ${probe.reason}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** A failure that already names `c2c plan` keeps that prefix; any other failure gets one `c2c:` prefix. */
function planFailure(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback;
  return msg.startsWith('c2c plan:') ? `${msg}\n` : `c2c: ${msg}\n`;
}

export function writePlanTree(dir: string, files: readonly PlanFile[]): void {
  for (const file of files) {
    const dest = join(dir, ...file.path.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.bytes ?? file.data);
  }
}

/**
 * `c2c plan <file|dir> --out <dir> [--dc <dc>] [--mail] [--project <id>] [--production]`.
 * Exit 0 when the plan is written (even when budgets fail: they are review
 * findings, not write errors), 2 on usage/DC errors and locked Marketplace
 * exports, 1 on load failures. A widget package that is missing html or json
 * still writes the plan, names the package in `manual`, and exits 1.
 *
 * A configured project (--project or c2c-deploy.json apps.<app>.project) plans
 * the per-step provisioning path. With no project the plan provisions by ONE
 * IaC import: provision/iac holds the template and the function code zip, and
 * the `import` step is the only create step.
 */
export async function planCli(args: readonly string[], io: Io): Promise<number> {
  const target = args.length > 0 && !args[0]!.startsWith('--') ? args[0]! : undefined;
  const out = flag(args, '--out');
  const unknown = args.filter((arg) => arg === '--confirm');
  if (!target || !out || unknown.length > 0) {
    io.stderr(
      coded('C2C-DEPLOY-021',
      'usage: c2c plan <file|dir> --out <dir> [--dc <dc>] [--mail] [--project <id>] [--production] [--source-backup <zip|dir>|--source-csv <dir>|--source-json <dir>] [--allow-budget-fail]\n' +
        '       --source-* measures the Creator data so is_mandatory/is_unique are provisioned only where the records allow it\n',
      ),
    );
    return 2;
  }
  let dc: DcResolution;
  try {
    dc = resolveDc(args, process.cwd());
  } catch (err) {
    io.stderr(coded('C2C-DEPLOY-002', planFailure(err, 'data centre lookup failed').trimEnd()));
    return 2;
  }
  try {
    const app = loadApp(target);
    const srcBackup = flag(args, '--source-backup');
    const srcCsv = flag(args, '--source-csv');
    const srcJson = flag(args, '--source-json');
    const named = [srcBackup, srcCsv, srcJson].filter((value) => value !== undefined).length;
    if (named > 1) throw new C2cError('C2C-CLI-012', 'c2c: pass at most one of --source-backup, --source-csv, or --source-json');
    const allowEmpty = args.includes('--allow-empty');
    const source = srcBackup !== undefined
      ? readSourceBackup(srcBackup, app, allowEmpty).sourceData
      : srcCsv !== undefined
        ? (hasReportJson(srcCsv, app) ? readSourceJson(srcCsv, app, allowEmpty) : readSourceCsv(srcCsv, app, allowEmpty)).sourceData
        : srcJson !== undefined
          ? readSourceJson(srcJson, app, allowEmpty).sourceData
          : undefined;
    const appKey = app.name ?? 'app';
    let configuredProject = flag(args, '--project');
    if (configuredProject !== undefined && !/^[0-9]+$/.test(configuredProject)) {
      io.stderr(coded('C2C-DEPLOY-021', 'c2c plan: --project must be a decimal id'));
      return 2;
    }
    if (configuredProject === undefined) {
      const configPath = flag(args, '--config') ?? join(process.cwd(), 'c2c-deploy.json');
      configuredProject = readDeployConfig(configPath).apps[appKey]?.project;
    }
    const subsetShims = args.includes('--subset-shims') || io.env.C2C_SUBSET_SHIMS === '1';
    const { files, plan } = buildOfflinePlan(app, {
      dc: dc.dc,
      dcSource: dc.source,
      mail: args.includes('--mail'),
      ...(source ? { source } : {}),
      newProject: configuredProject === undefined,
      ...(args.includes('--production') ? { production: true } : {}),
      ...(subsetShims ? { subsetShims: true } : {}),
    });
    // inputs.json and function-env.json are customer-edited; a re-plan must not clobber them.
    writePlanTree(
      out,
      files.filter(
        (file) =>
          file.path !== 'function-env.json' &&
          (file.path !== 'provision/inputs.json' || !statSync(join(out, 'provision', 'inputs.json'), { throwIfNoEntry: false })?.isFile()),
      ),
    );
    const fenvFile = files.find((f) => f.path === 'function-env.json');
    const fenvInitial = fenvFile ? (JSON.parse(fenvFile.data) as Record<string, string>) : undefined;
    writeOrUpdateFunctionEnv(out, {
      dc: dc.dc,
      env: args.includes('--production') ? 'Production' : 'Development',
      projectId: configuredProject,
      connectionSecrets: extractConnectionSecrets(app),
      existingEnv: fenvInitial,
    });
    io.stdout(`plan: ${out}/plan.md\n`);
    if (!plan.budgetsOk && !args.includes('--allow-budget-fail')) {
      const fails = plan.budgets.filter(b => b.status === 'fail');
      for (const fail of fails) {
        io.stderr(coded('C2C-DEPLOY-031', `c2c plan: budget failed: ${fail.id}: ${fail.detail}`));
      }
      return 1;
    }
    return widgetCommandStatus(app.widgets);
  } catch (err) {
    // A locked Marketplace export is refused, never planned: exit 2.
    if (err instanceof C2cError) {
      io.stderr(codedError(err));
      return err.exitCode ?? 1;
    }
    if (err instanceof LockedExportError) {
      io.stderr(coded('C2C-CLI-003', `c2c: ${err.message}`));
      return 2;
    }
    io.stderr(coded('C2C-DEPLOY-002', planFailure(err, 'plan failed').trimEnd()));
    return 1;
  }
}
