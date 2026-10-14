/**
 * Creator text functions.
 *
 * An empty result is null, not "". `replaceAll` treats the search text as a
 * regular expression (`.` matches any character). `get` on text is null.
 * `removeAllAlpha` removes ASCII letters only; accented letters stay.
 */
import { DelugeRuntimeError } from './errors.js';
import { javaMatches, javaReplaceAll } from './java-regex.js';

const INDEX = 'One or more specified index values were invalid. Index value must range between 0 and the length of the text';
const REVERSED = 'Start index cannot be greater than the end index';

/**
 * Bound on the `leftpad`/`rightpad` width argument. The Deluge help pages
 * for both functions cap the width (the "Maximum value" note on
 * functions/string/leftpad.html and functions/string/rightpad.html, rendered
 * as "100,00" — 10,000), and a migrated text column stores at most 10,000
 * characters, so a wider pad could never persist. A width past the bound
 * throws — Creator's refusal of an out-of-range argument — rather than
 * clamping to a wrong length or allocating without bound.
 */
export const PAD_WIDTH_MAX = 10_000;

/**
 * `len(s)` / `length(s)`: the character count of a text. The help page
 * (functions/string/length) gives `s.length()`, `length(s)`, `s.len()` and
 * `len(s)` as one function, so every form follows the method form
 * (`list.length`, whose list and empty-text results are Creator-recorded):
 * text gives its length, anything else, null included, gives null.
 */
export function len(value: unknown): number | null {
  if (typeof value === 'string') return value.length;
  return null;
}

export function length(value: unknown): number | null {
  return len(value);
}

export function lower(value: unknown): string | null {
  return toLowerCase(value);
}

export function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}

export function toLowerCase(value: unknown): string | null {
  if (value == null) return null;
  return emptyToNull(String(value).toLowerCase());
}

export function toUpperCase(value: unknown): string | null {
  if (value == null) return null;
  return emptyToNull(String(value).toUpperCase());
}

export function trim(value: unknown): string | null {
  if (value == null) return null;
  return emptyToNull(String(value).trim());
}

/**
 * Creator `replaceAll` is a regex replace, not a literal split. The optional
 * fourth argument `true` escapes the regular expression: the search text is
 * literal. Default false
 * (deluge-docs/pages/functions__string__replaceall.html,
 * https://www.zoho.com/deluge/help/functions/string/replaceall.html).
 * The search pattern is a Java regular expression, translated and refused the
 * same way as `matches`, including the text-length bound. The replacement
 * reads `\` and `$` as Java does: `\\` is a backslash, `\$` is a dollar, and
 * `$1` is a capturing group. An invalid pattern is an error.
 */
export function replaceAll(value: unknown, find: unknown, repl: unknown, escape?: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  if (s === '') return null;
  const pattern = find == null ? '' : String(find);
  const replacement = repl == null ? '' : String(repl);
  if (escape === true || escape === 'true') return emptyToNull(pattern === '' ? s : s.split(pattern).join(replacement));
  return emptyToNull(javaReplaceAll(s, pattern, replacement));
}

/**
 * `replaceAllIgnoreCase` / `replaceFirstIgnoreCase`: `replaceAll` /
 * `replaceFirst` with the search matched without regard to case
 * (functions/string/replaceallignorecase.html,
 * functions/string/replacefirstignorecase.html). Both pages give the same
 * fourth argument as `replaceAll`: by default (false) the search text is a
 * regular expression; true escapes it, so the search text is literal. The
 * pattern is a Java regular expression run with `Pattern.CASE_INSENSITIVE`
 * (US-ASCII folding), refused where Unicode folding could give another answer.
 * The replacement reads `\` and `$` as Java does.
 *
 * With true, the pages do not say whether the replacement is escaped as well,
 * so a replacement holding `\` or `$` is refused rather than read either way,
 * and so is an empty search text.
 */
export function replaceAllIgnoreCase(value: unknown, find: unknown, repl: unknown, escape?: unknown): string | null {
  return replaceIgnoreCase(value, find, repl, escape, false);
}

export function replaceFirstIgnoreCase(value: unknown, find: unknown, repl: unknown, escape?: unknown): string | null {
  return replaceIgnoreCase(value, find, repl, escape, true);
}

function replaceIgnoreCase(value: unknown, find: unknown, repl: unknown, escape: unknown, first: boolean): string | null {
  if (value == null) return null;
  const s = String(value);
  if (s === '') return null;
  let pattern = find == null ? '' : String(find);
  const replacement = repl == null ? '' : String(repl);
  if (escape === true || escape === 'true') {
    const name = first ? 'replaceFirstIgnoreCase' : 'replaceAllIgnoreCase';
    if (pattern === '') throw new DelugeRuntimeError(`Unsupported ${name} with an empty search text and true`);
    if (/[\\$]/.test(replacement)) throw new DelugeRuntimeError(`Unsupported ${name} with \\ or $ in the replacement and true`);
    // A backslash before a character that is not a letter or digit is that
    // character in a Java pattern.
    pattern = pattern.replace(/[^A-Za-z0-9]/g, (c) => (c.charCodeAt(0) < 0x80 ? `\\${c}` : c));
  }
  return emptyToNull(javaReplaceAll(s, pattern, replacement, first, true));
}

export function subString(value: unknown, start: unknown, end?: unknown): string | null {
  const s = value == null ? '' : String(value);
  const len = s.length;
  const a = Number(start);
  const b = end === undefined ? len : Number(end);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > len || b > len) {
    throw new DelugeRuntimeError(INDEX);
  }
  if (a > b) throw new DelugeRuntimeError(REVERSED);
  return emptyToNull(s.substring(a, b));
}

export function getPrefix(value: unknown, sep: unknown): string | null {
  const s = value == null ? '' : String(value);
  const needle = sep == null ? '' : String(sep);
  if (s === '' || needle === '') return null;
  const at = s.indexOf(needle);
  if (at < 0) return null;
  return emptyToNull(s.slice(0, at));
}

export function getSuffix(value: unknown, sep: unknown): string | null {
  const s = value == null ? '' : String(value);
  const needle = sep == null ? '' : String(sep);
  if (s === '' || needle === '') return null;
  const at = s.indexOf(needle);
  if (at < 0) return null;
  return emptyToNull(s.slice(at + needle.length));
}

export function startsWith(value: unknown, prefix: unknown): boolean {
  const s = value == null ? '' : String(value);
  const p = prefix == null ? '' : String(prefix);
  return s.startsWith(p);
}

/** `s.endsWith(p)` — null is empty text, the same rule as `startsWith`. */
export function endsWith(value: unknown, suffix: unknown): boolean {
  const s = value == null ? '' : String(value);
  const p = suffix == null ? '' : String(suffix);
  return s.endsWith(p);
}

export function startsWithIgnoreCase(value: unknown, prefix: unknown): boolean {
  const s = value == null ? '' : String(value);
  const p = prefix == null ? '' : String(prefix);
  return s.toLowerCase().startsWith(p.toLowerCase());
}

export function textToHex(value: unknown): string | null {
  if (value == null) return null;
  return Buffer.from(String(value), 'utf8').toString('hex');
}

/** Default pad is a space. A source longer than `width` is unchanged. */
export function leftPad(value: unknown, width: unknown, pad: unknown = ' '): string | null {
  const s = value == null ? '' : String(value);
  const w = Number(width);
  if (!Number.isFinite(w)) return emptyToNull(s);
  if (w > PAD_WIDTH_MAX) {
    throw new DelugeRuntimeError(`leftpad width cannot exceed ${PAD_WIDTH_MAX}`);
  }
  if (s.length >= w) return emptyToNull(s);
  const unit = pad == null || String(pad) === '' ? ' ' : String(pad);
  let fill = '';
  while (fill.length < w - s.length) fill += unit;
  return emptyToNull(fill.slice(0, w - s.length) + s);
}

export function rightPad(value: unknown, width: unknown, pad: unknown = ' '): string | null {
  const s = value == null ? '' : String(value);
  const w = Number(width);
  if (!Number.isFinite(w)) return emptyToNull(s);
  if (w > PAD_WIDTH_MAX) {
    throw new DelugeRuntimeError(`rightpad width cannot exceed ${PAD_WIDTH_MAX}`);
  }
  if (s.length >= w) return emptyToNull(s);
  const unit = pad == null || String(pad) === '' ? ' ' : String(pad);
  let fill = '';
  while (fill.length < w - s.length) fill += unit;
  return emptyToNull(s + fill.slice(0, w - s.length));
}

/** `s.equalsIgnoreCase(t)` — non case-sensitive equality (functions/string/equalsignorecase). */
export function equalsIgnoreCase(value: unknown, other: unknown): boolean {
  if (value == null || other == null) return value == null && other == null;
  return String(value).toLowerCase() === String(other).toLowerCase();
}

/** `s.containsIgnoreCase(t)` — non case-sensitive contains (functions/string/containsignorecase). */
export function containsIgnoreCase(value: unknown, needle: unknown): boolean {
  if (value == null || needle == null) return false;
  return String(value).toLowerCase().includes(String(needle).toLowerCase());
}

export function removeAllAlpha(value: unknown): string | null {
  if (value == null) return null;
  return emptyToNull(String(value).replace(/[A-Za-z]/g, ''));
}

/** One argument removes every literal occurrence. Two numbers remove a span (end exclusive). */
export function removeText(value: unknown, a?: unknown, b?: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  if (typeof a === 'number' && typeof b === 'number') {
    const out = s.slice(0, a) + s.slice(b);
    return emptyToNull(out);
  }
  const needle = a == null ? '' : String(a);
  if (needle === '') return emptyToNull(s);
  return emptyToNull(s.split(needle).join(''));
}

export function ifnull(value: unknown, replacement: unknown): unknown {
  const chosen = value == null ? replacement : value;
  return chosen === '' ? null : chosen;
}

/**
 * `s.removeFirstOccurence(t)` / `s.removeLastOccurence(t)`: drop one literal,
 * case-sensitive occurrence. A missing search text returns the text as it is
 * (functions/string/removefirstoccurence, removelastoccurence).
 */
export function removeFirstOccurence(value: unknown, needle: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  const n = needle == null ? '' : String(needle);
  const at = n === '' ? -1 : s.indexOf(n);
  return emptyToNull(at < 0 ? s : s.slice(0, at) + s.slice(at + n.length));
}

export function removeLastOccurence(value: unknown, needle: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  const n = needle == null ? '' : String(needle);
  const at = n === '' ? -1 : s.lastIndexOf(n);
  return emptyToNull(at < 0 ? s : s.slice(0, at) + s.slice(at + n.length));
}

/**
 * `getAlpha` keeps the letters, `getAlphaNumeric` the letters and digits;
 * everything else, spaces included, is dropped (functions/string/getAlpha,
 * getAlphaNumeric). Letters are ASCII, the same set `removeAllAlpha` removes.
 */
export function getAlpha(value: unknown): string | null {
  if (value == null) return null;
  return emptyToNull(String(value).replace(/[^A-Za-z]/g, ''));
}

export function getAlphaNumeric(value: unknown): string | null {
  if (value == null) return null;
  return emptyToNull(String(value).replace(/[^A-Za-z0-9]/g, ''));
}

/**
 * `s.subText(start[, end])`: like `subString`, except a negative end index
 * is ignored and the rest of the text is returned. An end before the start
 * is an error (functions/string/subtext).
 */
export function subText(value: unknown, start: unknown, end?: unknown): string | null {
  const e = end === undefined || end === null || Number(end) < 0 ? undefined : end;
  return subString(value, start, e);
}

/**
 * `s.matches(regex)`: true when the whole text fits the pattern,
 * case-sensitive (functions/string/matches). A null text does not match.
 * The pattern is a Java regular expression; see java-regex.ts for how it is
 * translated, which constructs are refused, and the text length bound.
 */
export function matches(value: unknown, pattern: unknown): boolean {
  if (value == null || pattern == null) return false;
  return javaMatches(String(value), String(pattern));
}

/**
 * `encodeUrl(s)`: form encoding. A space is `+`; letters, digits and
 * `. - * _` stay; every other character is its UTF-8 `%XX` escape
 * (functions/common/encodeurl).
 */
export function encodeUrl(value: unknown): string | null {
  if (value == null) return null;
  const out = encodeURIComponent(String(value))
    .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+')
    .replace(/%2A/g, '*');
  return emptyToNull(out);
}

export function left(value: unknown, n: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  const count = Number(n);
  if (!Number.isFinite(count) || count === 0) return null;
  if (count < 0) return emptyToNull(s);
  if (count > s.length) throw new DelugeRuntimeError(INDEX);
  return emptyToNull(s.slice(0, count));
}

export function right(value: unknown, n: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  const count = Number(n);
  if (!Number.isFinite(count) || count === 0) return null;
  if (count < 0 || count > s.length) throw new DelugeRuntimeError(INDEX);
  return emptyToNull(s.slice(Math.max(0, s.length - count)));
}

export function mid(value: unknown, start: unknown, end?: unknown): string | null {
  return subText(value, start, end);
}

export function ltrim(value: unknown): string | null {
  if (value == null) return null;
  return emptyToNull(String(value).trimStart());
}

export function rtrim(value: unknown): string | null {
  if (value == null) return null;
  return emptyToNull(String(value).trimEnd());
}

export function repeat(value: unknown, n: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  const count = Number(n);
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count * s.length > 100_000) throw new DelugeRuntimeError(`repeat result cannot exceed 100000`);
  return emptyToNull(s.repeat(count));
}

export function reverse(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return emptyToNull([...s].reverse().join(''));
}

export function isAscii(value: unknown): boolean | null {
  if (value == null || typeof value === 'boolean') return null;
  return /^[\x00-\x7F]*$/.test(String(value));
}

export function removeAllAlphaNumeric(value: unknown): string | null {
  if (value == null) return null;
  return emptyToNull(String(value).replace(/[A-Za-z0-9]/g, ''));
}

export function hexToText(value: unknown): string | null {
  if (value == null) return null;
  const str = String(value);
  if (str.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(str)) {
    return null;
  }
  if (typeof Buffer !== 'undefined') {
    return emptyToNull(Buffer.from(str, 'hex').toString('utf8'));
  }
  const bytes = new Uint8Array(str.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(str.slice(i * 2, i * 2 + 2), 16);
  }
  return emptyToNull(new TextDecoder().decode(bytes));
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/**
 * Encodes `&`, `<`, `>`, and `"`. The apostrophe stays literal
 * (https://www.zoho.com/deluge/help/string/html-encode.html, the htmlEncode
 * docUrl in docs/deluge-builtins.json). `&` is replaced first, so an
 * already-encoded `&amp;` becomes `&amp;amp;`, which htmlDecode turns back
 * into `&amp;`. Null and `""` match htmlDecode: null stays null, `""` is null.
 */
export function htmlEncode(value: unknown): string | null {
  if (value == null) return null;
  return emptyToNull(
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
  );
}

export function htmlDecode(value: unknown): string | null {
  if (value == null) return null;
  return emptyToNull(
    String(value).replace(/&(?:amp|lt|gt|quot|#39|apos|#\d+|#x[0-9a-fA-F]+);/gi, (match) => {
      const lower = match.toLowerCase();
      if (HTML_ENTITIES[lower]) return HTML_ENTITIES[lower]!;
      if (HTML_ENTITIES[match]) return HTML_ENTITIES[match]!;
      if (lower.startsWith('&#x')) {
        try {
          const cp = parseInt(lower.slice(3, -1), 16);
          if (cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF) || cp > 0x10FFFF) return match;
          return String.fromCodePoint(cp);
        } catch {
          return match;
        }
      }
      if (match.startsWith('&#')) {
        try {
          const cp = parseInt(match.slice(2, -1), 10);
          if (cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF) || cp > 0x10FFFF) return match;
          return String.fromCodePoint(cp);
        } catch {
          return match;
        }
      }
      return match;
    })
  );
}
