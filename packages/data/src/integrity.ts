/**
 * Loader integrity. Catalyst stores some bad values without an error:
 * varchar past max length is truncated, a numeric date such as 05-10-2026 is
 * stored as 0011-04-18, and a double with decimal_digits 2 stores 0.105 as 0.10
 * and -0.015 as -0.01. The writer refuses those before the POST. It does not round.
 *
 * Dates the Creator export actually uses are unambiguous: yyyy-MM-dd and
 * dd-MMM-yyyy. Datetimes are those dates plus HH:mm:ss. A trailing Z or a
 * numeric offset is refused, not dropped. A plain Double with more than 15
 * significant digits is refused before the POST. Anything else ambiguous is refused.
 *
 * The cell rules live in shims/write-rules.ts so the generated runtime and the
 * deployed datastore adapter refuse the same writes the loader does. This file
 * adds the read-back rules (silent-change, duplicate-source-id) and the report.
 */
import type { SchemaTable } from '../../schema/src/generator.js';
import {
  canonDecimal,
  checkCell,
  checkRow,
  isMissingCell,
  normalizeDate,
  validHms,
  type WriteRule,
  type WriteRuleColumn,
} from '../../shims/src/write-rules.js';

export {
  DOUBLE_SIGNIFICANT_DIGITS,
  TEXT_MAX_LENGTH,
  VARCHAR_DEFAULT_LENGTH,
  canonDecimal,
  canonCell,
  canonRow,
  checkCell,
  checkRow,
  fractionalDigits,
  isMissingCell,
  normalizeDate,
  normalizeDateTime,
  significantDigits,
} from '../../shims/src/write-rules.js';
export type { WriteRefusal, WriteRule, WriteRuleColumn } from '../../shims/src/write-rules.js';

export type IntegrityRule = WriteRule | 'silent-change' | 'duplicate-source-id' | 'duplicate-unique';

/** Rules the cell-level pre-write check can raise. Duplicate rows and silent changes are found after a read. */
type PreWriteRule = WriteRule;

export interface IntegrityColumn extends WriteRuleColumn {
  /** An insert must carry a non-empty value (schema `mandatory`). */
  required?: boolean;
}

export interface IntegrityRefusal {
  table: string;
  column: string;
  sourceId: string;
  rule: IntegrityRule;
}

export interface IntegrityReport {
  /** Rows checked against a schema and stored unchanged. */
  written: number;
  /** Rows stored with no schema columns. Never counted in written. */
  unverified: number;
  /** False when any row was stored without a schema check. */
  verified: boolean;
  /** Stored NULL cells the run filled from the source on an existing row. */
  filledNulls: number;
  /** Lookup cells still holding a raw source record id, corrected to the mapped ROWID. */
  correctedLookups: number;
  unknownThenFound: number;
  /** Source ids only. No cell values. */
  unknownThenFoundIds: string[];
  refusedByRule: { rule: IntegrityRule; count: number; rows: { table: string; column: string; sourceId: string }[] }[];
}

export function emptyIntegrity(): IntegrityReport {
  return { written: 0, unverified: 0, verified: true, filledNulls: 0, correctedLookups: 0, unknownThenFound: 0, unknownThenFoundIds: [], refusedByRule: [] };
}

/**
 * The write-rule columns of one schema table. `scope: 'store'` marks a column
 * `required` only when the Data Store column itself is mandatory (`mandatory`);
 * `scope: 'app'` marks it required when the generated app must check it — store
 * columns plus `appMandatory` ones (Creator-mandatory fields the source rows
 * disprove, which the store column does not enforce). Names in `optional` never
 * carry `required` — the caller lists columns it knowingly leaves off, such as
 * the cyclic FKs the table plan relaxed and writes in a second pass.
 * `app` rules name a renamed column by its Creator field name (what generated
 * code writes); `store` rules use the Data Store column name.
 */
export function integrityColumns(
  table: SchemaTable,
  optional?: ReadonlySet<string>,
  scope: 'app' | 'store' = 'app',
): IntegrityColumn[] {
  return table.columns.map((column) => ({
    name: scope === 'app' ? (column.field ?? column.name) : column.name,
    dataType: column.dataType,
    ...(column.length !== undefined ? { length: column.length } : {}),
    ...(column.precision !== undefined && (column.exactDecimal || column.dataType === 'Double') && !column.shadowFor
      ? { scale: column.precision }
      : {}),
    ...(column.exactDecimal ? { exactDecimal: true } : {}),
    ...(column.shadowFor ? { shadow: true } : {}),
    ...((scope === 'app' ? column.mandatory || column.appMandatory === true : column.mandatory) && !optional?.has(column.name)
      ? { required: true }
      : {}),
  }));
}

export function prepareCell(column: IntegrityColumn, value: unknown): { value: unknown } | { rule: PreWriteRule } {
  const prepared = checkCell(column, value);
  return 'rule' in prepared ? { rule: prepared.rule } : { value: prepared.value };
}

/** Full-row check for an insert: cell rules plus a mandatory value on every `required` column. */
export function prepareColumns(
  columns: readonly IntegrityColumn[] | undefined,
  cells: Record<string, unknown>,
): { cells: Record<string, unknown>; refusals: { column: string; rule: PreWriteRule }[] } {
  return checkRow(columns, cells, { required: true });
}

/**
 * Source rows missing a `required` column value, one refusal per cell. This is
 * the same check the writer runs per batch; running it over every row before the
 * first POST is what turns a report export that lacks a mandatory column into a
 * refusal instead of a partial load.
 */
export function mandatoryMissingRefusals(
  tables: readonly { table: string; rows: readonly { id: string; columns: Record<string, unknown> }[] }[],
  columnsByTable: Readonly<Record<string, readonly IntegrityColumn[] | undefined>>,
): IntegrityRefusal[] {
  const refusals: IntegrityRefusal[] = [];
  for (const table of tables) {
    const required = (columnsByTable[table.table] ?? []).filter((column) => column.required);
    if (!required.length) continue;
    for (const row of table.rows) {
      for (const column of required) {
        if (isMissingCell(row.columns[column.name])) {
          refusals.push({ table: table.table, column: column.name, sourceId: row.id, rule: 'mandatory-missing' });
        }
      }
    }
  }
  return refusals;
}

/**
 * Source rows repeating a value in a store-unique column, one refusal per repeat —
 * the column the source was provisioned with stays is_unique, so a load that would
 * store a second copy is refused before any write and the column must be
 * re-provisioned. Empty cells are not duplicates: the column may hold many NULLs.
 */
export function duplicateUniqueRefusals(
  tables: readonly { table: string; rows: readonly { id: string; columns: Record<string, unknown> }[] }[],
  uniqueByTable: Readonly<Record<string, readonly string[] | undefined>>,
): IntegrityRefusal[] {
  const refusals: IntegrityRefusal[] = [];
  for (const table of tables) {
    const unique = uniqueByTable[table.table] ?? [];
    for (const column of unique) {
      const seen = new Set<string>();
      for (const row of table.rows) {
        const value = row.columns[column];
        if (isMissingCell(value)) continue;
        const key = String(value);
        if (seen.has(key)) refusals.push({ table: table.table, column, sourceId: row.id, rule: 'duplicate-unique' });
        else seen.add(key);
      }
    }
  }
  return refusals;
}

export function changedColumns(
  sent: Record<string, unknown>,
  stored: Record<string, unknown>,
  columns: readonly IntegrityColumn[] | undefined,
): string[] {
  const byName = new Map((columns ?? []).map((column) => [column.name, column]));
  const changed: string[] = [];
  for (const [key, value] of Object.entries(sent)) {
    if (key === 'ROWID' || key === 'c2c_source_id') continue;
    if (!sameStored(value, stored[key], byName.get(key))) changed.push(key);
  }
  return changed;
}

/** A cell with no value: absent, NULL, or empty text. The store reads these back as NULL. */
export function isEmptyCell(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

interface StoredInstant {
  /** yyyy-MM-dd. */
  date: string;
  /** Milliseconds since midnight, including the fractional part. */
  ms: number;
  hasTime: boolean;
}

/**
 * A DateTime cell read back from the store: `yyyy-MM-dd[ T]HH:mm:ss` with an
 * optional `[:.]SSS` fraction and an optional trailing Z. The fraction is
 * compared, not dropped. A Date cell may carry a `00:00:00` time. Anything
 * else (a numeric offset, an ambiguous date) is not a canonical instant.
 */
function canonInstant(value: unknown): StoredInstant | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/Z$/, '');
  const timed = /^(.+?)[ T](\d{2}:\d{2}:\d{2})(?:[:.](\d{1,3}))?$/.exec(text);
  if (timed) {
    const date = normalizeDate(timed[1]!);
    if (!date.ok || !validHms(timed[2]!)) return null;
    const [hour, minute, second] = timed[2]!.split(':').map(Number);
    const fraction = timed[3] === undefined ? 0 : Number(timed[3].padEnd(3, '0'));
    return { date: date.value, ms: ((hour * 60 + minute) * 60 + second) * 1000 + fraction, hasTime: true };
  }
  const date = normalizeDate(text);
  return date.ok ? { date: date.value, ms: 0, hasTime: false } : null;
}

/** JSON booleans and the `true`/`false` text a cell can carry. */
function canonBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

function sameStored(sent: unknown, stored: unknown, column: IntegrityColumn | undefined): boolean {
  if (Object.is(sent, stored)) return true;
  // Empty and NULL are the same cell for every column the schema writes.
  const sentEmpty = isEmptyCell(sent);
  const storedEmpty = isEmptyCell(stored);
  if (sentEmpty || storedEmpty) return sentEmpty && storedEmpty;
  if (column?.dataType === 'DateTime') {
    // canonInstant drops a trailing Z because the store spells zone-less reads
    // that way. A numeric offset (+00:00) is never emitted, so it is not
    // canonical and still reads as a change — dropping it could hide one.
    const left = canonInstant(sent);
    const right = canonInstant(stored);
    if (left && right) return left.hasTime && right.hasTime && left.date === right.date && left.ms === right.ms;
  }
  if (column?.dataType === 'Date') {
    const left = canonInstant(sent);
    const right = canonInstant(stored);
    if (left && right) return left.date === right.date && left.ms === 0 && right.ms === 0;
  }
  if (column?.dataType === 'Boolean') {
    const left = canonBoolean(sent);
    const right = canonBoolean(stored);
    if (left !== null && right !== null) return left === right;
  }
  if (column?.exactDecimal || column?.dataType === 'Double' || (column?.scale !== undefined && !column.shadow)) {
    const left = canonDecimal(sent);
    const right = canonDecimal(stored);
    if (left !== null && right !== null) return left === right;
  }
  return String(stored) === String(sent);
}

export function mergeIntegrity(parts: readonly (IntegrityReport | undefined)[]): IntegrityReport {
  const refusals: IntegrityRefusal[] = [];
  let written = 0;
  let unverified = 0;
  let verified = true;
  let filledNulls = 0;
  let correctedLookups = 0;
  const unknownThenFoundIds: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    written += part.written;
    unverified += part.unverified;
    if (!part.verified) verified = false;
    filledNulls += part.filledNulls ?? 0;
    correctedLookups += part.correctedLookups ?? 0;
    unknownThenFoundIds.push(...part.unknownThenFoundIds);
    for (const group of part.refusedByRule) {
      for (const row of group.rows) refusals.push({ table: row.table, column: row.column, sourceId: row.sourceId, rule: group.rule });
    }
  }
  return {
    written,
    unverified,
    verified: verified && unverified === 0,
    filledNulls,
    correctedLookups,
    unknownThenFound: unknownThenFoundIds.length,
    unknownThenFoundIds,
    refusedByRule: groupRefusals(refusals),
  };
}

export function groupRefusals(items: readonly IntegrityRefusal[]): IntegrityReport['refusedByRule'] {
  const groups = new Map<IntegrityRule, IntegrityReport['refusedByRule'][number]>();
  for (const item of items) {
    const group = groups.get(item.rule) ?? { rule: item.rule, count: 0, rows: [] };
    group.count += 1;
    group.rows.push({ table: item.table, column: item.column, sourceId: item.sourceId });
    groups.set(item.rule, group);
  }
  return [...groups.values()];
}
