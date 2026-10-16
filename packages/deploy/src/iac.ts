/**
 * Catalyst IaC project template (project-template-1.0.0.json) and its drift check.
 *
 * The template is the real Catalyst format an `iac:export` produces and an IaC
 * import reads: { name, version, parameters, components: { <Component>: [item] } },
 * each item { type, name, properties, dependsOn }. References are names, not ids
 * (a column's table_id holds the table name). Format verified against the
 * vendor's own exported project template and import behaviour.
 *
 * Determinism: fixed component order, tables in tableCreatePlan order, columns in
 * schema order, dependsOn sorted, 2-space JSON with LF and a trailing newline.
 * No ids, timestamps or secrets: every env var value is written as "".
 *
 * Not emitted: NoSQL tables (no IaC key), Signals (no IaC key in a current export),
 * Circuits (not in IN), EventListeners (deprecated — Signals is the exit; never
 * emitted, but diffTemplate still reports export items so a console-added
 * listener or rule surfaces instead of passing silently), legacy Cron
 * (unstable shape).
 */
import { BASELINE_GRANT } from '../../auth/src/plan.js';
import type { SchemaPlan } from '../../schema/src/generator.js';
import { API_FUNCTION, FUNCTION_STACK } from './function-dir.js';
import { columnBody, tableCreatePlan, type ColumnCreate } from './tables.js';

export const PROJECT_TEMPLATE_FILE = 'project-template-1.0.0.json';

export interface TemplateItem {
  type: string;
  name: string;
  properties: Record<string, unknown>;
  dependsOn: string[];
}

export interface ProjectTemplate {
  name: 'project-template';
  version: '1.0.0';
  parameters: Record<string, never>;
  components: Record<string, TemplateItem[]>;
}

export interface TemplateFunction {
  name: string;
  /** IaC function type: applogic is Advanced I/O. */
  type: 'applogic' | 'basicio' | 'event' | 'cron' | 'job';
  stack: string;
  memory: number;
  /** Env var names. Values are never written to the template. */
  env: readonly string[];
}

/** The c2c_api Advanced I/O function every generated app deploys (function-dir.ts). */
export const API_TEMPLATE_FUNCTION: TemplateFunction = {
  name: API_FUNCTION,
  type: 'applogic',
  stack: FUNCTION_STACK,
  // [assumed] Catalyst's default function memory; catalyst-config.json does not set one.
  memory: 256,
  env: ['C2C_DEPLOY_MODE'],
};

/**
 * Per-table [tableName, table item, column items] groups in tableCreatePlan
 * order, columns in schema order (an FK column is not moved behind the system
 * columns). Shared by the datastore template and the import template.
 */
function tableGroups(plan: SchemaPlan): [string, TemplateItem, TemplateItem[]][] {
  const steps = tableCreatePlan(plan).filter((step) => !step.nosql);
  const tables: string[] = [];
  const columns = new Map<string, ColumnCreate[]>();
  for (const step of steps) {
    if (!columns.has(step.table)) {
      tables.push(step.table);
      columns.set(step.table, []);
    }
    columns.get(step.table)!.push(...step.columns);
  }
  // tableCreatePlan splits FK columns into a later step; the template keeps schema order.
  const order = new Map(plan.tables.map((table) => [table.name, table.columns.map((column) => column.name)]));
  return tables.map((table) => [
    table,
    { type: 'table', name: table, properties: { table_name: table }, dependsOn: [] },
    (() => {
      const ordinal = order.get(table) ?? [];
      return [...columns.get(table)!].sort((a, b) => ordinal.indexOf(a.column_name) - ordinal.indexOf(b.column_name)).map(columnItem);
    })(),
  ]);
}

/**
 * A Stratus bucket item, in the shape an IaC import accepts and an `iac:export`
 * writes back: bucket_meta carries versioning, encryption, audit_consent and
 * the caching status word the export uses. Emitted only when the app stores
 * file-column keys; an app without file fields gets the same empty Stratus
 * component an unmodified export shows.
 */
export function bucketItem(name: string): TemplateItem {
  return {
    type: 'bucket',
    name,
    properties: {
      bucket_name: name,
      bucket_meta: { versioning: false, encryption: false, audit_consent: false, caching: { status: 'Disabled' } },
    },
    dependsOn: [],
  };
}

export function projectTemplate(
  plan: SchemaPlan,
  functions: readonly TemplateFunction[] = [API_TEMPLATE_FUNCTION],
  opts: { bucket?: string } = {},
): ProjectTemplate {
  const groups = tableGroups(plan);
  const datastore: TemplateItem[] = groups.map(([, table]) => table);
  for (const [, , columns] of groups) datastore.push(...columns);
  const components: Record<string, TemplateItem[]> = {};
  if (opts.bucket) components.Stratus = [bucketItem(opts.bucket)];
  components.Datastore = datastore;
  if (functions.length) components.Functions = [...functions].sort((a, b) => cmp(a.name, b.name)).map(functionItem);
  return { name: 'project-template', version: '1.0.0', parameters: {}, components };
}

export function projectTemplateJson(plan: SchemaPlan, functions?: readonly TemplateFunction[], opts: { bucket?: string } = {}): string {
  return `${JSON.stringify(projectTemplate(plan, functions, opts), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The full import template: everything a new project needs in one import —
// datastore (tables, columns, per-role scopes and permissions), authentication
// (roles, signup), the c2c_api security rule, and the function code reference.
// ---------------------------------------------------------------------------

/**
 * Component keys in the order a Catalyst export writes them. Components the
 * app does not use stay as empty arrays — the import reads the same envelope.
 */
export const IAC_COMPONENT_ORDER = [
  'Pipelines',
  'ApplicationAlerts',
  'Stratus',
  'Functions',
  'Add-onServices',
  'WebClient',
  'Cron',
  'SchedulingJobpool',
  'Filestore',
  'Mail',
  'Zia',
  'Datastore',
  'Authentication',
  'AppSail',
  'SecurityRules',
  'EventListeners',
  'SchedulingCron',
  'Cache',
] as const;

export interface TemplateRole {
  role_name: string;
  description?: string;
  /** The built-in role a custom role is cloned from. */
  clone_role: 'App User' | 'App Administrator';
}

export interface TemplateGrant {
  table: string;
  role: string;
  permissions: readonly string[];
  scope: 'USER' | 'ORG' | 'GLOBAL';
}

export interface ImportTemplateInput {
  plan: SchemaPlan;
  /** Auth-plan roles. Built-ins are always emitted; every other role is Custom. */
  roles?: readonly TemplateRole[];
  /** Auth-plan table grants: per role, per table — CRUD verbs plus row scope. */
  tablePermissions?: readonly TemplateGrant[];
  functions?: readonly TemplateFunction[];
  /** Seed file-column bucket the import creates. Omitted for apps with no file fields. */
  bucket?: string;
}

/** The verb order a Catalyst export writes inside a tablePermission row. */
const PERMISSION_ORDER = ['SELECT', 'UPDATE', 'INSERT', 'DELETE'] as const;
const BUILTIN_ROLES = new Set(['App Administrator', 'App User']);

function roleType(role: string): string {
  return BUILTIN_ROLES.has(role) ? role : 'Custom';
}

/** Role order inside a table's scope/permission rows: the roles array order, then any leftover in first-seen order. */
function grantRoleOrder(grants: readonly { role: string }[], roles: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const role of [...roles, ...grants.map((grant) => grant.role)]) {
    if (seen.has(role)) continue;
    seen.add(role);
    out.push(role);
  }
  return out;
}

/** App Administrator keeps the Catalyst default: it reads and writes every row. */
const ADMIN_GRANT = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

/**
 * The grants the import writes for one table — one row per role the template
 * defines, not only the roles the auth plan grants: the plan's grant where it
 * exists, else App Administrator's full default or, for App User and every
 * custom role, the least-privilege baseline (no table operation, User scope).
 * The generated client never reads the Data Store directly, so that also holds
 * for c2c's own tables, which have no auth-plan row. An explicit row per role
 * is what lets the verify steps catch a grant the import dropped instead of
 * treating a missing row as no grant.
 */
export function importTableGrants(
  table: string,
  roles: readonly { role_name: string; clone_role?: 'App User' | 'App Administrator' }[],
  planGrants: readonly { table: string; role: string; permissions: readonly string[]; scope: string }[],
): { table: string; role: string; permissions: string[]; scope: string }[] {
  const roleNames = ['App Administrator', 'App User', ...roles.filter((role) => !BUILTIN_ROLES.has(role.role_name)).map((role) => role.role_name)];
  const tableGrants = planGrants.filter((grant) => grant.table === table);
  return grantRoleOrder(tableGrants, roleNames).map((role) => {
    const grant = tableGrants.find((row) => row.role === role);
    const admin = role === 'App Administrator';
    const permissions: readonly string[] = grant ? grant.permissions : admin ? ADMIN_GRANT : BASELINE_GRANT.permissions;
    return { table, role, permissions: PERMISSION_ORDER.filter((verb) => permissions.includes(verb)), scope: grant ? grant.scope : admin ? 'GLOBAL' : BASELINE_GRANT.scope };
  });
}

function authItems(roles: readonly TemplateRole[]): TemplateItem[] {
  const items: TemplateItem[] = [
    {
      type: 'emailTemplates',
      name: '1',
      properties: {
        subject: 'Welcome to %APP_NAME%',
        template_type: 1,
        message:
          "<p>Hello %FIRST_NAME% %LAST_NAME%,</p>\n<p>You have been invited to join %APP_NAME%. You can access the app from this link:</p>\n<p><a href='%LINK%'>%LINK%</a></p>\n<p>You are assigned to the role %ROLE_NAME% in this app.</p>\n<p>If you didn’t ask to join the application or if you think this was a mistake, you can ignore this email.</p>\n<p>Thanks,</p>\n<p>%APP_NAME% team</p>\n",
      },
      dependsOn: [],
    },
    {
      type: 'emailTemplates',
      name: '2',
      properties: {
        subject: 'Password Reset for %APP_NAME%',
        template_type: 2,
        message:
          "<p>Hello %FIRST_NAME% %LAST_NAME%,</p>\n<p>Follow this link to reset your %APP_NAME% password for your %EMAIL% account.</p>\n<p><a href='%LINK%'>%LINK%</a></p>\n<p>If you didn't ask to reset your password, you can ignore this email.</p>\n<p>Thanks,</p>\n<p>Your %APP_NAME% team</p>",
      },
      dependsOn: [],
    },
    {
      type: 'roles',
      name: 'App Administrator',
      properties: { role_name: 'App Administrator', description: 'Admin Role for the application', type: 'App Administrator', is_default: false },
      dependsOn: ['Authentication.roles.App User'],
    },
    {
      type: 'roles',
      name: 'App User',
      properties: { role_name: 'App User', description: 'User Role for the application', type: 'App User', is_default: true },
      dependsOn: [],
    },
  ];
  for (const role of roles) {
    if (BUILTIN_ROLES.has(role.role_name)) continue;
    items.push({
      type: 'roles',
      name: role.role_name,
      properties: { role_name: role.role_name, description: role.description ?? '', type: 'Custom', is_default: false },
      dependsOn: [`Authentication.roles.${role.clone_role}`],
    });
  }
  items.push(
    {
      type: 'SignupConfiguration',
      name: 'signup-configuration',
      properties: {
        app_account_meta: { limit: 1000, type: 0 },
        custom_validation: false,
        public_signup: false,
        url_preference: 0,
        status: { embedded_auth: true, third_party_auth: false, hosted_auth: true },
      },
      dependsOn: [],
    },
    {
      type: 'HostedLogin',
      name: 'hosted-login',
      properties: { config: { is_logo_present: false, company_name: '', colors: { background_color: '#dce7ff', primary_color: '#0059e9' } } },
      dependsOn: [],
    },
  );
  return items;
}

function securityRuleItems(functions: readonly TemplateFunction[]): TemplateItem[] {
  const advancedio: Record<string, unknown> = {};
  for (const fn of functions) {
    if (fn.type !== 'applogic') continue;
    advancedio[fn.name] = [{ '.*': { methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'], authentication: 'required' } }];
  }
  if (!Object.keys(advancedio).length) return [];
  return [{ type: 'rules', name: 'security-rules', properties: { advancedio }, dependsOn: [] }];
}

/**
 * The complete project template a single `project/import` provisions: the whole
 * component envelope in export order, Datastore rows grouped per table
 * (table, columns, tableScope then tablePermission per role — every role the
 * template defines, so a grant the import drops is a verify mismatch), the
 * Authentication block (built-ins, custom roles cloned from their base, signup,
 * hosted login), the authentication-required security rule for the Advanced I/O
 * functions, and the Default cache segment. An app with no roles emits an empty
 * Authentication component; the Slate authorized domain is not written — the
 * host is unknown until the first deploy.
 */
export function importTemplate(input: ImportTemplateInput): ProjectTemplate {
  const plan = input.plan;
  const roles = input.roles ?? [];
  const grants = input.tablePermissions ?? [];
  const functions = [...(input.functions ?? [API_TEMPLATE_FUNCTION])].sort((a, b) => cmp(a.name, b.name));

  const components: Record<string, TemplateItem[]> = {};
  for (const key of IAC_COMPONENT_ORDER) components[key] = [];

  components.Functions = functions.map(functionItem);
  if (input.bucket) components.Stratus = [bucketItem(input.bucket)];
  // A table group is table → columns → tableScope per role → tablePermission
  // per role, like a Catalyst export lays it out.
  const expanded: TemplateItem[] = [];
  for (const [table, tableItem, columns] of tableGroups(plan)) {
    expanded.push(tableItem, ...columns);
    const tableGrants = importTableGrants(table, roles, grants);
    for (const grant of tableGrants) {
      expanded.push({
        type: 'tableScope',
        name: `${table}-${grant.role}`,
        properties: { role_name: grant.role, table_scope: grant.scope, type: roleType(grant.role), table_name: table },
        dependsOn: [`Datastore.table.${table}`],
      });
    }
    for (const grant of tableGrants) {
      expanded.push({
        type: 'tablePermission',
        name: `${table}-${grant.role}`,
        properties: { role_name: grant.role, type: roleType(grant.role), table_permissions: grant.permissions, table_name: table },
        dependsOn: [`Datastore.table.${table}`],
      });
    }
  }
  components.Datastore = expanded;
  if (roles.length) components.Authentication = authItems(roles);
  components.SecurityRules = securityRuleItems(functions);
  components.Cache = [{ type: 'segment', name: 'Default', properties: { segment_name: 'Default' }, dependsOn: [] }];
  return { name: 'project-template', version: '1.0.0', parameters: {}, components };
}

export function importTemplateJson(input: ImportTemplateInput): string {
  return `${JSON.stringify(importTemplate(input), null, 2)}\n`;
}

function columnItem(column: ColumnCreate): TemplateItem {
  // columnBody is the REST create body; for IaC the parent reference is the table name.
  const body = columnBody(column, column.parent_table);
  const properties: Record<string, unknown> = {
    column_name: body.column_name,
    data_type: body.data_type,
  };
  if (body.max_length !== undefined) properties.max_length = Number(body.max_length);
  if (body.decimal_digits !== undefined) properties.decimal_digits = Number(body.decimal_digits);
  if (body.default_value !== undefined) properties.default_value = body.default_value;
  // An appUnique column (over the unique varchar budget) is is_unique false here;
  // the handler enforces it. The template has no Catalyst key for that, so none is added.
  properties.is_unique = body.is_unique;
  properties.is_mandatory = body.is_mandatory;
  properties.search_index_enabled = body.search_index_enabled;
  properties.audit_consent = body.audit_consent;
  const dependsOn = new Set([`Datastore.table.${column.table}`]);
  if (column.data_type === 'foreign key') {
    properties.parent_table = body.parent_table;
    properties.parent_column = 'ROWID';
    properties.constraint_type = body.constraint_type;
    dependsOn.add(`Datastore.table.${column.parent_table}`);
    // Zoho's demo-polls template lists this dependency on every FK column.
    dependsOn.add('Datastore.column.ROWID');
  }
  properties.table_id = column.table;
  properties.table_name = column.table;
  return { type: 'column', name: `${column.table}-${column.column_name}`, properties, dependsOn: [...dependsOn].sort(cmp) };
}

function functionItem(fn: TemplateFunction): TemplateItem {
  const variables: Record<string, string> = {};
  for (const name of [...new Set(fn.env)].sort(cmp)) variables[name] = '';
  return {
    type: 'function',
    name: fn.name,
    properties: {
      name: fn.name,
      type: fn.type,
      stack: fn.stack,
      code: { path: `functions/${fn.name}.zip` },
      configuration: { memory: fn.memory, environment: { variables } },
    },
    dependsOn: [],
  };
}

// ---------------------------------------------------------------------------
// Drift: normalise a template and an `iac:export` template, then diff them.
// ---------------------------------------------------------------------------

/** Server-set or secret fields that never take part in a diff. */
const VOLATILE_KEYS = new Set(['id', 'created_time', 'modified_time', 'last_updated_time', 'produce_url']);
/** Catalyst creates these in every project; they are drift only when the template declares them. */
const DEFAULT_ROLES = new Set(['App Administrator', 'App User']);

/**
 * Components the drift check watches even when the expected template declares
 * none of their items. c2c never emits EventListeners (deprecated — the
 * event-bus API already 404s on new projects and Signals is the replacement),
 * so any item an export carries there is a listener or rule c2c did not create:
 * reported as extra, never silently ignored.
 */
const WATCHED_COMPONENTS = new Set(['EventListeners']);

export interface NormalizedItem {
  key: string;
  properties: Record<string, unknown>;
  dependsOn: string[];
}

export interface DriftChange {
  key: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface DriftReport {
  /** 0 = exact, 1 = missing or changed, 2 = extra only. */
  exitCode: 0 | 1 | 2;
  missing: string[];
  changed: DriftChange[];
  extra: string[];
}

/**
 * Items keyed `<Component>.<type>.<name>`, with volatile fields removed and env var
 * values blanked. Accepts the `components` envelope and the top-level component
 * arrays some exports carry.
 */
export function normalizeTemplate(doc: unknown): Map<string, NormalizedItem> {
  const root = record(doc);
  if (!root) throw new Error('project template is not a JSON object');
  const components = record(root.components) ?? root;
  const out = new Map<string, NormalizedItem>();
  for (const component of Object.keys(components).sort(cmp)) {
    const items = components[component];
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      const item = record(raw);
      if (!item || typeof item.type !== 'string' || typeof item.name !== 'string') continue;
      const key = `${component}.${item.type}.${item.name}`;
      const properties = scrub(record(item.properties) ?? {}) as Record<string, unknown>;
      redactEnv(properties);
      const dependsOn = Array.isArray(item.dependsOn) ? item.dependsOn.filter((d): d is string => typeof d === 'string').sort(cmp) : [];
      out.set(key, { key, properties, dependsOn });
    }
  }
  return out;
}

/**
 * Diff a generated template (expected) against an export (actual). Only the
 * properties the template declares are compared, because an export also carries
 * Catalyst-filled defaults (an int column's max_length, for example). Export
 * components the template does not use at all, and Catalyst's default role
 * scopes and permissions and the Default cache segment, are not extra — except
 * WATCHED_COMPONENTS, which c2c never emits yet still reports on.
 */
export function diffTemplate(expectedDoc: unknown, actualDoc: unknown): DriftReport {
  const expected = normalizeTemplate(expectedDoc);
  const actual = normalizeTemplate(actualDoc);
  const declared = new Set([...expected.keys()].map((key) => key.split('.')[0]));
  for (const component of WATCHED_COMPONENTS) declared.add(component);
  const missing: string[] = [];
  const changed: DriftChange[] = [];
  for (const [key, want] of expected) {
    const got = actual.get(key);
    if (!got) {
      missing.push(key);
      continue;
    }
    for (const field of Object.keys(want.properties).sort(cmp)) {
      const a = want.properties[field];
      const b = got.properties[field];
      if (!same(a, b)) changed.push({ key, field, expected: a, actual: b === undefined ? null : b });
    }
    if (!same(want.dependsOn, got.dependsOn)) changed.push({ key, field: 'dependsOn', expected: want.dependsOn, actual: got.dependsOn });
  }
  const extra = [...actual.keys()].filter((key) => !expected.has(key) && declared.has(key.split('.')[0]) && !isDefault(actual.get(key)!)).sort(cmp);
  const exitCode = missing.length || changed.length ? 1 : extra.length ? 2 : 0;
  return { exitCode, missing: missing.sort(cmp), changed, extra };
}

export function formatDrift(report: DriftReport): string {
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`) : ['- none']);
  return [
    `drift: ${report.exitCode === 0 ? 'none' : report.exitCode === 1 ? 'missing or changed' : 'extra only'}`,
    'missing:',
    ...list(report.missing),
    'changed:',
    ...list(report.changed.map((c) => `${c.key} ${c.field}: expected ${JSON.stringify(c.expected)} actual ${JSON.stringify(c.actual)}`)),
    'extra:',
    ...list(report.extra),
    '',
  ].join('\n');
}

function isDefault(item: NormalizedItem): boolean {
  if (item.key === 'Cache.segment.Default') return true;
  const [component, type] = item.key.split('.');
  return component === 'Datastore' && (type === 'tableScope' || type === 'tablePermission') && DEFAULT_ROLES.has(String(item.properties.role_name));
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  const obj = record(value);
  if (!obj) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort(cmp)) if (!VOLATILE_KEYS.has(key)) out[key] = scrub(obj[key]);
  return out;
}

function redactEnv(properties: Record<string, unknown>): void {
  const variables = record(record(record(properties.configuration)?.environment)?.variables);
  if (!variables) return;
  for (const name of Object.keys(variables)) variables[name] = '';
}

/** Scalars compare by text (an export may write 255 or "255"); arrays of scalars as sets. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const scalar = (v: unknown) => v === null || typeof v !== 'object';
    if (a.every(scalar) && b.every(scalar)) {
      const left = a.map(String).sort(cmp);
      const right = b.map(String).sort(cmp);
      return left.every((v, i) => v === right[i]);
    }
    return a.every((v, i) => same(v, b[i]));
  }
  const ra = record(a);
  const rb = record(b);
  if (ra || rb) {
    if (!ra || !rb) return false;
    const keys = Object.keys(ra);
    return keys.length === Object.keys(rb).length && keys.every((key) => same(ra[key], rb[key]));
  }
  if (a === undefined || b === undefined || a === null || b === null) return a === b;
  return String(a) === String(b);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
