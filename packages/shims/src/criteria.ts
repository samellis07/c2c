/**
 * Criteria → ZCQL fragment.
 * Encrypted text columns accept only equality
 * (`Operator LIKE is not supported for ENCRYPTED TEXT`).
 *
 * Decimal, currency, and percent columns are exact decimal strings in VarChar(64).
 * ZCQL compares a varchar as text: `'20.00' <= '100.00'` is false. Each such column
 * has a Double shadow column (`<Field>__n`) written next to it. Criteria on the field
 * compile to a widened bound on the shadow, a superset of the exact match. The caller
 * then keeps only the rows {@link exactFilter} accepts, compared with `decimal.cmp`
 * on the varchar, so the result is exact.
 *
 * ZCQL WHERE is SQL three-valued: a comparison with a NULL shadow is UNKNOWN, NOT
 * UNKNOWN is UNKNOWN, and only TRUE rows come back. A shadow is NULL for a blank,
 * and for a row written before the shadow column existed (until `c2c deploy
 * --backfill-shadows` fills it). So every decimal leaf is total on a NULL shadow:
 * a superset leaf is `(<bound> OR <shadow> IS NULL)` and a subset leaf is
 * `(<shadow> IS NOT NULL AND <bound>)`; NOT of a leaf is `(NOT (<bound>) OR <shadow> IS NULL)`.
 * The exact pass then decides those rows on the varchar.
 */
import { Decimal, decimal } from './decimal.js';
import { DelugeDate, addDays, addMonths, asDate, cmp, now, requireZone, startOfMonth, startOfWeek, today } from './date.js';
import { UntranslatedConstruct } from './errors.js';
import { sameId } from './ids.js';

export type Criteria =
  | { op: 'true' }
  | { op: '==' | '!=' | '<' | '>' | '<=' | '>='; field: string; value: unknown }
  | { op: 'isNull' | 'notNull'; field: string }
  | { op: 'contains' | 'startsWith' | 'endsWith'; field: string; value: unknown }
  | { op: 'in'; field: string; value: unknown }
  | { op: 'and' | 'or'; args: Criteria[] }
  | { op: 'not'; arg: Criteria }
  | { op: 'todo'; construct: string };

export class EncryptedCriteriaError extends Error {
  readonly code = 'ENCRYPTED_EQUALITY_ONLY';
  constructor(field: string, op: string) {
    super(`encrypted column ${field} only supports equality, not ${op}`);
  }
}

/** True when any node of the tree is an untranslated criteria hole. */
export function criteriaHasTodo(criteria: Criteria): boolean {
  if (criteria.op === 'todo') return true;
  if (criteria.op === 'and' || criteria.op === 'or') return criteria.args.some(criteriaHasTodo);
  if (criteria.op === 'not') return criteriaHasTodo(criteria.arg);
  return false;
}

/**
 * A dependent record query used as a report-criteria comparison value
 * (`Form[criteria].field`, or a `thisapp` function that returns one). The
 * report read resolves it against the datastore under the caller's scope;
 * it is never compiled as a literal value.
 */
export interface RecordQuery {
  __rows: { form: string; criteria: Criteria; path: string[] };
}

export function isRecordQuery(value: unknown): value is RecordQuery {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { __rows?: unknown }).__rows === 'object';
}

/** True when any leaf value still carries a dependent record query marker. */
export function criteriaHasRecordQuery(criteria: Criteria): boolean {
  if (criteria.op === 'and' || criteria.op === 'or') return criteria.args.some(criteriaHasRecordQuery);
  if (criteria.op === 'not') return criteriaHasRecordQuery(criteria.arg);
  if (
    criteria.op === '==' ||
    criteria.op === '!=' ||
    criteria.op === '<' ||
    criteria.op === '>' ||
    criteria.op === '<=' ||
    criteria.op === '>=' ||
    criteria.op === 'in' ||
    criteria.op === 'contains' ||
    criteria.op === 'startsWith' ||
    criteria.op === 'endsWith'
  ) {
    const value = criteria.value;
    if (isRecordQuery(value)) return true;
    return Array.isArray(value) && value.some(isRecordQuery);
  }
  return false;
}

/** A report-criteria marker. Bound to concrete bounds before ZCQL or an in-memory match. */
export interface RelativeValue {
  __rel: string;
  /** Calendar-day membership (`==` / `is`). Absent means the midnight instant or a period. */
  day?: boolean;
}

export function isRelativeValue(value: unknown): value is RelativeValue {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { __rel?: unknown }).__rel === 'string';
}

function valueHasRelative(value: unknown): boolean {
  if (isRelativeValue(value)) return true;
  return Array.isArray(value) && value.some(isRelativeValue);
}

/** True when a report criteria still carries a relative-date marker. */
export function criteriaHasRelative(criteria: Criteria): boolean {
  if (criteria.op === 'and' || criteria.op === 'or') return criteria.args.some(criteriaHasRelative);
  if (criteria.op === 'not') return criteriaHasRelative(criteria.arg);
  if (
    criteria.op === '==' ||
    criteria.op === '!=' ||
    criteria.op === '<' ||
    criteria.op === '>' ||
    criteria.op === '<=' ||
    criteria.op === '>=' ||
    criteria.op === 'in' ||
    criteria.op === 'contains' ||
    criteria.op === 'startsWith' ||
    criteria.op === 'endsWith'
  ) {
    return valueHasRelative(criteria.value);
  }
  return false;
}

/**
 * Conditional formats are painted in the browser. A relative date is not
 * compared there: the leaf stays untranslated so the format is not applied
 * by string order of the marker.
 */
export function sealRelativeCriteria(criteria: Criteria): Criteria {
  if (criteria.op === 'and' || criteria.op === 'or') return { op: criteria.op, args: criteria.args.map(sealRelativeCriteria) };
  if (criteria.op === 'not') return { op: 'not', arg: sealRelativeCriteria(criteria.arg) };
  if (
    (criteria.op === '==' ||
      criteria.op === '!=' ||
      criteria.op === '<' ||
      criteria.op === '>' ||
      criteria.op === '<=' ||
      criteria.op === '>=' ||
      criteria.op === 'in' ||
      criteria.op === 'contains' ||
      criteria.op === 'startsWith' ||
      criteria.op === 'endsWith') &&
    valueHasRelative(criteria.value)
  ) {
    return { op: 'todo', construct: 'criteria-dynamic' };
  }
  return criteria;
}

function lit(value: unknown): string {
  if (isRelativeValue(value)) throw new UntranslatedConstruct('criteria-dynamic');
  if (isRecordQuery(value)) throw new UntranslatedConstruct('report-criteria');
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${text.replace(/'/g, "''")}'`;
}

function like(value: unknown, mode: 'contains' | 'startsWith' | 'endsWith'): string {
  const raw = typeof value === 'string' ? value : String(value);
  // ZCQL's LIKE wildcard is `*`; `%`, `_` and `\` are literal and not escaped.
  // ZCQL has no escape for a literal `*` or `?`, so a value holding one compiles
  // to the segment pattern (a superset of the real match) and {@link exactFilter}
  // applies the real operator in memory.
  const core = raw.split(/[*?]+/).filter((part) => part !== '');
  if (!core.length) return `'*'`;
  const body = core.map((part) => part.replace(/'/g, "''")).join('*');
  if (mode === 'contains') return `'*${body}*'`;
  if (mode === 'startsWith') return /^[*?]/.test(raw) ? `'*${body}*'` : `'${body}*'`;
  return /[*?]$/.test(raw) ? `'*${body}*'` : `'*${body}'`;
}

/** True when a contains/startsWith/endsWith value holds a ZCQL wildcard char. */
function looseLike(c: Criteria): boolean {
  if (c.op !== 'contains' && c.op !== 'startsWith' && c.op !== 'endsWith') return false;
  return /[*?]/.test(typeof c.value === 'string' ? c.value : String(c.value));
}

/** True when the compiled ZCQL is a superset because a LIKE cannot express a literal wildcard. */
function hasLooseLike(c: Criteria): boolean {
  if (looseLike(c)) return true;
  if (c.op === 'and' || c.op === 'or') return c.args.some(hasLooseLike);
  if (c.op === 'not') return hasLooseLike(c.arg);
  return false;
}

/** Shadow column and scale of one exact-decimal field. */
export interface DecimalColumn {
  shadow: string;
  scale: number;
}

/** field → shadow spec, for one form. */
export type DecimalColumns = Readonly<Record<string, DecimalColumn>>;

const NO_DECIMALS: DecimalColumns = Object.freeze({});
/** ROWID is never null. Bare `true`/`false` inside a ZCQL WHERE is not documented. */
const NEVER = '(ROWID IS NULL)';
const ALWAYS = '(ROWID IS NOT NULL)';

/**
 * Creator `ID` is a logical field, never a Catalyst column: a migrated row keeps
 * its Creator id in `c2c_source_id` and an app-created row has only `ROWID`. A
 * criteria on `ID` compiles against both, so `Form[ID == x]` finds the migrated
 * row by its source id and the new row by its Catalyst ROWID (docs/schema-mapping.md).
 * Each leaf below is total — never UNKNOWN — so it stays correct under
 * AND/OR/NOT for a row whose c2c_source_id is NULL.
 */
const ID_FIELD = 'ID';
/** Same name as SOURCE_ID_COLUMN in packages/schema/src/mapping.ts. */
const ID_SOURCE = 'c2c_source_id';
const ID_ROWID = 'ROWID';

/** The id inside a criteria value: a lookup `{id,label}` or a bound record carries it. */
function idCriteriaValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, '__row')) {
    const values = record.values;
    if (values && typeof values === 'object') {
      const row = values as Record<string, unknown>;
      return row.ROWID ?? row.rowid;
    }
  }
  if (Object.hasOwn(record, 'id')) return record.id;
  return value;
}

/** Quoted digits. c2c_source_id is varchar; `ROWID = 'x'` is the generated shape. */
function idLit(value: unknown): string {
  const v = idCriteriaValue(value);
  return lit(typeof v === 'bigint' || typeof v === 'number' ? String(v) : v);
}

/** Canonical digits of an ordering operand (no leading zeros), or undefined when it is not a whole id. */
function idDigits(value: unknown): string | undefined {
  const v = idCriteriaValue(value);
  const text = typeof v === 'bigint' || typeof v === 'number' || typeof v === 'string' ? String(v) : undefined;
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  return text.replace(/^0+(?=\d)/, '');
}

/**
 * Numeric `<col> <op> <id>` on the varchar c2c_source_id. ZCQL compares a varchar
 * as text ('10000000008009043' > '1000000000000113058') and allows no function or
 * CAST in WHERE, so a digit id is ordered by digit count first, then as text, which
 * is numeric order for ids without leading zeros. The count is a LIKE with ZCQL's
 * documented wildcards: `?` matches exactly one character, `*` zero or more. A
 * non-digit operand keeps the text comparison.
 */
function idOrderZcql(col: string, op: '<' | '>' | '<=' | '>=', value: unknown): string {
  const digits = idDigits(value);
  if (digits === undefined) return `${col} ${op} ${idLit(value)}`;
  const n = '?'.repeat(digits.length);
  const same = `${col} LIKE '${n}'`;
  const fewer = `NOT ${col} LIKE '${n}*'`;
  const more = `${col} LIKE '${n}?*'`;
  const text = `${col} ${op} '${digits}'`;
  return op === '<' || op === '<=' ? `(${fewer} OR (${same} AND ${text}))` : `(${more} OR (${same} AND ${text}))`;
}

/**
 * ZCQL for a leaf on logical `ID`. Equality and `in` match either identifier —
 * a source id names a migrated row and a ROWID names any row. Ordering and text
 * comparisons read the row's effective id: `c2c_source_id` when it exists, else
 * ROWID, and ordering is numeric on either ({@link idOrderZcql}). `isNull` is unreachable on stored rows (ROWID is never NULL); `notNull`
 * is every stored row.
 */
function compileIdLeaf(c: Criteria): string {
  const src = ID_SOURCE;
  const row = ID_ROWID;
  switch (c.op) {
    case '==':
      return `((${src} IS NOT NULL AND ${src} = ${idLit(c.value)}) OR ${row} = ${idLit(c.value)})`;
    case '!=':
      return `((${src} IS NULL OR ${src} != ${idLit(c.value)}) AND ${row} != ${idLit(c.value)})`;
    case 'in': {
      const items = (Array.isArray(c.value) ? c.value : [c.value]).map((v) => idLit(v)).join(', ');
      return `((${src} IS NOT NULL AND ${src} IN (${items})) OR ${row} IN (${items}))`;
    }
    case '<':
    case '>':
    case '<=':
    case '>=':
      return `((${src} IS NOT NULL AND ${idOrderZcql(src, c.op, c.value)}) OR (${src} IS NULL AND ${row} ${c.op} ${idLit(c.value)}))`;
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      const pattern = like(idCriteriaValue(c.value), c.op);
      return `((${src} IS NOT NULL AND ${src} LIKE ${pattern}) OR (${src} IS NULL AND ${row} LIKE ${pattern}))`;
    }
    case 'isNull':
      return `(${src} IS NULL AND ${row} IS NULL)`;
    case 'notNull':
      return `(${src} IS NOT NULL OR ${row} IS NOT NULL)`;
    default:
      throw new Error(`criteria: ID leaf does not take op ${c.op}`);
  }
}

/** Source id and Catalyst id of one row, for in-memory logical-ID matching. */
function idCells(row: Record<string, unknown>): { src: unknown; rid: unknown } {
  const rid = Object.hasOwn(row, 'ROWID') ? row.ROWID : Object.hasOwn(row, 'rowid') ? row.rowid : row.ID;
  return { src: row[ID_SOURCE], rid };
}

/** Id equality across the stored shapes: string, number, bigint, {id,label}. */
function sameIdCell(left: unknown, right: unknown): boolean {
  const value = idCriteriaValue(right);
  if (left == null || value == null) return false;
  if (typeof left === 'bigint' || typeof value === 'bigint') return sameId(left, value);
  if (typeof left === typeof value) return left === value;
  const comparable = (v: unknown) => typeof v === 'number' || typeof v === 'string';
  return comparable(left) && comparable(value) && String(left) === String(value);
}

/**
 * Digit ids compare as integers, whatever their storage shape: digit count first,
 * then text, as {@link idOrderZcql} does. Anything else compares as text.
 */
function compareIdCells(left: unknown, right: unknown): number {
  const a = idCriteriaValue(left);
  const b = idCriteriaValue(right);
  const as = idDigits(a) ?? (a == null ? '' : String(a));
  const bs = idDigits(b) ?? (b == null ? '' : String(b));
  if (/^\d+$/.test(as) && /^\d+$/.test(bs) && as.length !== bs.length) return as.length < bs.length ? -1 : 1;
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** In-memory counterpart of {@link compileIdLeaf}, with the same semantics. */
function matchIdLeaf(row: Record<string, unknown>, c: Criteria): boolean {
  const { src, rid } = idCells(row);
  switch (c.op) {
    case '==':
      return sameIdCell(src, c.value) || sameIdCell(rid, c.value);
    case '!=':
      return !sameIdCell(src, c.value) && !sameIdCell(rid, c.value);
    case 'in': {
      const items = Array.isArray(c.value) ? c.value : [c.value];
      return items.some((item) => sameIdCell(src, item) || sameIdCell(rid, item));
    }
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const cell = src != null ? src : rid;
      if (cell == null) return false;
      const diff = compareIdCells(cell, c.value);
      if (c.op === '<') return diff < 0;
      if (c.op === '>') return diff > 0;
      if (c.op === '<=') return diff <= 0;
      return diff >= 0;
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      const cell = src != null ? src : rid;
      if (cell == null) return false;
      const text = String(cell);
      const needle = c.value == null ? '' : String(idCriteriaValue(c.value));
      if (c.op === 'contains') return text.includes(needle);
      if (c.op === 'startsWith') return text.startsWith(needle);
      return text.endsWith(needle);
    }
    case 'isNull':
      return src == null && rid == null;
    case 'notNull':
      return src != null || rid != null;
    default:
      throw new Error(`criteria: ID leaf does not take op ${c.op}`);
  }
}

/** `(NOT p)` with the always-true marker folded to the never-match clause. */
function notMode(compiled: string): string {
  return compiled === 'true' ? NEVER : `(NOT ${compiled})`;
}

type Mode = 'exact' | 'super' | 'sub';

/**
 * Without `decimals`, the exact ZCQL of `c`. With `decimals`, a WHERE that matches
 * every row `c` matches (and possibly more): decimal leaves use the shadow column.
 * Run {@link exactFilter} on the result to drop the extra rows.
 */
export function compileCriteria(c: Criteria, encrypted: ReadonlySet<string> = new Set(), decimals: DecimalColumns = NO_DECIMALS): string {
  return compileMode(c, encrypted, decimals, 'super');
}

function compileMode(c: Criteria, encrypted: ReadonlySet<string>, decimals: DecimalColumns, mode: Mode): string {
  // Deluge `Field == input.X` with X empty matches the rows where Field is
  // empty; ZCQL has no `= null`, only IS NULL / IS NOT NULL.
  if ((c.op === '==' || c.op === '!=') && c.field !== ID_FIELD && (c.value === null || c.value === undefined)) {
    return compileMode({ op: c.op === '==' ? 'isNull' : 'notNull', field: c.field }, encrypted, decimals, mode);
  }
  if (mode !== 'exact' && !touchesDecimal(c, decimals) && !hasLooseLike(c)) mode = 'exact';
  if (mode !== 'exact' && isDecimalLeaf(c, decimals)) return decimalLeaf(c, decimals[c.field]!, mode);
  switch (c.op) {
    case 'true':
      return 'true';
    case 'todo':
      throw new UntranslatedConstruct(c.construct);
    case 'and': {
      // ZCQL has no boolean literal predicate: a `true` operand carries no
      // clause and is dropped, so `x AND true` compiles as `x`. An empty AND
      // is the always-true marker callers strip to no WHERE.
      const parts = c.args.map((a) => compileMode(a, encrypted, decimals, mode)).filter((part) => part !== 'true');
      if (!parts.length) return 'true';
      return `(${parts.join(' AND ')})`;
    }
    case 'or': {
      const parts = c.args.map((a) => compileMode(a, encrypted, decimals, mode));
      // `x OR true` is always true: keep the marker, never the bare literal.
      if (parts.includes('true')) return 'true';
      return `(${parts.join(' OR ')})`;
    }
    case 'not':
      if (mode === 'super' && isDecimalLeaf(c.arg, decimals)) {
        const bound = decimalBound(c.arg, decimals[c.arg.field]!, 'sub');
        if (bound === NEVER || bound === ALWAYS) return `(NOT ${bound})`;
        return `(NOT (${bound}) OR ${decimals[c.arg.field]!.shadow} IS NULL)`;
      }
      // NOT of a superset is a subset, so the operand is compiled the other way.
      return notMode(compileMode(c.arg, encrypted, decimals, mode === 'super' ? 'sub' : mode === 'sub' ? 'super' : 'exact'));
    case 'isNull':
      if (c.field === ID_FIELD) return compileIdLeaf(c);
      if (encrypted.has(c.field)) throw new EncryptedCriteriaError(c.field, 'IS NULL');
      return `${c.field} IS NULL`;
    case 'notNull':
      if (c.field === ID_FIELD) return compileIdLeaf(c);
      if (encrypted.has(c.field)) throw new EncryptedCriteriaError(c.field, 'IS NOT NULL');
      return `${c.field} IS NOT NULL`;
    case 'contains':
    case 'startsWith':
    case 'endsWith':
      if (c.field === ID_FIELD) return compileIdLeaf(c);
      if (encrypted.has(c.field)) throw new EncryptedCriteriaError(c.field, 'LIKE');
      // A subset of a literal wildcard cannot be expressed as a LIKE: emit the
      // empty match and let the in-memory pass decide (used under NOT).
      if (mode === 'sub' && looseLike(c)) return NEVER;
      return `${c.field} LIKE ${like(c.value, c.op)}`;
    case 'in': {
      if (c.field === ID_FIELD) return compileIdLeaf(c);
      if (encrypted.has(c.field)) throw new EncryptedCriteriaError(c.field, 'IN');
      const items = Array.isArray(c.value) ? c.value.map((v) => lit(v)).join(', ') : lit(c.value);
      return `${c.field} IN (${items})`;
    }
    case '==':
      if (c.field === ID_FIELD) return compileIdLeaf(c);
      return `${c.field} = ${lit(c.value)}`;
    case '!=':
    case '<':
    case '>':
    case '<=':
    case '>=':
      if (c.field === ID_FIELD) return compileIdLeaf(c);
      if (encrypted.has(c.field)) throw new EncryptedCriteriaError(c.field, c.op);
      return `${c.field} ${c.op} ${lit(c.value)}`;
    default: {
      const never: never = c;
      throw new Error(`criteria: ${JSON.stringify(never)}`);
    }
  }
}

type DecimalLeaf = Extract<Criteria, { op: '==' | '!=' | '<' | '>' | '<=' | '>=' | 'in' }>;

function isDecimalLeaf(c: Criteria, decimals: DecimalColumns): c is DecimalLeaf {
  switch (c.op) {
    case '==':
    case '!=':
    case '<':
    case '>':
    case '<=':
    case '>=':
    case 'in':
      return Object.hasOwn(decimals, c.field);
    default:
      return false;
  }
}

/** True when `c` has a comparison on an exact-decimal field. */
export function touchesDecimal(c: Criteria, decimals: DecimalColumns): boolean {
  if (c.op === 'and' || c.op === 'or') return c.args.some((a) => touchesDecimal(a, decimals));
  if (c.op === 'not') return touchesDecimal(c.arg, decimals);
  return isDecimalLeaf(c, decimals);
}

/** Exact decimal of a criteria value, or undefined when it is blank or not a number. */
function exactValue(value: unknown): Decimal | undefined {
  if (value instanceof Decimal) return value;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  try {
    return Decimal.from(String(value));
  } catch {
    return undefined;
  }
}

function absText(d: Decimal): string {
  const text = d.toString();
  return text.startsWith('-') ? text.slice(1) : text;
}

/**
 * [lo, hi] around `v` that holds the stored shadow of any exact value equal to `v`.
 * The shadow is binary64 (relative error 2^-53 < 1.2e-16), and a Double column with
 * `decimal_digits = scale` may round it to `scale` places (error 0.5 * 10^-scale).
 * The margin 10^-scale + |v| * 10^-15 covers both, and the rounding of the literal itself.
 * Not measured on a live column: deploy creates the Double with `max_length` 15
 * (`columnBody`). If Catalyst caps it at 15 significant digits, a 16+ digit value
 * (Creator allows 19 characters) can round by more than this margin.
 */
function bounds(v: Decimal, scale: number): { lo: string; hi: string } {
  const margin = Decimal.from(`1e-${Math.max(0, scale)}`).add(Decimal.from(absText(v)).mul('0.000000000000001'));
  return { lo: plain(v.sub(margin)), hi: plain(v.add(margin)) };
}

/** Decimal literal without trailing fractional zeros. Never exponent notation. */
function plain(d: Decimal): string {
  const text = d.toString();
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * Superset (`super`) or subset (`sub`) of one decimal comparison, on the shadow
 * column, never UNKNOWN: a NULL shadow is in every superset and in no subset.
 */
function decimalLeaf(c: DecimalLeaf, spec: DecimalColumn, mode: 'super' | 'sub'): string {
  const bound = decimalBound(c, spec, mode);
  if (bound === NEVER || bound === ALWAYS) return bound;
  return mode === 'super' ? `(${bound} OR ${spec.shadow} IS NULL)` : `(${spec.shadow} IS NOT NULL AND ${bound})`;
}

/** The comparison on a non-NULL shadow, or {@link NEVER} / {@link ALWAYS}. */
function decimalBound(c: DecimalLeaf, spec: DecimalColumn, mode: 'super' | 'sub'): string {
  const s = spec.shadow;
  const loose = mode === 'super' ? ALWAYS : NEVER;
  if (c.op === 'in') {
    const items = Array.isArray(c.value) ? c.value : [c.value];
    // A subset of exact equality cannot be bounded on a rounded shadow. `in ()` matches nothing.
    if (mode === 'sub' || !items.length) return NEVER;
    const parts: string[] = [];
    for (const item of items) {
      const v = exactValue(item);
      if (!v) return loose;
      const { lo, hi } = bounds(v, spec.scale);
      parts.push(`(${s} >= ${lo} AND ${s} <= ${hi})`);
    }
    return `(${parts.join(' OR ')})`;
  }
  const v = exactValue(c.value);
  if (!v) return loose;
  const { lo, hi } = bounds(v, spec.scale);
  if (mode === 'super') {
    switch (c.op) {
      case '<':
      case '<=':
        return `${s} <= ${hi}`;
      case '>':
      case '>=':
        return `${s} >= ${lo}`;
      case '==':
        return `(${s} >= ${lo} AND ${s} <= ${hi})`;
      case '!=':
        return ALWAYS;
    }
  }
  switch (c.op) {
    case '<':
    case '<=':
      return `${s} < ${lo}`;
    case '>':
    case '>=':
      return `${s} > ${hi}`;
    case '==':
      return NEVER;
    case '!=':
      return `(${s} < ${lo} OR ${s} > ${hi})`;
  }
}

/**
 * In-memory filter that makes a {@link compileCriteria} superset exact. Null when
 * the criteria has no decimal comparison and no LIKE over a literal wildcard,
 * so the ZCQL result is already exact.
 *
 * Decimal comparisons are exact (`decimal.cmp` on the varchar). A subtree without
 * one is already enforced by ZCQL when every ancestor is AND, so it is not re-checked.
 * Under OR or NOT it is evaluated in memory with {@link matchRow}.
 */
export function exactFilter(c: Criteria, decimals: DecimalColumns): ((row: Record<string, unknown>) => boolean) | null {
  const inexact = (node: Criteria): boolean => touchesDecimal(node, decimals) || hasLooseLike(node);
  if (!inexact(c)) return null;
  const evaluate = (node: Criteria, trusted: boolean, row: Record<string, unknown>): boolean => {
    if (!inexact(node)) return trusted ? true : matchRow(row, node, decimals);
    if (node.op === 'and') return node.args.every((a) => evaluate(a, trusted, row));
    if (node.op === 'or') return node.args.some((a) => evaluate(a, false, row));
    if (node.op === 'not') return !evaluate(node.arg, false, row);
    return matchRow(row, node, decimals);
  };
  return (row) => evaluate(c, true, row);
}

/**
 * Whether `row` matches `c`, in memory. Dry-run seeded reads use this, and so does
 * {@link exactFilter}. Fields in `decimals` compare with `decimal.cmp`, not as text.
 */
export function matchRow(row: Record<string, unknown>, c: Criteria, decimals: DecimalColumns = NO_DECIMALS): boolean {
  switch (c.op) {
    case 'true':
      return true;
    case 'todo':
      throw new UntranslatedConstruct(c.construct);
    case 'and':
      return c.args.every((arg) => matchRow(row, arg, decimals));
    case 'or':
      return c.args.some((arg) => matchRow(row, arg, decimals));
    case 'not':
      return !matchRow(row, c.arg, decimals);
    case 'isNull':
      if (c.field === ID_FIELD) return matchIdLeaf(row, c);
      return row[c.field] == null;
    case 'notNull':
      if (c.field === ID_FIELD) return matchIdLeaf(row, c);
      return row[c.field] != null;
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      if (c.field === ID_FIELD) return matchIdLeaf(row, c);
      const text = row[c.field] == null ? '' : String(row[c.field]);
      const needle = c.value == null ? '' : String(c.value);
      if (c.op === 'contains') return text.includes(needle);
      if (c.op === 'startsWith') return text.startsWith(needle);
      return text.endsWith(needle);
    }
    case 'in': {
      if (c.field === ID_FIELD) return matchIdLeaf(row, c);
      const items = Array.isArray(c.value) ? c.value : [c.value];
      if (Object.hasOwn(decimals, c.field)) return items.some((item) => decimalCompare(row[c.field], item, '=='));
      return items.some((item) => sameCell(row[c.field], item));
    }
    case '==':
      if (c.field === ID_FIELD) return matchIdLeaf(row, c);
      if (Object.hasOwn(decimals, c.field)) return decimalCompare(row[c.field], c.value, '==');
      return sameCell(row[c.field], c.value);
    case '!=':
      if (c.field === ID_FIELD) return matchIdLeaf(row, c);
      if (Object.hasOwn(decimals, c.field)) return decimalCompare(row[c.field], c.value, '!=');
      return !sameCell(row[c.field], c.value);
    case '<':
    case '>':
    case '<=':
    case '>=':
      if (c.field === ID_FIELD) return matchIdLeaf(row, c);
      if (Object.hasOwn(decimals, c.field)) return decimalCompare(row[c.field], c.value, c.op);
      return compareRel(row[c.field], c.value, c.op);
    default: {
      const never: never = c;
      throw new Error(`criteria: ${JSON.stringify(never)}`);
    }
  }
}

/** True when `value` is a blank or a number `decimal.cmp` accepts. */
function decimalOperand(value: unknown): value is string | number | bigint | Decimal | null | undefined {
  if (value == null || value instanceof Decimal) return true;
  if (typeof value === 'string') return value.trim() === '' || exactValue(value) !== undefined;
  if (typeof value === 'number' || typeof value === 'bigint') return exactValue(value) !== undefined;
  return false;
}

/**
 * `decimal.cmp`, exact. A blank is null (relational false). When a side is not a
 * number at all, the comparison falls back to the plain cell rules used before.
 */
function decimalCompare(left: unknown, right: unknown, op: '==' | '!=' | '<' | '>' | '<=' | '>='): boolean {
  if (decimalOperand(left) && decimalOperand(right)) {
    const r = typeof right === 'bigint' ? right.toString() : right;
    const l = typeof left === 'bigint' ? left.toString() : left;
    return decimal.cmp(l, r, op);
  }
  if (op === '==') return sameCell(left, right);
  if (op === '!=') return !sameCell(left, right);
  return compareRel(left, right, op);
}

/**
 * Sort order of two exact-decimal cells: blank first, then exact numeric order.
 * A non-number falls back to text order. ZCQL puts a null shadow first ascending.
 */
export function compareDecimalCells(left: unknown, right: unknown): number {
  const blankL = left == null || (typeof left === 'string' && left.trim() === '');
  const blankR = right == null || (typeof right === 'string' && right.trim() === '');
  if (blankL || blankR) return blankL && blankR ? 0 : blankL ? -1 : 1;
  const a = exactValue(left);
  const b = exactValue(right);
  if (a && b) return a.compare(b);
  return compareCells(left, right);
}

/** Shadow value written next to an exact-decimal cell. Null for a blank or a non-number. */
export function decimalShadow(value: unknown): number | null {
  const v = exactValue(value);
  if (!v) return null;
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : null;
}

export function sameCell(left: unknown, right: unknown): boolean {
  if (typeof left === 'bigint' || typeof right === 'bigint') return sameId(left, right);
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  if (typeof left === 'string' && typeof right === 'string') return left === right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right;
  if (left == null || right == null) return left == null && right == null;
  return left === right;
}

export function compareCells(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  const as = left == null ? '' : String(left);
  const bs = right == null ? '' : String(right);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function tryDate(value: unknown): DelugeDate | null {
  if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return null;
  try {
    return asDate(value);
  } catch {
    return null;
  }
}

function compareRel(left: unknown, right: unknown, op: '<' | '>' | '<=' | '>='): boolean {
  const ld = tryDate(left);
  const rd = tryDate(right);
  // A date orders against a date. A blank or a non-date does not match a date bound.
  if (ld || rd) {
    if (!ld || !rd) return false;
    const diff = cmp(ld, rd);
    if (op === '<') return diff < 0;
    if (op === '>') return diff > 0;
    if (op === '<=') return diff <= 0;
    return diff >= 0;
  }
  const diff = compareCells(left, right);
  if (op === '<') return diff < 0;
  if (op === '>') return diff > 0;
  if (op === '<=') return diff <= 0;
  return diff >= 0;
}

export type DateFieldKind = 'date' | 'datetime';

/**
 * Replace `{ __rel }` markers with concrete bounds at `instant` in `zone`.
 *
 * `today` is 00:00:00 in the application time zone
 * (https://www.zoho.com/deluge/help/functions/datetime/today.html).
 * A week starts on Sunday
 * (https://www.zoho.com/deluge/help/functions/datetime/getweekofyear.html).
 * `in this month` and the other period tests are a half-open range
 * `[start, end)` (https://www.zoho.com/deluge/help/criteria.html).
 * `== today` is that whole calendar day. `< today` compares to midnight.
 * A date column is stored as `yyyy-MM-dd`; a datetime column as
 * `yyyy-MM-dd HH:mm:ss`. An unknown field is treated as datetime.
 * A missing or invalid zone throws. Callers fail the read closed.
 */
export function bindRelativeCriteria(
  criteria: Criteria,
  instant: Date,
  zone: string,
  fieldKinds: Readonly<Record<string, DateFieldKind>> = {},
): Criteria {
  const resolved = requireZone(zone);
  return bindNode(criteria, instant, resolved, fieldKinds);
}

function bindNode(criteria: Criteria, instant: Date, zone: string, kinds: Readonly<Record<string, DateFieldKind>>): Criteria {
  if (criteria.op === 'and' || criteria.op === 'or') {
    return { op: criteria.op, args: criteria.args.map((arg) => bindNode(arg, instant, zone, kinds)) };
  }
  if (criteria.op === 'not') return { op: 'not', arg: bindNode(criteria.arg, instant, zone, kinds) };
  if (
    (criteria.op === '==' || criteria.op === '!=' || criteria.op === '<' || criteria.op === '>' || criteria.op === '<=' || criteria.op === '>=' || criteria.op === 'in') &&
    isRelativeValue(criteria.value)
  ) {
    return bindRelativeLeaf(criteria, instant, zone, kinds);
  }
  return criteria;
}

function bindRelativeLeaf(
  criteria: Extract<Criteria, { op: '==' | '!=' | '<' | '>' | '<=' | '>=' | 'in' }>,
  instant: Date,
  zone: string,
  kinds: Readonly<Record<string, DateFieldKind>>,
): Criteria {
  const rel = criteria.value as RelativeValue;
  const kind = kinds[criteria.field] ?? 'datetime';
  if (rel.__rel === 'now') {
    if (criteria.op === 'in') throw new UntranslatedConstruct('criteria-dynamic');
    return bindInstant(criteria, now(instant, zone), kind);
  }
  if (rel.day) return bindRange(criteria, shiftDay(rel.__rel, instant, zone), kind);
  if (rel.__rel === 'today' || rel.__rel === 'yesterday' || rel.__rel === 'tomorrow') {
    const day = shiftDay(rel.__rel, instant, zone);
    if (criteria.op === 'in') return bindRange(criteria, day, kind);
    return bindInstant(criteria, day, kind);
  }
  const window = periodWindow(rel.__rel, instant, zone);
  return bindRange(criteria, window.start, kind, window.end);
}

function shiftDay(spec: string, instant: Date, zone: string): DelugeDate {
  const base = today(instant, zone);
  if (spec === 'today') return base;
  if (spec === 'yesterday') return addDays(base, -1);
  if (spec === 'tomorrow') return addDays(base, 1);
  throw new UntranslatedConstruct('criteria-dynamic');
}

function bindRange(
  criteria: Extract<Criteria, { op: '==' | '!=' | '<' | '>' | '<=' | '>=' | 'in' }>,
  start: DelugeDate,
  kind: DateFieldKind,
  end = addDays(start, 1),
): Criteria {
  const range: Criteria = {
    op: 'and',
    args: [
      { op: '>=', field: criteria.field, value: formatBound(start, kind) },
      { op: '<', field: criteria.field, value: formatBound(end, kind) },
    ],
  };
  if (criteria.op === '==' || criteria.op === 'in') return range;
  if (criteria.op === '!=') return { op: 'not', arg: range };
  throw new UntranslatedConstruct('criteria-dynamic');
}

function bindInstant(
  criteria: Extract<Criteria, { op: '==' | '!=' | '<' | '>' | '<=' | '>=' | 'in' }>,
  at: DelugeDate,
  kind: DateFieldKind,
): Criteria {
  if (criteria.op === 'in') throw new UntranslatedConstruct('criteria-dynamic');
  if (kind === 'datetime') return { op: criteria.op, field: criteria.field, value: formatBound(at, 'datetime') };
  // A date cell is midnight of that calendar day.
  const day = formatBound(new DelugeDate(at.y, at.m, at.d), 'date');
  const midnight = at.hh === 0 && at.mm === 0 && at.ss === 0;
  const eq: Criteria = midnight
    ? { op: '==', field: criteria.field, value: day }
    : {
        op: 'and',
        args: [
          { op: '==', field: criteria.field, value: day },
          { op: '!=', field: criteria.field, value: day },
        ],
      };
  switch (criteria.op) {
    case '==':
      return eq;
    case '!=':
      return { op: 'not', arg: eq };
    case '<':
      return { op: midnight ? '<' : '<=', field: criteria.field, value: day };
    case '<=':
      return { op: '<=', field: criteria.field, value: day };
    case '>':
      return { op: '>', field: criteria.field, value: day };
    case '>=':
      return { op: midnight ? '>=' : '>', field: criteria.field, value: day };
    default:
      throw new UntranslatedConstruct('criteria-dynamic');
  }
}

/**
 * `last N` excludes the current period. `next N` starts at the next period.
 * `N ago` is that one period. N is a natural number. Days are calendar days
 * from today; weeks start on Sunday; months and years start on the 1st.
 */
function periodWindow(spec: string, instant: Date, zone: string): { start: DelugeDate; end: DelugeDate } {
  const base = today(instant, zone);
  const week0 = startOfWeek(base);
  const month0 = startOfMonth(base);
  const year0 = new DelugeDate(base.y, 1, 1);
  const simple = /^(this|last|next) (week|month|year)$/.exec(spec);
  if (simple) {
    const which = simple[1]!;
    const unit = simple[2]!;
    const start0 = unit === 'week' ? week0 : unit === 'month' ? month0 : year0;
    const step = (value: DelugeDate, n: number) => (unit === 'week' ? addDays(value, 7 * n) : unit === 'month' ? addMonths(value, n) : addMonths(value, 12 * n));
    if (which === 'this') return { start: start0, end: step(start0, 1) };
    if (which === 'last') return { start: step(start0, -1), end: start0 };
    return { start: step(start0, 1), end: step(start0, 2) };
  }
  const counted = /^(last|next) (\d+) (days|weeks|months|years)$/.exec(spec);
  if (counted) {
    const n = Number(counted[2]);
    if (!Number.isInteger(n) || n < 1) throw new UntranslatedConstruct('criteria-dynamic');
    const unit = counted[3]!;
    if (counted[1] === 'last') {
      if (unit === 'days') return { start: addDays(base, -n), end: base };
      if (unit === 'weeks') return { start: addDays(week0, -7 * n), end: week0 };
      if (unit === 'months') return { start: addMonths(month0, -n), end: month0 };
      return { start: addMonths(year0, -12 * n), end: year0 };
    }
    if (unit === 'days') return { start: addDays(base, 1), end: addDays(base, 1 + n) };
    if (unit === 'weeks') {
      const next = addDays(week0, 7);
      return { start: next, end: addDays(next, 7 * n) };
    }
    if (unit === 'months') {
      const next = addMonths(month0, 1);
      return { start: next, end: addMonths(next, n) };
    }
    const next = addMonths(year0, 12);
    return { start: next, end: addMonths(next, 12 * n) };
  }
  const ago = /^(\d+) (days|weeks|months|years) ago$/.exec(spec);
  if (ago) {
    const n = Number(ago[1]);
    if (!Number.isInteger(n) || n < 1) throw new UntranslatedConstruct('criteria-dynamic');
    const unit = ago[2]!;
    if (unit === 'days') {
      const day = addDays(base, -n);
      return { start: day, end: addDays(day, 1) };
    }
    if (unit === 'weeks') {
      const start = addDays(week0, -7 * n);
      return { start, end: addDays(start, 7) };
    }
    if (unit === 'months') {
      const start = addMonths(month0, -n);
      return { start, end: addMonths(start, 1) };
    }
    const start = addMonths(year0, -12 * n);
    return { start, end: addMonths(start, 12) };
  }
  throw new UntranslatedConstruct('criteria-dynamic');
}

function formatDate(value: DelugeDate): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${value.y}-${p(value.m)}-${p(value.d)}`;
}

function formatBound(value: DelugeDate, kind: DateFieldKind): string {
  if (kind === 'date') return formatDate(value);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(value)} ${p(value.hh)}:${p(value.mm)}:${p(value.ss)}`;
}
