/**
 * Creator list and map operations. Dispatch is by runtime shape so an
 * untyped receiver still matches: arrays are lists, plain objects are maps,
 * and text `.get` is null.
 */
import { DelugeDate, asDate, cmp as dateCmp } from './date.js';
import { Decimal } from './decimal.js';
import { DelugeRuntimeError } from './errors.js';
import { parseJsonLossless, sameId } from './ids.js';
import { removeText } from './text.js';

function isPlain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if ('__query' in (value as object)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function shownIndex(index: unknown): string {
  if (typeof index === 'number' || typeof index === 'string') return String(index);
  return String(Number(index));
}

function asIndex(index: unknown): number {
  return typeof index === 'number' ? index : Number(index);
}

export function get(value: unknown, index: unknown): unknown {
  if (Array.isArray(value)) {
    const i = asIndex(index);
    if (!Number.isInteger(i) || i < 0 || i >= value.length) {
      throw new DelugeRuntimeError(`Given index ${shownIndex(index)} is greater than the list size`);
    }
    return value[i];
  }
  if (isPlain(value)) {
    if (index == null) return null;
    const key = String(index);
    return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : null;
  }
  return null;
}

/**
 * `x.getJson(key)` reads a JSON-formatted text or a key-value collection.
 * A missing key is null; input that is not JSON text or a key-value
 * collection is a runtime error (deluge-docs functions/common/getjson).
 */
export function getJson(value: unknown, key: unknown): unknown {
  if (value == null) return null;
  let target: unknown = value;
  if (typeof value === 'string') {
    try {
      target = parseJsonLossless(value);
    } catch {
      throw new DelugeRuntimeError('getJson: input is not a JSON formatted text');
    }
  }
  if (isPlain(target)) {
    if (key == null) return null;
    const k = String(key);
    const found = Object.prototype.hasOwnProperty.call(target, k) ? target[k] : null;
    return found ?? null;
  }
  throw new DelugeRuntimeError('getJson: input is not a key-value collection');
}

/** Key spellings a map write may never use: they reach the shared prototype. */
const UNSAFE_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * `m.put(key, value)` inserts or overwrites the pair and returns the map
 * (deluge-docs map-manipulations/put). An array receiver takes
 * `put(index, value)`; anything else is returned unchanged.
 */
export function put(value: unknown, key: unknown, val?: unknown): unknown {
  if (isPlain(value)) {
    if (key != null && !UNSAFE_MAP_KEYS.has(String(key))) value[String(key)] = val ?? null;
    return value;
  }
  if (Array.isArray(value)) {
    const i = asIndex(key);
    if (Number.isInteger(i) && i >= 0) value[i] = val ?? null;
  }
  return value;
}

export function remove(value: unknown, a?: unknown, b?: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new DelugeRuntimeError('emptyList');
    const i = asIndex(a);
    if (!Number.isInteger(i) || i < 0 || i >= value.length) {
      throw new DelugeRuntimeError(`Given index ${shownIndex(a)} is greater than the list size`);
    }
    return value.splice(i, 1)[0];
  }
  return removeText(value, a, b);
}

export function removeAll(value: unknown, drop: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const ban = Array.isArray(drop) ? drop : [drop];
  const next = value.filter((item) => !ban.some((x) => x === item));
  value.length = 0;
  value.push(...next);
  return value;
}

export function removeElement(value: unknown, item: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const at = value.findIndex((x) => x === item);
  if (at >= 0) value.splice(at, 1);
  return value;
}

export function distinct(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const out: unknown[] = [];
  for (const item of value) {
    if (!out.some((seen) => seen === item)) out.push(item);
  }
  return out;
}

/**
 * UTF-16 code units, not localeCompare. sort.strings is a, a, b, c — code
 * units and en-US agree on that vector, and code units do not follow LANG.
 */
function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  const as = a == null ? '' : String(a);
  const bs = b == null ? '' : String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** `sort()` and `sort(true)` ascend. `sort(false)` descends. Mutates and returns the list. */
export function sort(value: unknown, asc?: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const dir = asc === false ? -1 : 1;
  value.sort((a, b) => compare(a, b) * dir);
  return value;
}

export function intersect(left: unknown, right: unknown): unknown[] {
  if (!Array.isArray(left) || !Array.isArray(right)) return [];
  const out: unknown[] = [];
  for (const item of left) {
    if (right.some((x) => x === item) && !out.some((seen) => seen === item)) out.push(item);
  }
  return out;
}

export function indexOf(value: unknown, needle: unknown, from?: unknown): number {
  const start = from == null ? 0 : Number(from);
  if (Array.isArray(value)) {
    for (let i = Number.isFinite(start) ? start : 0; i < value.length; i++) {
      if (sameId(value[i], needle)) return i;
    }
    return -1;
  }
  const s = value == null ? '' : String(value);
  return s.indexOf(needle == null ? '' : String(needle), Number.isFinite(start) ? start : 0);
}

/** Creator `length()` on a list is null. On text it is the character count. */
export function length(value: unknown): number | null {
  if (typeof value === 'string') return value.length;
  return null;
}

export function size(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (isPlain(value)) return Object.keys(value).length;
  if (typeof value === 'string') return value.length;
  return null;
}

export function add(value: unknown, ...items: unknown[]): unknown {
  if (!Array.isArray(value)) return value;
  value.push(...items);
  return value;
}

export function addAll(value: unknown, extra: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (Array.isArray(extra)) value.push(...extra);
  return value;
}

export function contains(value: unknown, needle: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => sameId(item, needle));
  if (value == null) return false;
  return String(value).includes(needle == null ? '' : String(needle));
}

export function containsKey(value: unknown, key: unknown): boolean {
  if (!isPlain(value) || key == null) return false;
  return Object.prototype.hasOwnProperty.call(value, String(key));
}

export function clear(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.length = 0;
    return value;
  }
  if (isPlain(value)) {
    for (const key of Object.keys(value)) delete value[key];
    return value;
  }
  return value;
}

export function insert(value: unknown, a?: unknown, b?: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (typeof a === 'number' && arguments.length >= 3) {
    const i = a < 0 ? 0 : a > value.length ? value.length : a;
    value.splice(i, 0, b);
    return value;
  }
  value.push(a);
  return value;
}

export function insertAll(value: unknown, a?: unknown, b?: unknown): unknown {
  if (!Array.isArray(value)) return value;
  let index: number | undefined;
  let extra: unknown;
  if (typeof a === 'number' && arguments.length >= 3) {
    index = a < 0 ? 0 : a > value.length ? value.length : a;
    extra = b;
  } else {
    extra = a;
  }
  if (Array.isArray(extra)) {
    if (index !== undefined) {
      value.splice(index, 0, ...extra);
    } else {
      value.push(...extra);
    }
  } else {
    if (index !== undefined) {
      value.splice(index, 0, extra);
    } else {
      value.push(extra);
    }
  }
  return value;
}

export function putAll(value: unknown, extra: unknown): unknown {
  if (isPlain(value) && isPlain(extra)) {
    for (const key of Object.keys(extra)) {
      if (!UNSAFE_MAP_KEYS.has(key)) value[key] = extra[key];
    }
  }
  return value;
}

export function lastIndexOf(value: unknown, needle: unknown): number {
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      if (sameId(value[i], needle)) return i;
    }
    return -1;
  }
  const s = value == null ? '' : String(value);
  return s.lastIndexOf(needle == null ? '' : String(needle));
}

export function values(value: unknown): unknown[] {
  if (isPlain(value)) return Object.values(value);
  if (Array.isArray(value)) return value.slice();
  return [];
}

export function update(value: unknown, a: unknown, b: unknown): unknown {
  if (isPlain(value)) {
    if (a != null) value[String(a)] = b ?? null;
    return value;
  }
  if (Array.isArray(value)) {
    const i = asIndex(a);
    if (!Number.isInteger(i) || i < 0 || i >= value.length) {
      throw new DelugeRuntimeError(`Given index ${shownIndex(a)} is greater than the list size`);
    }
    value[i] = b ?? null;
    return value;
  }
  return value;
}

export function keys(value: unknown): unknown[] {
  if (isPlain(value)) return Object.keys(value);
  return [];
}

export function isEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlain(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * `l.subList(start[, end])`: a new list of the elements from `start` up to,
 * not including, `end` (default: the list size). A negative start, an end
 * past the size, or an end before the start is a runtime error
 * (functions/list/sublist). The receiver is not changed.
 */
export function subList(value: unknown, start: unknown, end?: unknown): unknown[] {
  if (!Array.isArray(value)) throw new DelugeRuntimeError('subList: receiver is not a list');
  const a = asIndex(start);
  const b = end === undefined || end === null ? value.length : asIndex(end);
  if (!Number.isInteger(a) || a < 0) throw new DelugeRuntimeError(`Given index ${shownIndex(start)} is invalid`);
  if (!Number.isInteger(b) || b > value.length) {
    throw new DelugeRuntimeError(`Given index ${shownIndex(end)} is greater than the list size`);
  }
  if (a > b) throw new DelugeRuntimeError('Start index cannot be greater than the end index');
  return value.slice(a, b);
}

function readField(row: unknown, field: string): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  // A fetched or constructed row is `{ __row, form, values }`; the fields are
  // the values (runtime.ts RowMeta).
  const values = '__row' in row ? (row as Record<string, unknown>).values : undefined;
  const rec = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>) : (row as Record<string, unknown>);
  if (field === 'ID' && !Object.hasOwn(rec, 'ID')) return rec.ROWID ?? rec.rowid ?? null;
  return Object.hasOwn(rec, field) ? (rec[field] ?? null) : null;
}

/**
 * `Rows.Field.getAll()` on rows already in memory (a subform of the current
 * input or of a fetched record): that field's value on every row, in row
 * order. Not a list of rows: an empty list. One row: a one-element list.
 */
export function column(rows: unknown, field: unknown): unknown[] {
  const name = field == null ? '' : String(field);
  if (Array.isArray(rows)) return rows.map((row) => readField(row, name));
  if (rows && typeof rows === 'object') return [readField(rows, name)];
  return [];
}

function blankValue(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Decimal) return Number(v.toString());
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) throw new DelugeRuntimeError(`Cannot apply an aggregate function on a non numeric value ${String(v)}`);
  return n;
}

function isDateLike(v: unknown): boolean {
  if (v instanceof DelugeDate) return true;
  if (typeof v !== 'string') return false;
  try {
    return asDate(v) !== null;
  } catch {
    return false;
  }
}

function orderOf(a: unknown, b: unknown, dates: boolean, exact: boolean): number {
  if (dates) return dateCmp(asDate(a)!, asDate(b)!);
  if (exact) return Decimal.from(decimalText(a)).compare(decimalText(b));
  const x = asNumber(a);
  const y = asNumber(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function exactSum(values: unknown[]): Decimal {
  let total = Decimal.from(0);
  for (const v of values) {
    const text = decimalText(v);
    // Validates the value; a non-numeric value is the aggregate error.
    if (!(v instanceof Decimal)) asNumber(v);
    total = total.add(text);
  }
  return total;
}

function decimalText(v: unknown): string {
  if (v instanceof Decimal) return v.toString();
  if (typeof v === 'bigint') return v.toString();
  return String(v).trim();
}

/**
 * Creator aggregate functions over values already fetched or in memory:
 * `count`, `sum`, `avg` (`average`), `min` (`minimum`), `max` (`maximum`),
 * `median` and `distinct` (data-access/aggregate-records/*, functions/number/average).
 *
 * With `field`, `rows` is a list of records and the field is read from each.
 * Without it, `rows` is the value list. Blank values are skipped. `count()`
 * is the number of rows. `count(field)` is the number of values that field
 * holds: a stored empty string counts and null does not. With no non-blank
 * value every other function is null.
 * `exact` (a decimal, percent or currency field, or any decimal in the list)
 * sums and averages as exact decimals; otherwise the result is a number.
 * `min` and `max` also order date and date-time values and return the value.
 * `median` of an even count is the mean of the two middle values.
 */
/**
 * The receiver of `<numberList>.average()` / `.median()`: the pages document a
 * NUMBER LIST or DECIMAL LIST only, so a scalar or null is refused instead of
 * being read as a one-element list.
 */
export function numberList(value: unknown, fn: unknown): unknown[] {
  if (!Array.isArray(value)) throw new DelugeRuntimeError(`${String(fn)}: expected a number list`);
  return value;
}

export function aggregate(rows: unknown, fn: unknown, field?: unknown, exact?: unknown): unknown {
  const list = Array.isArray(rows) ? rows : rows == null ? [] : [rows];
  const name = String(fn).toLowerCase();
  const op = name === 'average' ? 'avg' : name === 'maximum' ? 'max' : name === 'minimum' ? 'min' : name;
  const raw = field == null || field === '' ? list : list.map((row) => readField(row, String(field)));
  // `count(field)` counts the values the field holds. A stored empty string
  // counts; null does not (data-access/aggregate-records/count). Without a
  // field, count is the number of fetched records.
  if (op === 'count') return field == null || field === '' ? list.length : raw.filter((v) => v != null).length;
  if (op === 'distinct') return distinct(raw);
  const values = raw.filter((v) => !blankValue(v));
  if (!values.length) return null;
  const decimalMode = exact === true || values.some((v) => v instanceof Decimal);
  if (op === 'min' || op === 'max' || op === 'median') {
    const byDate = op !== 'median' && values.every(isDateLike);
    const sorted = values.slice().sort((a, b) => orderOf(a, b, byDate, decimalMode && !byDate));
    // Stored numbers can arrive as text; the result is a number (or an exact
    // decimal for a decimal field), never the text.
    const typed = (v: unknown): unknown => (byDate ? asDate(v) : decimalMode ? Decimal.from(decimalText(v)) : asNumber(v));
    if (op === 'min') return typed(sorted[0]);
    if (op === 'max') return typed(sorted[sorted.length - 1]);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return typed(sorted[mid]);
    const half = exactSum([sorted[mid - 1], sorted[mid]]).div(2);
    return decimalMode ? half : Number(half.toString());
  }
  if (op === 'sum' || op === 'avg') {
    // Summed exactly either way, so 10.10 + 0.20 is 10.3, not 10.299999999999999.
    const total = exactSum(values);
    const result = op === 'sum' ? total : total.div(values.length);
    return decimalMode ? result : Number(result.toString());
  }
  throw new DelugeRuntimeError(`Unknown aggregate function ${String(fn)}`);
}

export function containsValue(value: unknown, val: unknown): boolean {
  if (isPlain(value)) return Object.values(value).some((item) => sameId(item, val));
  if (Array.isArray(value)) return value.some((item) => sameId(item, val));
  return false;
}

export function deleteKey(value: unknown, key: unknown): unknown {
  if (isPlain(value)) {
    if (key != null) delete value[String(key)];
  } else if (Array.isArray(value)) {
    const i = asIndex(key);
    if (!Number.isInteger(i) || i < 0 || i >= value.length) {
      throw new DelugeRuntimeError(`Given index ${shownIndex(key)} is greater than the list size`);
    }
    value.splice(i, 1);
  }
  return value;
}

export function deleteKeys(value: unknown, keysList: unknown): unknown {
  if (!Array.isArray(keysList)) return value;
  if (isPlain(value)) {
    for (const k of keysList) {
      if (k != null) delete value[String(k)];
    }
  } else if (Array.isArray(value)) {
    // Collect valid indices
    const indices: number[] = [];
    for (const k of keysList) {
      const i = asIndex(k);
      if (Number.isInteger(i) && i >= 0 && i < value.length) {
        indices.push(i);
      }
    }
    // Sort descending to not mess up indices during splice
    indices.sort((a, b) => b - a);
    for (const i of indices) {
      value.splice(i, 1);
    }
  }
  return value;
}

export function getKey(value: unknown, val: unknown): unknown {
  if (isPlain(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (sameId(v, val)) return k;
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (sameId(value[i], val)) return i;
    }
  }
  return Array.isArray(value) ? -1 : null;
}

export function getLastKey(value: unknown, val: unknown): unknown {
  if (isPlain(value)) {
    const keys = Object.keys(value);
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i]!;
      if (sameId(value[k], val)) return k;
    }
  } else if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      if (sameId(value[i], val)) return i;
    }
  }
  return Array.isArray(value) ? -1 : null;
}

export function deleteItem(value: unknown, item: unknown): unknown {
  if (Array.isArray(value)) {
    const i = value.findIndex((x) => sameId(x, item));
    if (i >= 0) value.splice(i, 1);
  }
  return value;
}

export function deleteAll(value: unknown, item: unknown): unknown {
  if (Array.isArray(value)) {
    let i = 0;
    while (i < value.length) {
      if (sameId(value[i], item)) {
        value.splice(i, 1);
      } else {
        i++;
      }
    }
  }
  return value;
}

export function duplicate(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice();
  if (isPlain(value)) return { ...value };
  return value;
}

export function sortKey(value: unknown): unknown {
  if (!isPlain(value)) return value;
  const keys = Object.keys(value).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = (value as Record<string, unknown>)[k];
  }
  return out;
}

/**
 * `notContains` (https://www.zoho.com/deluge/help/functions/string/notcontains.html).
 * Text is `contains` negated: a case-sensitive search, so "Zoho Creator"
 * does not contain "CREATOR". A list uses the same value test as `contains`,
 * negated. A map searches keys, negated: the help page returns true for an
 * absent key ("price") and false for a present key ("subscription").
 * Any other value is `contains` negated. A null receiver is not a collection;
 * `contains` is false, so this is true.
 */
export function notContains(value: unknown, needle: unknown): boolean {
  if (Array.isArray(value)) return !contains(value, needle);
  if (isPlain(value)) return !containsKey(value, needle);
  return !contains(value, needle);
}
