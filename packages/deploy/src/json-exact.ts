/**
 * JSON parser that keeps integer literals as their exact digit strings.
 * JSON.parse (and a reviver) cannot do this: a 17-digit Catalyst id is
 * already rounded to a double before the reviver runs.
 * 10000000000315013 becomes 10000000000315012. Non-integers stay numbers.
 *
 * Parsing is delegated to lossless-json 4.3.1 (MIT, zero dependencies,
 * CLI-side only: this module lives in deploy/, never in shims/, so it is not
 * bundled into generated Catalyst functions). The number callback below is
 * what preserves the historical contract: integer literals arrive as their
 * exact digit strings, everything else as numbers via Number(literal).
 */

import { parse as parseLosslessJson } from 'lossless-json';

/** An integer literal: optional minus, then 0 or a non-zero-leading run. */
const INTEGER_LITERAL = /^-?(0|[1-9][0-9]*)$/;

/**
 * lossless-json number callback. It receives the raw literal slice, so
 * `-0` stays the string "-0" and `1e3` becomes Number("1e3"), exactly as the
 * previous hand-rolled parser produced.
 */
function exactNumber(literal: string): string | number {
  return INTEGER_LITERAL.test(literal) ? literal : Number(literal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Inert replacement for a "__proto__" object key during parsing.
 * lossless-json assigns object keys (`object[key] = value`), which sends a
 * "__proto__" key through the __proto__ setter: object/null values overwrite
 * the prototype, primitive values are silently dropped — while plain
 * JSON.parse (and the previous parser) keeps it as an own data property.
 * renameProtoKeys rewrites every "__proto__" key in the raw text to this
 * sentinel before parsing; restoreProtoKeys defines it back as an own data
 * property at its original position afterwards, preserving JSON.parse key
 * order. A document that already contains the sentinel key itself would be
 * mis-renamed, which is accepted: it cannot occur in Creator/Catalyst bodies.
 */
const PROTO_SENTINEL = '\u0000\u0000c2c-proto-key\u0000\u0000';
const PROTO_SENTINEL_TOKEN = JSON.stringify(PROTO_SENTINEL);

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Rename every "__proto__" object key in raw JSON text to PROTO_SENTINEL.
 * The scan is string-aware: escaped quotes inside strings do not end a token,
 * and only a string token followed by a colon counts as a key. Keys written
 * with unicode escapes are decoded with JSON.parse so
 * they are caught too.
 */
function renameProtoKeys(text: string): string {
  // Fast path: a real "__proto__" key needs either the literal name or a \u escape.
  if (!text.includes('__proto__') && !text.includes('\\u')) return text;
  const parts: string[] = [];
  let last = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text.charCodeAt(i) !== 0x22 /* " */) {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < n) {
      const code = text.charCodeAt(end);
      if (code === 0x5c /* \ */) end += 2;
      else if (code === 0x22) break;
      else end += 1;
    }
    if (end >= n) break; // unterminated string: let the real parser report it
    let next = end + 1;
    while (next < n && isJsonWhitespace(text.charCodeAt(next))) next += 1;
    if (text.charCodeAt(next) === 0x3a /* : */) {
      const token = text.slice(i, end + 1);
      const isProtoKey = token === '"__proto__"' || (token.includes('\\') && JSON.parse(token) === '__proto__');
      if (isProtoKey) {
        parts.push(text.slice(last, i), PROTO_SENTINEL_TOKEN);
        last = end + 1;
      }
    }
    i = end + 1;
  }
  if (last === 0) return text;
  parts.push(text.slice(last));
  return parts.join('');
}

/**
 * Define the sentinel key back as an own data "__proto__" property, at the
 * position it originally occupied, so key order matches JSON.parse exactly.
 */
function restoreProtoKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = restoreProtoKeys(value[i]);
    return value;
  }
  if (!isRecord(value)) return value;
  if (!Object.prototype.hasOwnProperty.call(value, PROTO_SENTINEL)) {
    for (const key of Object.keys(value)) value[key] = restoreProtoKeys(value[key]);
    return value;
  }
  const restored: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const item = restoreProtoKeys(value[key]);
    if (key === PROTO_SENTINEL) {
      // defineProperty, not assignment: a "__proto__" key must land as an own
      // data property like every other key, not set the object's prototype.
      Object.defineProperty(restored, '__proto__', {
        value: item,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      restored[key] = item;
    }
  }
  return restored;
}

export function parseJsonExact(text: string): unknown {
  return restoreProtoKeys(
    parseLosslessJson(renameProtoKeys(text), null, {
      parseNumber: exactNumber,
      // The historical parser let a repeated key win silently; keep that.
      onDuplicateKey: ({ newValue }) => newValue,
    }),
  );
}

/** An id that is already a string is unchanged. A number that is not a safe integer has lost digits. */
export function exactId(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} is a numeric id beyond MAX_SAFE_INTEGER`);
    return String(value);
  }
  throw new Error(`${label} is not a string`);
}
