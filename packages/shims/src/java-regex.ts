/**
 * Deluge `matches` patterns are Java regular expressions; the shim runs them
 * as JavaScript RegExps. This module parses the Java pattern and re-emits an
 * equivalent JavaScript pattern (compiled with the `u` flag), so no construct
 * is left for JavaScript to read differently:
 *
 * - `\p{..}` / `\P{..}` Unicode categories, scripts and the binary properties
 *   whose Java and Unicode definitions agree compile to JavaScript `\p{..}`;
 *   the POSIX names (`\p{Alpha}`, `\p{Punct}`, ...) compile to their ASCII sets.
 * - `\Q..\E` is literal text; `\x{h..}`, `\0oct`, `\cX`, `\a`, `\e` are code points.
 * - `\h`, `\v`, `\s`, `.` and `$` use Java's character sets and line terminators.
 * - `\A` and `\G` (one match from the start) are the start of the text; `\z`
 *   is its end; `\Z` is the end before an optional final line terminator.
 * - `\b` / `\B` agree with Java on ASCII text only, so a non-ASCII text is refused.
 *
 * Constructs with no exact JavaScript equivalent are refused with a
 * DelugeRuntimeError that names the construct: possessive quantifiers,
 * atomic groups `(?>..)`, inline flags `(?i)`, back references, character
 * class union `[a[b]]` and intersection `&&`, Unicode blocks `\p{InX}`.
 *
 * Patterns that can backtrack catastrophically are refused before they run.
 * A quantifier whose upper bound is greater than 1 is refused when its body
 * can match in more than one length — an inner quantifier with a max above
 * its min, an optional, or an alternation of different widths — as in
 * `(a{1,2})*` and `(a?)*`. The one exception is a variable piece that is a
 * single atom closed by a following literal that atom cannot consume, which
 * makes each iteration unique (the dot in `(\d{1,3}\.){3}`). A repeated
 * alternation whose branches can start alike (`(a|a)*`) is refused as well.
 * The text is bounded by MATCH_INPUT_MAX. A character outside the Basic
 * Multilingual Plane is refused: Java counts UTF-16 units and this compiler
 * counts code points, so a code-point match would be the wrong answer.
 */
import { DelugeRuntimeError } from './errors.js';

/**
 * Longest text `matches` evaluates. A migrated text column stores at most
 * 10,000 characters (the same bound as the pad width), so a longer text is
 * refused rather than run against an arbitrary pattern without bound.
 */
export const MATCH_INPUT_MAX = 10_000;

export interface JavaRegex {
  re: RegExp;
  /** The pattern uses `\b` or `\B`, which agree with Java on ASCII text only. */
  asciiOnly: boolean;
  /** Capturing groups in source order. null means the group has no name. */
  groups: (string | null)[];
}

type AtomSet = 'd' | 'D' | 'w' | 'W' | 's' | 'S' | 'h' | 'H' | 'v' | 'V' | 'dot' | 'anchor';

type Node =
  | { t: 'atom'; js: string; ch?: number; set?: AtomSet }
  | { t: 'group'; open: string; body: Node }
  | { t: 'alt'; branches: Node[][] }
  | { t: 'quant'; node: Node; min: number; max: number; js: string };

const LINE_END = '(?:\\r\\n|[\\n\\r\\u0085\\u2028\\u2029])';
/** Java `$` / `\Z`: end of text, or before a final line terminator, never between `\r` and `\n`. */
const DOLLAR = `(?=${LINE_END}?(?![\\s\\S]))(?!(?<=\\r)\\n)`;
const START = '(?<![\\s\\S])';
const END = '(?![\\s\\S])';

const S_SET = ' \\t\\n\\x0B\\f\\r';
const H_SET = ' \\t\\u00A0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000';
const V_SET = '\\n\\x0B\\f\\r\\u0085\\u2028\\u2029';

/** Java POSIX classes (US-ASCII only without UNICODE_CHARACTER_CLASS). */
const POSIX: Record<string, string> = {
  Lower: 'a-z',
  Upper: 'A-Z',
  ASCII: '\\x00-\\x7F',
  Alpha: 'a-zA-Z',
  Digit: '0-9',
  Alnum: 'a-zA-Z0-9',
  Punct: '\\x21-\\x2F\\x3A-\\x40\\x5B-\\x60\\x7B-\\x7E',
  Graph: '\\x21-\\x7E',
  Print: '\\x20-\\x7E',
  Blank: ' \\t',
  Cntrl: '\\x00-\\x1F\\x7F',
  XDigit: '0-9a-fA-F',
  Space: S_SET,
};

const CATEGORIES = new Set([
  'L', 'LC', 'Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'M', 'Mn', 'Mc', 'Me', 'N', 'Nd', 'Nl', 'No',
  'P', 'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po', 'S', 'Sm', 'Sc', 'Sk', 'So',
  'Z', 'Zs', 'Zl', 'Zp', 'C', 'Cc', 'Cf', 'Cs', 'Co', 'Cn',
]);

/** Java binary properties (matched by upper-case name) whose definition is the Unicode one. */
const BINARY: Record<string, string> = {
  ALPHABETIC: 'Alphabetic',
  IDEOGRAPHIC: 'Ideographic',
  LOWERCASE: 'Lowercase',
  UPPERCASE: 'Uppercase',
  WHITE_SPACE: 'White_Space',
  WHITESPACE: 'White_Space',
  JOIN_CONTROL: 'Join_Control',
  JOINCONTROL: 'Join_Control',
  NONCHARACTER_CODE_POINT: 'Noncharacter_Code_Point',
  NONCHARACTERCODEPOINT: 'Noncharacter_Code_Point',
};

/** A class escape: `out` stands alone, `inner` goes inside `[...]` (null: not expressible there). */
interface ClassEscape {
  out: string;
  inner: string | null;
}

function refuse(what: string, pattern: string): never {
  throw new DelugeRuntimeError(`Unsupported regex feature ${what} in ${pattern}`);
}

function classAtomSet(c: string): AtomSet | undefined {
  switch (c) {
    case 'd': case 'D': case 'w': case 'W': case 's': case 'S':
    case 'h': case 'H': case 'v': case 'V':
      return c;
    default:
      return undefined;
  }
}

function invalid(pattern: string): never {
  throw new DelugeRuntimeError(`Invalid regular expression ${pattern}`);
}

/** A literal code point, safe both inside and outside a class under the `u` flag. */
function lit(cp: number): string {
  const c = String.fromCodePoint(cp);
  return /[A-Za-z0-9 _]/.test(c) ? c : `\\u{${cp.toString(16)}}`;
}

function isHex(c: string | undefined): boolean {
  return c !== undefined && /^[0-9a-fA-F]$/.test(c);
}

function scriptName(name: string): string | null {
  try {
    new RegExp(`\\p{Script=${name}}`, 'u');
    return name;
  } catch {
    return null;
  }
}

class Parser {
  private readonly cs: string[];
  private i = 0;
  asciiOnly = false;
  /** The pattern uses a `\p{..}` / `\P{..}` class, POSIX names included. */
  usesProperty = false;

  constructor(private readonly src: string) {
    this.cs = Array.from(src);
  }

  parse(): Node {
    const node = this.alt();
    if (this.i < this.cs.length) invalid(this.src); // an unmatched ')'
    return node;
  }

  private peek(k = 0): string | undefined {
    return this.cs[this.i + k];
  }

  private next(): string {
    const c = this.cs[this.i++];
    if (c === undefined) invalid(this.src);
    return c;
  }

  private alt(): Node {
    const branches = [this.seq()];
    while (this.peek() === '|') {
      this.i++;
      branches.push(this.seq());
    }
    return { t: 'alt', branches };
  }

  private seq(): Node[] {
    const items: Node[] = [];
    for (let c = this.peek(); c !== undefined && c !== '|' && c !== ')'; c = this.peek()) {
      const atoms = this.atom();
      items.push(...atoms);
      const q = this.quantifier();
      if (q) {
        const last = items.pop();
        if (last === undefined) invalid(this.src);
        items.push({ t: 'quant', node: last, ...q });
      }
    }
    return items;
  }

  private quantifier(): { min: number; max: number; js: string } | null {
    const c = this.peek();
    let min: number;
    let max: number;
    let js: string;
    if (c === '*' || c === '+' || c === '?') {
      this.i++;
      [min, max] = c === '*' ? [0, Infinity] : c === '+' ? [1, Infinity] : [0, 1];
      js = c;
    } else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.cs.slice(this.i, this.i + 24).join(''));
      if (!m) invalid(this.src);
      this.i += Array.from(m[0]).length;
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      if (max < min) invalid(this.src);
      js = m[0];
    } else {
      return null;
    }
    if (this.peek() === '+') refuse(`possessive quantifier ${js}+`, this.src);
    if (this.peek() === '?') {
      this.i++;
      js += '?';
    }
    return { min, max, js };
  }

  private atom(): Node[] {
    const c = this.next();
    switch (c) {
      case '(':
        return [this.group()];
      case '[':
        return [{ t: 'atom', js: this.cls() }];
      case '.':
        return [{ t: 'atom', js: '[^\\n\\r\\u0085\\u2028\\u2029]', set: 'dot' }];
      case '^':
        return [{ t: 'atom', js: START, set: 'anchor' }];
      case '$':
        return [{ t: 'atom', js: DOLLAR, set: 'anchor' }];
      case '*':
      case '+':
      case '?':
      case '{':
        return invalid(this.src);
      case '\\':
        return this.escape();
      default: {
        const cp = c.codePointAt(0)!;
        return [{ t: 'atom', js: lit(cp), ch: cp }];
      }
    }
  }

  private group(): Node {
    let open = '(';
    if (this.peek() === '?') {
      this.i++;
      const c = this.next();
      if (c === ':' || c === '=' || c === '!') {
        open = `(?${c}`;
      } else if (c === '<' && (this.peek() === '=' || this.peek() === '!')) {
        open = `(?<${this.next()}`;
      } else if (c === '<') {
        let name = '';
        while (this.peek() !== undefined && this.peek() !== '>') name += this.next();
        this.next();
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) invalid(this.src);
        open = `(?<${name}>`;
      } else if (c === '>') {
        refuse('atomic group (?>...)', this.src);
      } else {
        let flags = c;
        while (this.peek() !== undefined && this.peek() !== ')' && this.peek() !== ':') flags += this.next();
        refuse(`inline flags (?${flags})`, this.src);
      }
    }
    const body = this.alt();
    if (this.next() !== ')') invalid(this.src);
    return { t: 'group', open, body };
  }

  /** `\Q...\E`: the code points up to `\E` (or the end of the pattern). */
  private quoted(): number[] {
    const out: number[] = [];
    while (this.i < this.cs.length && !(this.peek() === '\\' && this.peek(1) === 'E')) out.push(this.next().codePointAt(0)!);
    if (this.i < this.cs.length) this.i += 2;
    return out;
  }

  private hex(n: number): number {
    let s = '';
    for (let k = 0; k < n; k++) {
      if (!isHex(this.peek())) invalid(this.src);
      s += this.next();
    }
    return parseInt(s, 16);
  }

  /** A literal-producing escape after the backslash, or null when `c` is not one. */
  private literalEscape(c: string): number | null {
    switch (c) {
      case 't': return 9;
      case 'n': return 10;
      case 'r': return 13;
      case 'f': return 12;
      case 'a': return 7;
      case 'e': return 27;
      case 'c': return this.next().codePointAt(0)! ^ 64;
      case '0': {
        let s = '';
        const max = this.peek() !== undefined && /[0-3]/.test(this.peek()!) ? 3 : 2;
        while (s.length < max && this.peek() !== undefined && /[0-7]/.test(this.peek()!)) s += this.next();
        if (s === '') invalid(this.src);
        return parseInt(s, 8);
      }
      case 'x': {
        if (this.peek() !== '{') return this.hex(2);
        this.i++;
        let s = '';
        while (isHex(this.peek())) s += this.next();
        if (this.next() !== '}' || s === '' || parseInt(s, 16) > 0x10ffff) invalid(this.src);
        return parseInt(s, 16);
      }
      case 'u': {
        const cp = this.hex(4);
        if (cp >= 0xd800 && cp <= 0xdbff && this.peek() === '\\' && this.peek(1) === 'u') {
          const save = this.i;
          this.i += 2;
          const lo = this.hex(4);
          if (lo >= 0xdc00 && lo <= 0xdfff) return (cp - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
          this.i = save;
        }
        return cp;
      }
      default:
        return /[A-Za-z0-9]/.test(c) ? null : c.codePointAt(0)!;
    }
  }

  private classEscape(c: string): ClassEscape | null {
    const set = (inner: string, negated: boolean): ClassEscape =>
      negated ? { out: `[^${inner}]`, inner: null } : { out: `[${inner}]`, inner };
    switch (c) {
      case 'd': case 'D': case 'w': case 'W':
        return { out: `\\${c}`, inner: `\\${c}` };
      case 's': case 'S':
        return set(S_SET, c === 'S');
      case 'h': case 'H':
        return set(H_SET, c === 'H');
      case 'v': case 'V':
        return set(V_SET, c === 'V');
      case 'p': case 'P':
        return this.property(c === 'P');
      default:
        return null;
    }
  }

  private property(negated: boolean): ClassEscape {
    let name: string;
    if (this.peek() === '{') {
      this.i++;
      name = '';
      while (this.peek() !== undefined && this.peek() !== '}') name += this.next();
      this.next();
    } else {
      name = this.next();
    }
    const shown = `\\${negated ? 'P' : 'p'}{${name}}`;
    this.usesProperty = true;
    const posix = POSIX[name];
    if (posix !== undefined) {
      return negated ? { out: `[^${posix}]`, inner: null } : { out: `[${posix}]`, inner: posix };
    }
    let js: string | null = null;
    const eq = name.indexOf('=');
    if (eq > 0) {
      const key = name.slice(0, eq).toLowerCase();
      const value = name.slice(eq + 1);
      if ((key === 'gc' || key === 'general_category') && CATEGORIES.has(value)) js = value;
      else if (key === 'sc' || key === 'script') js = scriptName(value) && `Script=${value}`;
    } else if (name.startsWith('Is')) {
      const rest = name.slice(2);
      const binary = BINARY[rest.toUpperCase()];
      if (binary) js = binary;
      else if (CATEGORIES.has(rest)) js = rest;
      else js = scriptName(rest) && `Script=${rest}`;
    } else if (CATEGORIES.has(name)) {
      js = name;
    }
    if (js === null) refuse(shown, this.src);
    const p = `\\${negated ? 'P' : 'p'}{${js}}`;
    return { out: p, inner: p };
  }

  private escape(): Node[] {
    const c = this.next();
    if (c === 'Q') return this.quoted().map((cp) => ({ t: 'atom', js: lit(cp), ch: cp }));
    if (c === 'A' || c === 'G') return [{ t: 'atom', js: START, set: 'anchor' }];
    if (c === 'z') return [{ t: 'atom', js: END, set: 'anchor' }];
    if (c === 'Z') return [{ t: 'atom', js: DOLLAR, set: 'anchor' }];
    if (c === 'b' || c === 'B') {
      this.asciiOnly = true;
      return [{ t: 'atom', js: `\\${c}`, set: 'anchor' }];
    }
    if (/[1-9]/.test(c) || c === 'k') refuse(`back reference \\${c}`, this.src);
    const ce = this.classEscape(c);
    if (ce) {
      const set = classAtomSet(c);
      return [set === undefined ? { t: 'atom', js: ce.out } : { t: 'atom', js: ce.out, set }];
    }
    const cp = this.literalEscape(c);
    if (cp === null) refuse(`escape \\${c}`, this.src);
    return [{ t: 'atom', js: lit(cp), ch: cp }];
  }

  /** A character class after its `[`, emitted as a JavaScript class. */
  private cls(): string {
    let out = '[';
    if (this.peek() === '^') {
      this.i++;
      out += '^';
    }
    if (this.peek() === ']') refuse("']' at the start of a character class", this.src);
    for (;;) {
      const c = this.next();
      if (c === ']') return `${out}]`;
      if (c === '[') refuse('character class union [..[..]]', this.src);
      if (c === '&' && this.peek() === '&') refuse('character class intersection &&', this.src);
      let lo: number | null;
      if (c === '\\') {
        const e = this.next();
        if (e === 'Q') {
          out += this.quoted().map(lit).join('');
          if (this.peek() === '-' && this.peek(1) !== ']') refuse('a range after \\Q...\\E in a character class', this.src);
          continue;
        }
        const ce = this.classEscape(e);
        if (ce) {
          if (ce.inner === null) refuse(`\\${e} inside a character class`, this.src);
          if (this.peek() === '-' && this.peek(1) !== ']') refuse(`a range from \\${e}`, this.src);
          out += ce.inner;
          continue;
        }
        if (/[1-9bBkAGzZ]/.test(e)) refuse(`\\${e} inside a character class`, this.src);
        lo = this.literalEscape(e);
        if (lo === null) refuse(`escape \\${e}`, this.src);
      } else {
        lo = c.codePointAt(0)!;
      }
      if (this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== undefined) {
        this.i++;
        const d = this.next();
        let hi: number | null;
        if (d === '[') refuse('character class union [..[..]]', this.src);
        if (d === '\\') {
          const e = this.next();
          if (e === 'Q' || this.classEscape(e)) refuse(`a range to \\${e}`, this.src);
          hi = this.literalEscape(e);
          if (hi === null) refuse(`escape \\${e}`, this.src);
        } else {
          hi = d.codePointAt(0)!;
        }
        if (hi < lo) invalid(this.src);
        out += `${lit(lo)}-${lit(hi)}`;
      } else {
        out += lit(lo);
      }
    }
  }
}

function emit(node: Node): string {
  switch (node.t) {
    case 'atom':
      return node.js;
    case 'group':
      return `${node.open}${emit(node.body)})`;
    case 'alt':
      return node.branches.map((b) => b.map(emit).join('')).join('|');
    case 'quant': {
      const inner = emit(node.node);
      return node.node.t === 'atom' || node.node.t === 'group' ? `${inner}${node.js}` : `(?:${inner})${node.js}`;
    }
  }
}

function isLookaround(open: string): boolean {
  return open.startsWith('(?=') || open.startsWith('(?!') || open.startsWith('(?<=') || open.startsWith('(?<!');
}

function isAnchor(node: Node): boolean {
  return node.t === 'atom' && node.set === 'anchor';
}

/** One width in characters, or null when the node can match in more than one length. */
function fixedWidth(node: Node): number | null {
  switch (node.t) {
    case 'atom':
      return isAnchor(node) ? 0 : 1;
    case 'group':
      if (isLookaround(node.open)) return 0;
      return fixedWidth(node.body);
    case 'alt': {
      if (node.branches.length === 0) return 0;
      let width: number | null = null;
      for (const branch of node.branches) {
        const w = sequenceFixed(branch);
        if (w === null) return null;
        if (width === null) width = w;
        else if (width !== w) return null;
      }
      return width;
    }
    case 'quant': {
      const inner = fixedWidth(node.node);
      if (inner === null || node.min !== node.max || node.max === Infinity) return null;
      return node.min * inner;
    }
  }
}

function sequenceFixed(items: Node[]): number | null {
  let sum = 0;
  for (const item of items) {
    const w = fixedWidth(item);
    if (w === null) return null;
    sum += w;
  }
  return sum;
}

function minWidth(node: Node): number {
  switch (node.t) {
    case 'atom':
      return isAnchor(node) ? 0 : 1;
    case 'group':
      if (isLookaround(node.open)) return 0;
      return minWidth(node.body);
    case 'alt':
      if (node.branches.length === 0) return 0;
      return Math.min(...node.branches.map((branch) => branch.reduce((sum, item) => sum + minWidth(item), 0)));
    case 'quant':
      return node.min * minWidth(node.node);
  }
}

function isDigitCp(cp: number): boolean {
  return cp >= 0x30 && cp <= 0x39;
}

function isWordCp(cp: number): boolean {
  return isDigitCp(cp) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f;
}

function isSpaceCp(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d;
}

function isHorizontalCp(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0xa0 || cp === 0x1680 || cp === 0x180e
    || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

function isVerticalCp(cp: number): boolean {
  return cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d || cp === 0x85 || cp === 0x2028 || cp === 0x2029;
}

const LINE_TERMINATOR = new Set([0x0a, 0x0d, 0x85, 0x2028, 0x2029]);

/** True when `atom` can be shown not to match `cp`. Unknown classes are not proved. */
function atomRejects(atom: Node, cp: number): boolean {
  if (atom.t !== 'atom') return false;
  if (atom.ch !== undefined) return atom.ch !== cp;
  switch (atom.set) {
    case 'd': return !isDigitCp(cp);
    case 'D': return isDigitCp(cp);
    case 'w': return !isWordCp(cp);
    case 'W': return isWordCp(cp);
    case 's': return !isSpaceCp(cp);
    case 'S': return isSpaceCp(cp);
    case 'h': return !isHorizontalCp(cp);
    case 'H': return isHorizontalCp(cp);
    case 'v': return !isVerticalCp(cp);
    case 'V': return isVerticalCp(cp);
    case 'dot': return LINE_TERMINATOR.has(cp);
    default: return false;
  }
}

/**
 * A body is safe to repeat when it always consumes the same positive number
 * of characters, or when each variable-length atom is followed by a literal
 * that atom cannot match. The literal fixes where the iteration ends, so the
 * text has only one partition (`(\d{1,3}\.){3}`). An optional with nothing
 * after it, or `{1,2}` of the same character the next iteration starts with,
 * does not.
 */
function repeatSafe(node: Node): boolean {
  const width = fixedWidth(node);
  if (width !== null && width >= 1) return true;
  return separatorClosed(node);
}

function separatorClosed(node: Node): boolean {
  if (node.t === 'group') {
    if (isLookaround(node.open)) return false;
    return separatorClosed(node.body);
  }
  if (node.t === 'alt') {
    if (node.branches.length !== 1) return false;
    return sequenceClosed(node.branches[0]!);
  }
  return false;
}

function sequenceClosed(items: Node[]): boolean {
  const min = items.reduce((sum, item) => sum + minWidth(item), 0);
  if (min < 1) return false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (fixedWidth(item) !== null) continue;
    if (item.t !== 'quant' || item.node.t !== 'atom') return false;
    const bodyWidth = fixedWidth(item.node);
    if (bodyWidth === null || bodyWidth < 1) return false;
    if (!hasDisjointSeparator(item.node, items, i + 1)) return false;
  }
  return true;
}

function hasDisjointSeparator(atom: Node, items: Node[], from: number): boolean {
  for (let j = from; j < items.length; j++) {
    const next = items[j]!;
    const width = fixedWidth(next);
    if (width === 0) continue;
    if (width === null || width < 1 || next.t !== 'atom' || next.ch === undefined) return false;
    return atomRejects(atom, next.ch);
  }
  return false;
}

/** The single literal a branch must start with, or null when that is not statically known. */
function firstLiteral(items: Node[]): number | null {
  const first = items[0];
  if (first === undefined) return null;
  if (first.t === 'atom') return first.ch ?? null;
  if (first.t === 'quant' && first.min >= 1) return firstLiteral([first.node]);
  if (first.t === 'group' && !first.open.startsWith('(?=') && !first.open.startsWith('(?!') && !first.open.startsWith('(?<=') && !first.open.startsWith('(?<!')) {
    const body = first.body;
    return body.t === 'alt' && body.branches.length === 1 ? firstLiteral(body.branches[0]!) : null;
  }
  return null;
}

/** An alternation (anywhere in `node`) whose branches are not told apart by distinct first literals. */
function hasAmbiguousAlternation(node: Node): boolean {
  switch (node.t) {
    case 'atom':
      return false;
    case 'group':
      return hasAmbiguousAlternation(node.body);
    case 'quant':
      return hasAmbiguousAlternation(node.node);
    case 'alt': {
      if (node.branches.length > 1) {
        const firsts = node.branches.map(firstLiteral);
        if (firsts.some((f) => f === null) || new Set(firsts).size !== firsts.length) return true;
      }
      return node.branches.some((b) => b.some(hasAmbiguousAlternation));
    }
  }
}

/** Refuses a repetition that can backtrack exponentially. */
function checkBacktracking(node: Node, pattern: string): void {
  switch (node.t) {
    case 'atom':
      return;
    case 'group':
      return checkBacktracking(node.body, pattern);
    case 'alt':
      return node.branches.forEach((b) => b.forEach((n) => checkBacktracking(n, pattern)));
    case 'quant':
      if (node.max > 1 && !repeatSafe(node.node)) {
        throw new DelugeRuntimeError(`Regex refused: a repeated group whose body can match in more than one length, like (a{1,2})* or (a?)*, can backtrack without bound in ${pattern}`);
      }
      if (node.max > 1 && hasAmbiguousAlternation(node.node)) {
        throw new DelugeRuntimeError(`Regex refused: a repeated alternation whose branches can start alike, like (a|a)*, can backtrack without bound in ${pattern}`);
      }
      return checkBacktracking(node.node, pattern);
  }
}

function capturingGroups(node: Node, out: (string | null)[] = []): (string | null)[] {
  switch (node.t) {
    case 'atom':
      break;
    case 'quant':
      capturingGroups(node.node, out);
      break;
    case 'alt':
      for (const branch of node.branches) for (const item of branch) capturingGroups(item, out);
      break;
    case 'group':
      if (!isLookaround(node.open) && node.open !== '(?:') {
        const named = /^\(\?<([A-Za-z][A-Za-z0-9]*)>$/.exec(node.open);
        out.push(named ? named[1]! : null);
      }
      capturingGroups(node.body, out);
      break;
  }
  return out;
}

const CACHE = new Map<string, JavaRegex>();
const CACHE_MAX = 256;

/**
 * Compiles a Java pattern. `anchor` wraps it so the whole text must match,
 * which is `String.matches`. Without `anchor` the pattern finds a substring,
 * which is `replaceAll`. Throws DelugeRuntimeError for an invalid pattern,
 * an unsupported construct, or a pattern that can backtrack without bound.
 *
 * `ignoreCase` is Java `Pattern.CASE_INSENSITIVE`, which folds US-ASCII
 * letters only. JavaScript's `iu` folds Unicode, so the two agree only while
 * no non-ASCII code point can take part in a fold: a pattern with a non-ASCII
 * code point or a `\p{..}` property is refused, and `guardText` refuses a text
 * with a non-ASCII letter that has a case.
 */
export function compileJavaRegex(pattern: string, anchor = true, ignoreCase = false): JavaRegex {
  const key = `${anchor ? 'a' : 'u'}${ignoreCase ? 'i' : ''}:${pattern}`;
  const hit = CACHE.get(key);
  if (hit) return hit;
  const parser = new Parser(pattern);
  const tree = parser.parse();
  checkBacktracking(tree, pattern);
  const body = emit(tree);
  if (ignoreCase && parser.usesProperty) refuse('\\p{..} with ignore case', pattern);
  if (ignoreCase) refuseUnicodeFold(body, pattern);
  let re: RegExp;
  try {
    re = new RegExp(anchor ? `^(?:${body})$` : body, `${anchor ? '' : 'g'}${ignoreCase ? 'i' : ''}u`);
  } catch {
    invalid(pattern);
  }
  const out = { re, asciiOnly: parser.asciiOnly, groups: capturingGroups(tree) };
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value!);
  CACHE.set(key, out);
  return out;
}

/**
 * A compiled body whose case-insensitive match could differ between Java's
 * US-ASCII folding and JavaScript's Unicode folding: a literal non-ASCII code
 * point, emitted as `\u{..}` or raw. The fixed
 * whitespace and line-terminator sets (`\uXXXX` form) have no case.
 */
function refuseUnicodeFold(body: string, pattern: string): void {
  if (/[^\x00-\x7F]/.test(body)) refuse('non-ASCII character with ignore case', pattern);
  for (const m of body.matchAll(/\\u\{([0-9a-f]+)\}/g)) {
    if (parseInt(m[1]!, 16) > 0x7f) refuse('non-ASCII character with ignore case', pattern);
  }
}

/** A non-ASCII letter with a case: Java's US-ASCII folding and Unicode folding disagree on it. */
function hasNonAsciiCased(text: string): boolean {
  for (const c of text) {
    if (c.charCodeAt(0) > 0x7f && (c.toLowerCase() !== c || c.toUpperCase() !== c)) return true;
  }
  return false;
}

function hasNonBmp(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.codePointAt(i)! > 0xffff) return true;
  }
  return false;
}

function guardText(text: string, pattern: string, asciiOnly: boolean, op: 'matches' | 'replaceAll' | 'replaceFirst', ignoreCase = false): void {
  if (text.length > MATCH_INPUT_MAX) {
    throw new DelugeRuntimeError(`Text of ${text.length} characters is longer than the ${MATCH_INPUT_MAX} that ${op} evaluates`);
  }
  if (asciiOnly && /[^\x00-\x7F]/.test(text)) {
    throw new DelugeRuntimeError(`Unsupported regex feature \\b word boundary on non-ASCII text in ${pattern}`);
  }
  if (hasNonBmp(text)) {
    throw new DelugeRuntimeError(`Unsupported regex feature non-BMP text in ${pattern}`);
  }
  if (ignoreCase && hasNonAsciiCased(text)) {
    throw new DelugeRuntimeError(`Unsupported regex feature ignore case on non-ASCII letters in ${pattern}`);
  }
}

/** Java `String.matches`: the whole text fits the pattern. */
export function javaMatches(text: string, pattern: string): boolean {
  const { re, asciiOnly } = compileJavaRegex(pattern, true);
  guardText(text, pattern, asciiOnly, 'matches');
  return re.test(text);
}

/**
 * Java replacement text. `\` escapes the next character, so `\\` is one
 * backslash and `\$` is a dollar. `$n` and `${n}` are capturing groups
 * (`$0` is the whole match). A `$` that is not a group reference is an error.
 * A group that did not participate adds nothing.
 */
function applyJavaReplacement(
  replacement: string,
  whole: string,
  captures: (string | undefined)[],
  groupNames: (string | null)[],
): string {
  const groupCount = groupNames.length;
  let out = '';
  let i = 0;
  while (i < replacement.length) {
    const c = replacement.charAt(i);
    if (c === '\\') {
      if (i + 1 >= replacement.length) {
        throw new DelugeRuntimeError('character to be escaped is missing in replacement');
      }
      out += replacement.charAt(i + 1);
      i += 2;
      continue;
    }
    if (c === '$') {
      i++;
      if (i >= replacement.length) throw new DelugeRuntimeError('Illegal group reference in replacement');
      const next = replacement.charAt(i);
      let ref: number;
      if (next === '{') {
        i++;
        const start = i;
        while (i < replacement.length && replacement.charAt(i) !== '}') i++;
        if (i >= replacement.length) throw new DelugeRuntimeError('named capturing group is missing trailing \'}\' in replacement');
        const name = replacement.slice(start, i);
        i++;
        if (name === '') throw new DelugeRuntimeError('named capturing group has 0 length name in replacement');
        if (/^\d+$/.test(name)) {
          ref = Number(name);
        } else {
          const at = groupNames.indexOf(name);
          if (at < 0) throw new DelugeRuntimeError(`No group ${name} in replacement`);
          ref = at + 1;
        }
      } else {
        const digit = next.charCodeAt(0) - 48;
        if (digit < 0 || digit > 9) throw new DelugeRuntimeError('Illegal group reference in replacement');
        i++;
        ref = digit;
        while (i < replacement.length) {
          const nextDigit = replacement.charCodeAt(i) - 48;
          if (nextDigit < 0 || nextDigit > 9) break;
          const grown = ref * 10 + nextDigit;
          if (grown > groupCount) break;
          ref = grown;
          i++;
        }
      }
      if (ref > groupCount) throw new DelugeRuntimeError(`No group ${ref} in replacement`);
      const value = ref === 0 ? whole : captures[ref - 1];
      if (value != null) out += value;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Java `String.replaceAll`: every match, with Java's replacement text.
 * `first` is `String.replaceFirst`; `ignoreCase` compiles the pattern with
 * `Pattern.CASE_INSENSITIVE` (see compileJavaRegex).
 */
export function javaReplaceAll(text: string, pattern: string, replacement: string, first = false, ignoreCase = false): string {
  const compiled = compileJavaRegex(pattern, false, ignoreCase);
  guardText(text, pattern, compiled.asciiOnly, first ? 'replaceFirst' : 'replaceAll', ignoreCase);
  compiled.re.lastIndex = 0;
  let done = false;
  return text.replace(compiled.re, (match: string, ...rest: unknown[]) => {
    if (done) return match;
    done = first;
    let end = rest.length;
    if (end > 0 && rest[end - 1] !== null && typeof rest[end - 1] === 'object') end -= 1;
    const captures = rest.slice(0, Math.max(0, end - 2)) as (string | undefined)[];
    return applyJavaReplacement(replacement, match, captures, compiled.groups);
  });
}
