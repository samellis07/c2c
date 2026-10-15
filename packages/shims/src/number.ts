/**
 * Creator numeric edges the JS Math functions do not match.
 * `round` halves away from zero (`round(-1.5, 0)` is -2).
 * `sqrt` of a negative is null, not NaN.
 * `isNumber(null)` and `isNumber(true)` are null.
 * `isNumber("1e2")` is false: Creator does not treat scientific notation as a number.
 *
 * The transcendental, hyperbolic, log10, and sqrt shims evaluate a double, so
 * an argument a double cannot carry exactly — a bigint outside the safe
 * integer range, or a Decimal whose digits do not round-trip through a double
 * — refuses like toLong instead of silently rounding.
 */
import { DelugeConversionError } from './convert.js';
import { Decimal } from './decimal.js';
import { DelugeRuntimeError, UntranslatedConstruct } from './errors.js';

export const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

function bigintSqrt(value: bigint): bigint {
  if (value === 0n) return 0n;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

export function round(value: unknown, places: unknown = 0): number | bigint {
  if (typeof value === 'bigint') return value;
  const n = typeof value === 'number' ? value : Number(value);
  const p = Number(places);
  if (!Number.isFinite(n)) return n;
  const f = 10 ** (Number.isFinite(p) ? p : 0);
  const x = n * f;
  if (x < 0) return -Math.round(-x) / f;
  return Math.round(x) / f;
}

export function sqrt(value: unknown): number | bigint | null {
  if (typeof value === 'bigint') {
    if (value < 0n) return null;
    const s = bigintSqrt(value);
    if (s * s === value) return s > MAX_SAFE ? s : Number(s);
    if (value > MAX_SAFE || value < MIN_SAFE) {
      throw new DelugeConversionError('toLong: magnitude exceeds 2^53; refusing to lose precision');
    }
    return Math.sqrt(Number(value));
  }
  const n = realArg('sqrt', value);
  if (n === null || n < 0) return null;
  return Math.sqrt(n);
}

export function log(value: unknown): number {
  if (typeof value === 'bigint') {
    if (value > MAX_SAFE || value < MIN_SAFE) {
      throw new DelugeConversionError('toLong: magnitude exceeds 2^53; refusing to lose precision');
    }
    return Math.log(Number(value));
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Math.log(n);
}

export function isNumber(value: unknown): boolean | null {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'bigint') return true;
  if (value instanceof Decimal) return true;
  if (typeof value === 'string') return NUMERIC.test(value.trim());
  return false;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if ('__query' in (value as object)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function largest(value: unknown): number | null {
  if (value == null || value === '' || (typeof value === 'string' && value.trim() === '')) return null;
  if (Array.isArray(value)) {
    let max = -Infinity;
    let found = false;
    for (const v of value) {
      if (v == null || v === '' || (typeof v === 'string' && v.trim() === '')) continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n >= max) { max = n; found = true; }
    }
    return found ? max : null;
  }
  if (isPlain(value)) {
    let max = -Infinity;
    let found = false;
    for (const k in value) {
      const v = value[k];
      if (v == null || v === '' || (typeof v === 'string' && v.trim() === '')) continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n >= max) { max = n; found = true; }
    }
    return found ? max : null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function smallest(value: unknown): number | null {
  if (value == null || value === '' || (typeof value === 'string' && value.trim() === '')) return null;
  if (Array.isArray(value)) {
    let min = Infinity;
    let found = false;
    for (const v of value) {
      if (v == null || v === '' || (typeof v === 'string' && v.trim() === '')) continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n <= min) { min = n; found = true; }
    }
    return found ? min : null;
  }
  if (isPlain(value)) {
    let min = Infinity;
    let found = false;
    for (const k in value) {
      const v = value[k];
      if (v == null || v === '' || (typeof v === 'string' && v.trim() === '')) continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n <= min) { min = n; found = true; }
    }
    return found ? min : null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// toWords, toHex, nthLargest and nthSmallest follow
// https://www.zoho.com/deluge/help/functions/number/towords.html, .../tohex.html,
// .../nth-largest.html and .../nth-smallest.html. Input the pages do not
// describe throws UntranslatedConstruct (a counted coverage gap), never a guess.
const SMALL_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS_WORDS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion'];
const INDIAN_SCALES = ['', 'thousand', 'lakh', 'crore'];
/** Languages the page lists. Only the English ones are rendered here. */
export const TO_WORDS_LANGUAGES = ['en-gb', 'ar', 'zh', 'en-in', 'en-us', 'fr', 'de', 'it', 'ja', 'ko', 'pt', 'es'];
export const TO_WORDS_RENDERED = ['en-us', 'en-gb', 'en-in'];

function untranslated(fn: string, what: string): UntranslatedConstruct {
  return new UntranslatedConstruct(`${fn}-${what}`, fn);
}

function underHundred(n: number): string {
  if (n < 20) return SMALL_WORDS[n]!;
  const tens = TENS_WORDS[Math.floor(n / 10)]!;
  return n % 10 ? `${tens}-${SMALL_WORDS[n % 10]}` : tens;
}

// The page's en-us example (1989 -> "one thousand nine hundred eighty-nine")
// has no "and". Its en-gb and en-in examples (-12, 10000000) never show
// whether British or Indian English adds "and" after "hundred" or before a
// final group under one hundred, so those spellings refuse.
function underThousand(n: number, andUnknown: boolean, language: string): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds && rest && andUnknown) throw untranslated('toWords', `${language}-and`);
  const words: string[] = [];
  if (hundreds) words.push(SMALL_WORDS[hundreds]!, 'hundred');
  if (rest) words.push(underHundred(rest));
  return words.join(' ');
}

function integerWords(value: bigint, language: string): string {
  if (value === 0n) return 'zero';
  const andUnknown = language !== 'en-us';
  const groups: number[] = [];
  let scales = SCALES;
  if (language === 'en-in') {
    // Lakh and crore only: the page shows "one crore" and nothing larger.
    if (value >= 1_000_000_000n) throw untranslated('toWords', 'en-in-scale');
    scales = INDIAN_SCALES;
    groups.push(Number(value % 1000n)); value /= 1000n;
    while (value > 0n) { groups.push(Number(value % 100n)); value /= 100n; }
  } else {
    while (value > 0n) { groups.push(Number(value % 1000n)); value /= 1000n; }
  }
  if (andUnknown && groups.length > 1 && groups[0]! > 0 && groups[0]! < 100) throw untranslated('toWords', `${language}-and`);
  const words: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!groups[i]) continue;
    words.push(underThousand(groups[i]!, andUnknown, language));
    if (scales[i]) words.push(scales[i]!);
  }
  return words.join(' ');
}

/** Zoho's English number words (en-us, en-gb, en-in); the other listed languages refuse. */
export function toWords(value: unknown, language: unknown): string {
  if (typeof language !== 'string' || !TO_WORDS_RENDERED.includes(language)) {
    throw untranslated('toWords', TO_WORDS_LANGUAGES.includes(String(language)) ? `language-${String(language)}` : 'language');
  }
  const isDecimal = value instanceof Decimal || (typeof value === 'number' && !Number.isInteger(value));
  if (!(typeof value === 'number' && Number.isFinite(value)) && typeof value !== 'bigint' && !(value instanceof Decimal)) {
    throw untranslated('toWords', value == null ? 'null' : 'non-number');
  }
  const text = value instanceof Decimal ? value.toString() : typeof value === 'number' ? Decimal.from(value).toString() : value.toString();
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace(/^-/, '').split('.');
  // "A number input value can contain up to 18 digits"; "the whole and decimal
  // parts of a decimal input value can collectively be up to 15 digits".
  if (isDecimal ? whole.length + fraction.length > 15 : whole.length > 18) throw untranslated('toWords', 'digits');
  // Whether Zoho reads a kept trailing zero ("1.50") is not documented.
  if (fraction.endsWith('0')) throw untranslated('toWords', 'trailing-zero');
  const integer = integerWords(BigInt(whole), language);
  const words = `${negative ? 'minus ' : ''}${integer}`;
  return fraction ? `${words} point ${[...fraction].map((digit) => SMALL_WORDS[Number(digit)]).join(' ')}` : words;
}

const LONG_MAX = 9223372036854775807n;

/**
 * Base-16 text of a NUMBER. The page shows only a positive whole number
 * (100 -> "64"): a DECIMAL, a negative, null and text refuse.
 */
export function toHex(value: unknown): string {
  if (value instanceof Decimal || (typeof value === 'number' && !Number.isInteger(value))) throw untranslated('toHex', 'decimal');
  if (typeof value !== 'number' && typeof value !== 'bigint') throw untranslated('toHex', value == null ? 'null' : 'non-number');
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw untranslated('toHex', 'range');
  const n = BigInt(value);
  if (n < 0n) throw untranslated('toHex', 'negative');
  if (n > LONG_MAX) throw untranslated('toHex', 'range');
  return n.toString(16);
}

export function nthLargest(value: unknown, rank: unknown): unknown {
  return numericListRank('nthLargest', value, rank, true);
}

export function nthSmallest(value: unknown, rank: unknown): unknown {
  return numericListRank('nthSmallest', value, rank, false);
}

function rankIndex(fn: string, rank: unknown): number {
  if (typeof rank === 'number' && Number.isSafeInteger(rank)) return rank;
  if (typeof rank === 'bigint') return rank > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(rank);
  // nthSmallest documents a NUMBER / DECIMAL rank; how a fractional one rounds is not documented.
  if (rank instanceof Decimal && rank.compare(Decimal.from(rank.toString().split('.')[0]!)) === 0) return Number(rank.toString().split('.')[0]);
  throw untranslated(fn, rank instanceof Decimal || typeof rank === 'number' ? 'fractional-rank' : 'rank');
}

/**
 * One-based rank in the collection sorted by value. Members keep their own
 * type (a DECIMAL comes back as the exact Decimal) and ties keep their
 * places. The pages describe a collection of NUMBER and DECIMAL values only:
 * a null, blank or text member refuses instead of being skipped, which would
 * shift every rank.
 */
function numericListRank(fn: string, value: unknown, rank: unknown, descending: boolean): unknown {
  if (!Array.isArray(value)) throw new DelugeRuntimeError(`${fn}: expected a number collection`);
  const members = value.map((item) => {
    if (typeof item === 'number' ? !Number.isFinite(item) : typeof item !== 'bigint' && !(item instanceof Decimal)) {
      throw untranslated(fn, item == null || (typeof item === 'string' && item.trim() === '') ? 'blank-member' : 'non-number-member');
    }
    return { item, key: Decimal.from(item as number | bigint | Decimal) };
  });
  const index = rankIndex(fn, rank);
  // "The index argument starts from 1" and "cannot be greater than the size of the collection".
  if (index < 1 || index > members.length) throw new DelugeRuntimeError(`${fn}: index ${index} is outside the collection size ${members.length}`);
  members.sort((a, b) => (descending ? b.key.compare(a.key) : a.key.compare(b.key)));
  return members[index - 1]!.item;
}

export function abs(value: unknown): number | bigint | Decimal | null {
  if (value instanceof Decimal) {
    return value.compare(0) < 0 ? value.mul(-1) : value;
  }
  if (typeof value === 'bigint') {
    return value < 0n ? -value : value;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n);
}

export function exp(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const result = Math.exp(n);
  if (!Number.isFinite(result)) return null;
  return result;
}

export function frac(value: unknown): number | Decimal | null {
  if (value instanceof Decimal) {
    const text = value.toString();
    const point = text.indexOf('.');
    if (point === -1) return Decimal.from(0);
    const isNeg = text.startsWith('-');
    return Decimal.from((isNeg ? '-' : '') + '0.' + text.slice(point + 1));
  }
  if (typeof value === 'bigint') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(Decimal.from(n).sub(Math.trunc(n)).toString());
}
/**
 * sin / cos / tan / asin take radians:
 * https://www.zoho.com/deluge/help/functions/number/sin.html (cos.html, tan.html).
 * asin is defined on [-1, 1] (https://www.zoho.com/deluge/help/functions/number/asin.html);
 * outside that range the result is null, not NaN.
 * Null or empty input is null, like the other number builtins.
 * The result is the binary64 value of the JS Math function, carried as a Decimal
 * of its shortest decimal form; it is not an exact decimal computation.
 * `tan(pi/2)` is the large finite binary64 value of Math.tan, not an error.
 * An input that a double cannot carry (a bigint past 2^53, or a Decimal whose
 * digits do not round-trip through a double) is refused rather than rounded.
 */
function trigInput(value: unknown, name: string): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    if (value > MAX_SAFE || value < -MAX_SAFE) {
      throw new DelugeConversionError(`${name}: magnitude exceeds 2^53; refusing to lose precision`);
    }
    return Number(value);
  }
  let exact: Decimal;
  if (value instanceof Decimal) exact = value;
  else if (typeof value === 'string' && NUMERIC.test(value.trim())) exact = Decimal.from(value.trim());
  else throw new DelugeConversionError(`${name}: input is not a number`);
  const n = Number(exact.toString());
  if (!Number.isFinite(n) || Decimal.from(n).compare(exact) !== 0) {
    throw new DelugeConversionError(`${name}: ${exact.toString()} is not exact as a double; refusing to lose precision`);
  }
  return n;
}

function trig(value: unknown, name: string, fn: (n: number) => number): Decimal | null {
  const n = trigInput(value, name);
  if (n === null) return null;
  const r = fn(n);
  return Number.isFinite(r) ? Decimal.from(r) : null;
}

export function sin(value: unknown): Decimal | null {
  return trig(value, 'sin', Math.sin);
}

export function cos(value: unknown): Decimal | null {
  return trig(value, 'cos', Math.cos);
}

export function tan(value: unknown): Decimal | null {
  return trig(value, 'tan', Math.tan);
}

export function asin(value: unknown): Decimal | null {
  return trig(value, 'asin', (n) => (n < -1 || n > 1 ? NaN : Math.asin(n)));
}

/**
 * One numeric argument as a double. A bigint outside the safe-integer range,
 * or a Decimal or numeric text whose digits a double cannot hold exactly,
 * refuses rather than rounding. Blank and non-numeric inputs are null; a
 * non-finite number is null.
 */
function realArg(name: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    if (value > MAX_SAFE || value < -MAX_SAFE) {
      throw new DelugeConversionError(`${name}: magnitude exceeds 2^53; refusing to lose precision`);
    }
    return Number(value);
  }
  if (value instanceof Decimal) return decimalArg(name, value);
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    let d: Decimal;
    try {
      d = Decimal.from(text);
    } catch {
      return null;
    }
    return decimalArg(name, d);
  }
  return null;
}

/** The decimal as a double, only when the double's shortest text is the decimal's own. */
function decimalArg(name: string, value: Decimal): number {
  const n = Number(value.toString());
  if (!Number.isFinite(n) || value.compare(n) !== 0) {
    throw new DelugeConversionError(`${name}: value ${value.toString()} is not exactly representable as a double; refusing to lose precision`);
  }
  return n;
}

export function acos(value: unknown): number | null {
  const n = realArg('acos', value);
  return n === null || n < -1 || n > 1 ? null : Math.acos(n);
}

export function acosh(value: unknown): number | null {
  const n = realArg('acosh', value);
  return n === null || n < 1 ? null : Math.acosh(n);
}

export function asinh(value: unknown): number | null {
  const n = realArg('asinh', value);
  return n === null ? null : Math.asinh(n);
}

export function atan(value: unknown): number | null {
  const n = realArg('atan', value);
  return n === null ? null : Math.atan(n);
}

export function atan2(y: unknown, x: unknown): number | null {
  const ny = realArg('atan2', y);
  const nx = realArg('atan2', x);
  if (ny === null || nx === null) return null;
  return Math.atan2(ny, nx);
}

export function atanh(value: unknown): number | null {
  const n = realArg('atanh', value);
  return n === null || n <= -1 || n >= 1 ? null : Math.atanh(n);
}

export function cosh(value: unknown): number | null {
  const n = realArg('cosh', value);
  return n === null ? null : Math.cosh(n);
}

export function log10(value: unknown): number | null {
  const n = realArg('log10', value);
  return n === null || n <= 0 ? null : Math.log10(n);
}

export function sinh(value: unknown): number | null {
  const n = realArg('sinh', value);
  return n === null ? null : Math.sinh(n);
}

export function tanh(value: unknown): number | null {
  const n = realArg('tanh', value);
  return n === null ? null : Math.tanh(n);
}

export function isEven(value: unknown): boolean | null {
  if (value == null || value === '' || (typeof value === 'string' && value.trim() === '')) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n % 2 === 0;
}

export function isOdd(value: unknown): boolean | null {
  if (value == null || value === '' || (typeof value === 'string' && value.trim() === '')) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n % 2 !== 0;
}
