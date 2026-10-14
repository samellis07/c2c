/**
 * Data Store table/column create plan. Missing objects only: never drop or alter.
 * Decimal is not a column type. Varchar is capped at 255. Foreign keys use the
 * API on_delete enums. Every table is created with its non-FK columns first
 * (including c2c_source_id). FK columns are added only after every table exists,
 * so a self-lookup or a cycle does not need a topological table order.
 *
 * A cyclic must-have FK cannot be inserted while is_mandatory is true, and the
 * column API we can call is create-only (POST /table/<id>/column). Those columns
 * are created not mandatory. The gap text is `mandatory relaxed: <table>.<column>`.
 */
import { staticDefault } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import type { ConstraintDecision, SchemaColumn, SchemaPlan, SchemaTable } from '../../schema/src/generator.js';
import { ORG_TABLE_LIMIT_RECOVERY } from '../../schema/src/limits.js';
import { UNIQUE_VARCHAR_MAX_PER_TABLE, isReservedColumnName } from '../../schema/src/mapping.js';
import { restWithRetry, type RetryOptions } from './retry.js';

export interface RestCall {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** 'zgraphql' sends the call to the Slate origin instead of the admin origin. */
  origin?: 'zgraphql';
}

export interface RestResult {
  status: number;
  body: unknown;
  /** A Retry-After response header, in ms, when the server sent one. */
  retryAfterMs?: number;
}

export type RestFn = (call: RestCall) => Promise<RestResult>;

export interface ColumnCreate {
  table: string;
  column_name: string;
  data_type: string;
  max_length?: number;
  decimal_digits?: number;
  is_unique: boolean;
  is_mandatory: boolean;
  /** Parent table name. Resolved to a table id at apply time. */
  parent_table?: string;
  constraint_type?: 'ON-DELETE-CASCADE' | 'ON-DELETE-SET-NULL';
  /** Cyclic must-have FK created not mandatory because the column cannot be altered later. */
  mandatoryRelaxed?: boolean;
  /** Set on a Double shadow: the exact-decimal varchar it shadows. */
  shadowFor?: string;
  /**
   * Static Creator initial value. Sent only for varchar, int,
   * bigint and boolean: the column API takes
   * default_value there (qty int "5", active boolean "true", status varchar
   * "New"); text is unsupported per the feature matrix, and date/datetime/
   * double acceptance is unverified, so those rely on the submit-handler
   * fallback instead.
   */
  default_value?: string;
}

export interface TableCreateStep {
  table: string;
  form: string;
  nosql: boolean;
  columns: ColumnCreate[];
}

/**
 * The table step stopped part way. `diff` is what was created before the failure,
 * so the deploy report and post-deploy steps can still be written.
 */
export class TablePlanError extends Error {
  readonly diff: TableDiff;
  constructor(message: string, diff: TableDiff) {
    super(message);
    this.name = 'TablePlanError';
    this.diff = diff;
  }
}

/** Unique varchar columns of a step, as Data Store counts them for its per-table limit. */
export function uniqueVarcharColumns(step: TableCreateStep): string[] {
  return step.columns.filter((column) => column.is_unique && column.data_type === 'varchar').map((column) => column.column_name);
}

export interface TableDiff {
  createdTables: string[];
  createdColumns: string[];
  unchanged: string[];
  skippedNosql: string[];
  /**
   * Every table the live listing reported (plus any this run created), name
   * sorted — the provision `tables` step publishes these so later <id:Table>
   * tokens resolve against the ids the run itself observed.
   */
  tables?: { table_name: string; table_id: string }[];
  /**
   * Shadow columns created on a table that already held rows. Those rows have a NULL
   * shadow until `c2c deploy --backfill-shadows`. `rows` is absent when the count failed.
   */
  shadowsOnExistingRows?: { table: string; column: string; shadow: string; rows?: number }[];
}

export function mandatoryRelaxedLine(table: string, column: string): string {
  return `mandatory relaxed: ${table}.${column}`;
}

export function mandatoryRelaxedColumns(steps: readonly TableCreateStep[]): { table: string; column: string }[] {
  const found: { table: string; column: string }[] = [];
  for (const step of steps) {
    for (const column of step.columns) {
      if (column.mandatoryRelaxed) found.push({ table: step.table, column: column.column_name });
    }
  }
  return found;
}

export function formatMandatoryRelaxed(items: readonly { table: string; column: string }[]): string[] {
  if (!items.length) return [];
  return ['coverage:', ...items.map((item) => `- ${mandatoryRelaxedLine(item.table, item.column)}`)];
}

export function foreignKeyId(key: { table: string; column: string }): string {
  return `${key.table}\0${key.column}`;
}

/**
 * A lookup column is written from a source record id; without a remap entry
 * the raw id would pass through to the store. Refuse the plan instead.
 */
export function assertLookupRemaps(
  lookupColumns: readonly { table: string; column: string }[],
  foreignKeys: readonly { table: string; column: string }[],
): void {
  const remapped = new Set(foreignKeys.map(foreignKeyId));
  for (const item of lookupColumns) {
    if (!remapped.has(foreignKeyId(item))) throw new Error(`lookup ${item.table}.${item.column} has no remap`);
  }
}

/**
 * Cyclic lookup edges that cannot move to the second pass. A store-mandatory
 * column must carry its value in the first insert — a second-pass row update is
 * too late. Only a column that is not a real foreign key sits in this position:
 * a mandatory foreign key inside a cycle is provisioned relaxed (nullable), so
 * its first pass is allowed to leave it empty. Self loops are never pinned —
 * they can only ever resolve once the row has a ROWID.
 */
export function nonDeferrableKeys(
  schema: { tables: readonly { name: string; columns: readonly { name: string; mandatory: boolean; relation?: unknown }[] }[] },
  keys: readonly { table: string; column: string; parent: string }[],
): Set<string> {
  const byTable = new Map(schema.tables.map((table) => [table.name, new Map(table.columns.map((column) => [column.name, column]))]));
  const out = new Set<string>();
  for (const key of keys) {
    if (key.table === key.parent) continue;
    const column = byTable.get(key.table)?.get(key.column);
    if (column?.mandatory === true && column.relation === undefined) out.add(foreignKeyId(key));
  }
  return out;
}

interface LiveColumnFlags {
  mandatory?: boolean;
  unique?: boolean;
}

function flagOf(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

/** column_name → live is_mandatory/is_unique from a table list or detail body. Absent flags stay unknown. */
function columnFlagsOf(body: unknown): Map<string, LiveColumnFlags> {
  const flags = new Map<string, LiveColumnFlags>();
  const root = asRecord(body) ?? {};
  const data = asRecord(root.data) ?? root;
  for (const list of [root.column_details, root.columns, data.column_details, data.columns]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const record = asRecord(item);
      if (!record) continue;
      const name = stringOf(record.column_name ?? record.name);
      if (!name) continue;
      flags.set(name, { mandatory: flagOf(record.is_mandatory), unique: flagOf(record.is_unique) });
    }
  }
  return flags;
}

/**
 * The constraint decisions the provisioned project already settled, read from
 * live column metadata. A schema-mandatory or schema-unique column the store
 * reports without the flag was demoted (source-measured) or relaxed (a cyclic
 * FK) when the tables were created — the load replays that decision instead of
 * re-measuring the current source, so a later export cannot relax what the
 * provisioned store still enforces, and rows that violate a kept store
 * constraint are refused before any write. An unverifiable table or flag
 * reports nothing: the Creator flag stands and the load fails closed.
 */
export async function provisionedConstraints(
  rest: RestFn,
  projectId: string,
  schema: Pick<SchemaPlan, 'tables'>,
  opts: RetryOptions = {},
): Promise<ConstraintDecision[]> {
  const prefix = `/baas/v1/project/${projectId}`;
  const ids = new Map<string, string>();
  const flags = new Map<string, Map<string, LiveColumnFlags>>();
  // These are reads: a transient 429/5xx retries as-is.
  const call: RestFn = async (c) => (await restWithRetry(rest, c, opts)).result;
  const listed = await call({ method: 'GET', path: `${prefix}/table` });
  if (listed.status < 400) {
    for (const item of arrayOf(listed.body)) {
      const record = asRecord(item);
      if (!record) continue;
      const name = stringOf(record.table_name ?? record.name);
      const id = stringOf(record.table_id ?? record.id);
      if (!name || !id) continue;
      ids.set(name, id);
      if (Object.prototype.hasOwnProperty.call(record, 'column_details') || Object.prototype.hasOwnProperty.call(record, 'columns')) {
        flags.set(name, columnFlagsOf(record));
      }
    }
  }
  const decisions: ConstraintDecision[] = [];
  for (const table of schema.tables) {
    if (table.nosql) continue;
    let columns = flags.get(table.name);
    if (!columns) {
      const id = ids.get(table.name);
      if (!id) continue;
      const detail = await call({ method: 'GET', path: `${prefix}/table/${id}` });
      if (detail.status >= 400) continue;
      columns = columnFlagsOf(detail.body);
    }
    for (const column of table.columns) {
      const live = columns.get(column.name);
      if (!live) continue;
      if (column.mandatory && live.mandatory === false) {
        decisions.push({ table: table.name, column: column.name, rule: 'mandatory', layer: 'app', violations: 0 });
      }
      if (column.unique && live.unique === false) {
        decisions.push({ table: table.name, column: column.name, rule: 'unique', layer: 'app', violations: 0 });
      }
    }
  }
  return decisions;
}

/**
 * Columns whose parent is the same table or the same strongly-connected
 * component — the edges a load writes by row update instead of in the insert.
 * `pin` names foreignKeyIds that must resolve in the first pass (a
 * store-mandatory column cannot wait for the update); a pin that cannot break
 * its cycle is refused rather than ordered by the fallback.
 */
export function cyclicForeignKeys(
  tables: readonly string[],
  keys: readonly { table: string; column: string; parent: string }[],
  pin?: ReadonlySet<string>,
): Set<string> {
  const deferred = new Set(cyclicForeignKeyComponents(tables, keys).keys());
  if (!pin?.size) return deferred;
  for (const id of pin) deferred.delete(id);
  const live = keys.filter((key) => !deferred.has(foreignKeyId(key)));
  const stuck = cyclicForeignKeyComponents(tables, live);
  if (stuck.size) {
    const names = [...stuck.keys()].map((id) => id.split('\0').join('.'));
    throw new Error(`cyclic store-mandatory lookup(s) cannot load: ${names.join(', ')} — one side of each cycle must be provisioned nullable`);
  }
  return deferred;
}

/**
 * Same deferral rule as cyclicForeignKeys, keyed by foreignKeyId, with the id of
 * the strongly-connected component (FK edges only) the key closes. A self-lookup
 * is its own component.
 */
export function cyclicForeignKeyComponents(
  tables: readonly string[],
  keys: readonly { table: string; column: string; parent: string }[],
): Map<string, number> {
  const nodes = new Set(tables);
  const edges = new Map<string, string[]>();
  for (const name of tables) edges.set(name, []);
  for (const key of keys) {
    if (!nodes.has(key.table) || !nodes.has(key.parent)) continue;
    edges.get(key.table)!.push(key.parent);
  }
  const component = stronglyConnected(tables, edges);
  const size = new Map<number, number>();
  for (const id of component.values()) size.set(id, (size.get(id) ?? 0) + 1);
  const deferred = new Map<string, number>();
  for (const key of keys) {
    if (!nodes.has(key.table) || !nodes.has(key.parent)) continue;
    const id = component.get(key.table);
    const same = id !== undefined && id === component.get(key.parent);
    if (key.table === key.parent || (same && (size.get(id!) ?? 0) > 1)) deferred.set(foreignKeyId(key), id!);
  }
  return deferred;
}

export function tableCreatePlan(plan: SchemaPlan): TableCreateStep[] {
  const steps = plan.tables.map(stepOf);
  const creatable = steps.filter((step) => !step.nosql);
  relaxCyclicMandatory(creatable);
  const ordered = orderByForeignKey(creatable);
  const base = ordered.map((step) => ({
    ...step,
    columns: step.columns.filter((column) => column.data_type !== 'foreign key'),
  }));
  const foreign = ordered
    .map((step) => ({
      ...step,
      columns: step.columns.filter((column) => column.data_type === 'foreign key'),
    }))
    .filter((step) => step.columns.length > 0);
  return [...base, ...foreign, ...steps.filter((step) => step.nosql)];
}

export function formatTableCreate(projectId: string, steps: readonly TableCreateStep[], confirm: boolean): string[] {
  const lines = [`table-create (Development only${confirm ? '' : '; not run'}):`, `- GET /baas/v1/project/${projectId}/table`];
  for (const step of steps) {
    if (step.nosql) {
      lines.push(`- skip nosql ${step.table} (POST /nosqltable is refused)`);
      continue;
    }
    const foreignOnly = step.columns.length > 0 && step.columns.every((column) => column.data_type === 'foreign key');
    if (!foreignOnly) lines.push(`- create table ${step.table} if missing`);
    for (const column of step.columns) {
      lines.push(`- create column ${step.table}.${columnLine(column)} if missing`);
      if (column.mandatoryRelaxed) lines.push(`- ${mandatoryRelaxedLine(step.table, column.column_name)}`);
    }
  }
  lines.push('- iac:import: not run');
  return lines;
}

export function formatTableDiff(diff: TableDiff): string {
  const list = (items: readonly string[]) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- none');
  return [
    'table-diff:',
    'created-tables:',
    list(diff.createdTables),
    'created-columns:',
    list(diff.createdColumns),
    'unchanged:',
    list(diff.unchanged),
    'skipped-nosql:',
    list(diff.skippedNosql),
    '',
  ].join('\n');
}

export function columnBody(column: ColumnCreate, parentId: string | undefined): Record<string, unknown> {
  if (column.data_type === 'decimal') throw new Error('decimal is not a Data Store column type');
  const body: Record<string, unknown> = {
    column_name: column.column_name,
    data_type: column.data_type,
    is_mandatory: column.is_mandatory,
    is_unique: column.is_unique,
    search_index_enabled: false,
    audit_consent: false,
  };
  if (column.default_value !== undefined) body.default_value = column.default_value;
  if (column.data_type === 'varchar') body.max_length = String(column.max_length ?? 255);
  if (column.data_type === 'double') {
    body.max_length = '15';
    body.decimal_digits = String(column.decimal_digits ?? 2);
  }
  if (column.data_type === 'foreign key') {
    if (!parentId || !column.constraint_type) throw new Error(`foreign key ${column.table}.${column.column_name} has no parent`);
    body.parent_table = parentId;
    body.constraint_type = column.constraint_type;
  }
  return body;
}

interface RemoteTable {
  id: string;
  columns: Set<string> | undefined;
}

export async function applyTablePlan(projectId: string, steps: readonly TableCreateStep[], rest: RestFn, opts: RetryOptions = {}): Promise<TableDiff> {
  const diff: TableDiff = { createdTables: [], createdColumns: [], unchanged: [], skippedNosql: [] };
  try {
    return await applySteps(projectId, steps, rest, diff, opts);
  } catch (err) {
    if (err instanceof TablePlanError) throw err;
    throw new TablePlanError(err instanceof Error ? err.message : String(err), diff);
  }
}

async function applySteps(projectId: string, steps: readonly TableCreateStep[], rest: RestFn, diff: TableDiff, opts: RetryOptions): Promise<TableDiff> {
  const prefix = `/baas/v1/project/${projectId}`;
  // Reads retry as-is on a transient 429/5xx. A write re-reads the affected
  // resource first — a failed POST may have landed, so the retry either sees
  // the effect is already there or re-sends only what is still missing.
  const call: RestFn = async (c) => (await restWithRetry(rest, c, opts)).result;
  // Never send a column batch Data Store will refuse: it rejects the whole batch and
  // leaves the table with no columns. The schema keeps the excess
  // as app-level unique, so this only trips on a hand-edited plan.
  for (const step of steps) {
    const unique = uniqueVarcharColumns(step);
    if (unique.length > UNIQUE_VARCHAR_MAX_PER_TABLE) {
      throw new Error(
        `refusing to create ${step.table}: ${unique.length} unique varchar columns (${unique.join(', ')}); Data Store allows ${UNIQUE_VARCHAR_MAX_PER_TABLE} per table`,
      );
    }
    // A reserved column name refuses the whole batch the same way. The schema
    // stores such a field under another column.
    const reserved = step.nosql ? [] : step.columns.filter((column) => isReservedColumnName(column.column_name)).map((column) => column.column_name);
    if (reserved.length) {
      throw new Error(`refusing to create ${step.table}: reserved column name(s) ${reserved.join(', ')}; Data Store refuses a column with a reserved name`);
    }
  }
  for (const step of steps) if (step.nosql) diff.skippedNosql.push(step.table);
  const live = await listTables(call, prefix);
  const ids = new Map<string, string>();
  for (const [name, remote] of live) ids.set(name, remote.id);

  for (const step of steps) {
    if (step.nosql) continue;
    let remote = live.get(step.table);
    if (!remote) {
      const created = await restWithRetry<RemoteTable>(
        rest,
        { method: 'POST', path: `${prefix}/table`, body: { table_name: step.table } },
        {
          ...opts,
          reRead: async () => {
            // The create may have landed despite the failure. Re-list, and if the
            // table is there now, use it — do not POST a duplicate. A failed
            // re-list proves nothing either way: abort with the create's own
            // failure. A list that lags the write is re-read after the next
            // backoff, never re-created on.
            try {
              const found = (await listTables(call, prefix)).get(step.table);
              return found ? { applied: found } : undefined;
            } catch {
              return { abort: true };
            }
          },
        },
      );
      if (created.applied) {
        remote = created.applied;
      } else {
        if (created.result.status >= 400) {
          const limit = isTableLimit(created.result.body)
            ? ` — the org-wide limit on table creates; this app needs ${steps.filter((item) => !item.nosql).length} table(s); ${diff.createdTables.length} created before the limit. On that refusal, ${ORG_TABLE_LIMIT_RECOVERY}`
            : '';
          throw new Error(`create table ${step.table} failed: ${created.result.status}${restDetail(created.result.body)}${limit}`);
        }
        remote = { id: tableIdOf(created.result.body), columns: new Set() };
      }
      live.set(step.table, remote);
      ids.set(step.table, remote.id);
      diff.createdTables.push(step.table);
    }
    if (!remote.columns) {
      const detail = await call({ method: 'GET', path: `${prefix}/table/${remote.id}` });
      if (detail.status >= 400) throw new Error(`read table ${step.table} failed: ${detail.status}`);
      remote.columns = columnNames(detail.body);
    }
    const missing = step.columns.filter((column) => !remote!.columns!.has(column.column_name));
    for (const column of step.columns) {
      if (remote.columns.has(column.column_name)) diff.unchanged.push(`${step.table}.${column.column_name}`);
    }
    if (!missing.length) continue;
    const columnBatch = (columns: readonly ColumnCreate[]) =>
      columns.map((column) => columnBody(column, column.parent_table ? ids.get(column.parent_table) : undefined));
    const post = { method: 'POST' as const, path: `${prefix}/table/${remote.id}/column`, body: columnBatch(missing) };
    const posted = await restWithRetry<true>(rest, post, {
      ...opts,
      reRead: async () => {
        // Re-read the table: whichever columns the failed batch did land are
        // dropped from the retry. All present → applied, some → a narrower
        // POST. A failed re-read proves nothing: abort rather than re-send
        // the whole batch blind.
        try {
          const detail = await call({ method: 'GET', path: `${prefix}/table/${remote!.id}` });
          if (detail.status >= 400) return { abort: true };
          const have = columnNames(detail.body);
          for (const name of have) remote!.columns!.add(name);
          const still = missing.filter((column) => !have.has(column.column_name));
          if (!still.length) return { applied: true as const };
          return { resend: { ...post, body: columnBatch(still) } };
        } catch {
          return { abort: true };
        }
      },
    });
    if (!posted.applied && posted.result.status >= 400) {
      throw new Error(`create columns on ${step.table} failed: ${posted.result.status}${restDetail(posted.result.body)}`);
    }
    for (const column of missing) {
      remote.columns.add(column.column_name);
      diff.createdColumns.push(`${step.table}.${column.column_name}`);
    }
    const shadows = missing.filter((column) => column.shadowFor);
    if (shadows.length && !diff.createdTables.includes(step.table)) {
      const rows = await countRows(call, prefix, step.table);
      if (rows !== 0) {
        diff.shadowsOnExistingRows ??= [];
        for (const column of shadows) {
          diff.shadowsOnExistingRows.push({ table: step.table, column: column.shadowFor!, shadow: column.column_name, ...(rows === undefined ? {} : { rows }) });
        }
      }
    }
  }
  diff.tables = [...live.entries()].map(([name, remote]) => ({ table_name: name, table_id: remote.id })).sort((a, b) => compareEnUs(a.table_name, b.table_name));
  return diff;
}

/** Row count of a table, or undefined when the query fails or the answer is not a count. */
async function countRows(rest: RestFn, prefix: string, table: string): Promise<number | undefined> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return undefined;
  try {
    const result = await rest({ method: 'POST', path: `${prefix}/query`, body: { query: `SELECT COUNT(ROWID) FROM ${table}` } });
    if (result.status >= 400) return undefined;
    return countOf(result.body);
  } catch {
    return undefined;
  }
}

function countOf(body: unknown): number | undefined {
  let found: number | undefined;
  const visit = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) visit(child, childKey);
      return;
    }
    if (key && /count/i.test(key) && (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) found = Number(value);
  };
  visit(body);
  return found;
}

/** Catalyst's error code and message, so a refusal can be diagnosed without a second call. */
/**
 * 403 API_LIMIT_REACHED "… API Limit for table": the org-wide limit on table
 * creates is used up. The deploy stops there; the recovery is the
 * datastore.tables_per_org rule (ORG_TABLE_LIMIT_RECOVERY), not an immediate
 * retry.
 */
export function isTableLimit(body: unknown): boolean {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  const err = data && typeof data === 'object' ? (data as { error_code?: unknown; message?: unknown }) : undefined;
  return err?.error_code === 'API_LIMIT_REACHED' && typeof err.message === 'string' && /api limit for table/i.test(err.message);
}

function restDetail(body: unknown): string {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  const err = data && typeof data === 'object' ? (data as { error_code?: unknown; message?: unknown }) : undefined;
  if (!err) return '';
  const code = typeof err.error_code === 'string' ? err.error_code : '';
  const message = typeof err.message === 'string' ? err.message.slice(0, 300) : '';
  return code || message ? ` ${[code, message].filter(Boolean).join(': ')}` : '';
}

function stepOf(table: SchemaTable): TableCreateStep {
  return {
    table: table.name,
    form: table.form,
    nosql: table.nosql,
    columns: table.columns.map((column) => columnOf(table.name, column)),
  };
}

function columnOf(table: string, column: SchemaColumn): ColumnCreate {
  const api = apiType(column);
  // The schema carries the raw .ds initial value (quoted: '"Draft"').
  // Catalyst takes the bare value, so only a static literal is sent, unquoted.
  // A dynamic value (zoho.loginuser, an expression) is never a column default:
  // the store would write its source text as the cell.
  const literal = staticDefault(column.defaultValue);
  const takesDefault =
    literal !== undefined &&
    (api.data_type === 'varchar' || api.data_type === 'int' || api.data_type === 'bigint' || api.data_type === 'boolean');
  return {
    table,
    column_name: column.name,
    data_type: api.data_type,
    ...(takesDefault ? { default_value: literal } : {}),
    ...(api.max_length !== undefined ? { max_length: api.max_length } : {}),
    ...(api.decimal_digits !== undefined ? { decimal_digits: api.decimal_digits } : {}),
    is_unique: column.unique,
    is_mandatory: column.mandatory,
    ...(api.parent_table ? { parent_table: api.parent_table } : {}),
    ...(api.constraint_type ? { constraint_type: api.constraint_type } : {}),
    ...(column.shadowFor ? { shadowFor: column.shadowFor } : {}),
  };
}

function apiType(column: SchemaColumn): {
  data_type: string;
  max_length?: number;
  decimal_digits?: number;
  parent_table?: string;
  constraint_type?: ColumnCreate['constraint_type'];
} {
  switch (column.dataType) {
    case 'VarChar': {
      const length = column.length ?? 255;
      if (length > 255) return { data_type: 'text' };
      return { data_type: 'varchar', max_length: Math.max(1, length) };
    }
    case 'Text':
      return { data_type: 'text' };
    case 'Int':
      return { data_type: 'int' };
    case 'BigInt':
      return { data_type: 'bigint' };
    case 'Double':
      return { data_type: 'double', decimal_digits: column.precision ?? 2 };
    case 'Boolean':
      return { data_type: 'boolean' };
    case 'Date':
      return { data_type: 'date' };
    case 'DateTime':
      return { data_type: 'datetime' };
    case 'Encrypted':
      return { data_type: 'encrypted text' };
    case 'Foreign Key':
      if (!column.relation) throw new Error(`foreign key ${column.name} has no parent`);
      return { data_type: 'foreign key', parent_table: column.relation.table, constraint_type: column.relation.onDelete };
    default:
      throw new Error(`no Data Store type for ${column.dataType}`);
  }
}

function columnLine(column: ColumnCreate): string {
  const bits = [`data_type=${column.data_type}`];
  if (column.data_type === 'varchar') bits.push(`max_length=${column.max_length ?? 255}`);
  if (column.data_type === 'double') bits.push(`decimal_digits=${column.decimal_digits ?? 2}`);
  if (column.is_unique) bits.push('unique');
  if (column.is_mandatory) bits.push('mandatory');
  if (column.parent_table) bits.push(`parent=${column.parent_table} on_delete=${column.constraint_type}`);
  return `${column.column_name} ${bits.join(' ')}`;
}

function orderByForeignKey(steps: readonly TableCreateStep[]): TableCreateStep[] {
  const byName = new Map(steps.map((step) => [step.table, step]));
  const deps = new Map<string, Set<string>>();
  for (const step of steps) {
    const parents = new Set<string>();
    for (const column of step.columns) {
      if (!column.parent_table || column.parent_table === step.table) continue;
      if (!byName.has(column.parent_table)) throw new Error(`parent table ${column.parent_table} is not a Data Store table`);
      parents.add(column.parent_table);
    }
    deps.set(step.table, parents);
  }
  const ready = [...deps.entries()].filter(([, parents]) => parents.size === 0).map(([name]) => name).sort();
  const ordered: TableCreateStep[] = [];
  const placed = new Set<string>();
  while (ready.length) {
    const name = ready.shift()!;
    if (placed.has(name)) continue;
    placed.add(name);
    ordered.push(byName.get(name)!);
    for (const [other, parents] of deps) {
      if (!parents.delete(name)) continue;
      if (parents.size === 0) {
        ready.push(other);
        ready.sort();
      }
    }
  }
  // A self-lookup or a mutual lookup cannot be ordered. Those tables are still
  // created here; their FK columns are a later step, after every table id exists.
  if (ordered.length !== steps.length) {
    const rest = steps.map((step) => step.table).filter((name) => !placed.has(name)).sort();
    for (const name of rest) ordered.push(byName.get(name)!);
  }
  return ordered;
}

async function listTables(rest: RestFn, prefix: string): Promise<Map<string, RemoteTable>> {
  const response = await rest({ method: 'GET', path: `${prefix}/table` });
  if (response.status >= 400) throw new Error(`list tables failed: ${response.status}`);
  const map = new Map<string, RemoteTable>();
  for (const item of arrayOf(response.body)) {
    const record = asRecord(item);
    if (!record) continue;
    const name = stringOf(record.table_name ?? record.name);
    const id = stringOf(record.table_id ?? record.id);
    if (!name || !id) continue;
    const known = Object.prototype.hasOwnProperty.call(record, 'column_details') || Object.prototype.hasOwnProperty.call(record, 'columns');
    map.set(name, { id, columns: known ? columnNames(record) : undefined });
  }
  return map;
}

function tableIdOf(body: unknown): string {
  const root = asRecord(body) ?? {};
  const data = asRecord(root.data) ?? root;
  const id = stringOf(data.table_id ?? data.id ?? asRecord(data.table)?.table_id);
  if (!id) throw new Error('create table response has no table_id');
  return id;
}

function columnNames(body: unknown): Set<string> {
  const names = new Set<string>();
  const root = asRecord(body) ?? {};
  const data = asRecord(root.data) ?? root;
  const lists = [root.column_details, root.columns, data.column_details, data.columns];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const record = asRecord(item);
      const name = record ? stringOf(record.column_name ?? record.name) : undefined;
      if (name) names.add(name);
    }
  }
  return names;
}

function arrayOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const root = asRecord(body);
  if (!root) return [];
  if (Array.isArray(root.data)) return root.data;
  if (Array.isArray(root.tables)) return root.tables;
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('id is a numeric id beyond MAX_SAFE_INTEGER');
    if (value < 0) return undefined;
    return String(value);
  }
  return undefined;
}

function relaxCyclicMandatory(steps: readonly TableCreateStep[]): void {
  const keys: { table: string; column: string; parent: string }[] = [];
  for (const step of steps) {
    for (const column of step.columns) {
      if (!column.parent_table) continue;
      keys.push({ table: step.table, column: column.column_name, parent: column.parent_table });
    }
  }
  const cyclic = cyclicForeignKeys(
    steps.map((step) => step.table),
    keys,
  );
  for (const step of steps) {
    for (const column of step.columns) {
      if (!column.is_mandatory || !column.parent_table) continue;
      if (!cyclic.has(foreignKeyId({ table: step.table, column: column.column_name }))) continue;
      column.is_mandatory = false;
      column.mandatoryRelaxed = true;
    }
  }
}

function stronglyConnected(nodes: readonly string[], edges: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const component = new Map<string, number>();
  let index = 0;
  let comp = 0;
  const visit = (node: string) => {
    indexOf.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!indexOf.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, indexOf.get(next)!));
      }
    }
    if (low.get(node) === indexOf.get(node)) {
      let member = '';
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.set(member, comp);
      } while (member !== node);
      comp += 1;
    }
  };
  for (const node of nodes) if (!indexOf.has(node)) visit(node);
  return component;
}
