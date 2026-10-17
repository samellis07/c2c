import { createHash } from 'node:crypto';
import { flowStatusColumn, formLink, formScheduleSweepGap, isApprovalWorkflow, isBlueprintWorkflow, isFormScheduleWorkflow, type App, type Field, type Form } from '../../core/src/ir.js';
import { toolchain } from '../../core/src/toolchain.js';
import { quantizeDecimal } from '../../shims/src/decimal.js';
import { multiValueDefault } from '../../shims/src/multi-value.js';
import {
  CURRENCY_CODES,
  DECISIONS,
  EXACT_DECIMAL_LENGTH,
  RESERVED_COLUMN_SUFFIX,
  SOURCE_ID_COLUMN,
  SOURCE_ID_MAX_LENGTH,
  SYSTEM_FIELD_COLUMNS,
  UNIQUE_VARCHAR_MAX_PER_TABLE,
  fieldTypeById,
  fieldTypeRow,
  isReservedColumnName,
  normalizeType,
  type CatalystType,
  type FieldTypeRow,
  type Support,
} from './mapping.js';
import { requiredCompositePart } from './composite-parts.js';
import { ANCHOR_GROUP, formatLimitReport, limitValue, splitTable, tableNameLengthBlocker, type LimitBlocker, type SchemaSplit } from './limits.js';

export type OnDelete = 'ON-DELETE-CASCADE' | 'ON-DELETE-SET-NULL';

export interface SchemaColumn {
  /** Data Store column name. */
  name: string;
  /**
   * Creator field link name, set only when the column is stored under another
   * name because the field name is a reserved column name (`Table` → `Table_col`).
   * Generated app code keeps the field name; the datastore adapter and the data
   * loader translate.
   */
  field?: string;
  creatorType: string;
  matrixId: string;
  status: Support;
  dataType: CatalystType;
  length?: number;
  precision?: number;
  /** Canonical decimal string in this varchar, not a Double. */
  exactDecimal?: boolean;
  /** ISO 4217 code from `type = INR`. Absent when the type word is `currency`. */
  currencyCode?: string;
  mandatory: boolean;
  unique: boolean;
  /**
   * Creator unique, enforced by the generated handler instead of the store — the table
   * is over UNIQUE_VARCHAR_MAX_PER_TABLE, or the source rows repeat a value. `unique`
   * is false on such a column.
   */
  appUnique?: boolean;
  /**
   * Creator mandatory, enforced by the generated handler instead of the store, because
   * the source rows hold an empty value. `mandatory` is false on such a column.
   */
  appMandatory?: boolean;
  defaultValue?: string;
  relation?: { table: string; column: 'ROWID'; onDelete: OnDelete };
  /**
   * A Creator lookup past the per-table foreign-key budget: stored as a plain BigInt
   * holding the parent ROWID. `relation` names the parent so the loader still remaps
   * ids, but the store enforces neither the reference nor `onDelete`.
   */
  plainLookup?: boolean;
  /** This Double is the ZCQL criteria/sort shadow of the named exact-decimal column. */
  shadowFor?: string;
  note?: string;
}

export interface SchemaTable {
  name: string;
  form: string;
  /** Child table of an inline subform, a generated junction, a generated system table, or a 1:1 column-cap extension. */
  role: 'form' | 'child' | 'junction' | 'system' | 'extension';
  nosql: boolean;
  nosqlReason?: string;
  /** Set only on an extension table. The base table name. Absent otherwise, so under-cap JSON is unchanged. */
  extensionOf?: string;
  columns: SchemaColumn[];
  /** Inline subform link names embedded when the form is NoSQL. */
  embedded?: string[];
  /** Set on a `child` table: the inline subform it stores and its link and order columns. */
  subform?: SubformLink;
}

/** One inline subform stored as a child table. Rows keep their Creator order in `orderColumn`. */
export interface SubformLink {
  /** Parent form link name. */
  form: string;
  /** Subform field link name on the parent form. */
  field: string;
  parentTable: string;
  /** Foreign key to the parent ROWID, ON-DELETE-CASCADE. */
  parentColumn: string;
  /** 0-based row position inside the subform. */
  orderColumn: string;
}

/** One field stored under another column name because its own name is reserved. */
export interface ColumnRename {
  table: string;
  form: string;
  field: string;
  column: string;
}

export interface SignalRule {
  table: string;
  event: 'row_inserted' | 'row_updated' | 'row_deleted';
  target: 'event-function';
  note: string;
}

export interface MigrationIssue {
  severity: 'warning' | 'unsupported';
  form?: string;
  field?: string;
  message: string;
}

export interface FieldOutcome {
  form: string;
  field: string;
  creatorType: string;
  matrixId: string;
  status: Support;
  reason: string;
}

/** A field type with known migration behavior that is incomplete or unsupported. */
export interface FieldGap {
  matrixId: string;
  count: number;
  reason: string;
  fields: { form: string; field: string }[];
}

/** Group partial and unsupported field outcomes without implying a generated shim. */
export function fieldGapsOf(fields: readonly FieldOutcome[]): FieldGap[] {
  const gaps = new Map<string, FieldGap>();
  for (const outcome of fields) {
    if (outcome.status === 'supported') continue;
    let gap = gaps.get(outcome.matrixId);
    if (!gap) {
      gap = { matrixId: outcome.matrixId, count: 0, reason: outcome.reason, fields: [] };
      gaps.set(outcome.matrixId, gap);
    }
    gap.count++;
    gap.fields.push({ form: outcome.form, field: outcome.field });
  }
  return [...gaps.values()].sort((a, b) => (a.matrixId < b.matrixId ? -1 : a.matrixId > b.matrixId ? 1 : 0));
}

export interface SchemaSummary {
  tables: number;
  nosqlCollections: number;
  columns: number;
  fields: number;
  supported: number;
  partial: number;
  unsupported: number;
  /** Supported + partial, over fields. Null when there are no fields. One decimal. */
  mappedPct: number | null;
}

export interface SchemaPlan {
  version: 1;
  dryRun: true;
  app?: string;
  projectName: string;
  decisions: typeof DECISIONS;
  tables: SchemaTable[];
  /**
   * Store constraints the source data disproved, in table then column order.
   * Present only when generateSchema ran with `source`.
   */
  constraints?: ConstraintDecision[];
  /** Fields stored under another column name, in table then column order. Present only when there is one. */
  renames?: ColumnRename[];
  signals: SignalRule[];
  issues: MigrationIssue[];
  fields: FieldOutcome[];
  summary: SchemaSummary;
  /** Present only when a form was split. Omitted otherwise so schema JSON stays byte-identical. */
  splits?: SchemaSplit[];
  /** Present only when a split was unsafe. The table is left unsplit. */
  limitBlockers?: LimitBlocker[];
}

/**
 * Source rows a constraint decision is measured against, one entry per table the
 * source holds. `carried` lists the column names the source exposes even when every
 * cell is empty (a mapped header). `complete` marks a source that holds every record —
 * for it, a column the source does not carry has no value on any record.
 */
export interface SourceTableData {
  table: string;
  carried?: readonly string[];
  complete?: boolean;
  rows: readonly { columns: Record<string, unknown> }[];
}

/** One store-constraint decision measured against source rows. */
export interface ConstraintDecision {
  table: string;
  column: string;
  rule: 'mandatory' | 'unique';
  /**
   * 'store' keeps the constraint on the Data Store column; 'app' moves it to the
   * generated handler (the column is created without it). applySourceConstraints
   * only emits 'app' entries — a column kept at store level needs no record.
   */
  layer: 'store' | 'app';
  /** Empty source cells (mandatory) or rows repeating a value (unique). */
  violations: number;
}

const NAME_PARTS = ['prefix', 'first_name', 'last_name', 'suffix'] as const;
const ADDRESS_PARTS = ['address_line_1', 'address_line_2', 'district_city', 'state_province', 'postal_code', 'country', 'latitude', 'longitude'] as const;

/**
 * Column names a field produces beyond its base column: the composite parts
 * (`<Field>_<part>`) and the exact-decimal shadow (`<Field>__n`). A second
 * field that takes one of these names would silently land on a `_2` column,
 * so checks run before schema generation.
 */
export function derivedFieldColumns(field: Field): string[] {
  const row = fieldTypeRow(field.type);
  const out: string[] = [];
  if (row?.kind === 'composite') {
    const parts = field.subfields.length ? field.subfields.map((s) => s.name) : row.id === 'address' ? ADDRESS_PARTS : NAME_PARTS;
    for (const part of parts) out.push(`${field.name}_${part}`);
  }
  if (row && (row.id === 'decimal' || row.id === 'percent' || row.id === 'currency')) out.push(`${field.name}__n`);
  return out;
}
const SIGNAL_EVENTS = ['row_inserted', 'row_updated', 'row_deleted'] as const;
const SIGNAL_NOTE = 'One event per Signals rule. Target is an Event function only.';

function sourceIdColumn(): SchemaColumn {
  return {
    name: SOURCE_ID_COLUMN,
    creatorType: 'system',
    matrixId: 'c2c-source-id',
    status: 'supported',
    dataType: 'VarChar',
    length: SOURCE_ID_MAX_LENGTH,
    mandatory: false,
    unique: false,
    note: 'Creator source record id. NULL on rows the app creates. The loader keeps it unique per table and skips ids already stored on resume. Longer than 255 is rejected, not hashed.',
  };
}

/** Form and child tables reserve the four Creator system names so a field cannot take them. Junction tables do not. */
function reservedNames(role: 'form' | 'child' | 'junction' | 'system'): Set<string> {
  const used = new Set<string>([SOURCE_ID_COLUMN]);
  if (role !== 'junction') {
    for (const column of SYSTEM_FIELD_COLUMNS) used.add(column.name);
  }
  return used;
}

type ColumnGroups = WeakMap<SchemaColumn, string>;

function pushSystemColumns(columns: SchemaColumn[], groups: ColumnGroups): void {
  const present = new Set<string>();
  for (const column of columns) present.add(column.name);
  for (const spec of SYSTEM_FIELD_COLUMNS) {
    if (present.has(spec.name)) continue;
    const column: SchemaColumn = {
      name: spec.name,
      creatorType: 'system',
      matrixId: 'c2c-system-field',
      status: 'supported',
      dataType: spec.dataType,
      ...(spec.length ? { length: spec.length } : {}),
      mandatory: false,
      unique: false,
      note: spec.note,
    };
    groups.set(column, ANCHOR_GROUP);
    columns.push(column);
  }
}

function pushSourceId(columns: SchemaColumn[], groups: ColumnGroups): void {
  const column = sourceIdColumn();
  groups.set(column, ANCHOR_GROUP);
  columns.push(column);
}

const MULTI_TOKENS = new Set(['list', 'checkboxes', 'multi select', 'multiselect', 'lookup multi', 'multi lookup']);

/** Columns every generated transition-history row carries, in this order. */
const FLOW_HISTORY_FIELDS = ['Machine', 'Form', 'Record_ID', 'Action', 'Name', 'From_Status', 'To_Status', 'Actor', 'Comment'] as const;

function flowStatusSchemaColumn(name: string): SchemaColumn {
  return {
    name,
    creatorType: 'system',
    matrixId: 'c2c-flow-status',
    status: 'supported',
    dataType: 'VarChar',
    length: 255,
    mandatory: false,
    unique: false,
    note: 'Approval / blueprint state machine stage. The generated flow functions write it; the client cannot.',
  };
}

function flowHistorySchemaColumn(name: string): SchemaColumn {
  return {
    name,
    creatorType: 'system',
    matrixId: 'c2c-flow-history',
    status: 'supported',
    dataType: 'VarChar',
    length: 255,
    mandatory: false,
    unique: false,
    note: 'State machine transition audit row. Written by the generated flow functions.',
  };
}

/**
 * Forms an approval or blueprint workflow governs, each to its machine status
 * column. `Form[criteria]` selects the same form name; the criteria decide at
 * run time which records a machine governs, not which column it uses.
 */
function governedStatusColumns(app: App): Map<string, string> {
  const governed = new Map<string, string>();
  for (const w of app.workflows) {
    if (!isApprovalWorkflow(w) && !isBlueprintWorkflow(w)) continue;
    const name = formLink(w.form).name;
    const form = app.forms.find((item) => item.name === name);
    if (form && !governed.has(form.name)) governed.set(form.name, flowStatusColumn(form.fields));
  }
  return governed;
}

/** The generated transition-history table name, or undefined when the app has no state machines. */
export function flowHistoryTable(app: App): string | undefined {
  return generateSchema(app).tables.find((table) => table.role === 'system' && table.form === 'C2C_Flow_History')?.name;
}

export function projectNameFor(link: string): string {
  const clean = (link || 'app').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'app';
  // A link that already carries the c2c- prefix keeps it once (c2c-example-app, not c2c-c2c-example-app).
  const base = /^c2c-/i.test(clean) ? clean : `c2c-${clean}`;
  if (base.length <= 50) return base;
  const hash = createHash('sha1').update(link).digest('hex').slice(0, 6);
  return `${base.slice(0, 43)}-${hash}`;
}

/** Identifier for a table or column: `$` and every character outside ASCII letters, digits, and underscore become `_`, and a leading digit is prefixed. */
export function schemaIdent(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  const name = cleaned || fallback;
  return name.toLowerCase() === 'rowid' ? `f_${name}` : name;
}

function ident(raw: string, fallback: string): string {
  return schemaIdent(raw, fallback);
}

/** Child or junction table name before a collision suffix: parent table, `__`, field identifier. */
export function linkedTableName(parentTable: string, fieldName: string, fallback: string): string {
  return `${parentTable}__${schemaIdent(fieldName, fallback)}`;
}

function prop(field: Field, key: string): string | undefined {
  const want = key.toLowerCase();
  const found = field.properties.find((p) => p.key.toLowerCase() === want);
  return found ? found.value.trim() : undefined;
}

function propInt(field: Field, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = prop(field, key);
    if (raw === undefined) continue;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function creatorTypeOf(field: Field): string {
  return normalizeType(field.type) || '(none)';
}

function isUsers(field: Field): boolean {
  const token = creatorTypeOf(field);
  if (token === 'users' || token === 'user') return true;
  return normalizeType(prop(field, 'module')) === 'users';
}

/** A multi select or checkboxes field: one text column holding a JSON list (not a lookup). */
export function isMultiChoiceField(field: Field): boolean {
  return !field.lookup && isMulti(field);
}

function isMulti(field: Field): boolean {
  const token = creatorTypeOf(field);
  if (MULTI_TOKENS.has(token)) return true;
  if (token === 'checkbox' && ((field.choices?.length ?? 0) > 0 || field.lookup)) return true;
  return false;
}

function isSubform(field: Field): boolean {
  const token = creatorTypeOf(field);
  return token === 'grid' || token === 'subform' || token === 'inline subform' || token === 'form';
}

function isInlineSubform(field: Field): boolean {
  return isSubform(field) && !field.lookup;
}

function rowOf(id: string): FieldTypeRow {
  const row = fieldTypeById(id);
  if (!row) throw new Error(`missing field type row ${id}`);
  return row;
}

function varcharSpec(field: Field, fallback: 'VarChar' | 'Text'): { dataType: 'VarChar' | 'Text'; length?: number; promoted: boolean } {
  const max = propInt(field, ['maxchar', 'max char', 'max length']);
  const choiceTooLong = (field.choices ?? []).some((c) => c.length > 255);
  const over = (max !== undefined && max > 255) || choiceTooLong;
  if (over || (fallback === 'Text' && (max === undefined || max > 255))) {
    if (fallback === 'Text' && !over && (max === undefined || max > 255)) {
      return max !== undefined && max <= 255 ? { dataType: 'VarChar', length: Math.max(1, max), promoted: false } : { dataType: 'Text', promoted: false };
    }
    return { dataType: 'Text', promoted: true };
  }
  const length = max !== undefined ? Math.min(255, Math.max(1, max)) : 255;
  return { dataType: 'VarChar', length, promoted: false };
}

interface ColumnEnv {
  form: Form;
  columns: SchemaColumn[];
  used: Set<string>;
  issues: MigrationIssue[];
  outcomes: FieldOutcome[];
  formTable: Map<string, string>;
  nosqlForms: Set<string>;
  /** Field link name, or ANCHOR_GROUP. Not copied onto the column, so JSON is unchanged. */
  groups: ColumnGroups;
  /** Column names the form's own fields take; a reserved-name rename does not reuse one. */
  claimed: ReadonlySet<string>;
}

function pushColumn(env: ColumnEnv, column: SchemaColumn, group: string): void {
  env.groups.set(column, group);
  env.columns.push(column);
}

function allocColumn(used: Set<string>, raw: string): string {
  let name = ident(raw, 'col');
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let i = 2;
  while (used.has(`${name}_${i}`)) i++;
  const next = `${name}_${i}`;
  used.add(next);
  return next;
}

/**
 * Column for a field's own value. A reserved name takes RESERVED_COLUMN_SUFFIX
 * and skips any name another field of the form takes; `field` records the
 * Creator name for the translation.
 */
function allocFieldColumn(env: ColumnEnv, raw: string): { name: string; field?: string } {
  const base = ident(raw, 'col');
  if (!isReservedColumnName(base)) return { name: allocColumn(env.used, raw) };
  const stem = `${base}${RESERVED_COLUMN_SUFFIX}`;
  let name = stem;
  for (let i = 2; env.used.has(name) || env.claimed.has(name); i++) name = `${stem}_${i}`;
  env.used.add(name);
  return { name, field: raw };
}

/** Column names the fields and subfields of a form take before any rename. */
function claimedNames(form: Form): Set<string> {
  const out = new Set<string>();
  for (const field of form.fields) {
    out.add(ident(field.name, 'col'));
    for (const sub of field.subfields) out.add(ident(sub.name, 'col'));
  }
  return out;
}

function pushOutcome(env: ColumnEnv, field: Field, row: FieldTypeRow, creatorType: string): void {
  env.outcomes.push({
    form: env.form.name,
    field: field.name,
    creatorType,
    matrixId: row.id,
    status: row.status,
    reason: row.reason,
  });
}

function baseColumn(env: ColumnEnv, field: Field, row: FieldTypeRow, dataType: CatalystType, extra: Partial<SchemaColumn> = {}): SchemaColumn {
  const alloc = allocFieldColumn(env, field.name);
  const column: SchemaColumn = {
    name: alloc.name,
    ...(alloc.field !== undefined ? { field: alloc.field } : {}),
    creatorType: creatorTypeOf(field),
    matrixId: row.id,
    status: row.status,
    dataType,
    mandatory: field.required,
    unique: field.unique,
    ...extra,
  };
  if (dataType === 'Text' || dataType === 'Foreign Key' || dataType === 'Encrypted') {
    if (field.unique && dataType !== 'Text') column.unique = field.unique;
  }
  applyDefault(env, field, column);
  return column;
}

function applyDefault(env: ColumnEnv, field: Field, column: SchemaColumn): void {
  if (field.initialValue === undefined) return;
  if (column.dataType === 'Text' || column.dataType === 'Foreign Key' || column.dataType === 'Encrypted') {
    // A multi-value column holds a JSON list, so its prefill is that list (["No"]), not the .ds list source.
    const multi = column.matrixId === 'multi-select' || column.matrixId === 'checkbox-multi';
    const prefill = multi ? multiValueDefault(field.initialValue) : field.initialValue;
    env.issues.push({
      severity: 'warning',
      form: env.form.name,
      field: field.name,
      message:
        prefill === undefined
          ? `Default is not set on ${column.dataType} column ${column.name}. The initial value is not a static list, so the generated form does not prefill it.`
          : multi
            ? `Default is not set on ${column.dataType} column ${column.name}. The generated form prefills ${prefill} instead, and the submit handler stores it on insert.`
            : `Default is not set on ${column.dataType} column ${column.name}. The generated form prefills "${prefill}" instead.`,
    });
    return;
  }
  column.defaultValue = field.initialValue;
}

function notePrecision(env: ColumnEnv, field: Field, column: SchemaColumn, row: FieldTypeRow): void {
  const precision = propInt(field, ['decimalplace', 'decimal places', 'decimal digits']) ?? 2;
  column.precision = precision;
  env.issues.push({
    severity: 'warning',
    form: env.form.name,
    field: field.name,
    message: `${row.label} has no decimal column type. ${column.name} is Double with precision ${precision} enforced by generated code.`,
  });
}

function currencyCodeOf(field: Field): string | undefined {
  const token = normalizeType(field.type);
  if (!token || !CURRENCY_CODES.has(token)) return undefined;
  return token.toUpperCase();
}

function canonicalDefault(raw: string, places: number): string | undefined {
  const stripped = raw.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  try {
    return quantizeDecimal(stripped, places);
  } catch {
    return undefined;
  }
}

function pushExactDecimal(env: ColumnEnv, field: Field, row: FieldTypeRow): void {
  const places = propInt(field, ['decimalplace', 'decimal places', 'decimal digits']) ?? 2;
  const currencyCode = currencyCodeOf(field);
  const column = baseColumn(env, field, row, 'VarChar', {
    length: EXACT_DECIMAL_LENGTH,
    precision: places,
    exactDecimal: true,
    ...(currencyCode ? { currencyCode } : {}),
    note: 'exact decimal string',
  });
  if (column.defaultValue !== undefined) {
    const canonical = canonicalDefault(column.defaultValue, places);
    if (canonical !== undefined) column.defaultValue = canonical;
  }
  pushColumn(env, column, field.name);

  // ZCQL compares the varchar as text ('20.00' <= '100.00' is false). Criteria and
  // ORDER BY use this Double shadow, and the runtime re-checks the varchar exactly.
  // Not mandatory or unique: two exact values can share one binary64 value.
  pushColumn(env, {
    name: allocColumn(env.used, `${column.name}__n`),
    creatorType: column.creatorType,
    matrixId: column.matrixId,
    status: column.status,
    dataType: 'Double',
    precision: places,
    mandatory: false,
    unique: false,
    shadowFor: column.name,
    note: 'Double shadow of the exact decimal for ZCQL criteria and sort; written by the runtime, never read by app code',
  }, field.name);
}

function fkTarget(env: ColumnEnv, field: Field): { table?: string; missing: boolean } {
  const target = field.lookup?.form;
  if (!target) return { missing: true };
  if (env.nosqlForms.has(target)) return { missing: true };
  const table = env.formTable.get(target);
  if (!table) return { missing: true };
  return { table, missing: false };
}

function onDeleteFor(field: Field, child: boolean): OnDelete {
  // Subform rows belong to the parent. A mandatory lookup cannot use SET-NULL.
  return child || field.required ? 'ON-DELETE-CASCADE' : 'ON-DELETE-SET-NULL';
}

function pushFk(env: ColumnEnv, field: Field, row: FieldTypeRow, child: boolean): void {
  const target = fkTarget(env, field);
  const column = baseColumn(env, field, row, target.missing ? 'BigInt' : 'Foreign Key');
  if (target.missing) {
    column.note = 'FK needs console';
    env.issues.push({
      severity: 'warning',
      form: env.form.name,
      field: field.name,
      message: `FK needs console: lookup ${field.name} has no Data Store parent (${field.lookup?.form ?? 'unknown'}). Stored as bigint id.`,
    });
  } else {
    column.relation = { table: target.table!, column: 'ROWID', onDelete: onDeleteFor(field, child) };
  }
  pushColumn(env, column, field.name);
}

function pushComposite(env: ColumnEnv, field: Field, row: FieldTypeRow, parts: readonly string[]): void {
  const fromSub = field.subfields.map((s) => s.name);
  const names = fromSub.length ? fromSub : [...parts];
  const widget: 'name' | 'address' = row.id === 'address' ? 'address' : 'name';
  for (const part of names) {
    const token = normalizeType(part);
    const dataType: CatalystType = token === 'latitude' || token === 'longitude' ? 'Double' : 'VarChar';
    const column: SchemaColumn = {
      name: allocColumn(env.used, `${field.name}_${part}`),
      creatorType: creatorTypeOf(field),
      matrixId: row.id,
      status: row.status,
      dataType,
      mandatory: field.required && requiredCompositePart(widget, part, names),
      unique: false,
      ...(dataType === 'VarChar' ? { length: 255 } : {}),
      ...(dataType === 'Double' ? { precision: 6 } : {}),
    };
    pushColumn(env, column, field.name);
  }
}

function mapScalar(env: ColumnEnv, field: Field): void {
  const creatorType = creatorTypeOf(field);
  if (isUsers(field) && !field.lookup) {
    const row = rowOf('users');
    pushOutcome(env, field, row, creatorType);
    pushColumn(env, baseColumn(env, field, row, 'BigInt'), field.name);
    return;
  }
  if (field.lookup && isMulti(field)) {
    const row = rowOf('lookup-multi');
    pushOutcome(env, field, row, creatorType);
    // Junction is created by the caller when it sees this outcome's kind. Column is not on the parent.
    env.issues.push({
      severity: 'warning',
      form: env.form.name,
      field: field.name,
      message: `Multi lookup ${field.name} is a junction table, not a column on ${env.form.name}.`,
    });
    return;
  }
  if (field.lookup) {
    const row = rowOf('lookup-single');
    pushOutcome(env, field, row, creatorType);
    pushFk(env, field, row, false);
    return;
  }
  if (creatorType === 'checkbox' && isMulti(field)) {
    const row = rowOf('checkbox-multi');
    pushOutcome(env, field, row, creatorType);
    const column = baseColumn(env, field, row, 'Text');
    column.note = 'JSON list';
    pushColumn(env, column, field.name);
    return;
  }
  const row = fieldTypeRow(field.type);
  if (!row) {
    const unknown: FieldTypeRow = {
      id: 'unmapped',
      label: 'Unmapped',
      tokens: [],
      status: 'unsupported',
      kind: 'none',
      reason: `No mapping for Creator field type "${field.type ?? ''}". Not generated.`,
    };
    pushOutcome(env, field, unknown, creatorType);
    env.issues.push({
      severity: 'unsupported',
      form: env.form.name,
      field: field.name,
      message: unknown.reason,
    });
    return;
  }
  pushOutcome(env, field, row, creatorType);
  if (row.kind === 'none') return;
  if (row.kind === 'composite') {
    pushComposite(env, field, row, row.id === 'address' ? ADDRESS_PARTS : NAME_PARTS);
    return;
  }
  if (row.id === 'lookup-single' || row.id === 'lookup-multi') {
    // A lookup token with no values = Form.Field still must not pretend the FK exists.
    pushFk(env, field, row, false);
    return;
  }
  if (row.kind === 'child-table' || row.kind === 'junction') return;
  if (row.id === 'decimal' || row.id === 'percent' || row.id === 'currency') {
    pushExactDecimal(env, field, row);
    return;
  }
  const dataType = row.dataType ?? 'Text';
  if (dataType === 'VarChar' || (dataType === 'Text' && row.id === 'url')) {
    const spec = varcharSpec(field, dataType === 'Text' ? 'Text' : 'VarChar');
    const column = baseColumn(env, field, row, spec.dataType, spec.length ? { length: spec.length } : {});
    if (spec.promoted) {
      column.note = 'promoted to text';
      env.issues.push({
        severity: 'warning',
        form: env.form.name,
        field: field.name,
        message: `${field.name} promoted to text to avoid silent varchar truncation (max 255).`,
      });
    }
    pushColumn(env, column, field.name);
    return;
  }
  if (dataType === 'Double') {
    const column = baseColumn(env, field, row, 'Double');
    notePrecision(env, field, column, row);
    pushColumn(env, column, field.name);
    return;
  }
  if (dataType === 'Encrypted') {
    const column = baseColumn(env, field, row, 'Encrypted');
    column.note = 'equality only';
    pushColumn(env, column, field.name);
    return;
  }
  const column = baseColumn(env, field, row, dataType);
  if (row.id === 'multi-select' || row.id === 'checkbox-multi') column.note = 'JSON list';
  if (row.id === 'auto-number') {
    const start = prop(field, 'start index');
    if (start) column.note = `start index ${start}`;
    column.unique = false;
  }
  pushColumn(env, column, field.name);
}

function childTable(parent: SchemaTable, field: Field, envFor: (columns: SchemaColumn[], used: Set<string>) => ColumnEnv, alloc: (base: string) => string): SchemaTable {
  const columns: SchemaColumn[] = [];
  const used = reservedNames('child');
  const env = envFor(columns, used);
  const parentId: SchemaColumn = {
    name: allocColumn(used, 'parent_id'),
    creatorType: 'subform',
    matrixId: 'subform',
    status: 'partial',
    dataType: 'Foreign Key',
    mandatory: true,
    unique: false,
    relation: { table: parent.name, column: 'ROWID', onDelete: 'ON-DELETE-CASCADE' },
  };
  env.groups.set(parentId, ANCHOR_GROUP);
  columns.push(parentId);
  const order: SchemaColumn = {
    name: allocColumn(used, 'row_order'),
    creatorType: 'subform',
    matrixId: 'subform',
    status: 'partial',
    dataType: 'Int',
    mandatory: false,
    unique: false,
    note: 'Subform row position, 0-based. Reads order by it, then ROWID.',
  };
  columns.push(order);
  for (const sub of field.subfields) {
    if (isSubform(sub)) {
      env.issues.push({
        severity: 'warning',
        form: env.form.name,
        field: sub.name,
        message: `Nested subform ${sub.name} is not expanded. Review it by hand.`,
      });
      continue;
    }
    mapScalar(env, sub);
  }
  pushSystemColumns(columns, env.groups);
  pushSourceId(columns, env.groups);
  return {
    name: alloc(linkedTableName(parent.name, field.name, 'sub')),
    form: env.form.name,
    role: 'child',
    nosql: false,
    columns,
    subform: { form: env.form.name, field: field.name, parentTable: parent.name, parentColumn: parentId.name, orderColumn: order.name },
  };
}

function junctionTable(
  parent: SchemaTable,
  field: Field,
  env: ColumnEnv,
  alloc: (base: string) => string,
): SchemaTable {
  const columns: SchemaColumn[] = [];
  const used = new Set<string>([SOURCE_ID_COLUMN]);
  const local: ColumnEnv = { ...env, columns, used };
  const left: SchemaColumn = {
    name: allocColumn(used, 'parent_id'),
    creatorType: 'lookup multi',
    matrixId: 'lookup-multi',
    status: 'partial',
    dataType: 'Foreign Key',
    mandatory: true,
    unique: false,
    relation: { table: parent.name, column: 'ROWID', onDelete: 'ON-DELETE-CASCADE' },
  };
  local.groups.set(left, ANCHOR_GROUP);
  columns.push(left);
  columns.push({
    name: allocColumn(used, 'row_order'),
    creatorType: 'lookup multi',
    matrixId: 'lookup-multi-order',
    status: 'partial',
    dataType: 'Int',
    mandatory: false,
    unique: false,
    note: 'Lookup value position, 0-based. Reads order by it, then ROWID.',
  });
  pushFk(local, field, rowOf('lookup-multi'), false);
  // pushFk names the column after the field. That is the related id.
  pushSourceId(columns, local.groups);
  return {
    name: alloc(linkedTableName(parent.name, field.name, 'link')),
    form: env.form.name,
    role: 'junction',
    nosql: false,
    columns,
  };
}

/**
 * matrixIds of generated columns that are not a Creator field: link/order columns on
 * child and junction tables, the source id, system and flow-history columns. A store
 * constraint on one is never relaxed by source data — there is no app-layer rule that
 * would take over (a child row without its parent link would just be orphaned).
 */
const GENERATED_COLUMN_IDS = new Set(['subform', 'lookup-multi', 'lookup-multi-order', 'c2c-source-id', 'c2c-system-field', 'c2c-flow-status', 'c2c-flow-history']);

const emptyCell = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

/** One plan/report line for a decision: names the column and the violating row count. */
export function constraintDecisionNote(decision: ConstraintDecision): string {
  if (decision.rule === 'mandatory') {
    return `${decision.table}.${decision.column} is mandatory but the source holds ${decision.violations} empty value(s); the column is created not mandatory and the generated app still requires it`;
  }
  return decision.violations > 0
    ? `${decision.table}.${decision.column} is unique but ${decision.violations} source row(s) repeat a value; the column is created not unique and the generated app still checks it`
    : `${decision.table}.${decision.column} is unique but the source carries no value for it; the column is created not unique and the generated app still checks it`;
}

/**
 * Measure a generated schema's mandatory/unique columns against the source rows.
 * A Creator "must have"/"must be unique" field is a submit-time rule: existing
 * records may violate it, and the store column must accept those rows. Only a
 * column the source actually carries can disprove a constraint: a mandatory
 * field whose carried cells hold an empty value is created not mandatory and
 * marked `appMandatory` — the generated handler still refuses the empty write —
 * and a unique field whose carried cells repeat a value is created not unique
 * and marked `appUnique`. A column the source does not carry proves nothing:
 * it stays store-constrained and a load that leaves it empty is refused before
 * any write (a complete source may store the field outside the row files, as a
 * bidirectional reverse lookup does). Runs before the unique-varchar budget so
 * a demoted column does not spend one of the two store-level slots.
 */
export function applySourceConstraints(
  tables: readonly SchemaTable[],
  source: readonly SourceTableData[],
  issues: MigrationIssue[],
): ConstraintDecision[] {
  const decisions: ConstraintDecision[] = [];
  const byTable = new Map(source.map((item) => [item.table, item]));
  for (const table of tables) {
    if (table.nosql) continue;
    const src = byTable.get(table.name);
    if (!src) continue;
    const carried = new Set(src.carried ?? []);
    for (const column of table.columns) {
      if (GENERATED_COLUMN_IDS.has(column.matrixId)) continue;
      if (column.mandatory) {
        const empties = src.rows.reduce((n, row) => n + (emptyCell(row.columns[column.name]) ? 1 : 0), 0);
        if (carried.has(column.name) && empties > 0) {
          column.mandatory = false;
          column.appMandatory = true;
          const decision: ConstraintDecision = { table: table.name, column: column.name, rule: 'mandatory', layer: 'app', violations: empties };
          column.note = [column.note, constraintDecisionNote(decision)].filter(Boolean).join(' ');
          issues.push({ severity: 'warning', form: table.form, field: column.name, message: constraintDecisionNote(decision) });
          decisions.push(decision);
        }
      }
      if (column.unique) {
        const seen = new Set<string>();
        let dupes = 0;
        for (const row of src.rows) {
          const value = row.columns[column.name];
          if (emptyCell(value)) continue;
          const key = String(value);
          if (seen.has(key)) dupes += 1;
          else seen.add(key);
        }
        if (dupes > 0) {
          column.unique = false;
          column.appUnique = true;
          const decision: ConstraintDecision = { table: table.name, column: column.name, rule: 'unique', layer: 'app', violations: dupes };
          column.note = [column.note, constraintDecisionNote(decision)].filter(Boolean).join(' ');
          issues.push({ severity: 'warning', form: table.form, field: column.name, message: constraintDecisionNote(decision) });
          decisions.push(decision);
        }
      }
    }
  }
  return decisions;
}

/**
 * Apply recorded decisions to a freshly generated schema. Used when the source rows
 * are no longer at hand: 'app' entries demote the column, 'store' entries leave the
 * Creator flag in place so a load that violates it is refused before any write.
 */
export function applyConstraintDecisions(plan: SchemaPlan, decisions: readonly ConstraintDecision[]): SchemaPlan {
  for (const decision of decisions) {
    if (decision.layer !== 'app') continue;
    const column = plan.tables.find((table) => table.name === decision.table)?.columns.find((item) => item.name === decision.column);
    if (!column) continue;
    if (decision.rule === 'mandatory' && column.mandatory) {
      column.mandatory = false;
      column.appMandatory = true;
    }
    if (decision.rule === 'unique' && column.unique) {
      column.unique = false;
      column.appUnique = true;
    }
  }
  if (decisions.length) plan.constraints = [...decisions];
  return plan;
}

export function generateSchema(app: App, opts?: { source?: readonly SourceTableData[] }): SchemaPlan {
  const issues: MigrationIssue[] = [];
  const outcomes: FieldOutcome[] = [];
  const tables: SchemaTable[] = [];
  const usedTables = new Set<string>();
  const alloc = (base: string): string => {
    let name = base || 'Table';
    if (!usedTables.has(name)) {
      usedTables.add(name);
      return name;
    }
    let i = 2;
    while (usedTables.has(`${name}_${i}`)) i++;
    const next = `${name}_${i}`;
    usedTables.add(next);
    return next;
  };
  const groups: ColumnGroups = new WeakMap();
  const formTable = new Map<string, string>();
  for (const form of app.forms) formTable.set(form.name, alloc(ident(form.name, 'Table')));
  // Every inline subform is a child table, however many the form has.
  const nosqlForms = new Set<string>();
  const pendingJunctions: { parent: SchemaTable; field: Field; env: ColumnEnv }[] = [];
  const pendingRefs: { field: Field; form: Form }[] = [];
  const governed = governedStatusColumns(app);

  for (const form of app.forms) {
    const columns: SchemaColumn[] = [];
    const used = reservedNames('form');
    const env: ColumnEnv = { form, columns, used, issues, outcomes, formTable, nosqlForms, groups, claimed: claimedNames(form) };
    const table: SchemaTable = {
      name: formTable.get(form.name)!,
      form: form.name,
      role: 'form',
      nosql: false,
      columns,
    };
    for (const field of form.fields) {
      if (isInlineSubform(field)) {
        const row = rowOf('subform');
        pushOutcome(env, field, row, creatorTypeOf(field));
        const child = childTable(table, field, (cols, u) => ({ ...env, columns: cols, used: u }), alloc);
        tables.push(child);
        for (const sub of field.subfields) {
          if (sub.lookup && isMulti(sub)) pendingJunctions.push({ parent: child, field: sub, env });
        }
        continue;
      }
      if (isSubform(field) && field.lookup) {
        const row = rowOf('subform');
        pushOutcome(env, field, row, creatorTypeOf(field));
        pendingRefs.push({ field, form });
        continue;
      }
      const before = columns.length;
      mapScalar(env, field);
      if (field.lookup && isMulti(field) && columns.length === before) pendingJunctions.push({ parent: table, field, env });
    }
    const status = governed.get(form.name);
    if (status) {
      const column = flowStatusSchemaColumn(status);
      groups.set(column, ANCHOR_GROUP);
      columns.push(column);
    }
    pushSystemColumns(columns, groups);
    pushSourceId(columns, groups);
    tables.push(table);
  }

  for (const item of pendingJunctions) {
    if (item.parent.nosql) {
      issues.push({
        severity: 'warning',
        form: item.env.form.name,
        field: item.field.name,
        message: `Multi lookup ${item.field.name} stays inside the NoSQL document. No junction table.`,
      });
      continue;
    }
    tables.push(junctionTable(item.parent, item.field, item.env, alloc));
  }

  for (const { field, form } of pendingRefs) {
    const targetName = field.lookup?.form;
    const targetTable = targetName ? tables.find((t) => t.form === targetName && t.role === 'form') : undefined;
    const back = prop(field, 'bidirectional');
    if (!targetTable || targetTable.nosql) {
      issues.push({
        severity: 'warning',
        form: form.name,
        field: field.name,
        message: `FK needs console: subform ${field.name} target ${targetName ?? 'unknown'} is not a Data Store table.`,
      });
      continue;
    }
    if (back && targetTable.columns.some((c) => c.name === ident(back, 'parent_id'))) continue;
    const used = new Set(targetTable.columns.map((c) => c.name));
    const backColumn: SchemaColumn = {
      name: allocColumn(used, back || `${form.name}_id`),
      creatorType: 'subform',
      matrixId: 'subform',
      status: 'partial',
      dataType: 'Foreign Key',
      mandatory: false,
      unique: false,
      relation: { table: formTable.get(form.name)!, column: 'ROWID', onDelete: 'ON-DELETE-CASCADE' },
    };
    groups.set(backColumn, field.name);
    targetTable.columns.push(backColumn);
  }

  // One history table serves every approval and blueprint. It is generated
  // state, not migrated data, so no CSV or counts.json row ever names it.
  if (governed.size) {
    const columns: SchemaColumn[] = FLOW_HISTORY_FIELDS.map((name) => flowHistorySchemaColumn(name));
    pushSystemColumns(columns, groups);
    tables.push({ name: alloc('C2C_Flow_History'), form: 'C2C_Flow_History', role: 'system', nosql: false, columns });
  }

  // The same classifier the emitter uses for the sweeper Job, so the
  // checkpoint table is planned exactly when a sweeper is generated. The
  // criteria compiler lives in the emitter, so an untranslatable `Form[criteria]`
  // selector keeps the table rather than stranding a sweeper without one.
  const hasFormSchedule = app.workflows.some((w) => isFormScheduleWorkflow(w) && !formScheduleSweepGap(app, w, true));
  if (hasFormSchedule) {
    const columns: SchemaColumn[] = [
      {
        name: 'Job_Key',
        creatorType: 'system',
        matrixId: 'c2c-job-key',
        status: 'supported',
        dataType: 'VarChar',
        length: 255,
        mandatory: true,
        unique: true,
      },
      {
        name: 'State',
        creatorType: 'system',
        matrixId: 'c2c-job-state',
        status: 'supported',
        dataType: 'Text',
        mandatory: true,
        unique: false,
      },
    ];
    pushSystemColumns(columns, groups);
    tables.push({ name: alloc('C2CJobCheckpoint'), form: 'C2CJobCheckpoint', role: 'system', nosql: false, columns });
  }

  // Source rows decide whether a Creator constraint can be a store constraint;
  // demotion runs first so a relaxed column does not spend a unique varchar slot.
  const constraints = opts?.source ? applySourceConstraints(tables, opts.source, issues) : undefined;

  const cap = limitValue('datastore.columns_per_table');
  const groupOf = (column: SchemaColumn): string => groups.get(column) ?? column.name;
  const splits: SchemaSplit[] = [];
  const limitBlockers: LimitBlocker[] = [];
  const splitTables: SchemaTable[] = [];
  for (const table of tables) {
    const result = splitTable(table, cap, groupOf, alloc);
    splitTables.push(...result.tables);
    if (result.split) {
      splits.push(result.split);
      issues.push({
        severity: 'warning',
        form: table.form,
        message: `${table.form} exceeds the Data Store column cap ${cap}. Split into ${result.split.base} plus ${result.split.extensions.map((ext) => ext.name).join(', ')}. 1:1 on parent_rowid. The cap is unverified.`,
      });
    }
    if (result.blocker) limitBlockers.push(result.blocker);
  }
  tables.length = 0;
  tables.push(...splitTables);
  for (const table of tables) {
    if (table.nosql) continue;
    const nameBlocker = tableNameLengthBlocker(table.form, table.name);
    if (nameBlocker) limitBlockers.push(nameBlocker);
  }
  for (const table of tables) demoteUniqueDates(table, issues);
  for (const table of tables) budgetUniqueVarchar(table, issues);
  for (const table of tables) budgetForeignKeys(table, issues);

  const renames: ColumnRename[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.field === undefined) continue;
      renames.push({ table: table.name, form: table.form, field: column.field, column: column.name });
      issues.push({
        severity: 'warning',
        form: table.form,
        field: column.field,
        message: `"${column.field}" is a reserved Data Store column name. ${table.name} stores it as ${column.name}; the generated app and the data loader translate the name.`,
      });
    }
  }

  const signals: SignalRule[] = [];
  for (const table of tables) {
    if (table.nosql) continue;
    for (const event of SIGNAL_EVENTS) {
      signals.push({ table: table.name, event, target: 'event-function', note: SIGNAL_NOTE });
    }
  }

  const supported = outcomes.filter((f) => f.status === 'supported').length;
  const partial = outcomes.filter((f) => f.status === 'partial').length;
  const unsupported = outcomes.filter((f) => f.status === 'unsupported').length;
  const fieldCount = outcomes.length;
  const summary: SchemaSummary = {
    tables: tables.length,
    nosqlCollections: tables.filter((t) => t.nosql).length,
    columns: tables.reduce((n, t) => n + t.columns.length, 0),
    fields: fieldCount,
    supported,
    partial,
    unsupported,
    mappedPct: fieldCount === 0 ? null : Math.round(((supported + partial) * 1000) / fieldCount) / 10,
  };
  const link = app.name || 'app';
  return {
    version: 1,
    dryRun: true,
    app: app.name,
    projectName: projectNameFor(link),
    decisions: DECISIONS,
    tables,
    ...(constraints?.length ? { constraints } : {}),
    ...(renames.length ? { renames } : {}),
    signals,
    issues,
    fields: outcomes,
    summary,
    ...(splits.length ? { splits } : {}),
    ...(limitBlockers.length ? { limitBlockers } : {}),
  };
}

/** A column Data Store stores as varchar (VarChar ≤ 255). Longer VarChar becomes text. */
export function isStoreVarchar(column: SchemaColumn): boolean {
  return column.dataType === 'VarChar' && (column.length ?? 255) <= 255;
}

/**
 * Data Store refuses every insert into a unique Date or DateTime column with
 * 400 INVALID_INPUT "date value expected" — the same value a non-unique date
 * column accepts (live probe, 2026-10-16). A Creator "no duplicate values" date
 * field is therefore never store-unique: the column is created without
 * is_unique and marked appUnique so the generated handler enforces the rule by
 * a ZCQL read before insert and update. Data Store-level uniqueness is not
 * enforced for dates, and that check is not atomic. The demotion is
 * unconditional — it does not depend on source rows.
 */
function demoteUniqueDates(table: SchemaTable, issues: MigrationIssue[]): void {
  if (table.nosql) return;
  const demoted: string[] = [];
  for (const column of table.columns) {
    if (!column.unique || (column.dataType !== 'Date' && column.dataType !== 'DateTime')) continue;
    column.unique = false;
    column.appUnique = true;
    column.note = [
      column.note,
      'Unique is enforced by the c2c handler, not the store: a unique Date/DateTime column refuses every insert (400 INVALID_INPUT "date value expected"), so Data Store-level uniqueness is not enforced for dates.',
    ]
      .filter(Boolean)
      .join(' ');
    demoted.push(column.name);
  }
  if (demoted.length) {
    issues.push({
      severity: 'warning',
      form: table.form,
      message: `${table.name} has ${demoted.length} unique date/datetime column(s); a unique date column refuses every insert (400 INVALID_INPUT "date value expected"). App-level unique (checked by the handler, not atomic; the store does not enforce it): ${demoted.join(', ')}.`,
    });
  }
}

/**
 * Keep the first UNIQUE_VARCHAR_MAX_PER_TABLE unique varchar columns store-level, in
 * column order; the rest become app-level unique (checked by the handler). Without this
 * the column batch is refused and the table is left empty.
 */
function budgetUniqueVarchar(table: SchemaTable, issues: MigrationIssue[]): void {
  if (table.nosql) return;
  const unique = table.columns.filter((column) => column.unique && isStoreVarchar(column));
  const excess = unique.slice(UNIQUE_VARCHAR_MAX_PER_TABLE);
  if (!excess.length) return;
  for (const column of excess) {
    column.unique = false;
    column.appUnique = true;
    column.note = [
      column.note,
      `Unique is enforced by the c2c handler, not the store: Data Store allows ${UNIQUE_VARCHAR_MAX_PER_TABLE} unique varchar columns per table.`,
    ]
      .filter(Boolean)
      .join(' ');
  }
  issues.push({
    severity: 'warning',
    form: table.form,
    message: `${table.name} has ${unique.length} unique varchar columns; Data Store allows ${UNIQUE_VARCHAR_MAX_PER_TABLE}. Store-level unique: ${unique
      .slice(0, UNIQUE_VARCHAR_MAX_PER_TABLE)
      .map((column) => column.name)
      .join(', ')}. App-level unique (checked by the handler, not atomic): ${excess.map((column) => column.name).join(', ')}.`,
  });
}

/**
 * Keep the datastore.fk_columns limit's worth of lookups as store foreign keys: the ON-DELETE-CASCADE
 * ones first (parent ids and mandatory lookups), then column order. The rest become
 * plain BigInt ROWID columns that keep `relation` (the loader remaps them) but have
 * no store constraint. Every demoted lookup is named in the migration report.
 */
function budgetForeignKeys(table: SchemaTable, issues: MigrationIssue[]): void {
  if (table.nosql) return;
  const max = limitValue('datastore.fk_columns');
  const keys = table.columns.filter((column) => column.dataType === 'Foreign Key' && column.relation);
  if (keys.length <= max) return;
  const ranked = [
    ...keys.filter((column) => column.relation!.onDelete === 'ON-DELETE-CASCADE'),
    ...keys.filter((column) => column.relation!.onDelete !== 'ON-DELETE-CASCADE'),
  ];
  const excess = new Set(ranked.slice(max));
  const demoted = keys.filter((column) => excess.has(column));
  for (const column of demoted) {
    column.dataType = 'BigInt';
    column.plainLookup = true;
    column.note = [
      column.note,
      `Plain bigint ROWID of ${column.relation!.table}, not a foreign key: Data Store allows ${max} foreign keys per table. The store does not check the id or apply ${column.relation!.onDelete}.`,
    ]
      .filter(Boolean)
      .join(' ');
  }
  issues.push({
    severity: 'warning',
    form: table.form,
    message: `${table.name} has ${keys.length} lookups; Data Store allows ${max} foreign keys per table (unverified). Foreign keys: ${keys
      .filter((column) => !excess.has(column))
      .map((column) => column.name)
      .join(', ')}. Stored as plain bigint ROWID ids (${demoted.length}): ${demoted
      .map((column) => `${column.name} -> ${column.relation!.table}`)
      .join(', ')}. Manual step: the store does not check these ids or apply ON DELETE, so a deleted parent row leaves its id behind; clear or re-point those ids when you delete a parent row, or move these lookups to a child table.`,
  });
}

export function schemaAsJson(plan: SchemaPlan): string {
  return JSON.stringify(plan, null, 2);
}

function columnLine(column: SchemaColumn): string {
  const type = column.dataType.includes(' ') ? `"${column.dataType}"` : column.dataType;
  const bits = [`  column ${column.name} type=${type}`];
  if (column.length) bits.push(`length=${column.length}`);
  if (column.precision !== undefined) bits.push(`precision=${column.precision}`);
  if (column.exactDecimal) bits.push('exact-decimal');
  if (column.currencyCode) bits.push(`currency=${column.currencyCode}`);
  if (column.shadowFor) bits.push(`shadow-of=${column.shadowFor}`);
  if (column.mandatory) bits.push('mandatory');
  if (column.unique) bits.push('unique');
  if (column.defaultValue !== undefined) bits.push(`default=${JSON.stringify(column.defaultValue)}`);
  if (column.plainLookup) bits.push(`plain-id-of=${column.relation!.table}.${column.relation!.column}`);
  else if (column.relation) bits.push(`references=${column.relation.table}.${column.relation.column} on_delete=${column.relation.onDelete}`);
  return bits.join(' ');
}

export function schemaAsIac(plan: SchemaPlan): string {
  const blocks: string[] = [];
  const pin = toolchain();
  blocks.push(`# c2c generated output\n# node: ${pin.node}\n# typescript: ${pin.typescript}`);
  blocks.push(`# dry-run project ${plan.projectName}`);
  blocks.push(`# ${plan.decisions.jobPool}`);
  for (const table of plan.tables) {
    const kind = table.nosql ? 'nosql' : 'table';
    const head = table.nosqlReason ? `${kind} ${table.name} { # ${table.nosqlReason}` : `${kind} ${table.name} {`;
    const body = table.columns.map(columnLine);
    if (table.embedded?.length) body.push(`  embedded ${table.embedded.join(', ')}`);
    blocks.push([head, ...body, '}'].join('\n'));
  }
  if (plan.signals.length) {
    blocks.push(['signals {', ...plan.signals.map((s) => `  ${s.table} ${s.event} -> ${s.target}`), '}'].join('\n'));
  }
  return blocks.join('\n\n') + '\n';
}

function listOutcomes(plan: SchemaPlan, status: Support): string {
  const rows = plan.fields.filter((f) => f.status === status);
  if (!rows.length) return '- none';
  return rows.map((f) => `- ${f.form}.${f.field} (${f.creatorType} → ${f.matrixId})${status === 'supported' ? '' : ` — ${f.reason}`}`).join('\n');
}

export function schemaAsReport(plan: SchemaPlan): string {
  const s = plan.summary;
  const pct = (n: number) => (s.fields === 0 ? 'n/a' : `${((n * 100) / s.fields).toFixed(1)}%`);
  const issues = plan.issues.length
    ? plan.issues.map((i) => `- ${i.severity}${i.form ? ` ${i.form}` : ''}${i.field ? `.${i.field}` : ''}: ${i.message}`).join('\n')
    : '- none';
  return [
    `# Schema migration report${plan.app ? `: ${plan.app}` : ''}`,
    '',
    `Dry run only. Project \`${plan.projectName}\`.`,
    '',
    '## Decisions',
    '',
    ...Object.entries(plan.decisions).map(([k, v]) => `- **${k}.** ${v}`), // determinism-allow: const DECISIONS object; key order is the published schema contract, not a hash map
    '',
    '## Summary',
    '',
    `Tables: ${s.tables} (NoSQL collections: ${s.nosqlCollections})`,
    `Columns: ${s.columns}`,
    `Fields: ${s.fields} — Supported ${s.supported} (${pct(s.supported)}), Partial ${s.partial} (${pct(s.partial)}), Unsupported ${s.unsupported} (${pct(s.unsupported)})`,
    `Mapped (supported + partial): ${s.mappedPct === null ? 'n/a' : `${s.mappedPct.toFixed(1)}%`}`,
    '',
    '## Generated (supported)',
    '',
    listOutcomes(plan, 'supported'),
    '',
    '## Partial',
    '',
    listOutcomes(plan, 'partial'),
    '',
    '## Unsupported',
    '',
    listOutcomes(plan, 'unsupported'),
    '',
    '## Issues',
    '',
    issues,
    '',
    ...(plan.renames?.length
      ? [
          '## Renamed columns',
          '',
          'Reserved Data Store column names. The generated app keeps the Creator field name; the store column differs.',
          '',
          ...plan.renames.map((r) => `- ${r.form}.${r.field} → ${r.table}.${r.column}`),
          '',
        ]
      : []),
    '## Signals',
    '',
    'One Data Store row event per rule. Targets are Event functions only.',
    '',
    plan.signals.length ? plan.signals.map((sig) => `- ${sig.table} ${sig.event}`).join('\n') : '- none (no Data Store tables)',
    '',
    formatLimitReport(plan),
  ].join('\n');
}

/** Generated-app name of a column: the Creator field name when the column was renamed, else the column name. */
export function appColumnName(column: Pick<SchemaColumn, 'name' | 'field'>): string {
  return column.field ?? column.name;
}

/**
 * Table → { Creator field name: store column } for every renamed column, keys
 * sorted. The datastore adapter's translation map. Empty when nothing was renamed.
 */
export function columnRenamesOf(plan: Pick<SchemaPlan, 'tables'>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const table of plan.tables) {
    const renamed = table.columns.filter((column) => column.field !== undefined).sort((a, b) => (a.field! < b.field! ? -1 : a.field! > b.field! ? 1 : 0));
    if (!renamed.length) continue;
    const entry: Record<string, string> = {};
    for (const column of renamed) entry[column.field!] = column.name;
    out[table.name] = entry;
  }
  return out;
}

/** Parent form → its inline subforms as child tables, in schema order. The shape `shim` subform helpers take. */
export function subformTablesOf(plan: SchemaPlan): Record<string, { field: string; table: string; parentColumn: string; orderColumn: string }[]> {
  const out: Record<string, { field: string; table: string; parentColumn: string; orderColumn: string }[]> = {};
  for (const table of plan.tables) {
    const link = table.subform;
    if (table.role !== 'child' || !link) continue;
    (out[link.form] ??= []).push({ field: link.field, table: table.name, parentColumn: link.parentColumn, orderColumn: link.orderColumn });
  }
  return out;
}

/** Field types whose column stores a Stratus object key (`kind: stratus-key`). */
export const STRATUS_KEY_TYPES: readonly string[] = ['file-upload', 'image', 'audio', 'video', 'signature'];

/** Table → its Stratus-key columns (form and child tables) by generated-app name, in column order. Tables without one are absent. */
export function fileColumnsOf(plan: SchemaPlan): Record<string, { form: string; role: SchemaTable['role']; columns: string[] }> {
  const out: Record<string, { form: string; role: SchemaTable['role']; columns: string[] }> = {};
  for (const table of plan.tables) {
    const columns = table.columns.filter((column) => STRATUS_KEY_TYPES.includes(column.matrixId)).map(appColumnName);
    if (columns.length) out[table.name] = { form: table.form, role: table.role, columns };
  }
  return out;
}
