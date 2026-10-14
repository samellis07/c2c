/**
 * Creator report CSV → Data Store rows.
 * One file per report (or the form link name when the form has no report),
 * plus <Form>__<Subform>.csv for an inline subform. counts.json is optional.
 * With it, each form's row count must match that file, and a generated table
 * (a subform child or a lookup junction) may pin its own row total under its
 * table name. Without it, the expected
 * count is the number of distinct rows exported for that form, and the plan says so.
 * Child and junction tables are re-counted by source id too, so an acknowledged
 * write that did not store them fails.
 * The ID column is the Creator record id when the export includes it. Otherwise
 * the source id is derived from the form's unique fields, or from the mapped
 * values shared by every export of that form, and the plan says which. A derived
 * id that repeats inside one file is refused. The same id from two reports of
 * one form is one row. A CSV that derives ids says to prefer the JSON export:
 * a JSON report carries a record ID on every row, and a lookup object is
 * remapped by that object's record ID.
 * A header matches a field link name, display name, or the report column label.
 * A lookup cell is a record id, or the display value named by the field's
 * display format. A missing or ambiguous display match is refused. A name or
 * address exported as one column is split into its parts. A flattened subform
 * column — `Sub.Field` dotted keys, a report column label, or a
 * `Sub.A + " - " + Sub.B` display expression — becomes rows of the generated
 * child table, linked by parent_id and ordered by row_order. The comma-joined
 * elements must agree across a subform's columns and split unambiguously;
 * anything else is refused naming the parent row and column. A flattened
 * column that cannot be carried is listed under data fidelity and is not
 * written as a parent cell. Dates are dd-MMM-yyyy
 * or already ISO. An ambiguous date is left as text so the writer can refuse it.
 * Decimals drop grouping commas and pad up to the column scale. Extra fractional
 * digits are kept so the writer can refuse them instead of rounding. Choice
 * multi-select becomes a JSON list; multi-lookup values become ordered junction
 * rows. Files are the exported reference.
 *
 * Acyclic lookups are resolved to parent ROWIDs before insert. A self-lookup
 * or a cycle cannot be: those columns are omitted on insert, then set with a
 * row update once every side has a ROWID (Creator id → ROWID via c2c_source_id).
 * The update does not insert rows, so source and destination counts stay equal.
 * Query bodies are parsed with parseJsonExact. ROWIDs and FK ids stay strings.
 * A numeric id past MAX_SAFE_INTEGER is refused.
 * A cyclic must-have FK is created not mandatory. The report lists that gap.
 * The loader's own reports from an earlier run, and the seed.json manifest that
 * `c2c seed --out` writes beside its CSVs, are skipped; any other file that does
 * not match a report, form, or subform is refused.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Field, Form, Report, ReportColumn } from '../../core/src/ir.js';
import {
  ZCQL_IN_LIMIT,
  emptyCheckpoint,
  type CatalystScope,
  type Checkpoint,
  type FetchLike,
  type MigrateResult,
} from '../../data/src/migrate.js';
import {
  applyConstraintDecisions,
  constraintDecisionNote,
  generateSchema,
  type ConstraintDecision,
  type SchemaColumn,
  type SchemaPlan,
  type SchemaTable,
  type SourceTableData,
} from '../../schema/src/generator.js';
import { SOURCE_ID_COLUMN, SYSTEM_FIELD_COLUMNS, SYSTEM_FIELD_COVERAGE_GAP } from '../../schema/src/mapping.js';
import { formatSkipped, migrateSeed, type SeedRow, type SeedTable } from './seed.js';
import { SEED_BLOCKED_KEY } from '../../data/src/seed.js';
import {
  duplicateUniqueRefusals,
  emptyIntegrity,
  groupRefusals,
  integrityColumns,
  mandatoryMissingRefusals,
  mergeIntegrity,
  type IntegrityRefusal,
} from '../../data/src/integrity.js';
import { decimalShadow } from '../../shims/src/criteria.js';
import { quantizeDecimal } from '../../shims/src/decimal.js';
import { exactId, parseJsonExact } from './json-exact.js';
import { confirmGuardLines, planScopeLines } from './guards.js';
import {
  countFrom,
  deferredColumns,
  loadRowIds,
  omitColumns,
  orderTables,
  query,
  resolveForeignKeys,
  updateDeferredForeignKeys,
} from './remap.js';
import { appShadowColumns, backfillCommand, staleShadowCountQuery } from './shadows.js';
import { assertLookupRemaps, cyclicForeignKeys, foreignKeyId, formatMandatoryRelaxed, mandatoryRelaxedColumns, nonDeferrableKeys, tableCreatePlan } from './tables.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SYSTEM_FIELD_NAMES = new Set<string>(SYSTEM_FIELD_COLUMNS.map((column) => column.name));

export type CellKind = 'text' | 'date' | 'datetime' | 'decimal' | 'bool' | 'multi' | 'lookup' | 'file' | 'number';

interface ColSpec {
  /** Data Store column. */
  column: string;
  /** Creator field name the column carries; differs from `column` only for a reserved name. */
  field: string;
  kind: CellKind;
  headers: Set<string>;
  parent?: string;
  /** Lookup displayformat from the .ds, including the brackets. */
  displayFormat?: string;
  /** Fractional digits for an exact-decimal varchar. Absent for other kinds. */
  scale?: number;
  /** Double shadow of this exact-decimal column. Filled from it, never from a CSV header. */
  shadowFor?: string;
}

const NAME_PARTS = ['prefix', 'first_name', 'last_name', 'suffix'] as const;
const ADDRESS_PARTS = ['address_line_1', 'address_line_2', 'district_city', 'state_province', 'postal_code', 'country', 'latitude', 'longitude'] as const;

type RawCell = string | { id: string } | { list: RawCell[] } | { composite: Record<string, string> } | { row: Record<string, RawCell> };

interface SourceSheet {
  file: string;
  headers: string[];
  rows: RawCell[][];
}

interface PendingLink {
  table: string;
  parentId: string;
  column: string;
  parent: string;
  displayFormat?: string;
  raw: string;
  file: string;
  authoritative: boolean;
  order: number;
}

/** Rows harvested from flattened subform columns, destined for a child table. */
interface ChildAcc {
  spec: TableSpec;
  field: Field;
  rows: Map<string, SeedRow>;
  raw: Map<string, Record<string, string>>;
  /** Subfield names that at least one exported column supplied. */
  written: Set<string>;
  /** Per parent id: the child-row count each export file claimed, and whether it was provable. */
  contrib: Map<string, { file: string; row: number; header: string; count: number; proved: boolean }[]>;
}

interface Materialized {
  table: SeedTable;
  pending: PendingLink[];
  raw: Map<string, Record<string, string>>;
  notes: CsvColumnNote[];
  missingRequired: { form: string; table: string; field: string }[];
  absentFields: { form: string; table: string; field: string }[];
  derived: { table: string; detail: string }[];
  authoritative: string[];
  fidelity: string[];
  children: Map<string, ChildAcc>;
}

type HeaderHit =
  | { kind: 'column'; column: ColSpec; displayTrue?: string; displayFalse?: string }
  | { kind: 'composite'; field: Field }
  | { kind: 'junction'; table: string; column: string }
  | { kind: 'subform'; field: Field; child: TableSpec; parts: SubPart[] }
  | { kind: 'unmapped'; reason: string; cover?: string; subform?: string };

/** One child-table column fed by a flattened subform column. */
interface SubPart {
  field: Field;
  /** Literal text before this field inside a composite display element. */
  separator?: string;
  /** Absent when the subfield is itself composite (name/address): the cell is split into its parts. */
  column?: ColSpec;
}

interface ReportHeader {
  field: string;
  displayTrue?: string;
  displayFalse?: string;
  /** Composite display expression: `Sub.A + " - " + Sub.B`. */
  expr?: string;
}

interface TableSpec {
  table: string;
  form: string;
  role: SchemaTable['role'];
  columns: ColSpec[];
  field?: string;
  /** Present on a child table: the inline subform field it expands and its link columns. */
  subform?: { form: string; field: string; parentTable: string; parentColumn: string; orderColumn: string };
}

export interface CsvCount {
  form: string;
  table: string;
  expected: number;
  catalyst?: number;
  mismatch: boolean;
}

export interface CsvGap {
  form: string;
  table: string;
  detail: string;
}

export interface CsvColumnNote {
  file: string;
  table: string;
  mapped: { header: string; column: string }[];
  unmapped: { header: string; reason: string }[];
}

export interface CsvLoad {
  /** csv is a report CSV. json is a JSON report export. backup is an application backup. */
  source: 'csv' | 'json' | 'backup';
  tables: SeedTable[];
  expected: { form: string; table: string; count: number }[];
  /** counts.json when that file is present; otherwise the rows of the export or backup itself. */
  countsFrom: 'counts.json' | 'export' | 'backup';
  /**
   * The generated tables in the schema — subform children and lookup junctions.
   * Their rows may ride inside a parent form's records or a separate
   * <Form>__<Subform>.csv file, so a parent form's counts.json entry never
   * proves them complete: only a backup, or their own counts.json entry, does.
   */
  generatedTables?: string[];
  foreignKeys: { table: string; column: string; parent: string }[];
  skipped: CsvGap[];
  relaxed: { table: string; column: string }[];
  /** Present when a CSV for a form or child table omits Creator system columns. Not a nosql skip. */
  systemFieldGaps?: { table: string; missing: string[]; detail: string }[];
  columns: CsvColumnNote[];
  missingRequired: { form: string; table: string; field: string }[];
  /**
   * Required columns with no value on at least one row (one entry per cell).
   * A report export that omits a must-have column lists it here for every row.
   * Confirm refuses before any write; plan reports the same list.
   */
  missingMandatory: IntegrityRefusal[];
  /** Non-required form fields the export does not carry at all. Reported, not refused. */
  absentFields: { form: string; table: string; field: string }[];
  derivedIds: { table: string; detail: string }[];
  lookups: { table: string; column: string; parent: string; by: string }[];
  /** Columns the export holds that cannot be written to the schema as it stands. */
  fidelity: string[];
  ignored: string[];
  /** Source facts worth a line in the plan (a backup's app, dc, row totals, payload summary). */
  notes?: string[];
  /**
   * The rows each table's constraint decisions were measured on: every row plus the
   * column names the source carries, and `complete` when the source holds every
   * record (an application backup). Re-run at load time so the same decisions apply.
   */
  sourceData?: SourceTableData[];
  /** Mandatory/unique columns the source disproved — created without the store constraint. */
  constraints?: ConstraintDecision[];
}

export interface CsvMigrateResult extends MigrateResult {
  counts: CsvCount[];
  skipped: CsvGap[];
  relaxed: { table: string; column: string }[];
  /** Columns the export holds that could not be written to the schema as it stands. */
  fidelity: string[];
  /** Mandatory/unique columns the source disproved — recorded so the report names them. */
  constraints?: ConstraintDecision[];
  /**
   * Rows of a written table whose exact-decimal shadow is NULL while the varchar holds a
   * value: rows stored before the shadow column existed, which this run did not rewrite.
   * Each line names the count and the backfill command.
   */
  warnings?: string[];
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (ch === '\r') continue;
    cell += ch;
  }
  if (quoted) throw new Error('CSV has an unclosed quote');
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim() !== ''));
}

/** Loader report. Separate from the deploy report so a seed directory is not mistaken for a deploy. */
export const LOADER_REPORT = 'c2c-load-report.json';
/** Fidelity report: per-table source/written counts, id checksums, and value checksums. */
export const FIDELITY_JSON = 'c2c-fidelity.json';
export const FIDELITY_MD = 'c2c-fidelity.md';
/** The manifest `c2c seed --out` writes beside its per-form CSVs: `{ Form: [rows] }`. */
const SEED_MANIFEST = 'seed.json';

/**
 * A file c2c itself wrote into a source directory, not report data: the loader
 * and fidelity reports of an earlier run, or the `c2c seed` manifest. The
 * manifest is recognised only when no report, form, or subform is named `seed`
 * and the file is an object of form names to row lists; any other seed.json is
 * read (and refused) like any other file.
 */
export function isLoaderSidecar(dir: string, name: string, app: App): boolean {
  if (name === LOADER_REPORT || name === FIDELITY_JSON) return true;
  if (name !== SEED_MANIFEST) return false;
  const specs = tableSpecs(app, generateSchema(app).tables);
  try {
    resolveFile(name, new Map(app.reports.map((report) => [report.name, report])), new Map(app.forms.map((form) => [form.name, form])), specs);
    return false;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('does not match a Data Store form')) throw err;
    // No report, form, or subform named seed: check the manifest shape.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  // `c2c seed` keys the manifest by table name: the parent form, its generated
  // child/junction tables, and the reserved blocked-form record.
  const names = new Set([...specs.map((spec) => spec.table), SEED_BLOCKED_KEY]);
  return Object.entries(parsed).every(([table, rows]) => names.has(table) && Array.isArray(rows));
}

/** True when the directory holds a JSON report export (c2c's own files, edits logs included, aside). */
export function hasReportJson(dir: string, app: App): boolean {
  return readdirSync(dir).some(
    (name) =>
      !name.startsWith('.') &&
      name !== 'counts.json' &&
      !name.endsWith('.edits.json') &&
      name.toLowerCase().endsWith('.json') &&
      !isLoaderSidecar(dir, name, app),
  );
}

export function readSourceCsv(dir: string, app: App, allowEmpty = false): CsvLoad {
  return loadSource(dir, app, allowEmpty, 'csv');
}

/** JSON report export. Record ID is the source id. A lookup object uses its record ID. */
export function readSourceJson(dir: string, app: App, allowEmpty = false): CsvLoad {
  return loadSource(dir, app, allowEmpty, 'json');
}

function loadSource(dir: string, app: App, allowEmpty: boolean, format: 'csv' | 'json'): CsvLoad {
  const schema = generateSchema(app);
  const specs = tableSpecs(app, schema.tables);
  const byTable = new Map(specs.map((spec) => [spec.table, spec]));
  const forms = new Map(app.forms.map((form) => [form.name, form]));
  const reports = new Map(app.reports.map((report) => [report.name, report]));
  const names = readdirSync(dir).filter((name) => !name.startsWith('.')).sort();
  const hasCounts = names.includes('counts.json');
  const ignored: string[] = [];
  const grouped = new Map<string, SourceSheet[]>();
  for (const name of names) {
    // A confirmed load writes its reports next to the export; a re-run reads past
    // them, as it does the edits log a project folder can carry.
    if (name === 'counts.json' || name === LOADER_REPORT || name === FIDELITY_JSON || name.endsWith('.edits.json')) continue;
    const lower = name.toLowerCase();
    if (lower.endsWith('.md') || (format === 'json' && lower.endsWith('.csv')) || isLoaderSidecar(dir, name, app)) {
      ignored.push(name);
      continue;
    }
    if (format === 'json' ? !lower.endsWith('.json') : !lower.endsWith('.csv')) throw new Error(`unexpected file ${name}`);
    const table = resolveFile(name, reports, forms, specs);
    const spec = byTable.get(table);
    if (!spec) throw new Error(`${name} does not match a report, form, or subform`);
    const stored = schema.tables.find((item) => item.name === table);
    if (stored?.nosql) throw new Error(`${name} is a NoSQL form; this stage does not load it`);
    const text = readFileSync(join(dir, name), 'utf8');
    const sheet = format === 'json' ? parseJsonSheet(name, text) : parseCsvSheet(name, text);
    const list = grouped.get(table) ?? [];
    list.push(sheet);
    grouped.set(table, list);
  }
  const foreignKeys = specs.flatMap((spec) =>
    spec.columns.filter((column) => column.parent).map((column) => ({ table: spec.table, column: column.column, parent: column.parent! })),
  );
  assertLookupRemaps(
    specs.flatMap((spec) => spec.columns.filter((column) => column.kind === 'lookup' && !column.shadowFor).map((column) => ({ table: spec.table, column: column.column }))),
    foreignKeys,
  );
  const active = specs.filter((spec) => !schema.tables.find((item) => item.name === spec.table)?.nosql);
  const occupied = new Set(grouped.keys());
  const built = active.map((spec) => materialize(spec, grouped.get(spec.table) ?? [], specs, forms.get(spec.form), reports));
  // Rows harvested from flattened subform columns land in the child tables.
  for (const item of built) {
    for (const acc of item.children.values()) {
      const target = built.find((entry) => entry.table.table === acc.spec.table);
      if (!target) continue;
      for (const [id, row] of acc.rows) {
        const existing = target.table.rows.find((entry) => entry.id === id);
        if (existing) mergeColumns(existing, row.columns, 'the export');
        else target.table.rows.push(row);
        const targetRaw = target.raw.get(id) ?? {};
        mergeRaw(id, targetRaw, acc.raw.get(id) ?? {}, 'the export');
        target.raw.set(id, targetRaw);
      }
    }
  }
  const tables = built.map((item) => item.table);
  resolveLookupCells(
    tables,
    new Map(built.map((item) => [item.table.table, item.raw])),
    built.flatMap((item) => item.pending),
    specs,
    occupied,
    new Set(built.flatMap((item) => item.authoritative)),
  );
  const countsFrom = hasCounts ? 'counts.json' as const : 'export' as const;
  const expected = hasCounts
    ? parseCounts(readFileSync(join(dir, 'counts.json'), 'utf8'), schema.tables)
    : exportCounts(active, tables);
  // A generated table — a subform child or a lookup junction — never inherits a
  // parent form's completeness: counts.json counts parent records, and a
  // separate <Form>__<Subform>.csv can be filtered while every form count still
  // matches. It proves complete only from a backup or its own counts.json entry.
  const generatedTables = schema.tables
    .filter((table) => (table.role === 'child' || table.role === 'junction') && !table.nosql)
    .map((table) => table.name);
  const skipped = schema.tables
    .filter((table) => table.nosql)
    .map((table) => ({ form: table.form, table: table.name, detail: 'POST /nosqltable is refused' }));
  const systemFieldGaps = active.flatMap((spec) => {
    const missing = missingSystemHeaders(spec, grouped.get(spec.table));
    return missing.length ? [{ table: spec.table, missing, detail: SYSTEM_FIELD_COVERAGE_GAP }] : [];
  });
  const ordered = orderTables(tables, foreignKeys);
  // The columns a table's export carries: every mapped header plus every column a
  // materialized row holds (flattened subform parts land without a header). A
  // column absent from a report export is not proof of empty — the report may
  // simply not show the field — so a report source is not `complete`.
  const carriedByTable = new Map<string, Set<string>>();
  const carry = (table: string, column: string): void => {
    const set = carriedByTable.get(table) ?? new Set<string>();
    set.add(column);
    carriedByTable.set(table, set);
  };
  for (const note of built.flatMap((item) => item.notes)) {
    for (const item of note.mapped) carry(note.table, item.column);
  }
  for (const table of ordered) for (const row of table.rows) for (const column of Object.keys(row.columns)) carry(table.table, column);
  const sourceData: SourceTableData[] = ordered.map((table) => ({
    table: table.table,
    carried: [...(carriedByTable.get(table.table) ?? [])].sort(),
    rows: table.rows,
  }));
  const checked = generateSchema(app, { source: sourceData });
  const relaxed = mandatoryRelaxedColumns(tableCreatePlan(checked));
  const absentFields = built.flatMap((item) => item.absentFields);
  const loaded: CsvLoad = {
    source: format,
    tables: ordered,
    expected,
    countsFrom,
    generatedTables,
    foreignKeys,
    skipped,
    relaxed,
    columns: built.flatMap((item) => item.notes),
    missingRequired: built.flatMap((item) => item.missingRequired),
    missingMandatory: mandatoryMissingRefusals(ordered, loaderColumns(checked, ordered, foreignKeys)),
    absentFields,
    derivedIds: built.flatMap((item) => item.derived),
    lookups: lookupPlan(active),
    fidelity: [
      ...built.flatMap((item) => item.fidelity),
      ...absentFields.map((field) => `${field.table}.${field.field} (${field.form}) is not in the export; the column stays empty`),
      ...(checked.constraints ?? []).map(constraintDecisionNote),
    ],
    ignored,
    ...(systemFieldGaps.length ? { systemFieldGaps } : {}),
    sourceData,
    ...(checked.constraints?.length ? { constraints: checked.constraints } : {}),
  };
  assertExportCounts(loaded, allowEmpty);
  return loaded;
}

/**
 * Write-rule columns per table for the loader: schema columns with the store-level
 * `mandatory` flag carried as `required`, minus the cyclic foreign keys the run
 * writes in the second pass (they are created non-mandatory, so the first pass
 * leaves them out). `appMandatory` columns are app-layer only: source rows that
 * leave them empty still load.
 */
export function loaderColumns(
  schema: SchemaPlan,
  tables: readonly { table: string }[],
  foreignKeys: readonly { table: string; column: string; parent: string }[],
): Record<string, ReturnType<typeof integrityColumns>> {
  const deferred = cyclicForeignKeys(
    tables.map((table) => table.table),
    foreignKeys,
    nonDeferrableKeys(schema, foreignKeys),
  );
  return Object.fromEntries(
    schema.tables.map((table) => [table.name, integrityColumns(table, deferredColumns(table.name, deferred), 'store')]),
  );
}

/** CSV row count must match counts.json before any write. An all-zero export is refused unless allowEmpty. */
export function assertExportCounts(loaded: CsvLoad, allowEmpty: boolean): void {
  for (const item of loaded.expected) {
    const rows = loaded.tables.find((table) => table.table === item.table)?.rows.length ?? 0;
    if (rows === 0 && item.count > 0) {
      throw new Error(`refusing an empty export for ${item.form}; counts.json says ${item.count}`);
    }
    if (rows !== item.count) {
      throw new Error(`CSV row count for ${item.form} is ${rows} but counts.json says ${item.count}`);
    }
  }
  if (loaded.expected.length > 0 && loaded.expected.every((item) => item.count === 0) && !allowEmpty) {
    throw new Error('refusing an all-zero export; pass --allow-empty');
  }
}

export async function migrateCsv(opts: {
  app: App;
  dir: string;
  dc: string;
  catalystBase: string;
  fetch: FetchLike;
  checkpoint?: Checkpoint;
  saveCheckpoint?: (checkpoint: Checkpoint) => void;
  scope: CatalystScope;
  allowEmpty?: boolean;
  format?: 'csv' | 'json';
  /** Decisions the provisioned project recorded. Given, the load replays them instead of re-measuring the source. */
  constraints?: readonly ConstraintDecision[];
}): Promise<CsvMigrateResult> {
  const loaded = (opts.format === 'json' ? readSourceJson : readSourceCsv)(opts.dir, opts.app, opts.allowEmpty === true);
  return migrateLoaded({ ...opts, loaded });
}

/** Write a loaded source through the guarded loader. Callers build `loaded` from any supported source. */
export async function migrateLoaded(opts: {
  app: App;
  loaded: CsvLoad;
  dc: string;
  catalystBase: string;
  fetch: FetchLike;
  checkpoint?: Checkpoint;
  saveCheckpoint?: (checkpoint: Checkpoint) => void;
  scope: CatalystScope;
  /**
   * The constraint decisions the project was provisioned with. Given, they are
   * replayed as-is: a load never re-decides a column the provision run already
   * settled, so rows that violate a kept store constraint are refused before
   * any write regardless of what this source would have measured.
   */
  constraints?: readonly ConstraintDecision[];
}): Promise<CsvMigrateResult> {
  if (!opts.scope?.org || !opts.scope.projectId || !opts.scope.token) throw new Error('migrate requires the guarded org, project, and token');
  const loaded = opts.loaded;
  // The schema as provisioned: recorded decisions replay when the caller has
  // them; otherwise the load falls back to the source's own measure (rows that
  // leave an appMandatory column empty load, while a column the source kept
  // store-level is refused — the existing constraint is never silently relaxed).
  const schema = opts.constraints
    ? applyConstraintDecisions(generateSchema(opts.app), opts.constraints)
    : loaded.sourceData
      ? generateSchema(opts.app, { source: loaded.sourceData })
      : applyConstraintDecisions(generateSchema(opts.app), loaded.constraints ?? []);
  const columnsByTable = loaderColumns(schema, loaded.tables, loaded.foreignKeys);
  const deferred = cyclicForeignKeys(
    loaded.tables.map((table) => table.table),
    loaded.foreignKeys,
    nonDeferrableKeys(schema, loaded.foreignKeys),
  );
  // Refuse before the first write: a report export that does not carry a column
  // the schema marks mandatory would load every earlier table and stop here. The
  // same guard catches a later load that repeats a value in a column the source
  // kept store-unique or leaves a store-mandatory column empty.
  const missing = mandatoryMissingRefusals(loaded.tables, columnsByTable);
  const uniqueDupes = duplicateUniqueRefusals(
    loaded.tables,
    Object.fromEntries(schema.tables.map((table) => [table.name, table.columns.filter((column) => column.unique).map((column) => column.name)])),
  );
  // loaded.missingMandatory was measured on this source's own schema at read
  // time; a replayed provisioned decision may have settled the column already,
  // so under an explicit replay the internal check is the only authority.
  const refused = [...(opts.constraints ? [] : loaded.missingMandatory), ...missing, ...uniqueDupes].filter(
    (item, index, all) => all.findIndex((other) => other.table === item.table && other.column === item.column && other.sourceId === item.sourceId && other.rule === item.rule) === index,
  );
  if (refused.length) {
    const names = [...new Set(refused.map((item) => `${item.table}.${item.column}`))].join(', ');
    const label = uniqueDupes.length
      ? `${refused.length} constraint violation(s)`
      : `${refused.length} missing mandatory value(s)`;
    return {
      ok: false,
      dryRun: false,
      tables: [],
      counts: [],
      skipped: loaded.skipped,
      relaxed: loaded.relaxed,
      fidelity: loaded.fidelity,
      integrity: { ...emptyIntegrity(), refusedByRule: groupRefusals(refused) },
      ...preferredGaps(loaded, []),
      error: `refused ${label} before any write: ${names} — the column is store-constrained; fix the source or re-provision it without the constraint`,
    };
  }
  const checkpoint = opts.checkpoint ?? emptyCheckpoint();
  const rowIds = new Map<string, Map<string, string>>();
  const written: MigrateResult['tables'] = [];
  const seeded: MigrateResult[] = [];
  // A failed table stops the writes — a child resolved against dropped rows
  // would write garbage foreign keys — but the read-back and count passes below
  // still run, so the report names every table that did not land.
  let failed = false;
  for (const table of loaded.tables) {
    const resolved = resolveForeignKeys(
      table,
      loaded.foreignKeys.filter((key) => !deferred.has(foreignKeyId(key))),
      rowIds,
    );
    const stripped = omitColumns(resolved, deferredColumns(table.table, deferred));
    // The remap this table's lookup cells went through, so a re-run can correct
    // a stored cell still holding the raw source id.
    const lookupSourceIds: Record<string, ReadonlyMap<string, string>> = {};
    for (const key of loaded.foreignKeys) {
      if (key.table !== table.table || deferred.has(foreignKeyId(key))) continue;
      const map = rowIds.get(key.parent);
      if (map) lookupSourceIds[key.column] = map;
    }
    const result = await migrateSeed({
      tables: [stripped],
      dc: opts.dc,
      catalystBase: opts.catalystBase,
      dryRun: false,
      fetch: opts.fetch,
      checkpoint,
      saveCheckpoint: opts.saveCheckpoint,
      scope: opts.scope,
      columnsByTable,
      ...(Object.keys(lookupSourceIds).length ? { lookupSourceIds: { [table.table]: lookupSourceIds } } : {}),
    });
    written.push(...result.tables);
    seeded.push(result);
    if (!result.ok) {
      failed = true;
      break;
    }
    rowIds.set(
      table.table,
      await loadRowIds(opts.fetch, opts.catalystBase, opts.dc, table.table, table.rows.map((row) => row.id), opts.scope),
    );
  }
  if (!failed && deferred.size > 0) await updateDeferredForeignKeys(opts, loaded.tables, loaded.foreignKeys, deferred, rowIds);
  const counts: CsvCount[] = [];
  const counted = new Set<string>();
  for (const item of loaded.expected) {
    const ids = loaded.tables.find((table) => table.table === item.table)?.rows.map((row) => row.id) ?? [];
    const catalyst = await loadCount(opts.fetch, opts.catalystBase, opts.dc, item.table, ids, opts.scope);
    counts.push({ form: item.form, table: item.table, expected: item.count, catalyst, mismatch: catalyst !== ids.length });
    counted.add(item.table);
  }
  for (const table of loaded.tables) {
    if (counted.has(table.table)) continue;
    const ids = table.rows.map((row) => row.id);
    const catalyst = await loadCount(opts.fetch, opts.catalystBase, opts.dc, table.table, ids, opts.scope);
    counts.push({ form: table.table, table: table.table, expected: ids.length, catalyst, mismatch: catalyst !== ids.length });
  }
  const ok = !failed && written.every((table) => !table.mismatch) && counts.every((item) => !item.mismatch);
  const warnings: string[] = [];
  const tables = new Set(loaded.tables.map((table) => table.table));
  for (const c of appShadowColumns(opts.app)) {
    if (!tables.has(c.table)) continue;
    const stale = countFrom(await query(opts.fetch, opts.catalystBase, opts.dc, staleShadowCountQuery(c), opts.scope));
    if (stale === undefined || stale > 0) {
      warnings.push(
        `${c.table}.${c.shadow}: ${stale === undefined ? 'an unknown number of' : stale} rows have a NULL shadow but a value in ${c.column}; decimal criteria read them all until you run ${backfillCommand(opts.scope.projectId, opts.scope.org)}`,
      );
    }
  }
  return {
    ok,
    dryRun: false,
    tables: written,
    counts,
    skipped: loaded.skipped,
    relaxed: loaded.relaxed,
    fidelity: loaded.fidelity,
    integrity: mergeIntegrity(seeded.map((item) => item.integrity)),
    ...preferredGaps(loaded, seeded),
    ...(warnings.length ? { warnings } : {}),
    ...(schema.constraints?.length ? { constraints: schema.constraints } : {}),
  };
}

function preferredGaps(loaded: CsvLoad, seen: readonly MigrateResult[]): { systemFieldGaps?: NonNullable<MigrateResult['systemFieldGaps']> } {
  if (loaded.systemFieldGaps?.length) return { systemFieldGaps: loaded.systemFieldGaps };
  const gaps = seen.flatMap((result) => result.systemFieldGaps ?? []);
  return gaps.length ? { systemFieldGaps: gaps } : {};
}

export function formatCsvPlan(loaded: CsvLoad, guard: Parameters<typeof planScopeLines>[0]): string {
  const lines = [
    'c2c migrate-data plan v1',
    `source: ${loaded.source}`,
    ...planScopeLines(guard),
    'credential: not checked',
    ...confirmGuardLines(),
    'confirm: no',
    '',
    'tables:',
    ...loaded.tables.map((table) => `- ${table.table} source ${table.rows.length}`),
    '',
    `counts: ${loaded.countsFrom === 'export' ? 'from the export' : loaded.countsFrom === 'backup' ? 'from the backup' : 'from counts.json'}`,
    ...loaded.expected.map((item) => `- ${item.form} ${item.count}`),
    ...formatNameList('notes', loaded.notes ?? []),
    '',
    ...formatSkipped(loaded.skipped),
    ...(loaded.relaxed.length ? ['', ...formatMandatoryRelaxed(loaded.relaxed)] : []),
    ...formatSystemFieldGaps(loaded.systemFieldGaps),
    ...formatColumnNotes(loaded.columns),
    ...formatNameList('missing required', loaded.missingRequired.map((item) => `${item.table}.${item.field}`)),
    ...formatNameList(
      'mandatory missing (confirm will refuse before any write)',
      loaded.missingMandatory.map((item) => `${item.table}.${item.column} row ${item.sourceId}`),
    ),
    ...formatNameList('derived ids', [
      ...loaded.derivedIds.map((item) => item.detail),
      ...(loaded.source === 'csv' && loaded.derivedIds.length ? ['CSV has no record ids; prefer the JSON export'] : []),
    ]),
    ...formatNameList('lookups', loaded.lookups.map((item) => `${item.table}.${item.column} matches ${item.parent} on ${item.by}`)),
    ...formatNameList('data fidelity', loaded.fidelity),
    ...formatNameList('ignored', loaded.ignored),
    '',
    'writes: no',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function tableSpecs(app: App, tables: readonly SchemaTable[]): TableSpec[] {
  const forms = new Map(app.forms.map((form) => [form.name, form]));
  // Generated state (the state-machine history table) has no source CSV.
  return tables.filter((table) => table.role !== 'system').map((table) => ({
    table: table.name,
    form: table.form,
    role: table.role,
    field: table.role === 'form' ? undefined : suffixField(table.name),
    ...(table.subform
      ? { subform: { form: table.subform.form, field: table.subform.field, parentTable: table.subform.parentTable, parentColumn: table.subform.parentColumn, orderColumn: table.subform.orderColumn } }
      : {}),
    columns: table.columns
      .filter((column) => column.name !== SOURCE_ID_COLUMN)
      .map((column) => colSpec(column, table.subform ? forms.get(table.form)?.fields.find((field) => field.name === table.subform?.field)?.subfields : forms.get(table.form)?.fields)),
  }));
}

function formatColumnNotes(notes: CsvColumnNote[]): string[] {
  if (!notes.length) return [];
  const lines = ['', 'columns:'];
  for (const note of notes) {
    lines.push(`- ${note.file} → ${note.table}`);
    lines.push(`  mapped: ${note.mapped.map((item) => `${item.header} → ${item.column}`).join(', ') || 'none'}`);
    lines.push(`  unmapped: ${note.unmapped.map((item) => `${item.header} (${item.reason})`).join(', ') || 'none'}`);
  }
  return lines;
}

function formatNameList(title: string, items: readonly string[]): string[] {
  if (!items.length) return [];
  return ['', `${title}:`, ...items.map((item) => `- ${item}`)];
}

function formatSystemFieldGaps(gaps: CsvLoad['systemFieldGaps']): string[] {
  if (!gaps?.length) return [];
  return ['', 'system fields:', ...gaps.map((gap) => `- ${gap.table} missing ${gap.missing.join(', ')}`), `- ${gaps[0]!.detail}`];
}

function missingSystemHeaders(spec: TableSpec, files: { headers: string[] }[] | undefined): string[] {
  if (!files?.length) return [];
  const system = spec.columns.filter((column) => SYSTEM_FIELD_NAMES.has(column.column));
  if (!system.length) return [];
  const headers = new Set<string>();
  for (const file of files) for (const cell of file.headers) headers.add(norm(cell));
  return system.filter((column) => ![...column.headers].some((header) => headers.has(header))).map((column) => column.column);
}

function suffixField(table: string): string | undefined {
  const index = table.lastIndexOf('__');
  if (index < 0) return undefined;
  return table.slice(index + 2);
}

function colSpec(column: SchemaColumn, fields: readonly Field[] | undefined): ColSpec {
  if (column.shadowFor) return { column: column.name, field: column.name, kind: 'decimal', headers: new Set(), shadowFor: column.shadowFor };
  const source = column.field ?? column.name;
  const headers = new Set<string>([norm(source)]);
  const field = fields?.find((item) => item.name === source || (column.field === undefined && column.name.startsWith(`${item.name}_`)));
  if (field?.name === source) {
    headers.add(norm(field.name));
    if (field.displayName) headers.add(norm(field.displayName));
  } else if (field && column.name.startsWith(`${field.name}_`)) {
    const part = column.name.slice(field.name.length + 1);
    headers.add(norm(`${field.name}.${part}`));
    headers.add(norm(`${field.name}_${part}`));
    headers.add(norm(part));
  }
  if (column.name === 'parent_id') headers.add(norm('Parent_ID'));
  if (column.name === 'Added_Time') headers.add('createdtime');
  if (column.name === 'Modified_Time') headers.add('modifiedtime');
  if (SYSTEM_FIELD_NAMES.has(column.name)) headers.add(norm(column.name.replace(/_/g, ' ')));
  return {
    column: column.name,
    field: source,
    kind: cellKind(column),
    headers,
    ...(column.relation ? { parent: column.relation.table } : {}),
    ...(field?.name === source && field.lookup?.displayFormat ? { displayFormat: field.lookup.displayFormat } : {}),
    ...(column.exactDecimal ? { scale: column.precision ?? 2 } : {}),
  };
}

export function cellKind(column: SchemaColumn): CellKind {
  if (column.relation || column.matrixId === 'lookup-single' || column.matrixId === 'lookup-multi') return 'lookup';
  switch (column.matrixId) {
    case 'date':
      return 'date';
    case 'date-time':
      return 'datetime';
    case 'decimal':
    case 'percent':
    case 'currency':
      return 'decimal';
    case 'decision-box':
      return 'bool';
    case 'multi-select':
    case 'checkbox-multi':
      return 'multi';
    case 'file-upload':
    case 'image':
    case 'audio':
    case 'video':
    case 'signature':
      return 'file';
    case 'number':
    case 'auto-number':
    case 'users':
      return 'number';
    default:
      if (column.dataType === 'Double') return 'decimal';
      if (column.dataType === 'Boolean') return 'bool';
      if (column.dataType === 'Date') return 'date';
      if (column.dataType === 'DateTime') return 'datetime';
      return 'text';
  }
}

function resolveFile(fileName: string, reports: Map<string, Report>, forms: Map<string, Form>, specs: readonly TableSpec[]): string {
  const base = fileName.replace(/\.(csv|json)$/i, '');
  const report = reports.get(base);
  if (report?.form) {
    const spec = specs.find((item) => item.role === 'form' && item.form === report.form);
    if (!spec) throw new Error(`${fileName} does not match a Data Store form`);
    return spec.table;
  }
  if (forms.has(base)) {
    const spec = specs.find((item) => item.role === 'form' && item.form === base);
    if (!spec) throw new Error(`${fileName} does not match a Data Store form`);
    return spec.table;
  }
  const nested = specs.find((item) => item.role !== 'form' && (item.table === base || (item.field !== undefined && base === `${item.form}__${item.field}`)));
  if (nested) return nested.table;
  throw new Error(`${fileName} does not match a report, form, or subform`);
}

function parseCsvSheet(file: string, text: string): SourceSheet {
  const parsed = parseCsv(text);
  const headers = (parsed[0] ?? []).map((cell) => cell.trim());
  const rows = parsed.slice(1).map((record) => headers.map((_, index) => record[index] ?? ''));
  return { file, headers, rows };
}

function parseJsonSheet(file: string, text: string): SourceSheet {
  let parsed: unknown;
  try {
    parsed = parseJsonExact(text);
  } catch {
    throw new Error(`JSON ${file} is not JSON`);
  }
  const records = jsonRecords(parsed, file);
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
    }
  }
  return { file, headers, rows: records.map((record) => headers.map((key) => jsonCell(record[key], file))) };
}

function jsonRecords(parsed: unknown, file: string): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed.map((row, index) => jsonObject(row, file, index));
  const lists = parsed && typeof parsed === 'object' ? Object.values(parsed).filter((item) => Array.isArray(item)) : [];
  if (lists.length !== 1) throw new Error(`JSON ${file} does not contain one record list`);
  return (lists[0] as unknown[]).map((row, index) => jsonObject(row, file, index));
}

function jsonObject(row: unknown, file: string, index: number): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`JSON ${file} row ${index + 1} is not an object`);
  return row as Record<string, unknown>;
}

function jsonCell(value: unknown, file: string): RawCell {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return { list: value.map((item) => jsonCell(item, file)) };
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const id = record.ID ?? record.Id ?? record.id;
    if (typeof id === 'string' || typeof id === 'number') return { id: exactId(id, `ID in ${file}`) };
    const composite: Record<string, string> = {};
    const nested: Record<string, RawCell> = {};
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') composite[key] = String(item);
      else if (item !== null && item !== undefined) nested[key] = jsonCell(item, file);
    }
    if (Object.keys(nested).length) return { row: { ...composite, ...nested } };
    return { composite };
  }
  return '';
}

interface PlannedFile {
  sheet: SourceSheet;
  hasId: boolean;
  hits: ('id' | HeaderHit)[];
  mapped: { header: string; column: string }[];
  unmapped: { header: string; reason: string }[];
  /** Flattened subform columns and how many non-empty cells they hold. */
  fidelity: { header: string; subform: string; cells: number }[];
  covered: Set<string>;
  mappedColumns: Set<string>;
}

interface IdPlan {
  from: 'unique' | 'mapped' | 'values';
  names: string[];
}

function materialize(
  spec: TableSpec,
  files: readonly SourceSheet[],
  specs: readonly TableSpec[],
  form: Form | undefined,
  reports: Map<string, Report>,
): Materialized {
  const plans = files.filter((file) => file.headers.length).map((file) => planFile(file, spec, specs, form, reports));
  const idFiles = plans.filter((plan) => !plan.hasId);
  const idPlan = idColumnSet(spec, form, idFiles);
  const derived = idFiles.length ? [{ table: spec.table, detail: derivedDetail(spec.table, idPlan) }] : [];
  const rows = new Map<string, SeedRow>();
  const raw = new Map<string, Record<string, string>>();
  const pending: PendingLink[] = [];
  const authoritative: string[] = [];
  const children = new Map<string, ChildAcc>();
  for (const plan of plans) {
    const seen = new Map<string, number>();
    let rowIndex = 0;
    for (const record of plan.sheet.rows) {
      rowIndex += 1;
      const columns: Record<string, string> = {};
      const rawCells: Record<string, string> = {};
      const idInputs: Record<string, string> = {};
      const rowPending: PendingLink[] = [];
      const authColumns: string[] = [];
      const subAcc = new Map<string, { hit: Extract<HeaderHit, { kind: 'subform' }>; lists: { header: string; items: Record<string, RawCell>[]; proved: boolean }[] }>();
      let explicit = '';
      plan.hits.forEach((hit, index) => {
        const header = plan.sheet.headers[index] ?? '';
        const cell = record[index] ?? '';
        if (hit === 'id') {
          explicit = cellString(cell).trim();
          return;
        }
        if (hit.kind === 'unmapped') return;
        if (hit.kind === 'subform') {
          const acc = subAcc.get(hit.field.name) ?? { hit, lists: [] };
          const items = subformElements(hit, cell, header, plan.sheet.file, rowIndex);
          acc.lists.push({ header, items, proved: typeof cell !== 'string' || commaProved(hit) });
          subAcc.set(hit.field.name, acc);
          return;
        }
        if (hit.kind === 'junction') {
          const column = junctionColumn(hit.table, hit.column, specs);
          relatedValues(cell).forEach((related, order) => {
            rowPending.push({
              table: hit.table,
              parentId: '',
              column: hit.column,
              parent: column?.parent ?? '',
              displayFormat: column?.displayFormat,
              raw: related.raw,
              file: plan.sheet.file,
              authoritative: related.authoritative,
              order,
            });
          });
          return;
        }
        if (hit.kind === 'composite') {
          writeComposite(hit.field, cell, spec, columns, rawCells, idInputs);
          return;
        }
        writeColumn(header, cell, hit, plan.sheet.file, columns, rawCells, idInputs, authColumns);
      });
      const names = idPlan.from === 'values' ? Object.keys(idInputs).sort() : idPlan.names;
      const id = plan.hasId ? explicit : sourceHash(names, idInputs);
      if (plan.hasId && !id) throw new Error(`${plan.sheet.file} has a row with an empty ID`);
      if (!plan.hasId) {
        const first = seen.get(id);
        if (first !== undefined) {
          throw new Error(`${plan.sheet.file} rows ${first} and ${rowIndex} derive the same record id; c2c_source_id must be unique per table`);
        }
        seen.set(id, rowIndex);
      }
      for (const acc of subAcc.values()) {
        const n = Math.max(0, ...acc.lists.map((list) => list.items.length));
        for (const list of acc.lists) {
          if (list.items.length && list.items.length !== n) {
            throw new Error(`"${list.header}" in ${plan.sheet.file} row ${rowIndex} holds ${list.items.length} ${acc.hit.field.name} row(s) but a sibling column holds ${n}`);
          }
        }
        const accTable = children.get(acc.hit.child.table) ?? { spec: acc.hit.child, field: acc.hit.field, rows: new Map(), raw: new Map(), written: new Set(), contrib: new Map() };
        children.set(acc.hit.child.table, accTable);
        if (n > 0) {
          const contribs = accTable.contrib.get(id) ?? [];
          for (const prior of contribs) {
            if (prior.file !== plan.sheet.file && prior.count !== n) {
              throw new Error(`${plan.sheet.file} row ${rowIndex} holds ${n} ${acc.hit.field.name} row(s) for ${id} but ${prior.file} row ${prior.row} holds ${prior.count}`);
            }
          }
          contribs.push({
            file: plan.sheet.file,
            row: rowIndex,
            header: acc.lists[0]?.header ?? acc.hit.field.name,
            count: n,
            proved: acc.lists.some((list) => list.proved && list.items.length > 0),
          });
          accTable.contrib.set(id, contribs);
        }
        for (let i = 0; i < n; i += 1) {
          const childId = `${id}__${acc.hit.field.name}__${i}`;
          const childColumns: Record<string, string> = {
            [acc.hit.child.subform!.parentColumn]: id,
            [acc.hit.child.subform!.orderColumn]: String(i),
          };
          const childRaw: Record<string, string> = {};
          const childAuth: string[] = [];
          for (const list of acc.lists) {
            const element = list.items[i];
            if (!element) continue;
            for (const [subName, value] of Object.entries(element)) {
              const sub = acc.hit.field.subfields.find((item) => item.name === subName)!;
              const col = acc.hit.child.columns.find((column) => column.field === sub.name);
              accTable.written.add(sub.name);
              if (col) {
                const prior = childColumns[col.column];
                writeColumn(list.header, value, { kind: 'column', column: col, displayTrue: fieldProp(sub, 'displaytrue'), displayFalse: fieldProp(sub, 'displayfalse') }, plan.sheet.file, childColumns, childRaw, {}, childAuth);
                if (prior !== undefined && childColumns[col.column] !== prior) {
                  throw new Error(`"${list.header}" in ${plan.sheet.file} row ${rowIndex} conflicts with another ${acc.hit.field.name}.${sub.name} column`);
                }
              } else if (isComposite(sub)) {
                writeComposite(sub, value, acc.hit.child, childColumns, childRaw, {});
              }
            }
          }
          fillShadows(acc.hit.child, childColumns);
          const existingChild = accTable.rows.get(childId);
          if (!existingChild) {
            accTable.rows.set(childId, { id: childId, columns: childColumns });
            accTable.raw.set(childId, childRaw);
          } else {
            mergeColumns(existingChild, childColumns, plan.sheet.file);
            const existingRaw = accTable.raw.get(childId) ?? {};
            mergeRaw(childId, existingRaw, childRaw, plan.sheet.file);
            accTable.raw.set(childId, existingRaw);
          }
          for (const column of childAuth) authoritative.push(`${acc.hit.child.table}\0${childId}\0${column}`);
        }
      }
      for (const column of authColumns) authoritative.push(`${spec.table}\0${id}\0${column}`);
      for (const link of rowPending) pending.push({ ...link, parentId: id });
      fillShadows(spec, columns);
      const existing = rows.get(id);
      if (!existing) {
        rows.set(id, { id, columns });
        raw.set(id, rawCells);
      } else {
        mergeColumns(existing, columns, plan.sheet.file);
        const existingRaw = raw.get(id) ?? {};
        mergeRaw(id, existingRaw, rawCells, plan.sheet.file);
        raw.set(id, existingRaw);
      }
    }
  }
  // A comma split that no independent column confirms is a guess, not a read.
  for (const acc of children.values()) {
    for (const [parentId, contribs] of acc.contrib) {
      if (contribs.some((contrib) => contrib.proved)) continue;
      const suspect = contribs.find((contrib) => contrib.count > 1);
      if (!suspect) continue;
      throw new Error(`"${suspect.header}" in ${suspect.file} row ${suspect.row}: the ${acc.field.name} split into ${suspect.count} rows is not provable — no lookup, number, or date column confirms it for ${parentId}; export the JSON report`);
    }
  }
  const covered = new Set<string>();
  for (const plan of plans) for (const name of plan.covered) covered.add(name);
  const fidelity = plans.flatMap((plan) =>
    plan.fidelity.map((item) => `${plan.sheet.file} column "${item.header}" is subform ${item.subform} flattened in the export: ${item.cells} non-empty cell(s) will not be written`),
  );
  if (plans.length && form) {
    for (const field of form.fields) {
      if (!isSubform(field) || field.lookup || !field.subfields.length) continue;
      const child = childSpecOf(field, specs);
      if (!child) continue;
      const acc = children.get(child.table);
      if (!acc) {
        fidelity.push(`${child.table} (${spec.table}.${field.name}) has no flattened columns in the export; its rows are not carried`);
        continue;
      }
      const missing = field.subfields.filter((sub) => !acc.written.has(sub.name)).map((sub) => sub.name);
      if (missing.length) fidelity.push(`${child.table} omits ${missing.join(', ')}: not in the flattened ${field.name} columns`);
    }
  }
  const gaps = fieldGaps(spec, form, plans.length > 0, covered);
  return {
    table: { table: spec.table, rows: [...rows.values()] },
    pending,
    raw,
    notes: plans.map((plan) => ({ file: plan.sheet.file, table: spec.table, mapped: plan.mapped, unmapped: plan.unmapped })),
    missingRequired: gaps.missingRequired,
    absentFields: gaps.absentFields,
    derived,
    authoritative,
    fidelity,
    children,
  };
}

function planFile(file: SourceSheet, spec: TableSpec, specs: readonly TableSpec[], form: Form | undefined, reports: Map<string, Report>): PlannedFile {
  const report = reports.get(file.file.replace(/\.(csv|json)$/i, ''));
  const reportMap = reportHeaderMap(report);
  const hits = file.headers.map((header) => (isIdHeader(header) ? 'id' as const : mapHeader(header, file.file, spec, specs, form, report, reportMap)));
  const mapped: PlannedFile['mapped'] = [];
  const unmapped: PlannedFile['unmapped'] = [];
  const fidelity: PlannedFile['fidelity'] = [];
  const covered = new Set<string>();
  const mappedColumns = new Set<string>();
  hits.forEach((hit, index) => {
    const header = file.headers[index] ?? '';
    if (hit === 'id') return;
    if (hit.kind === 'column') {
      mapped.push({ header, column: hit.column.column });
      mappedColumns.add(hit.column.column);
      coverName(covered, hit.column.column, form);
      return;
    }
    if (hit.kind === 'composite') {
      const parts = compositeColumns(spec, hit.field);
      if (parts.length) for (const column of parts) mapped.push({ header, column });
      else mapped.push({ header, column: hit.field.name });
      for (const column of parts) mappedColumns.add(column);
      covered.add(hit.field.name);
      return;
    }
    if (hit.kind === 'junction') {
      mapped.push({ header, column: hit.column });
      return;
    }
    if (hit.kind === 'subform') {
      mapped.push({ header, column: `${hit.child.table}.${hit.parts.map((part) => part.column?.column ?? part.field.name).join(' + ')}` });
      covered.add(hit.field.name);
      return;
    }
    if (hit.subform !== undefined) {
      const cells = file.rows.filter((record) => cellString(record[index] ?? '').trim() !== '').length;
      fidelity.push({ header, subform: hit.subform, cells });
    }
    unmapped.push({ header, reason: hit.reason });
    if (hit.cover) covered.add(hit.cover);
  });
  return { sheet: file, hasId: hits.includes('id'), hits, mapped, unmapped, fidelity, covered, mappedColumns };
}

function idColumnSet(spec: TableSpec, form: Form | undefined, idFiles: readonly PlannedFile[]): IdPlan {
  if (!idFiles.length) return { from: 'mapped', names: [] };
  const unique = uniqueNames(form, spec).filter((name) => idFiles.every((file) => file.mappedColumns.has(name)));
  if (unique.length) return { from: 'unique', names: unique };
  const sets = idFiles.map((file) => file.mappedColumns);
  const shared = [...sets[0]!].filter((name) => sets.every((set) => set.has(name)) && !spec.columns.some((column) => column.column === name && column.shadowFor)).sort();
  if (shared.length) return { from: 'mapped', names: shared };
  return { from: 'values', names: [] };
}

function uniqueNames(form: Form | undefined, spec: TableSpec): string[] {
  if (!form) return [];
  return form.fields
    .filter((field) => field.unique)
    .flatMap((field) => spec.columns.filter((column) => column.field === field.name && !column.shadowFor).map((column) => column.column))
    .sort();
}

function derivedDetail(table: string, plan: IdPlan): string {
  if (plan.from === 'values') return `${table} from mapped values`;
  return `${table} from ${plan.from} columns ${plan.names.join(', ')}`;
}

function sourceHash(names: readonly string[], values: Readonly<Record<string, string>>): string {
  // An ordered [name, value] pair list is unambiguous even when a value holds a
  // newline or a '='; a "name=value\n" join is not.
  const body = JSON.stringify(names.map((name) => [name, values[name] ?? null]));
  return `d_${createHash('sha256').update(body).digest('hex')}`;
}

function mapHeader(
  header: string,
  file: string,
  spec: TableSpec,
  specs: readonly TableSpec[],
  form: Form | undefined,
  report: Report | undefined,
  reportMap: Map<string, ReportHeader>,
): HeaderHit {
  const flattened = (sub: Field): HeaderHit => ({ kind: 'unmapped', reason: `subform ${sub.name} is flattened in the export`, cover: sub.name, subform: sub.name });
  if (header.includes('.')) {
    const dot = header.indexOf('.');
    const tail = header.slice(dot + 1);
    const sub = spec.role === 'form' ? form?.fields.find((field) => isSubform(field) && normKey(field.name) === normKey(header.slice(0, dot))) : undefined;
    if (sub) {
      // A dotted key may carry a composite expression column; the export names it
      // after the expression's first field.
      return exprColumnHit(sub, tail, report, specs) ?? dottedSubformHit(sub, tail, specs) ?? flattened(sub);
    }
    // `Name.first_name` is a composite part, the header Creator's report import uses.
    const composite = form?.fields.find((field) => isComposite(field) && normKey(field.name) === normKey(header.slice(0, dot)));
    const part = composite ? spec.columns.find((column) => !column.shadowFor && column.column === `${composite.name}_${tail}`) : undefined;
    if (part) return { kind: 'column', column: part };
    return { kind: 'unmapped', reason: `related column ${header}` };
  }
  const columns = spec.columns.filter((column) => !column.shadowFor);
  let hits = columns.filter((column) => headerMatches(column, header));
  const reportHit = reportMap.get(normKey(header));
  if (reportHit && !reportHit.field.includes('.')) {
    const column = columns.find((item) => item.field === reportHit.field);
    if (column && !hits.includes(column)) hits = [...hits, column];
  }
  if (reportHit?.field.includes('.') && !hits.length) {
    const dot = reportHit.field.indexOf('.');
    const sub = spec.role === 'form' ? form?.fields.find((field) => isSubform(field) && field.name === reportHit.field.slice(0, dot)) : undefined;
    if (sub) {
      if (reportHit.expr) {
        const child = childSpecOf(sub, specs);
        const parts = child ? subformExpression(sub, reportHit.expr, child) : undefined;
        if (child && parts) return { kind: 'subform', field: sub, child, parts };
      }
      return dottedSubformHit(sub, reportHit.field.slice(dot + 1), specs) ?? flattened(sub);
    }
    return { kind: 'unmapped', reason: `related column ${reportHit.field}` };
  }
  if (hits.length > 1) {
    const exact = hits.filter((column) => normKey(column.column) === normKey(header) || norm(column.column) === norm(header));
    if (exact.length === 1) hits = exact;
    else throw new Error(`${file} header ${header} matches more than one column`);
  }
  if (hits.length === 1) {
    const column = hits[0]!;
    return { kind: 'column', column, ...boolLabels(column, form, report, reportHit) };
  }
  const composite = form?.fields.find((field) => isComposite(field) && (normKey(field.name) === normKey(header) || (field.displayName !== undefined && normKey(field.displayName) === normKey(header))));
  if (composite) return { kind: 'composite', field: composite };
  const sub = spec.role === 'form' ? form?.fields.find((field) => isSubform(field) && subformHeader(field, header, reportHit)) : undefined;
  if (sub) {
    if (sub.lookup || !sub.subfields.length) return flattened(sub);
    const child = childSpecOf(sub, specs);
    if (!child) return flattened(sub);
    const expr = reportHit?.field === sub.name ? reportHit.expr : undefined;
    const parts = expr ? subformExpression(sub, expr, child) : undefined;
    return parts ? { kind: 'subform', field: sub, child, parts } : flattened(sub);
  }
  if (spec.role === 'form') {
    const junction = junctionHit(header, spec, specs);
    if (junction) return { kind: 'junction', table: junction.table, column: junction.column };
  }
  return { kind: 'unmapped', reason: 'no matching field' };
}

/** The generated child table for an inline subform field, when the schema expanded it. */
function childSpecOf(field: Field, specs: readonly TableSpec[]): TableSpec | undefined {
  return specs.find((spec) => spec.role === 'child' && spec.subform?.field === field.name);
}

function subFieldOf(field: Field, name: string): Field | undefined {
  return field.subfields.find((item) => normKey(item.name) === normKey(name) || (item.displayName !== undefined && normKey(item.displayName) === normKey(name)));
}

function subFieldColumn(child: TableSpec, sub: Field): ColSpec | undefined {
  return child.columns.find((column) => column.field === sub.name);
}

/** A report column with a display expression is keyed by its first field in a JSON export. */
function exprColumnHit(field: Field, tail: string, report: Report | undefined, specs: readonly TableSpec[]): HeaderHit | undefined {
  const child = childSpecOf(field, specs);
  if (!child || !report) return undefined;
  const visit = (columns: readonly ReportColumn[]): HeaderHit | undefined => {
    for (const column of columns) {
      const expr = propValue(column.properties, 'field');
      if (expr) {
        const parts = subformExpression(field, expr, child);
        if (parts && normKey(parts[0]!.field.name) === normKey(tail)) return { kind: 'subform', field, child, parts };
      }
      const nested = visit(column.subcolumns ?? []);
      if (nested) return nested;
    }
    return undefined;
  };
  return visit(report.columns);
}

/** A `Subform.Field` column carries one child field per element, comma-joined. */
function dottedSubformHit(field: Field, tail: string, specs: readonly TableSpec[]): HeaderHit | undefined {
  if (field.lookup || !field.subfields.length) return undefined;
  const child = childSpecOf(field, specs);
  const sub = subFieldOf(field, tail);
  if (!child || !sub) return undefined;
  return { kind: 'subform', field, child, parts: [{ field: sub, column: subFieldColumn(child, sub) }] };
}

/**
 * `Sub.A + " - " + Sub.B` in a report column joins child fields with literal
 * text. Returns the parts in order, or undefined when the expression is not a
 * field/literal chain over this one subform.
 */
function subformExpression(field: Field, expr: string, child: TableSpec): SubPart[] | undefined {
  const tokens = expr.match(/"((?:[^"\\]|\\.)*)"|([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)?)|\+|./gsu);
  if (!tokens?.length) return undefined;
  const parts: SubPart[] = [];
  let pending = '';
  let wantField = true;
  for (const token of tokens) {
    if (token === '+' || !token.trim()) continue;
    if (token.startsWith('"')) {
      if (wantField) return undefined;
      pending += token.slice(1, -1).replace(/\\(.)/gs, '$1');
      continue;
    }
    if (!/^[\p{L}_][\p{L}\p{N}_]*\.[\p{L}_][\p{L}\p{N}_]*$/u.test(token)) return undefined;
    const dot = token.indexOf('.');
    if (token.slice(0, dot) !== field.name) return undefined;
    const sub = subFieldOf(field, token.slice(dot + 1));
    if (!sub) return undefined;
    // Two fields joined with no literal between them cannot be split back apart.
    if (parts.length && !pending) return undefined;
    parts.push({ field: sub, separator: parts.length ? pending : undefined, column: subFieldColumn(child, sub) });
    pending = '';
    wantField = false;
  }
  return parts.length && !wantField && !pending ? parts : undefined;
}

/**
 * A flattened subform cell is the child rows joined on commas — or, for a JSON
 * export, a real list/object. Each element becomes a subfield-name → cell map.
 * A string element of a multi-part column is split on the literal separators of
 * the report expression; a separator that is missing or repeats is refused.
 */
function subformElements(hit: Extract<HeaderHit, { kind: 'subform' }>, cell: RawCell, header: string, file: string, rowIndex: number): Record<string, RawCell>[] {
  const single = hit.parts.length === 1 ? hit.parts[0]! : undefined;
  const element = (item: RawCell): Record<string, RawCell> => {
    if (typeof item === 'string') return splitSubformElement(hit, item, header, file, rowIndex);
    if ('id' in item) {
      if (!single) throw new Error(`"${header}" in ${file} row ${rowIndex} holds a record id where ${hit.field.name} needs ${hit.parts.length} fields`);
      return { [single.field.name]: item };
    }
    if ('composite' in item || 'row' in item) {
      const entries = 'composite' in item ? Object.entries(item.composite) : Object.entries(item.row);
      const out: Record<string, RawCell> = {};
      for (const [key, value] of entries) {
        const sub = subFieldOf(hit.field, key);
        if (!sub) throw new Error(`"${header}" in ${file} row ${rowIndex}: ${key} is not a field of subform ${hit.field.name}`);
        out[sub.name] = value;
      }
      return out;
    }
    throw new Error(`"${header}" in ${file} row ${rowIndex} holds a nested list where a ${hit.field.name} row was expected`);
  };
  if (typeof cell === 'string') {
    if (!cell.trim()) return [];
    // Rows are joined with a bare ',' — a piece starting with whitespace means
    // the comma sat inside a value, and a numeric column can hide a grouping
    // comma ("1,000" is one number, not two rows). Neither is a readable split.
    const pieces = cell.split(',');
    for (let i = 1; i < pieces.length; i += 1) {
      if (/^\s/.test(pieces[i]!)) {
        throw new Error(`"${header}" in ${file} row ${rowIndex}: a comma inside a ${hit.field.name} value cannot be told from a row break; export the JSON report`);
      }
    }
    if (pieces.length > 1) refuseNumericSplit(hit, cell, header, file, rowIndex);
    return pieces.map((part) => element(part));
  }
  if ('list' in cell) return cell.list.map(element);
  return [element(cell)];
}

/**
 * A comma split of a numeric column is believable only when no piece can be a
 * grouping tail: refuse "1,000" and "2,300", allow "2,3".
 */
function refuseNumericSplit(hit: Extract<HeaderHit, { kind: 'subform' }>, cell: string, header: string, file: string, rowIndex: number): void {
  if (hit.parts.length !== 1) return;
  const part = hit.parts[0]!;
  const kind = part.column?.kind;
  if (kind !== 'number' && kind !== 'decimal') return;
  const pieces = cell.split(',');
  const whole = cell.trim();
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(whole) || pieces.slice(1).some((piece) => /^\d{3}(\.\d+)?$/.test(piece.trim()))) {
    throw new Error(`"${header}" in ${file} row ${rowIndex}: "${whole}" reads as a grouped ${hit.field.name}.${part.field.name} number, not ${pieces.length} rows; export the JSON report`);
  }
}

/** A piece headed for a numeric subfield must already be a plain number. */
function checkSubNumeric(hit: Extract<HeaderHit, { kind: 'subform' }>, part: SubPart, value: string, header: string, file: string, rowIndex: number): string {
  const kind = part.column?.kind;
  const ok = kind === 'number' ? /^-?\d+$/.test(value) : kind === 'decimal' ? /^-?\d+(\.\d+)?$/.test(value) : true;
  if (!ok) throw new Error(`"${header}" in ${file} row ${rowIndex}: "${value}" is not a ${hit.field.name}.${part.field.name} number`);
  return value;
}

const COMMA_PROOF_KINDS: ReadonlySet<CellKind> = new Set(['lookup', 'number', 'decimal', 'date', 'datetime', 'bool']);

/**
 * What makes a comma split provable: a JSON list/object carries real structure,
 * a multi-field expression column must show its separator in every element, and
 * a lookup, number, or date column refuses a piece that is not a real value.
 */
function commaProved(hit: Extract<HeaderHit, { kind: 'subform' }>): boolean {
  if (hit.parts.length > 1) {
    return hit.parts.every((part, index) => index === 0 || (part.separator !== undefined && part.separator.length > 0 && !part.separator.includes(',')));
  }
  const kind = hit.parts[0]?.column?.kind;
  return kind !== undefined && COMMA_PROOF_KINDS.has(kind);
}

/** Split one comma element into the expression's fields, on each literal exactly once. */
function splitSubformElement(hit: Extract<HeaderHit, { kind: 'subform' }>, text: string, header: string, file: string, rowIndex: number): Record<string, RawCell> {
  if (hit.parts.length === 1) return { [hit.parts[0]!.field.name]: checkSubNumeric(hit, hit.parts[0]!, text.trim(), header, file, rowIndex) };
  let rest = text;
  const out: Record<string, RawCell> = {};
  for (let i = 0; i < hit.parts.length - 1; i += 1) {
    const sep = hit.parts[i + 1]!.separator!;
    const at = rest.indexOf(sep);
    if (at < 0 || rest.indexOf(sep, at + sep.length) >= 0) {
      throw new Error(`"${header}" in ${file} row ${rowIndex}: "${text}" does not split into ${hit.field.name} fields on "${sep}"`);
    }
    out[hit.parts[i]!.field.name] = checkSubNumeric(hit, hit.parts[i]!, rest.slice(0, at).trim(), header, file, rowIndex);
    rest = rest.slice(at + sep.length);
  }
  const last = hit.parts.at(-1)!;
  out[last.field.name] = checkSubNumeric(hit, last, rest.trim(), header, file, rowIndex);
  return out;
}

function subformHeader(field: Field, header: string, reportHit: ReportHeader | undefined): boolean {
  if (normKey(field.name) === normKey(header)) return true;
  if (field.displayName && normKey(field.displayName) === normKey(header)) return true;
  return reportHit !== undefined && (reportHit.field === field.name || reportHit.field.startsWith(`${field.name}.`));
}

function isComposite(field: Field): boolean {
  const type = (field.type ?? '').toLowerCase();
  return type === 'name' || type === 'address';
}

function isSubform(field: Field): boolean {
  const type = (field.type ?? '').toLowerCase();
  return type === 'grid' || type === 'subform' || type === 'inline subform' || type === 'form';
}

function reportHeaderMap(report: Report | undefined): Map<string, ReportHeader> {
  const map = new Map<string, ReportHeader>();
  if (!report) return map;
  const visit = (column: ReportColumn) => {
    const header: ReportHeader = { field: column.field };
    const displayTrue = propValue(column.properties, 'displaytrue');
    const displayFalse = propValue(column.properties, 'displayfalse');
    const expr = propValue(column.properties, 'field');
    if (displayTrue) header.displayTrue = displayTrue;
    if (displayFalse) header.displayFalse = displayFalse;
    if (expr) header.expr = expr;
    const keys: string[] = [];
    if (column.label) keys.push(normKey(column.label));
    if (column.field && !column.field.includes('.')) keys.push(normKey(column.field));
    for (const key of keys) if (key && !map.has(key)) map.set(key, header);
    for (const sub of column.subcolumns ?? []) visit(sub);
  };
  for (const column of report.columns) visit(column);
  return map;
}

function boolLabels(column: ColSpec, form: Form | undefined, report: Report | undefined, reportHit: ReportHeader | undefined): { displayTrue?: string; displayFalse?: string } {
  const field = form?.fields.find((item) => item.name === column.field);
  const fromReport = reportHit && reportHit.field === column.field ? reportHit : reportFieldLabels(report, column.field);
  const displayTrue = fromReport?.displayTrue ?? fieldProp(field, 'displaytrue');
  const displayFalse = fromReport?.displayFalse ?? fieldProp(field, 'displayfalse');
  return {
    ...(displayTrue ? { displayTrue } : {}),
    ...(displayFalse ? { displayFalse } : {}),
  };
}

function reportFieldLabels(report: Report | undefined, field: string): ReportHeader | undefined {
  if (!report) return undefined;
  const found = report.columns.find((column) => column.field === field);
  if (!found) return undefined;
  const header: ReportHeader = { field };
  const displayTrue = propValue(found.properties, 'displaytrue');
  const displayFalse = propValue(found.properties, 'displayfalse');
  if (displayTrue) header.displayTrue = displayTrue;
  if (displayFalse) header.displayFalse = displayFalse;
  return header;
}

function propValue(properties: { key: string; value: string }[] | undefined, key: string): string | undefined {
  const found = properties?.find((item) => item.key.toLowerCase() === key);
  if (!found) return undefined;
  const value = unquote(found.value).trim();
  return value || undefined;
}

function fieldProp(field: Field | undefined, key: string): string | undefined {
  return propValue(field?.properties, key);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1);
  return trimmed;
}

function headerMatches(column: ColSpec, header: string): boolean {
  const key = normKey(header);
  if (normKey(column.column) === key) return true;
  for (const item of column.headers) if (item === norm(header) || normKey(item) === key) return true;
  return false;
}

function writeColumn(
  header: string,
  cell: RawCell,
  hit: Extract<HeaderHit, { kind: 'column' }>,
  file: string,
  columns: Record<string, string>,
  rawCells: Record<string, string>,
  idInputs: Record<string, string>,
  authColumns: string[],
): void {
  const column = hit.column;
  if (typeof cell !== 'string' && 'list' in cell && column.kind === 'multi') {
    const values = cell.list.map((item) => cellString(item).trim()).filter((item) => item.length > 0);
    if (!values.length) return;
    const value = JSON.stringify(values);
    columns[column.column] = value;
    idInputs[column.column] = value;
    return;
  }
  if (typeof cell !== 'string' && 'id' in cell) {
    const text = cell.id.trim();
    if (!text) return;
    columns[column.column] = text;
    rawCells[column.column] = text;
    idInputs[column.column] = text;
    if (column.kind === 'lookup') authColumns.push(column.column);
    return;
  }
  if (typeof cell !== 'string' && ('composite' in cell || 'row' in cell)) {
    if (column.kind === 'lookup') throw new Error(`lookup ${column.column} in ${file} must be a record ID, not a display value`);
    return;
  }
  const text = cellString(cell);
  const value = convertCell(header, text, column, file, { displayTrue: hit.displayTrue, displayFalse: hit.displayFalse });
  if (value === undefined) return;
  columns[column.column] = value;
  rawCells[column.column] = text.trim();
  idInputs[column.column] = column.kind === 'lookup' ? text.trim() : value;
}

function writeComposite(field: Field, cell: RawCell, spec: TableSpec, columns: Record<string, string>, rawCells: Record<string, string>, idInputs: Record<string, string>): void {
  const scalarEntries = typeof cell !== 'string' && 'row' in cell ? Object.fromEntries(Object.entries(cell.row).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined;
  const parts = typeof cell !== 'string' && 'composite' in cell ? cell.composite : scalarEntries ?? splitComposite(field, cellString(cell));
  const original = cellString(cell).trim();
  if (original) rawCells[field.name] = original;
  for (const [name, value] of Object.entries(parts)) {
    const column = `${field.name}_${name}`;
    if (!spec.columns.some((item) => item.column === column)) continue;
    const text = value.trim();
    if (!text) continue;
    columns[column] = text;
    rawCells[column] = text;
    idInputs[column] = text;
  }
}

function splitComposite(field: Field, text: string): Record<string, string> {
  if (!text.trim()) return {};
  return (field.type ?? '').toLowerCase() === 'address' ? splitAddress(field, text) : splitName(field, text);
}

function splitName(field: Field, text: string): Record<string, string> {
  const parts = field.subfields.length ? field.subfields.map((item) => item.name) : [...NAME_PARTS];
  const choices = field.subfields.find((item) => item.name === 'prefix')?.choices ?? [];
  const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
  const out: Record<string, string> = {};
  let rest = tokens;
  if (parts.includes('prefix') && rest.length && isPrefix(rest[0]!, choices)) {
    out.prefix = rest[0]!;
    rest = rest.slice(1);
  }
  if (rest.length === 1 && parts.includes('first_name')) out.first_name = rest[0]!;
  else if (rest.length >= 2) {
    if (parts.includes('first_name')) out.first_name = rest[0]!;
    if (parts.includes('last_name')) out.last_name = rest.slice(1).join(' ');
  }
  return out;
}

function isPrefix(token: string, choices: readonly string[]): boolean {
  if (!choices.length) return false;
  const key = token.toLowerCase().replace(/\./g, '');
  return choices.some((choice) => choice.toLowerCase().replace(/\./g, '') === key);
}

function splitAddress(field: Field, text: string): Record<string, string> {
  const parts = field.subfields.length ? field.subfields.map((item) => item.name) : [...ADDRESS_PARTS];
  const bits = text.split(',').map((item) => item.trim());
  const out: Record<string, string> = {};
  parts.forEach((name, index) => {
    const value = index < parts.length - 1 ? (bits[index] ?? '') : bits.slice(index).join(', ');
    if (value.trim()) out[name] = value.trim();
  });
  return out;
}

function compositeColumns(spec: TableSpec, field: Field): string[] {
  const parts = field.subfields.length ? field.subfields.map((item) => item.name) : (field.type ?? '').toLowerCase() === 'address' ? [...ADDRESS_PARTS] : [...NAME_PARTS];
  return parts.map((part) => `${field.name}_${part}`).filter((column) => spec.columns.some((item) => item.column === column));
}

function relatedValues(cell: RawCell): { raw: string; authoritative: boolean }[] {
  if (typeof cell === 'string') return splitMulti(cell).map((raw) => ({ raw, authoritative: false }));
  if ('id' in cell) return cell.id.trim() ? [{ raw: cell.id.trim(), authoritative: true }] : [];
  if ('list' in cell) return cell.list.flatMap((item) => relatedValues(item));
  if ('row' in cell) return Object.values(cell.row).flatMap((item) => relatedValues(item));
  return [];
}

function junctionColumn(table: string, column: string, specs: readonly TableSpec[]): ColSpec | undefined {
  return specs.find((spec) => spec.table === table)?.columns.find((item) => item.column === column);
}

function cellString(cell: RawCell): string {
  if (typeof cell === 'string') return cell;
  if ('id' in cell) return cell.id;
  if ('list' in cell) return cell.list.map((item) => cellString(item)).filter((item) => item.trim()).join(', ');
  if ('row' in cell) return Object.values(cell.row).map((item) => cellString(item)).filter((item) => item.trim()).join(' ');
  return Object.values(cell.composite).join(' ');
}

function coverName(covered: Set<string>, column: string, form: Form | undefined): void {
  covered.add(column);
  if (!form) return;
  for (const field of form.fields) if (field.name === column || column.startsWith(`${field.name}_`)) covered.add(field.name);
}

function fieldGaps(
  spec: TableSpec,
  form: Form | undefined,
  hasFile: boolean,
  covered: ReadonlySet<string>,
): { missingRequired: Materialized['missingRequired']; absentFields: Materialized['absentFields'] } {
  const missingRequired: Materialized['missingRequired'] = [];
  const absentFields: Materialized['absentFields'] = [];
  if (!hasFile || spec.role !== 'form' || !form) return { missingRequired, absentFields };
  for (const field of form.fields) {
    const type = (field.type ?? '').toLowerCase();
    if (type === 'section' || type === 'plaintext' || covered.has(field.name)) continue;
    if (field.required) missingRequired.push({ form: form.name, table: spec.table, field: field.name });
    else absentFields.push({ form: form.name, table: spec.table, field: field.name });
  }
  return { missingRequired, absentFields };
}

function fillShadows(spec: TableSpec, columns: Record<string, string>): void {
  for (const column of spec.columns) {
    if (!column.shadowFor || columns[column.shadowFor] === undefined) continue;
    const shadow = decimalShadow(columns[column.shadowFor]!);
    if (shadow !== null) columns[column.column] = String(shadow);
  }
}

function junctionHit(header: string, parent: TableSpec, specs: readonly TableSpec[]): { table: string; column: string } | undefined {
  for (const spec of specs) {
    if (spec.role !== 'junction' || spec.form !== parent.form) continue;
    const column = spec.columns.find((item) => item.column !== 'parent_id' && !item.shadowFor && headerMatches(item, header));
    if (column) return { table: spec.table, column: column.column };
  }
  return undefined;
}

function mergeColumns(row: SeedRow, columns: Record<string, string>, file: string): void {
  for (const [key, value] of Object.entries(columns)) {
    const prev = row.columns[key];
    if (prev !== undefined && prev !== value) throw new Error(`conflicting ${key} for ${row.id}: "${value}" in ${file} but the export already gave "${prev}"`);
    row.columns[key] = value;
  }
}

function mergeRaw(id: string, into: Record<string, string>, extra: Record<string, string>, file: string): void {
  for (const [key, value] of Object.entries(extra)) {
    const prev = into[key];
    if (prev !== undefined && prev !== value) throw new Error(`conflicting ${key} for ${id}: "${value}" in ${file} but the export already gave "${prev}"`);
    into[key] = value;
  }
}

function convertCell(label: string, raw: string, column: ColSpec, file: string, labels?: { displayTrue?: string; displayFalse?: string }): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  switch (column.kind) {
    case 'date':
      return formatDate(text, label, file);
    case 'datetime':
      return formatDateTime(text, label, file);
    case 'decimal':
      return formatDecimal(text, label, file, column.scale);
    case 'bool':
      return formatBool(text, label, file, labels?.displayTrue, labels?.displayFalse);
    case 'multi':
      return JSON.stringify(splitMulti(text));
    case 'lookup':
      return text;
    case 'number':
      if (!/^-?\d+$/.test(text)) throw new Error(`${label} in ${file} must be a record ID, not a display value`);
      return text;
    case 'file':
      return text;
    default:
      return text;
  }
}

function formatDate(text: string, _label: string, _file: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text);
  const month = match ? MONTHS.indexOf(match[2].toLowerCase()) : -1;
  if (!match || month < 0) return text;
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

function formatDateTime(text: string, label: string, file: string): string {
  const parts = text.split(/\s+/);
  if (parts.length < 2 || !/^\d{2}:\d{2}:\d{2}$/.test(parts[1])) throw new Error(`${label} in ${file} must be dd-MMM-yyyy HH:mm:ss`);
  return `${formatDate(parts[0], label, file)} ${parts[1]}`;
}

function formatDecimal(text: string, label: string, file: string, scale?: number): string {
  const stripped = text.replace(/[$₹€£%\s]/g, '');
  const grouped = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(stripped) ? stripped.replace(/,/g, '') : stripped;
  if (!/^-?\d+(\.\d+)?$/.test(grouped)) throw new Error(`${label} in ${file} is not a decimal`);
  if (scale === undefined) return grouped;
  const dot = grouped.indexOf('.');
  const digits = dot < 0 ? 0 : grouped.length - dot - 1;
  // More fractional digits than the column scale must reach the writer unchanged. Quantize would round them away.
  if (digits > scale) return grouped;
  try {
    return quantizeDecimal(grouped, scale);
  } catch {
    throw new Error(`${label} in ${file} is not a decimal`);
  }
}

function formatBool(text: string, label: string, file: string, displayTrue?: string, displayFalse?: string): string {
  if (displayTrue !== undefined && text === displayTrue) return 'true';
  if (displayFalse !== undefined && text === displayFalse) return 'false';
  const value = text.toLowerCase();
  if (value === 'true' || value === 'yes' || value === '1') return 'true';
  if (value === 'false' || value === 'no' || value === '0') return 'false';
  throw new Error(`${label} in ${file} is not true or false`);
}

function splitMulti(text: string): string[] {
  return (text.includes(';') ? text.split(';') : text.split(',')).map((item) => item.trim()).filter((item) => item.length > 0);
}

function isIdHeader(header: string): boolean {
  const key = norm(header);
  return key === 'id' || key === 'record_id';
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/[\s.]+/g, '_');
}

function normKey(value: string): string {
  return norm(value).replace(/[^a-z0-9]+/g, '');
}

type DisplaySpec = { kind: 'id' } | { kind: 'field'; field: string } | { kind: 'expr'; expr: string };

interface IndexedRow {
  id: string;
  raw: Record<string, string>;
  columns: Record<string, string>;
}

function resolveLookupCells(
  tables: SeedTable[],
  rawByTable: Map<string, Map<string, Record<string, string>>>,
  pending: PendingLink[],
  specs: readonly TableSpec[],
  occupied: ReadonlySet<string>,
  authoritative: ReadonlySet<string>,
): void {
  const orderColumns = new Map(specs.filter((spec) => spec.role === 'junction').map((spec) => [spec.table, spec.columns.find((column) => column.field === 'row_order' || column.column === 'row_order')?.column]));
  const bySpec = new Map(specs.map((spec) => [spec.table, spec]));
  const index = new Map<string, IndexedRow[]>();
  for (const table of tables) {
    const raws = rawByTable.get(table.table);
    index.set(table.table, table.rows.map((row) => ({ id: row.id, raw: raws?.get(row.id) ?? {}, columns: { ...row.columns } })));
  }
  for (const table of tables) {
    const spec = bySpec.get(table.table);
    if (!spec) continue;
    for (const row of table.rows) {
      for (const column of spec.columns) {
        if (column.kind !== 'lookup' || !column.parent || column.shadowFor) continue;
        const value = row.columns[column.column];
        if (!value || authoritative.has(`${table.table}\0${row.id}\0${column.column}`)) continue;
        row.columns[column.column] = resolveOne(value, column.column, table.table, row.id, column.parent, column.displayFormat, index.get(column.parent) ?? []);
      }
    }
  }
  for (const link of pending) {
    if (occupied.has(link.table)) continue;
    const target = link.authoritative
      ? link.raw
      : resolveOne(link.raw, link.column, link.table, link.parentId, link.parent, link.displayFormat, index.get(link.parent) ?? []);
    const id = `${link.parentId}__${link.column}__${target}`;
    const table = tables.find((item) => item.table === link.table);
    if (!table || table.rows.some((row) => row.id === id)) continue;
    const orderColumn = orderColumns.get(link.table);
    table.rows.push({ id, columns: { parent_id: link.parentId, ...(orderColumn ? { [orderColumn]: String(link.order) } : {}), [link.column]: target } });
  }
}

function resolveOne(text: string, column: string, table: string, rowId: string, parent: string, displayFormat: string | undefined, parents: readonly IndexedRow[]): string {
  const spec = displaySpec(displayFormat);
  if (!spec || spec.kind === 'id') {
    if (isSourceIdToken(text)) return text;
    throw new Error(`lookup ${column} on ${table} row ${rowId} must be a record ID, not a display value`);
  }
  const matches = parents.filter((row) => displayMatches(row, spec, text));
  if (matches.length > 1) {
    throw new Error(`lookup ${column} on ${table} row ${rowId} is ambiguous for "${text}" in ${parent} (${matches.length} rows); export a column that carries the ${parent} record ID or a unique display field`);
  }
  if (matches.length === 1) return matches[0]!.id;
  if (isSourceIdToken(text)) return text;
  throw new Error(`lookup ${column} on ${table} row ${rowId} has no match for "${text}" in ${parent}; export a column that carries the ${parent} record ID`);
}

function displayMatches(row: IndexedRow, spec: DisplaySpec, text: string): boolean {
  if (spec.kind === 'id') return false;
  const candidates = spec.kind === 'field' ? fieldCandidates(row, spec.field) : [evalDisplay(spec.expr, aliasMap(row.raw)), evalDisplay(spec.expr, aliasMap({ ...row.raw, ...row.columns }))];
  return candidates.some((value) => sameDisplay(value, text));
}

function fieldCandidates(row: IndexedRow, field: string): string[] {
  const out: string[] = [];
  const raw = row.raw[field];
  const column = row.columns[field];
  if (raw !== undefined) out.push(raw);
  if (column !== undefined && column !== raw) out.push(column);
  return out;
}

function sameDisplay(left: string, right: string): boolean {
  const a = left.trim().replace(/\s+/g, ' ');
  const b = right.trim().replace(/\s+/g, ' ');
  return a === b;
}

function aliasMap(cells: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(cells)) {
    map.set(key, value);
    for (const part of [...NAME_PARTS, ...ADDRESS_PARTS]) {
      const suffix = `_${part}`;
      if (!key.endsWith(suffix)) continue;
      const parent = key.slice(0, -suffix.length);
      if (!parent) continue;
      const dotted = `${parent}.${part}`;
      if (!map.has(dotted)) map.set(dotted, value);
    }
  }
  return map;
}

function evalDisplay(expr: string, cells: Map<string, string>): string {
  const parts = expr.match(/"((?:[^"\\]|\\.)*)"|([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)?)/gu);
  if (!parts) return '';
  let out = '';
  for (const part of parts) {
    if (part.startsWith('"')) out += part.slice(1, -1).replace(/\\(.)/gs, '$1');
    else out += cells.get(part) ?? '';
  }
  return out.trim().replace(/\s+/g, ' ');
}

function displaySpec(format: string | undefined): DisplaySpec | undefined {
  if (!format?.trim()) return undefined;
  let inner = format.trim();
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1).trim();
  if (!inner || inner.toLowerCase() === 'id') return { kind: 'id' };
  if (/[+\s".]/.test(inner)) return { kind: 'expr', expr: inner };
  return { kind: 'field', field: inner };
}

function describeDisplay(format: string | undefined): string {
  const spec = displaySpec(format);
  if (!spec || spec.kind === 'id') return 'record id';
  if (spec.kind === 'field') return spec.field;
  return 'display format';
}

function isSourceIdToken(text: string): boolean {
  return /^-?\d+$/.test(text) || /^d_[0-9a-f]{64}$/.test(text);
}

function exportCounts(active: readonly TableSpec[], tables: readonly SeedTable[]): { form: string; table: string; count: number }[] {
  return active
    .filter((spec) => spec.role === 'form' || spec.role === 'child')
    .map((spec) => ({
      form: spec.role === 'child' ? `${spec.form}.${spec.subform?.field ?? spec.table}` : spec.form,
      table: spec.table,
      count: tables.find((table) => table.table === spec.table)?.rows.length ?? 0,
    }));
}

function lookupPlan(specs: readonly TableSpec[]): CsvLoad['lookups'] {
  const lines: CsvLoad['lookups'] = [];
  for (const spec of specs) {
    for (const column of spec.columns) {
      if (!column.parent || column.column === 'parent_id' || column.shadowFor) continue;
      lines.push({ table: spec.table, column: column.column, parent: column.parent, by: describeDisplay(column.displayFormat) });
    }
  }
  return lines;
}

function parseCounts(text: string, tables: readonly SchemaTable[]): { form: string; table: string; count: number }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('counts.json is not JSON');
  }
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  const source = root && root.counts && typeof root.counts === 'object' && !Array.isArray(root.counts) ? (root.counts as Record<string, unknown>) : root;
  if (!source) throw new Error('counts.json is not an object');
  const forms = tables.filter((table) => table.role === 'form');
  const byForm = new Map(forms.map((table) => [table.form, table]));
  // A generated table (a subform child or a lookup junction) may also pin its
  // own row total — under its table name, or the <Form>__<Subform> spelling its
  // own file would use. The entry is optional: without it the table simply
  // cannot prove completeness to a delta delete.
  const generated = new Map<string, SchemaTable>();
  for (const table of tables) {
    if (table.role !== 'child' && table.role !== 'junction') continue;
    generated.set(table.name, table);
    const field = suffixField(table.name);
    if (field !== undefined) generated.set(`${table.form}__${field}`, table);
  }
  const expected: { form: string; table: string; count: number }[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (name === 'version') continue;
    const table = byForm.get(name) ?? generated.get(name);
    if (!table) throw new Error(`counts.json names unknown form or table ${name}`);
    if (table.nosql) throw new Error(`counts.json lists NoSQL ${table.role === 'form' ? 'form' : 'table'} ${name}; this stage does not load it`);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`counts.json count for ${name} must be a non-negative integer`);
    expected.push({ form: name, table: table.name, count: value });
  }
  for (const table of forms) {
    if (table.nosql) continue;
    if (!expected.some((item) => item.form === table.form)) throw new Error(`counts.json is missing form ${table.form}`);
  }
  return expected;
}

export function sourceIdCountQueries(table: string, ids: readonly string[]): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`table name is not a ZCQL identifier: ${table}`);
  if (ids.length === 0) return [];
  const queries: string[] = [];
  for (let i = 0; i < ids.length; i += ZCQL_IN_LIMIT) {
    const list = ids.slice(i, i + ZCQL_IN_LIMIT).map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
    queries.push(`SELECT COUNT(ROWID) FROM ${table} WHERE ${SOURCE_ID_COLUMN} IN (${list})`);
  }
  return queries;
}

async function loadCount(fetch: FetchLike, base: string, dc: string, table: string, ids: readonly string[], scope: CatalystScope): Promise<number> {
  if (ids.length === 0) return 0;
  let total = 0;
  for (const sql of sourceIdCountQueries(table, ids)) {
    const count = countFrom(await query(fetch, base, dc, sql, scope));
    if (count === undefined) throw new Error(`count for ${table} was not a number`);
    total += count;
  }
  return total;
}
