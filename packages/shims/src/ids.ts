/**
 * Exact record ids.
 *
 * Creator record ids are 19 digits (1000000000000000001) and Catalyst ROWIDs
 * are 17 (10000000000315013). Both are past Number.MAX_SAFE_INTEGER, so a JS
 * number rounds them. Deluge types them as bigint / NUMBER (a 64-bit long:
 * the Deluge `toLong` and list data type help pages, `List:Bigint`). Here an id is a digit string, or
 * a JS bigint when a script did `toLong()` on it.
 *
 * - parseJsonLossless: JSON.parse, except an integer literal past the safe
 *   range comes back as its exact digit string. Safe integers and decimals
 *   are numbers as before. A JSON.parse reviver cannot do this on Node 20:
 *   the value is already rounded when the reviver sees it.
 * - sameId: equality that is exact across string / number / bigint.
 * - jsonReplacer: JSON.stringify replacer that writes a bigint as its digits.
 * - bigintsToDigits: a copy with every bigint, at any depth, as its digits.
 *
 * fn/index.js and ui/src/client-runtime.js are standalone files; they carry
 * a copy of quoteUnsafeIntegers. Keep the three in step.
 */

/** Wrap every integer literal outside a string that is not a safe integer in quotes. */
export function quoteUnsafeIntegers(text: string): string {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const start = i;
      i += 1;
      while (i < text.length && /[0-9.eE+-]/.test(text[i]!)) i += 1;
      const token = text.slice(start, i);
      if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) {
        out += `${text.slice(last, start)}"${token}"`;
        last = i;
      }
      continue;
    }
    i += 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

export function parseJsonLossless(text: string): unknown {
  return JSON.parse(quoteUnsafeIntegers(text));
}

/** `JSON.stringify(value, jsonReplacer)`: a bigint is written as its digit string. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * A bigint anywhere in plain objects and arrays (a map `{ id: x.toLong() }`, a
 * list of ids, subform rows) becomes its digit string. Other objects (Decimal,
 * DelugeDate) are left alone: they serialise through their own toJSON.
 * c2c-sdk-datastore.mjs carries a copy (`digits`); keep the two in step.
 */
export function bigintsToDigits(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(bigintsToDigits);
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = bigintsToDigits(item);
    return out;
  }
  return value;
}

const INTEGER = /^\s*[+-]?\d+\s*$/;

function asBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && INTEGER.test(value)) return BigInt(value.trim());
  return null;
}

/**
 * Same type: `===`. A bigint against an integer string or number: compared as
 * BigInt, so `"1000000000000000001"` equals `1000000000000000001n`. Other
 * mixed types keep their existing (strict) answer.
 */
export function sameId(left: unknown, right: unknown): boolean {
  if (typeof left === typeof right) return left === right;
  if (typeof left !== 'bigint' && typeof right !== 'bigint') return left === right;
  const a = asBigInt(left);
  const b = asBigInt(right);
  return a !== null && b !== null && a === b;
}
