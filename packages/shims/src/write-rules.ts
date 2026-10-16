/**
 * Write rules shared by the data loader (data/integrity.ts) and the generated
 * runtime. Catalyst stores some bad values without an error: varchar past max
 * length is truncated, a numeric date such as 05-10-2026 is stored as
 * 0011-04-18, and a double with decimal_digits 2 stores 0.105 as 0.10 and
 * -0.015 as -0.01. The loader refuses those before the write. It does not
 * round. The runtime and the deployed adapter round a scale column to its
 * places first (quantizeRow) and then run the same check.
 *
 * Dates the Creator export actually uses are unambiguous: yyyy-MM-dd and
 * dd-MMM-yyyy. Datetimes are those dates plus HH:mm:ss. A trailing Z or a
 * numeric offset is refused, not dropped. A plain Double with more than 15
 * significant digits is refused before the write. A missing `required` value
 * on an insert is refused (`mandatory-missing`) instead of leaving the store
 * to answer 403 partway through a load.
 */

import { Decimal, quantizeDecimal } from './decimal.js';
import { multiValueCell } from './multi-value.js';

/** Catalyst text cap. VarChar uses its own length, default 255. */
export const TEXT_MAX_LENGTH = 10_000;
export const VARCHAR_DEFAULT_LENGTH = 255;
/** Data Store creates every Double with max_length 15. More digits are stored altered. */
export const DOUBLE_SIGNIFICANT_DIGITS = 15;

/** Every rule a write check can raise. Detection-only rules (silent-change, duplicate id) live with the caller. */
export type WriteRule = 'text-length' | 'decimal-scale' | 'date-format' | 'significant-digits' | 'mandatory-missing';

export interface WriteRuleColumn {
  name: string;
  dataType: string;
  length?: number;
  /** Fractional digits. The loader refuses extra digits; the runtime and adapter round them first (quantizeRow). */
  scale?: number;
  /** Canonical decimal string. The stored text must match the sent text. */
  exactDecimal?: boolean;
  /** Derived double. Scale is enforced on the exact column, not here. */
  shadow?: boolean;
  /** An insert must carry a non-empty value. Partial updates never check it. */
  required?: boolean;
  /** Multi select or checkboxes: text holding a JSON list, written through multiValueCell. */
  multiValue?: boolean;
}

export interface WriteRefusal {
  column: string;
  rule: WriteRule;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function validYmd(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validHms(text: string): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  return hour <= 23 && minute <= 59 && second <= 59;
}

/** yyyy-MM-dd, or Creator dd-MMM-yyyy. Numeric dates are ambiguous and refused. */
export function normalizeDate(text: string): { ok: true; value: string } | { ok: false } {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return validYmd(trimmed) ? { ok: true, value: trimmed } : { ok: false };
  const named = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(trimmed);
  if (!named) return { ok: false };
  const month = MONTHS.indexOf(named[2]!.toLowerCase());
  if (month < 0) return { ok: false };
  const iso = `${named[3]}-${String(month + 1).padStart(2, '0')}-${named[1]!.padStart(2, '0')}`;
  return validYmd(iso) ? { ok: true, value: iso } : { ok: false };
}

/**
 * yyyy-MM-dd HH:mm:ss, or Creator dd-MMM-yyyy HH:mm:ss. A T separator is accepted.
 * A trailing Z or a numeric offset is refused. Catalyst DateTime has no zone, and
 * dropping the marker would store a different instant.
 */
export function normalizeDateTime(text: string): { ok: true; value: string } | { ok: false } {
  const trimmed = text.trim();
  if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)) return { ok: false };
  const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(trimmed);
  if (iso) {
    const date = normalizeDate(iso[1]!);
    if (!date.ok || !validHms(iso[2]!)) return { ok: false };
    return { ok: true, value: `${date.value} ${iso[2]}` };
  }
  const named = /^(\d{1,2}-[A-Za-z]{3}-\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(trimmed);
  if (!named) return { ok: false };
  const date = normalizeDate(named[1]!);
  if (!date.ok || !validHms(named[2]!)) return { ok: false };
  return { ok: true, value: `${date.value} ${named[2]}` };
}

function plainDecimal(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
}

export function fractionalDigits(value: unknown): number | null {
  const text = plainDecimal(value);
  if (text === null) return null;
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * The store has no composite value: a `Name` or `Address` field is one column
 * per part (`Name_first_name`, `Name_last_name`). A write that carries the
 * field as a nested object — a posted record, or a dotted Deluge
 * `insert into` target (`Name.first_name = …` arrives as the key
 * "Name.first_name") — is rewritten onto those columns before any check, so a
 * mandatory part is satisfied by its submitted value instead of
 * `mandatory-missing` on a column that never materialised.
 *
 * A nested value expands only when every one of its keys names a
 * `<field>_<part>` column; a key that has no column keeps the nested cell, so a
 * wrong part name is refused by the store rather than dropped. Dotted keys
 * move to the `<field>_<part>` column only when that column exists. Anything
 * else is left untouched — a lookup `{id, label}` or a file `{key}` has no
 * `<field>_<part>` columns and stays as it was.
 */
export function expandCompositeCells(
  columns: readonly WriteRuleColumn[] | undefined,
  cells: Record<string, unknown>,
): Record<string, unknown> {
  if (!columns?.length) return cells;
  const byName = new Set(columns.map((column) => column.name));
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(cells)) {
    if (byName.has(key)) continue;
    const dot = key.indexOf('.');
    if (dot > 0) {
      const flat = `${key.slice(0, dot)}_${key.slice(dot + 1)}`;
      if (byName.has(flat)) {
        if (!out) out = { ...cells };
        delete out[key];
        out[flat] = value;
      }
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) continue;
    const inner = value as Record<string, unknown>;
    const parts = Object.keys(inner);
    if (!parts.length || !parts.every((part) => byName.has(`${key}_${part}`))) continue;
    if (!out) out = { ...cells };
    delete out[key];
    for (const part of parts) out[`${key}_${part}`] = inner[part];
  }
  return out ?? cells;
}

/**
 * Round every scale-column cell to its places, half away from zero (the same
 * rule as the Deluge round shim). A computed Decimal (Deluge
 * `Total + Tax / 100 * Total - ...`) can carry more fractional digits than the
 * column; the writer rounds it the way the field keeps it instead of
 * refusing. Missing cells and values that are not decimals pass through for
 * the check to handle. The row-by-row loader never calls this — a CSV value
 * with extra digits is still refused; `bulkLoad` calls it only under
 * `roundScale`.
 */
export function quantizeRow(
  columns: readonly WriteRuleColumn[] | undefined,
  cells: Record<string, unknown>,
): Record<string, unknown> {
  if (!columns?.length) return cells;
  cells = expandCompositeCells(columns, cells);
  const byName = new Map(columns.map((column) => [column.name, column]));
  let out = cells;
  for (const [key, value] of Object.entries(cells)) {
    const column = byName.get(key);
    if (!column || column.scale === undefined || column.shadow) continue;
    if (isMissingCell(value)) continue;
    const text = value instanceof Decimal ? value.toString() : value;
    if (fractionalDigits(text) === null || (fractionalDigits(text) ?? 0) <= column.scale) continue;
    let rounded: string;
    try {
      rounded = quantizeDecimal(value instanceof Decimal ? value.toString() : String(value), column.scale);
    } catch {
      continue;
    }
    if (out === cells) out = { ...cells };
    out[key] = rounded;
  }
  return out;
}

/** Digits after the sign, decimal point, and leading zeros. Null when it is not a plain decimal. */
export function significantDigits(value: unknown): number | null {
  const text = plainDecimal(value);
  if (text === null) return null;
  return text.replace('-', '').replace('.', '').replace(/^0+/, '').length;
}

function textMax(column: WriteRuleColumn): number | undefined {
  if (column.dataType === 'VarChar') return column.length ?? VARCHAR_DEFAULT_LENGTH;
  if (column.dataType === 'Text' || column.dataType === 'Encrypted') return column.length ?? TEXT_MAX_LENGTH;
  return undefined;
}

/** One cell against its column rules. Returns the value to write (a date is normalized) or the refused rule. */
export function checkCell(column: WriteRuleColumn, value: unknown): { value: unknown } | { rule: WriteRule } {
  if (column.multiValue) value = multiValueCell(value);
  if (isMissingCell(value)) return { value };
  if (column.dataType === 'Date') {
    if (typeof value !== 'string') return { rule: 'date-format' };
    // A Deluge date a script assigns (`input.D = input.End.subDay(n)`) reaches
    // the write as its serial form, yyyy-MM-ddT00:00:00. Creator stores the
    // day; only midnight is folded, so a time of day is never dropped silently.
    const serial = /^(\d{4}-\d{2}-\d{2})T00:00:00$/.exec(value.trim());
    const next = normalizeDate(serial ? serial[1]! : value);
    return next.ok ? { value: next.value } : { rule: 'date-format' };
  }
  if (column.dataType === 'DateTime') {
    if (typeof value !== 'string') return { rule: 'date-format' };
    const next = normalizeDateTime(value);
    return next.ok ? { value: next.value } : { rule: 'date-format' };
  }
  const max = textMax(column);
  if (max !== undefined && typeof value === 'string' && value.length > max) return { rule: 'text-length' };
  if (column.scale !== undefined && !column.shadow) {
    const digits = fractionalDigits(value);
    if (digits === null || digits > column.scale) return { rule: 'decimal-scale' };
  }
  if (column.dataType === 'Double' && !column.shadow && !column.exactDecimal) {
    const digits = significantDigits(value);
    if (digits === null || digits > DOUBLE_SIGNIFICANT_DIGITS) return { rule: 'significant-digits' };
  }
  return { value };
}

/** The value is absent for a required check: nothing, an empty string, or an empty list. */
export function isMissingCell(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
}

/**
 * Check every cell against the column rules. A `required` column carried with an
 * empty value is refused as mandatory-missing on every write — the store rejects
 * blanking a mandatory column on update too. With `required: true` (an insert of
 * a whole row) a required column absent from the row is refused as well; the
 * update paths pass false because they write a partial row. Cells without a
 * column entry pass through. Returns the cells to write plus every refusal.
 */
export function checkRow(
  columns: readonly WriteRuleColumn[] | undefined,
  cells: Record<string, unknown>,
  opts: { required?: boolean } = {},
): { cells: Record<string, unknown>; refusals: WriteRefusal[] } {
  if (!columns?.length) return { cells, refusals: [] };
  cells = expandCompositeCells(columns, cells);
  const byName = new Map(columns.map((column) => [column.name, column]));
  const next: Record<string, unknown> = { ...cells };
  const refusals: WriteRefusal[] = [];
  for (const [key, cell] of Object.entries(cells)) {
    const column = byName.get(key);
    if (!column) continue;
    const value = column.multiValue ? multiValueCell(cell) : cell;
    if (column.required && isMissingCell(value)) {
      refusals.push({ column: key, rule: 'mandatory-missing' });
      continue;
    }
    const prepared = checkCell(column, value);
    if ('rule' in prepared) refusals.push({ column: key, rule: prepared.rule });
    else next[key] = prepared.value;
  }
  if (opts.required) {
    for (const column of columns) {
      if (!column.required || Object.hasOwn(cells, column.name)) continue;
      refusals.push({ column: column.name, rule: 'mandatory-missing' });
    }
  }
  return { cells: next, refusals };
}

/**
 * A refused write. `code` is the Catalyst store code the refusal maps to so the
 * generated handler replies with the same 4xx shape a store refusal would get:
 * a missing mandatory value is MANDATORY_MISSING (422), anything else is
 * INVALID_INPUT (400). `field` names the column. The message lists columns and
 * rules only — never cell values.
 */
export class WriteRuleError extends Error {
  readonly code: 'MANDATORY_MISSING' | 'INVALID_INPUT';
  readonly table: string;
  readonly field: string;
  readonly rule: WriteRule;
  readonly refusals: readonly WriteRefusal[];
  constructor(table: string, refusals: readonly WriteRefusal[]) {
    const first = refusals[0] ?? { column: '?', rule: 'invalid' as WriteRule };
    const detail = refusals.map((refusal) => `${refusal.column} (${refusal.rule})`).join(', ');
    super(`${table}: write refused: ${detail}`);
    this.name = 'WriteRuleError';
    this.code = refusals.some((refusal) => refusal.rule === 'mandatory-missing') ? 'MANDATORY_MISSING' : 'INVALID_INPUT';
    this.table = table;
    this.field = first.column;
    this.rule = first.rule;
    this.refusals = refusals;
  }
}

/**
 * checkRow that throws a WriteRuleError on the first sign of a refused write.
 * Returns the normalized cells so callers write the canonical value (dates are
 * normalized to yyyy-MM-dd / yyyy-MM-dd HH:mm:ss).
 */
export function assertWritable(
  table: string,
  columns: readonly WriteRuleColumn[] | undefined,
  cells: Record<string, unknown>,
  opts: { required?: boolean } = {},
): Record<string, unknown> {
  const checked = checkRow(columns, cells, opts);
  if (checked.refusals.length) throw new WriteRuleError(table, checked.refusals);
  return checked.cells;
}

/** Compare a decimal without rounding. Trailing zeros do not count. Null when it is not a plain decimal. */
export function canonDecimal(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return canonDecimal(String(value));
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const neg = text.startsWith('-');
  const body = neg ? text.slice(1) : text;
  const [whole, frac = ''] = body.split('.');
  const w = whole!.replace(/^0+(?=\d)/, '') || '0';
  const f = frac.replace(/0+$/, '');
  const core = f.length ? `${w}.${f}` : w;
  if (core === '0') return '0';
  return neg ? `-${core}` : core;
}

/**
 * One cell as a canonical token: the same text for every value the read-back
 * check treats as equal. Decimals and doubles fold through canonDecimal so
 * trailing zeros do not count; dates fold through normalizeDateTime's ISO form;
 * missing and null are the same token. Anything else is its String() text.
 */
export function canonCell(column: WriteRuleColumn | undefined, value: unknown): string {
  if (value === undefined || value === null) return 'n:';
  if (column?.exactDecimal || column?.dataType === 'Double' || (column?.scale !== undefined && !column.shadow)) {
    const dec = canonDecimal(value);
    if (dec !== null) return `d:${dec}`;
  }
  if (column?.dataType === 'Date' && typeof value === 'string') {
    const date = normalizeDate(value);
    if (date.ok) return `t:${date.value}`;
  }
  if (column?.dataType === 'DateTime' && typeof value === 'string') {
    const date = normalizeDateTime(value);
    if (date.ok) return `t:${date.value}`;
  }
  return `s:${String(value)}`;
}

/**
 * A row's canonical fingerprint for the fidelity checksum: the `keys` cells
 * (the columns that were sent), keyed and folded in sorted-key order. A stored
 * row hashed with the same keys and columns differs exactly where a value was
 * truncated, rounded, or coerced after the write.
 */
export function canonRow(
  cells: Record<string, unknown>,
  keys: readonly string[],
  columns: readonly WriteRuleColumn[] | undefined,
): string {
  const byName = new Map((columns ?? []).map((column) => [column.name, column]));
  const parts: string[] = [];
  for (const key of [...keys].sort()) {
    parts.push(`${key}=${canonCell(byName.get(key), cells[key])}`);
  }
  return parts.join('\x01');
}
