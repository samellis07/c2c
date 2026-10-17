/**
 * Unverified Catalyst limits.
 * Every value is unverified.
 * Callers read this table. They do not copy the numbers.
 */
import { LIMITS as MEASURED } from '../../shims/src/runtime.js';
import type { SchemaColumn, SchemaPlan, SchemaTable } from './generator.js';

export type LimitAction = 'split' | 'stage' | 'blocker' | 'report';

export interface CatalystLimit {
  id: string;
  /** Null when no number is stated. */
  value: number | null;
  unit: string;
  verified: false;
  /** What generation does when a form or query exceeds this limit. */
  action: LimitAction;
  whenExceeded: string;
}

/**
 * Recovery on a table-create refusal from the datastore.tables_per_org row.
 * Deploy errors, the org-tables budget and docs read this; they do not
 * rephrase it.
 */
export const ORG_TABLE_LIMIT_RECOVERY =
  'stop creates, keep created tables, and retry after 30/60/120 minutes; a project delete may not free capacity at once';

/**
 * Longest Data Store table name a create has kept.
 * No published table-name maximum is recorded, so this is not a cap to truncate to.
 */
export const LONGEST_KEPT_TABLE_NAME = 'Rate_Your_Vendors__Product_Service';

export const TABLE_NAME_LENGTH_UNVERIFIED = 'table-name-length-unverified';

export const CATALYST_LIMITS: readonly CatalystLimit[] = [
  {
    id: 'datastore.columns_per_table',
    value: 250,
    unit: 'columns',
    verified: false,
    action: 'split',
    whenExceeded:
      'Split the Creator form into a base table plus 1:1 extension tables keyed by parent_rowid (the parent ROWID). Field groups stay together, in source order. A group that cannot fit on an empty extension is a precheck blocker, not a partial table.',
  },
  {
    id: 'datastore.columns_per_table_default',
    value: 100,
    unit: 'columns',
    verified: false,
    action: 'report',
    whenExceeded:
      'Reported only. Splitting at the default 100 would multiply tables against the org table cap. Generation uses the raised cap of 250.',
  },
  {
    id: 'datastore.columns_per_table_ceiling',
    value: 325,
    unit: 'columns',
    verified: false,
    action: 'report',
    whenExceeded: 'Reported only. 325 is a further stated ceiling, not the cap generation splits on.',
  },
  {
    id: 'datastore.text_columns',
    value: 130,
    unit: 'columns',
    verified: false,
    action: 'report',
    whenExceeded:
      'Reported only. Generation splits on the total column cap. A table that is still over 130 text columns is named in the migration report, not silently repacked.',
  },
  {
    id: 'datastore.varchar_chars',
    value: 250,
    unit: 'characters',
    verified: false,
    action: 'report',
    whenExceeded:
      'Reported only. The measured varchar cap used by the mapper is 255. The stated value 250 is unverified, so generation does not change that promotion.',
  },
  {
    id: 'datastore.text_chars',
    value: 10000,
    unit: 'characters',
    verified: false,
    action: 'report',
    whenExceeded: 'Reported only. A generated length check already rejects longer text. No new runtime change.',
  },
  {
    id: 'datastore.unique_text_columns',
    value: 2,
    unit: 'columns',
    verified: false,
    action: 'report',
    whenExceeded:
      'Reported only. Dropping UNIQUE would change Creator semantics. The migration report names the table. It does not silently clear the flag.',
  },
  {
    id: 'datastore.fk_columns',
    value: 15,
    unit: 'columns',
    verified: false,
    action: 'report',
    whenExceeded:
      'Generation keeps 15 foreign keys per table (ON-DELETE-CASCADE ones first, then column order) and stores the rest as plain bigint ROWID ids with no store check or ON DELETE. The loader still remaps them. The migration report names every such lookup; none is dropped.',
  },
  {
    id: 'datastore.tables_per_org',
    value: null,
    unit: 'tables',
    verified: false,
    action: 'report',
    whenExceeded:
      `Reported only. The org-wide table-create limit has no published number or window: API_LIMIT_REACHED on a table create is the signal, not a count. On that refusal, ${ORG_TABLE_LIMIT_RECOVERY}. Generation does not block on it.`,
  },
  {
    id: 'zcql.joins',
    value: 4,
    unit: 'joins',
    verified: false,
    action: 'stage',
    whenExceeded:
      'Stage each keyable join (lookup ROWID or extension parent_rowid) as its own query. A join with no key that would push one statement over 4 joins fails generation. Predicates are not dropped.',
  },
  {
    id: 'zcql.select_columns',
    value: 30,
    unit: 'columns',
    verified: false,
    action: 'stage',
    whenExceeded:
      'Stage the select list. Each statement selects at most 30 columns, in the original order, and repeats the stitch key (ROWID or parent_rowid). No column is omitted.',
  },
  {
    id: 'datastore.write_requests_per_minute',
    value: 100,
    unit: 'requests/minute',
    verified: false,
    action: 'report',
    whenExceeded:
      'Reported only. The plan warns with the mover write-call estimate: one insert call per batch of 200 source rows per Data Store table, before fill-back updates, file uploads and retries. The mover does not pace writes; probe P-RATE measures the real rate.',
  },
  {
    id: 'datastore.rows_per_table_dev',
    value: null,
    unit: 'rows',
    verified: false,
    action: 'report',
    whenExceeded:
      'Reported only. Development enforces a per-table row cap whose value is not published: a load refused with 403 API_LIMIT_REACHED "API Limit for row" is the signal, not a number. The plan warns with the largest measured per-table row counts from --source-* data. A large load is rehearsed on a different environment; generation does not block on it.',
  },
  {
    id: 'datastore.concurrency_dev',
    value: 15,
    unit: 'concurrent requests',
    verified: false,
    action: 'report',
    whenExceeded: 'Reported only. The runtime pool is not changed.',
  },
  {
    id: 'function.concurrency_dev',
    value: 10,
    unit: 'concurrent executions',
    verified: false,
    action: 'report',
    whenExceeded:
      'Reported only. Stated figures disagree (10, 15, 30). The table keeps the lowest stated Dev figure. No runtime change.',
  },
  {
    id: 'url.throttle',
    value: null,
    unit: 'requests',
    verified: false,
    action: 'report',
    whenExceeded: 'Reported only. The throttle exists; the number and the reset window are not stated.',
  },
  {
    id: 'function.timeout_seconds',
    value: 30,
    unit: 'seconds',
    verified: false,
    action: 'report',
    whenExceeded: 'Reported only. Job routing is not changed.',
  },
  {
    id: 'job.timeout_minutes',
    value: 15,
    unit: 'minutes',
    verified: false,
    action: 'report',
    whenExceeded: 'Reported only. No runtime change.',
  },
  {
    id: 'api.calls_dev',
    value: 200000,
    unit: 'API calls',
    verified: false,
    action: 'report',
    whenExceeded:
      'Reported only. The plan warns with the mover call estimate: per batch of 200 source rows per Data Store table one reconcile read, one insert and one write-recount read, plus verification, remap and count reads per 300 ids, fixed per-table verification passes and deferred-lookup updates, before retries, file uploads and runtime calls. No generation change.',
  },
  {
    id: 'bulk.rows_per_call',
    value: null,
    unit: 'rows',
    verified: false,
    action: 'report',
    whenExceeded: 'Reported only. The stated text is garbled (about 100,000). The generated batch is not compared with a guessed number.',
  },
  {
    id: TABLE_NAME_LENGTH_UNVERIFIED,
    value: null,
    unit: 'characters',
    verified: false,
    action: 'blocker',
    whenExceeded: `No published Data Store table-name maximum is recorded. A name longer than ${LONGEST_KEPT_TABLE_NAME} (${LONGEST_KEPT_TABLE_NAME.length} characters, the longest table name a create has kept) is a ${TABLE_NAME_LENGTH_UNVERIFIED} blocker. Generation still emits the table. It does not truncate or hash the name.`,
  },
];

const BY_ID = new Map(CATALYST_LIMITS.map((row) => [row.id, row]));

export function catalystLimit(id: string): CatalystLimit {
  const row = BY_ID.get(id);
  if (!row) throw new Error(`unknown Catalyst limit ${id}`);
  return row;
}

export function limitValue(id: string): number {
  const row = catalystLimit(id);
  if (row.value === null) throw new Error(`Catalyst limit ${id} has no numeric value`);
  return row.value;
}

/** Blocker when a table name is longer than the longest name a create has kept. Absent at or under that length. */
export function tableNameLengthBlocker(form: string, table: string): LimitBlocker | undefined {
  const kept = LONGEST_KEPT_TABLE_NAME.length;
  if (table.length <= kept) return undefined;
  const limit = catalystLimit(TABLE_NAME_LENGTH_UNVERIFIED);
  return {
    form,
    table,
    field: null,
    limitId: limit.id,
    message: `${table} is ${table.length} characters. No published Data Store table-name maximum is recorded (${limit.id}, verified: false). The longest table name a create has kept is ${LONGEST_KEPT_TABLE_NAME} (${kept} characters). This name is longer.`,
    fix: `Shorten the form, subform, or field link name so the table name is at most ${kept} characters, or confirm that a longer name creates.`,
  };
}

/** 1:1 extension key. Holds the parent row's ROWID. */
export const EXTENSION_KEY = 'parent_rowid';

/** Column group for identity columns that stay on the base table. */
export const ANCHOR_GROUP = '__anchor';

export class ZcqlLimitError extends Error {
  readonly code = 'ZCQL_LIMIT';
  readonly limitId: string;
  readonly verified = false as const;
  constructor(limitId: string, message: string) {
    super(message);
    this.name = 'ZcqlLimitError';
    this.limitId = limitId;
  }
}

export interface ZcqlSelect {
  table: string;
  column: string;
}

export interface ZcqlJoin {
  table: string;
  on: string;
  /** Set when the other table can be read by this column without a JOIN. */
  stageKey?: string;
  /**
   * Column of `from` whose values are the stage key.
   * Extension rows use the base ROWID. A lookup uses the foreign-key column,
   * not the base ROWID.
   */
  bindColumn?: string;
}

export interface ZcqlPlanInput {
  from: string;
  columns: readonly ZcqlSelect[];
  joins?: readonly ZcqlJoin[];
  where?: string;
  orderBy?: string;
}

export interface ZcqlPlan {
  queries: string[];
  staged: boolean;
  exceeded: { select: boolean; joins: boolean };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string, limitId: string): string {
  if (!IDENT.test(name)) throw new ZcqlLimitError(limitId, `ZCQL identifier rejected: ${name}`);
  return name;
}

function selectSql(table: string, columns: readonly string[], where: string, orderBy: string): string {
  const cols = columns.map((column) => ident(column, 'zcql.select_columns')).join(', ');
  let sql = `SELECT ${cols} FROM ${ident(table, 'zcql.select_columns')}`;
  const filter = where.trim();
  if (filter && filter.toLowerCase() !== 'true') {
    if (filter.includes(';')) throw new ZcqlLimitError('zcql.select_columns', 'ZCQL WHERE must not contain a semicolon');
    sql += ` WHERE ${filter}`;
  }
  const order = orderBy.trim();
  if (order) {
    if (order.includes(';')) throw new ZcqlLimitError('zcql.select_columns', 'ZCQL ORDER BY must not contain a semicolon');
    sql += ` ${order}`;
  }
  return sql;
}

export function selectListOf(sql: string): string[] {
  const match = /^SELECT (.+) FROM /.exec(sql);
  if (!match) return [];
  return match[1]!.split(', ').filter((part) => part.length > 0);
}

function chunkColumns(columns: readonly string[], key: string | null, limit: number): string[][] {
  const payload = columns.filter((column) => column !== key);
  const keyExtra = key && !columns.includes(key) ? 1 : 0;
  if (payload.length + keyExtra <= limit && columns.length + keyExtra <= limit && columns.length + keyExtra > 0 && new Set(columns).size === columns.length) {
    // One statement fits, including the stitch key when the caller asked for one.
    return [keyExtra ? [key!, ...columns] : columns.slice()];
  }
  const width = key ? limit - 1 : limit;
  if (width < 1) {
    throw new ZcqlLimitError('zcql.select_columns', `ZCQL select limit ${limit} (zcql.select_columns, verified: false) leaves no room for a column beside the stitch key`);
  }
  const chunks: string[][] = [];
  const body = payload;
  if (body.length === 0) return [key ? [key] : []];
  for (let i = 0; i < body.length; i += width) {
    const part = body.slice(i, i + width);
    chunks.push(key ? [key, ...part] : part);
  }
  return chunks;
}

/**
 * One ZCQL statement per stage. Under both limits and on one table, a single
 * select is returned and `staged` is false. Over either limit, keyable joins
 * and wide selects become more statements. An unkeyable join that does not fit
 * throws. Columns are not dropped.
 */
export function planZcql(input: ZcqlPlanInput): ZcqlPlan {
  const selectLimit = limitValue('zcql.select_columns');
  const joinLimit = limitValue('zcql.joins');
  const joins = input.joins ?? [];
  const selectExceeded = input.columns.length > selectLimit;
  const joinExceeded = joins.length > joinLimit;
  // First-seen column order. An array, not a Set, so the walk stays source-ordered.
  const otherTables: string[] = [];
  for (const column of input.columns) {
    if (column.table !== input.from && !otherTables.includes(column.table)) otherTables.push(column.table);
  }
  const multiTable = otherTables.length > 0;
  if (!selectExceeded && !joinExceeded && !multiTable) {
    const names = input.columns.map((column) => column.column);
    const queries = [selectSql(input.from, names.length ? names : ['ROWID'], input.where ?? '', input.orderBy ?? '')];
    return { queries, staged: false, exceeded: { select: false, joins: false } };
  }

  const atomic = joins.filter((join) => !join.stageKey);
  if (atomic.length > joinLimit || (atomic.length > 0 && (joinExceeded || selectExceeded || multiTable))) {
    throw new ZcqlLimitError(
      'zcql.joins',
      `ZCQL join limit ${joinLimit} (zcql.joins, verified: false) exceeded: ${atomic.length} join(s) have no stage key and a predicate would have to be dropped to keep one statement. No columns or predicates were dropped.`,
    );
  }

  const stageKey = new Map<string, string>();
  const stageBind = new Map<string, string>();
  for (const join of joins) {
    if (join.stageKey) stageKey.set(join.table, join.stageKey);
    if (join.bindColumn) stageBind.set(join.table, join.bindColumn);
  }
  for (const table of otherTables) {
    if (!stageKey.has(table)) stageKey.set(table, EXTENSION_KEY);
  }

  const byTable = new Map<string, string[]>();
  for (const column of input.columns) {
    const list = byTable.get(column.table) ?? [];
    list.push(column.column);
    byTable.set(column.table, list);
  }

  const queries: string[] = [];
  const baseColumns = byTable.get(input.from) ?? [];
  // Follow-up statements bind (:from_ROWID), so a staged base keeps ROWID even when the payload already fills the cap.
  const stitch = otherTables.length > 0 || baseColumns.length > selectLimit;
  const chunks = chunkColumns(baseColumns.length ? baseColumns : ['ROWID'], stitch ? 'ROWID' : null, selectLimit);
  chunks.forEach((columns, index) => {
    // Chunk 0 keeps the caller's predicate. Later chunks of the same statement
    // must page the same ROWIDs, or a 300-row ZCQL page returns a different set.
    const where = index === 0 ? input.where ?? '' : `ROWID IN (:${input.from}_ROWID)`;
    const order = index === 0 ? input.orderBy ?? '' : 'ORDER BY ROWID';
    queries.push(selectSql(input.from, columns, where, order));
  });

  for (const table of otherTables) {
    const key = stageKey.get(table) ?? EXTENSION_KEY;
    const columns = byTable.get(table) ?? [];
    const parts = chunkColumns(columns, key, selectLimit);
    const bindColumn = stageBind.get(table) ?? 'ROWID';
    parts.forEach((part, index) => {
      const listed = part.includes(key) ? part : [key, ...part];
      if (listed.length > selectLimit) {
        throw new ZcqlLimitError('zcql.select_columns', `staged select for ${table} still has ${listed.length} columns`);
      }
      // selectSql adds WHERE itself. Pass the predicate without the keyword.
      // Every chunk of this table is bound, including chunks after the first.
      const predicate = `${key} IN (:${input.from}_${bindColumn})`;
      const order = index === 0 ? '' : `ORDER BY ${key}`;
      queries.push(selectSql(table, listed, predicate, order));
    });
  }

  for (const sql of queries) {
    const count = selectListOf(sql).length;
    if (count > selectLimit) {
      throw new ZcqlLimitError('zcql.select_columns', `staged select has ${count} columns; the unverified cap is ${selectLimit}`);
    }
    if (sql.includes(' JOIN ')) {
      throw new ZcqlLimitError('zcql.joins', 'a staged query must not contain a JOIN');
    }
  }
  return { queries, staged: true, exceeded: { select: selectExceeded, joins: joinExceeded } };
}

export interface SchemaSplit {
  form: string;
  base: string;
  extensions: { name: string; columns: string[] }[];
  limitId: 'datastore.columns_per_table';
  value: number;
  verified: false;
}

export interface LimitBlocker {
  form: string;
  table: string;
  field: string | null;
  limitId: string;
  message: string;
  fix: string;
}

interface ColumnGroup {
  id: string;
  columns: SchemaColumn[];
}

function parentKeyColumn(baseName: string): SchemaColumn {
  const cap = catalystLimit('datastore.columns_per_table');
  return {
    name: EXTENSION_KEY,
    creatorType: 'system',
    matrixId: 'c2c-extension-key',
    status: 'partial',
    dataType: 'Foreign Key',
    mandatory: true,
    unique: true,
    relation: { table: baseName, column: 'ROWID', onDelete: 'ON-DELETE-CASCADE' },
    note: `1:1 parent ROWID. Column cap ${cap.value} is ${cap.id}, verified: false.`,
  };
}

/**
 * Split one physical table that is over the column cap.
 * `cap` is the numeric cap (tests pass a small one; generation passes the table value).
 * Returns the original table unchanged when it is within the cap.
 */
export function splitTable(
  table: SchemaTable,
  cap: number,
  groupOf: (column: SchemaColumn) => string,
  alloc: (base: string) => string,
): { tables: SchemaTable[]; split?: SchemaSplit; blocker?: LimitBlocker } {
  if (table.nosql || table.columns.length <= cap) return { tables: [table] };

  const leading: SchemaColumn[] = [];
  const trailing: SchemaColumn[] = [];
  const groups: ColumnGroup[] = [];
  let seenPayload = false;
  for (const column of table.columns) {
    const id = groupOf(column);
    if (id === ANCHOR_GROUP) {
      if (seenPayload) trailing.push(column);
      else leading.push(column);
      continue;
    }
    seenPayload = true;
    const last = groups[groups.length - 1];
    if (last && last.id === id) last.columns.push(column);
    else groups.push({ id, columns: [column] });
  }

  const anchors = leading.length + trailing.length;
  const limit = catalystLimit('datastore.columns_per_table');
  const blocker = (field: string | null, message: string): LimitBlocker => ({
    form: table.form,
    table: table.name,
    field,
    limitId: limit.id,
    message,
    fix: 'Shorten the field group so it fits on one table, or confirm a higher column cap. The cap is unverified (verified: false).',
  });
  if (anchors > cap) {
    return {
      tables: [table],
      blocker: blocker(null, `${table.form} identity columns (${anchors}) exceed the Data Store column cap ${cap} (${limit.id}, verified: false). The form was not split.`),
    };
  }
  const baseBudget = cap - anchors;
  const extBudget = cap - 1;
  if (extBudget < 1) {
    return {
      tables: [table],
      blocker: blocker(null, `${table.form} cannot reserve ${EXTENSION_KEY} under the column cap ${cap} (${limit.id}, verified: false).`),
    };
  }
  for (const group of groups) {
    const room = Math.max(baseBudget, extBudget);
    if (group.columns.length > room) {
      return {
        tables: [table],
        blocker: blocker(
          group.id,
          `${table.form}.${group.id} is ${group.columns.length} columns. An extension holds ${extBudget} payload columns beside ${EXTENSION_KEY} (cap ${cap}, ${limit.id}, verified: false). Splitting the field would break it, so generation left the table unsplit.`,
        ),
      };
    }
  }

  const baseGroups: ColumnGroup[] = [];
  let baseUsed = 0;
  const extChunks: ColumnGroup[][] = [];
  let chunk: ColumnGroup[] = [];
  let chunkUsed = 0;
  const park = () => {
    if (chunk.length) extChunks.push(chunk);
    chunk = [];
    chunkUsed = 0;
  };
  for (const group of groups) {
    if (baseUsed < baseBudget && baseUsed + group.columns.length <= baseBudget && extChunks.length === 0 && chunk.length === 0) {
      baseGroups.push(group);
      baseUsed += group.columns.length;
      continue;
    }
    if (chunkUsed + group.columns.length <= extBudget) {
      chunk.push(group);
      chunkUsed += group.columns.length;
      continue;
    }
    park();
    chunk.push(group);
    chunkUsed = group.columns.length;
  }
  park();

  const baseColumns = [...leading, ...baseGroups.flatMap((group) => group.columns), ...trailing];
  table.columns = baseColumns;
  const extensions: SchemaTable[] = [];
  for (const groupsInChunk of extChunks) {
    const name = alloc(`${table.name}__ext`);
    const columns = [parentKeyColumn(table.name), ...groupsInChunk.flatMap((group) => group.columns)];
    extensions.push({
      name,
      form: table.form,
      role: 'extension',
      nosql: false,
      extensionOf: table.name,
      columns,
    });
  }
  const split: SchemaSplit = {
    form: table.form,
    base: table.name,
    extensions: extensions.map((ext) => ({ name: ext.name, columns: ext.columns.map((column) => column.name) })),
    limitId: 'datastore.columns_per_table',
    value: cap,
    verified: false,
  };
  return { tables: [table, ...extensions], split };
}

function isText(column: SchemaColumn): boolean {
  return column.dataType === 'VarChar' || column.dataType === 'Text';
}

/** Columns as they would exist without the extension key that the split added. */
export function logicalColumns(plan: SchemaPlan, table: SchemaTable): SchemaColumn[] {
  if (table.role === 'extension') return table.columns.filter((column) => column.name !== EXTENSION_KEY);
  const extras = (plan.splits ?? []).filter((split) => split.base === table.name);
  if (!extras.length) return table.columns;
  const out = table.columns.slice();
  for (const split of extras) {
    for (const ext of split.extensions) {
      const physical = plan.tables.find((item) => item.name === ext.name);
      if (!physical) continue;
      for (const column of physical.columns) {
        if (column.name === EXTENSION_KEY) continue;
        out.push(column);
      }
    }
  }
  return out;
}

export interface LimitHitCounts {
  /** Data Store form tables whose unsplit column count exceeds the cap. */
  formsOverColumnCap: number;
  formsOverTextColumns: number;
  formsOverUniqueText: number;
  formsOverFk: number;
  /** Reports whose select list exceeds 30, and reports whose joins exceed 4. */
  reportSelect: number;
  reportJoins: number;
  /** Report criteria and named filters. */
  criteriaSelect: number;
  criteriaJoins: number;
  splits: number;
  blockers: number;
  tables: number;
  forms: number;
  reports: number;
  criteria: number;
}

function dottedForms(field: string, formName: string): string | null {
  const dot = field.indexOf('.');
  if (dot <= 0) return null;
  const head = field.slice(0, dot);
  if (head === formName || head === 'input' || head === 'old' || head === 'row') return null;
  return head;
}

function columnNamesOf(table: SchemaTable): string[] {
  return table.columns.filter((column) => column.matrixId !== 'c2c-system-field' && column.matrixId !== 'c2c-source-id' && column.name !== EXTENSION_KEY).map((column) => column.name);
}

/** Select list and joins for one read of a form. Field order is the caller's order. */
export function planFormRead(plan: SchemaPlan, formName: string, fields: readonly string[]): ZcqlPlan {
  const base = plan.tables.find((table) => table.role === 'form' && table.form === formName && !table.nosql);
  if (!base) return { queries: [], staged: false, exceeded: { select: false, joins: false } };
  const owned = plan.tables.filter((table) => table.form === formName && !table.nosql && (table.role === 'form' || table.role === 'extension'));
  const location = new Map<string, string>();
  for (const table of owned) {
    for (const column of table.columns) {
      if (!location.has(column.name)) location.set(column.name, table.name);
    }
  }
  const columns: ZcqlSelect[] = [];
  const joins: ZcqlJoin[] = [];
  const seen = new Set<string>();
  const foreignKeys: string[] = [];
  const addJoin = (tableName: string, stageKey: string, on: string, bindColumn?: string) => {
    if (seen.has(tableName) || tableName === base.name) return;
    seen.add(tableName);
    joins.push({ table: tableName, on, stageKey, ...(bindColumn ? { bindColumn } : {}) });
  };
  for (const field of fields) {
    const other = dottedForms(field, formName);
    if (other) {
      const target = plan.tables.find((table) => table.role === 'form' && table.form === other);
      const tableName = target?.name ?? other;
      const column = field.slice(field.indexOf('.') + 1) || 'ROWID';
      // The target ROWID matches the base foreign key, not the base ROWID.
      addJoin(tableName, 'ROWID', `${base.name}.${other} = ${tableName}.ROWID`, other);
      columns.push({ table: tableName, column });
      foreignKeys.push(other);
      continue;
    }
    const tableName = location.get(field) ?? base.name;
    columns.push({ table: tableName, column: field });
    if (tableName !== base.name) addJoin(tableName, EXTENSION_KEY, `${tableName}.${EXTENSION_KEY} = ${base.name}.ROWID`);
  }
  for (const foreignKey of foreignKeys) {
    if (columns.some((column) => column.table === base.name && column.column === foreignKey)) continue;
    columns.push({ table: base.name, column: foreignKey });
  }
  return planZcql({ from: base.name, columns, joins, orderBy: 'ORDER BY ROWID' });
}

export function payloadFields(plan: SchemaPlan, formName: string): string[] {
  const base = plan.tables.find((table) => table.role === 'form' && table.form === formName && !table.nosql);
  if (!base) return [];
  return columnNamesOf({ ...base, columns: logicalColumns(plan, base) });
}

/** Full-row read. This is what SELECT * would have selected. */
export function planFullRowRead(plan: SchemaPlan, formName: string, dotted: readonly string[] = []): ZcqlPlan {
  const fields = [...payloadFields(plan, formName), ...dotted.map((form) => `${form}.ROWID`)];
  return planFormRead(plan, formName, fields);
}

/**
 * Staged full-row statements when one SELECT cannot cover the row: the form is
 * split, or its column list is past the unverified select cap. Under the cap an
 * unsplit table stays one query. A narrow parent is not staged because a child
 * table is wide. Null when the form is absent or the read is one statement.
 */
export function plainRecordStages(plan: SchemaPlan, form: string): string[] | null {
  const base = plan.tables.find((table) => table.role === 'form' && table.form === form && !table.nosql);
  if (!base) return null;
  const read = planFullRowRead(plan, form);
  return read.staged ? read.queries : null;
}

function flattenReportFields(columns: readonly { field: string; subcolumns?: readonly { field: string }[] }[]): string[] {
  const out: string[] = [];
  for (const column of columns) {
    if (column.subcolumns?.length) {
      for (const sub of column.subcolumns) out.push(sub.field);
    } else out.push(column.field);
  }
  return out;
}

export function planReportQuery(
  plan: SchemaPlan,
  formName: string | undefined,
  columns: readonly { field: string; subcolumns?: readonly { field: string }[] }[],
): ZcqlPlan {
  if (!formName) return { queries: [], staged: false, exceeded: { select: false, joins: false } };
  const listed = flattenReportFields(columns);
  const fields = listed.length ? listed : payloadFields(plan, formName);
  return planFormRead(plan, formName, fields);
}

export interface AppLimitHits {
  counts: LimitHitCounts;
  /** Forms whose unsplit width exceeds a counted cap. Names only, for tests. */
  wideForms: string[];
}

export function measureApp(plan: SchemaPlan, reports: readonly { form?: string; criteria?: string; columns: readonly { field: string; subcolumns?: readonly { field: string }[] }[]; filters?: readonly { criteria?: string }[] }[]): AppLimitHits {
  const counts: LimitHitCounts = {
    formsOverColumnCap: 0,
    formsOverTextColumns: 0,
    formsOverUniqueText: 0,
    formsOverFk: 0,
    reportSelect: 0,
    reportJoins: 0,
    criteriaSelect: 0,
    criteriaJoins: 0,
    splits: plan.splits?.length ?? 0,
    blockers: plan.limitBlockers?.length ?? 0,
    tables: plan.tables.length,
    forms: 0,
    reports: reports.length,
    criteria: 0,
  };
  const columnCap = limitValue('datastore.columns_per_table');
  const textCap = limitValue('datastore.text_columns');
  const uniqueCap = limitValue('datastore.unique_text_columns');
  const fkCap = limitValue('datastore.fk_columns');
  const wideForms: string[] = [];
  for (const table of plan.tables) {
    if (table.role !== 'form' || table.nosql) continue;
    counts.forms += 1;
    const columns = logicalColumns(plan, table);
    const text = columns.filter(isText).length;
    const unique = columns.filter((column) => column.unique && isText(column)).length;
    const fk = columns.filter((column) => column.dataType === 'Foreign Key' || column.plainLookup).length;
    if (columns.length > columnCap) {
      counts.formsOverColumnCap += 1;
      wideForms.push(table.form);
    }
    if (text > textCap) counts.formsOverTextColumns += 1;
    if (unique > uniqueCap) counts.formsOverUniqueText += 1;
    if (fk > fkCap) counts.formsOverFk += 1;
  }
  const countCriteria = (form: string | undefined, text: string | undefined) => {
    if (!form || !text?.trim()) return;
    counts.criteria += 1;
    const width = payloadFields(plan, form).length;
    if (width > limitValue('zcql.select_columns')) counts.criteriaSelect += 1;
    const heads = new Set<string>();
    for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*[A-Za-z_]/g)) {
      const head = match[1]!;
      if (head !== form && head !== 'input' && head !== 'old' && head !== 'row' && head !== 'zoho' && head !== 'thisapp') heads.add(head);
    }
    if (heads.size > limitValue('zcql.joins')) counts.criteriaJoins += 1;
  };
  for (const report of reports) {
    let read: ZcqlPlan;
    try {
      read = planReportQuery(plan, report.form, report.columns);
    } catch {
      // An unplannable read is one join hit, counted once below.
      read = { queries: [], staged: true, exceeded: { select: false, joins: true } };
    }
    if (read.exceeded.select) counts.reportSelect += 1;
    if (read.exceeded.joins) counts.reportJoins += 1;
    countCriteria(report.form, report.criteria);
    for (const filter of report.filters ?? []) countCriteria(report.form, filter.criteria);
  }
  return { counts, wideForms };
}

export function emptyHits(): LimitHitCounts {
  return {
    formsOverColumnCap: 0,
    formsOverTextColumns: 0,
    formsOverUniqueText: 0,
    formsOverFk: 0,
    reportSelect: 0,
    reportJoins: 0,
    criteriaSelect: 0,
    criteriaJoins: 0,
    splits: 0,
    blockers: 0,
    tables: 0,
    forms: 0,
    reports: 0,
    criteria: 0,
  };
}

export function addHits(total: LimitHitCounts, extra: LimitHitCounts): void {
  for (const key of Object.keys(total).sort() as (keyof LimitHitCounts)[]) {
    total[key] += extra[key];
  }
}

/**
 * Generated batch versus throttle limits. The batch is one bulk request of
 * measured rows, not one request per row. It does not exceed the per-minute
 * write cap, so the batch size is not changed.
 */
export function batchVersusThrottles(): { batchRows: number; exceeds: false; note: string } {
  const write = catalystLimit('datastore.write_requests_per_minute');
  const batchRows = MEASURED.insertRowsPerCall;
  const note = `Generated write batch is ${batchRows} rows in one bulk request (measured insertRowsPerCall). The unverified write cap is ${write.value} ${write.unit} (${write.id}, verified: false). One request does not exceed it. URL throttle (${catalystLimit('url.throttle').id}) has no stated number. No runtime change.`;
  return { batchRows, exceeds: false, note };
}

export function formatLimitReport(plan: SchemaPlan): string {
  const lines: string[] = ['## Catalyst limits', '', 'Unverified. Every row is verified: false. Generation reads this table; the numbers are not copied into callers.', ''];
  for (const row of CATALYST_LIMITS) {
    const value = row.value === null ? 'unstated' : String(row.value);
    lines.push(`- ${row.id}: ${value} ${row.unit} (${row.id}, verified: false). ${row.whenExceeded}`);
  }
  lines.push('', '## Column splits', '');
  if (!plan.splits?.length) lines.push('- none');
  else {
    for (const split of plan.splits) {
      const ext = split.extensions.map((item) => `${item.name} (${item.columns.join(', ')})`).join('; ');
      lines.push(`- ${split.form} base ${split.base} plus ${ext}. 1:1 on ${EXTENSION_KEY}. Cap ${split.value} (${split.limitId}, verified: false).`);
    }
  }
  lines.push('', '## Limit blockers', '');
  if (!plan.limitBlockers?.length) lines.push('- none');
  else {
    for (const blocker of plan.limitBlockers) lines.push(`- ${blocker.form}: ${blocker.message}`);
  }
  lines.push('', '## Throttles', '', batchVersusThrottles().note, '');
  return lines.join('\n');
}
