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
import { DelugeRuntimeError } from './errors.js';

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

const SMALL_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS_WORDS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion'];

function underThousand(n: number, british: boolean): string {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) words.push(SMALL_WORDS[hundreds]!, 'hundred');
  if (rest) {
    if (hundreds && british) words.push('and');
    if (rest < 20) words.push(SMALL_WORDS[rest]!);
    else {
      const tens = TENS_WORDS[Math.floor(rest / 10)]!;
      words.push(rest % 10 ? `${tens}-${SMALL_WORDS[rest % 10]}` : tens);
    }
  }
  return words.join(' ');
}

function integerWords(text: string, language: string): string {
  let value = BigInt(text);
  if (value === 0n) return 'zero';
  const negative = value < 0n;
  if (negative) value = -value;
  const british = language === 'en-gb';
  const groups: number[] = [];
  if (language === 'en-in') {
    groups.push(Number(value % 1000n)); value /= 1000n;
    while (value > 0n) { groups.push(Number(value % 100n)); value /= 100n; }
    const scales = ['', 'thousand', 'lakh', 'crore', 'arab', 'kharab'];
    const words: string[] = [];
    for (let i = groups.length - 1; i >= 0; i--) if (groups[i]) words.push(underThousand(groups[i]!, false), scales[i] ?? '');
    return `${negative ? 'minus ' : ''}${words.join(' ').trim()}`;
  }
  while (value > 0n) { groups.push(Number(value % 1000n)); value /= 1000n; }
  const words: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) if (groups[i]) words.push(underThousand(groups[i]!, british), SCALES[i] ?? '');
  return `${negative ? 'minus ' : ''}${words.join(' ').trim()}`;
}

/** Zoho's documented English number words (en-us, en-gb and en-in). */
export function toWords(value: unknown, language: unknown): string {
  const locale = String(language ?? '').toLowerCase();
  if (!['en-us', 'en-gb', 'en-in'].includes(locale)) throw new DelugeRuntimeError(`toWords: unsupported language ${String(language)}`);
  let text = value instanceof Decimal ? value.toString() : typeof value === 'bigint' ? value.toString() : String(value ?? '');
  text = text.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new DelugeRuntimeError('toWords: input must be a number');
  const negative = text.startsWith('-');
  text = text.replace(/^[+-]/, '');
  const [whole = '0', fraction] = text.split('.');
  const integer = integerWords(`${negative ? '-' : ''}${BigInt(whole || '0')}`, locale);
  return fraction ? `${integer} point ${[...fraction].map((digit) => SMALL_WORDS[Number(digit)]).join(' ')}` : integer;
}

/** Converts an integer number to its base-16 text without locale dependence. */
export function toHex(value: unknown): string {
  let text = value instanceof Decimal ? value.toString() : typeof value === 'bigint' ? value.toString() : String(value ?? '');
  text = text.trim();
  if (!/^[+-]?\d+$/.test(text)) throw new DelugeRuntimeError('toHex: input must be an integer');
  return BigInt(text).toString(16);
}

export function nthLargest(value: unknown, rank: unknown): unknown {
  return numericListRank(value, rank, true);
}

export function nthSmallest(value: unknown, rank: unknown): unknown {
  return numericListRank(value, rank, false);
}

function numericListRank(value: unknown, rank: unknown, descending: boolean): unknown {
  if (!Array.isArray(value)) throw new DelugeRuntimeError('nth: expected a number collection');
  const values = value.filter((item) => item != null && !(typeof item === 'string' && item.trim() === '')).map((item) => {
    const n = typeof item === 'number' ? item : Number(item instanceof Decimal ? item.toString() : item);
    if (!Number.isFinite(n)) throw new DelugeRuntimeError('nth: collection contains a non-numeric value');
    return n;
  });
  const index = Number(rank);
  if (!Number.isInteger(index) || index < 1 || index > values.length) return null;
  values.sort((a, b) => descending ? b - a : a - b);
  return values[index - 1];
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
