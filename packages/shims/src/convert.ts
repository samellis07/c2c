/**
 * Deluge value conversions.
 *
 * - toLong / toNumber — https://www.zoho.com/deluge/help/functions/common/tolong.html
 *   Decimals truncate toward zero (including negatives). Date-time becomes
 *   epoch milliseconds in the app time zone, including across a DST boundary.
 *   Integers past 2^53 are returned as bigint; a JS number that is already
 *   past the safe range throws rather than rounding. Empty text and
 *   non-numeric text throw. Null throws (it is not NUMBER / DECIMAL /
 *   DATE-TIME / TEXT, and is not coerced to 0).
 * - toDecimal — https://www.zoho.com/deluge/help/functions/common/todecimal.html
 *   Empty or non-numeric text throws. Only plain decimal text is numeric
 *   (optional sign, digits, optional point and digits): hex, scientific
 *   notation and booleans throw. Text and bigint convert exactly. Null is
 *   null, like the other builtins on an empty field.
 * - toList — https://www.zoho.com/deluge/help/functions/string/tolist.html
 *   No separator, an empty separator, or a separator that does not occur →
 *   a one-element list. Consecutive separators → null elements.
 * - toMap — https://www.zoho.com/deluge/help/functions/string/tomap.html
 *   JSON object or Deluge `{key:value}` text. Not a map throws. Text over 5 MB throws.
 * - toJSONList — https://www.zoho.com/deluge/help/functions/common/tojsonlist.html
 *   JSON array text → list. Text that is not valid JSON, or JSON that is not
 *   an array, throws. A list is already a list and passes through.
 * - toJSONCollection — JSON object text → map. Text that is not valid JSON,
 *   or JSON that is not an object, throws. A map passes through.
 */

import { Decimal } from './decimal.js';
import { DelugeDate, TimeZoneRequired, epochMillis } from './date.js';
import { DelugeRuntimeError } from './errors.js';
import { parseJsonLossless } from './ids.js';

const MAX_MAP_TEXT = 5 * 1024 * 1024;
const MAX_MAP_DEPTH = 64;
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export class DelugeConversionError extends DelugeRuntimeError {
  override readonly code = 'DELUGE_CONVERSION';
  constructor(message: string) {
    super(message);
    this.name = 'DelugeConversionError';
  }
}

export interface ConvertCtx {
  appTimeZone?: string;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function longCast(value: unknown, name: string): DelugeConversionError {
  if (value == null) return new DelugeConversionError(`Value is empty and '${name}' function cannot be applied`);
  const shown = typeof value === 'string' ? value : String(value);
  return new DelugeConversionError(`Unable to cast the '${shown}' value into a 'Long' value because the input is in an invalid format`);
}

export function toLong(value: unknown, ctx?: ConvertCtx, ...extra: unknown[]): number | bigint {
  return castLong(value, ctx, 'toLong', extra);
}

/** Same numeric rules as toLong. The null message names `toNumber`. */
export function toNumber(value: unknown, ctx?: ConvertCtx, ...extra: unknown[]): number | bigint {
  return castLong(value, ctx, 'toNumber', extra);
}

function castLong(value: unknown, ctx: ConvertCtx | undefined, name: string, extra: unknown[]): number | bigint {
  if (extra.length) throw new DelugeConversionError(`${name}() takes no arguments`);
  if (value == null) throw longCast(value, name);
  if (value instanceof DelugeDate) {
    if (!ctx?.appTimeZone) throw new TimeZoneRequired();
    return epochMillis(value, ctx.appTimeZone);
  }
  if (value instanceof Decimal) return truncTowardZero(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw longCast(value, name);
    const truncated = Math.trunc(value);
    if (!Number.isSafeInteger(truncated)) {
      throw new DelugeConversionError('toLong: magnitude exceeds 2^53; refusing to lose precision');
    }
    return truncated;
  }
  if (typeof value === 'bigint') return fit(value);
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '' || !NUMERIC.test(text)) throw longCast(value, name);
    if (/[.eE]/.test(text)) return truncTowardZero(Decimal.from(text).toString());
    return truncTowardZero(text);
  }
  throw longCast(value, name);
}

const DECIMAL_BAD = 'Unable to convert the input text to decimal';

const PLAIN_DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;

export function toDecimal(value: unknown, _ctx?: ConvertCtx, ...extra: unknown[]): Decimal | null {
  if (extra.length) throw new DelugeConversionError('toDecimal() takes no arguments');
  if (value == null) return null;
  if (value instanceof Decimal) return value;
  if (typeof value === 'bigint') return Decimal.from(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DelugeConversionError(DECIMAL_BAD);
    return Decimal.from(String(value));
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!PLAIN_DECIMAL.test(text)) throw new DelugeConversionError(DECIMAL_BAD);
    return Decimal.from(text);
  }
  throw new DelugeConversionError(DECIMAL_BAD);
}

function token(part: string): string | null {
  return part === '' ? null : part;
}

export function toList(value: unknown, _ctx?: ConvertCtx, separator?: unknown, ...extra: unknown[]): unknown[] {
  if (extra.length) throw new DelugeConversionError('toList() takes at most one argument');
  if (Array.isArray(value)) {
    if (separator !== undefined) throw new DelugeConversionError('toList: separator is for text');
    return value.slice();
  }
  if (typeof value !== 'string') throw new DelugeConversionError('toList: null or source is not text');
  if (separator === undefined || separator === null) return [token(value)];
  const sep = String(separator);
  if (sep === '' || !value.includes(sep)) return [token(value)];
  return value.split(sep).map(token);
}

const MAP_BAD = 'Invalid JSON Format String';

export function toMap(value: unknown, _ctx?: ConvertCtx, ...extra: unknown[]): Record<string, unknown> {
  if (extra.length) throw new DelugeConversionError('toMap() takes no arguments');
  if (isPlain(value)) return { ...value };
  if (typeof value !== 'string') throw new DelugeConversionError(MAP_BAD);
  if (value.length > MAX_MAP_TEXT) throw new DelugeConversionError('toMap: text exceeds 5 MB');
  const text = value.trim();
  if (!text) throw new DelugeConversionError(MAP_BAD);
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = parseJsonLossless(text);
      if (isPlain(parsed)) return parsed;
    } catch {
      /* Deluge's {key:value} form is not JSON. */
    }
    return looseMap(text);
  }
  throw new DelugeConversionError(MAP_BAD);
}

const JSON_LIST_BAD = 'Invalid JSON Format String';

export function toJSONList(value: unknown, _ctx?: ConvertCtx, ...extra: unknown[]): unknown[] {
  if (extra.length) throw new DelugeConversionError('toJSONList() takes no arguments');
  if (Array.isArray(value)) return value.slice();
  if (typeof value !== 'string') throw new DelugeConversionError(JSON_LIST_BAD);
  let parsed: unknown;
  try {
    parsed = parseJsonLossless(value);
  } catch {
    throw new DelugeConversionError(JSON_LIST_BAD);
  }
  if (!Array.isArray(parsed)) throw new DelugeConversionError(JSON_LIST_BAD);
  return parsed;
}

export function toJSONCollection(value: unknown, _ctx?: ConvertCtx, ...extra: unknown[]): Record<string, unknown> {
  if (extra.length) throw new DelugeConversionError('toJSONCollection() takes no arguments');
  if (isPlain(value)) return { ...value };
  if (typeof value !== 'string') throw new DelugeConversionError(MAP_BAD);
  let parsed: unknown;
  try {
    parsed = parseJsonLossless(value);
  } catch {
    throw new DelugeConversionError(MAP_BAD);
  }
  if (!isPlain(parsed)) throw new DelugeConversionError(MAP_BAD);
  return parsed;
}

function truncTowardZero(text: string): number | bigint {
  const neg = text.startsWith('-');
  const body = text.replace(/^[+-]/, '');
  const whole = body.split('.')[0] || '0';
  if (!/^\d+$/.test(whole)) throw new DelugeConversionError('toLong: not a finite number');
  return fit(neg ? -BigInt(whole) : BigInt(whole));
}

function fit(value: bigint): number | bigint {
  if (value > MAX_SAFE || value < -MAX_SAFE) return value;
  return Number(value);
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof Decimal || value instanceof DelugeDate) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function looseMap(text: string, depth = 0): Record<string, unknown> {
  if (depth >= MAX_MAP_DEPTH) throw new DelugeConversionError('toMap: text exceeds the depth limit');
  const inner = text.slice(1, -1).trim();
  const out: Record<string, unknown> = {};
  if (!inner) return out;
  for (const pair of splitTop(inner, ',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colon = topColon(trimmed);
    if (colon < 0) throw new DelugeConversionError('toMap: text is not a key-value map');
    const key = unquote(trimmed.slice(0, colon).trim());
    if (!key) throw new DelugeConversionError('toMap: empty key');
    // defineProperty so '__proto__' is data, not a prototype write.
    Object.defineProperty(out, key, { value: looseValue(trimmed.slice(colon + 1).trim(), depth), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function looseValue(raw: string, depth: number): unknown {
  if (!raw) throw new DelugeConversionError('toMap: empty value');
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return unquote(raw);
  if (raw.startsWith('{') && raw.endsWith('}')) return looseMap(raw, depth + 1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (NUMERIC.test(raw)) {
    if (/[.eE]/.test(raw)) return Decimal.from(raw);
    // Past 2^53 the digits are kept as text (as parseJsonLossless does); toLong makes them a bigint.
    return Number.isSafeInteger(Number(raw)) ? Number(raw) : raw.replace(/^\+/, '');
  }
  if (/^[A-Za-z_][\w$]*$/.test(raw)) return raw;
  throw new DelugeConversionError('toMap: text is not a key-value map');
}

function unquote(token: string): string {
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return token;
}

function splitTop(input: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out;
}

function topColon(input: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0) return i;
  }
  return -1;
}

/**
 * `x.toListString()`: comma-separated text, or a list, as a list of text
 * elements (functions/list/to-list-string: `"1,2,3,4,5"` is a list of five
 * texts). Empty tokens are null, as `toList` makes them.
 */
export function toListString(value: unknown, _ctx?: ConvertCtx): unknown[] {
  if (Array.isArray(value)) return value.map((v) => (v == null ? null : token(String(v))));
  if (typeof value !== 'string') throw new DelugeConversionError('toListString: null or source is not text');
  return value.split(',').map(token);
}


