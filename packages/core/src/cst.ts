/**
 * Concrete syntax tree for `.ds` files.
 *
 * The CST is lossless: every token, including whitespace and comments, is a
 * leaf, and `print(parse(src)) === src` for any input. Structure is layered on
 * top of the token stream in two steps:
 *
 *  1. bracket matching turns `{...}`, `(...)` and `[...]` into `Group` nodes;
 *  2. the contents of block bodies are split into `Statement` nodes using the
 *     line-oriented conventions observed in real exports (see docs/ir-v1.md).
 *
 * Groups that hold embedded Deluge (`custom deluge script ( ... )`, `on click
 * ( ... )`, `name(args) { ... }`) are marked `raw` and are not split further:
 * Deluge is a later phase, so the IR keeps it as an exact source span.
 */

import { tokenize, isTrivia, type Token } from './lexer.js';

export type { Token } from './lexer.js';

export interface Group {
  type: 'group';
  /** `{`, `(` or `[`. */
  open: Token;
  /** Statements and trivia for structured bodies; tokens and groups for raw/flat ones. */
  children: Node[];
  /** `null` when the file ended before the bracket was closed. */
  close: Token | null;
  /** True when the body is embedded Deluge kept verbatim. */
  raw: boolean;
  /** True when the body was split into statements. */
  structured: boolean;
  start: number;
  end: number;
}

export type StatementKind =
  | 'property' // key words = value
  | 'block' // header words { body }
  | 'call' // header words ( body ) [trailing]
  | 'word' // bare words: a field reference in a column list, `cancel submit`, `Member.Name as "Name"`, ...
  | 'pairs' // key : value [, key : value ...]  (`visibility:true,readonly:false`, `from : "x"`)
  | 'group' // a lone bracket group: `[ type = tooltip message = "..." ]`
  | 'unknown'; // anything else, kept verbatim

export interface Statement {
  type: 'stmt';
  kind: StatementKind;
  children: Node[];
  start: number;
  end: number;
}

export type Node = Token | Group | Statement;

export interface Document {
  type: 'document';
  source: string;
  /** Top-level statements and trivia. */
  children: Node[];
  /** Structural problems found while building the tree (unbalanced brackets, bad tokens). */
  errors: ParseIssue[];
}

export interface ParseIssue {
  code: 'stray-closer' | 'unclosed-bracket' | 'bad-token';
  offset: number;
  message: string;
}

export function isToken(n: Node): n is Token {
  return (n as Group).type === undefined;
}
export function isGroup(n: Node): n is Group {
  return (n as Group).type === 'group';
}
export function isStatement(n: Node): n is Statement {
  return (n as Statement).type === 'stmt';
}
export function isSignificant(n: Node): boolean {
  return !isToken(n) || !isTrivia(n);
}

export function nodeStart(n: Node): number {
  return isToken(n) ? n.start : n.start;
}
export function nodeEnd(n: Node): number {
  return isToken(n) ? n.start + n.text.length : n.end;
}

// ---------------------------------------------------------------------------
// Printing

export function print(n: Document | Node): string {
  const parts: string[] = [];
  // Iterative walk with an explicit stack: recursion here overflowed the call
  // stack on pathologically nested input (fuzz: `'{' * 4000`).
  interface Frame {
    children: Node[];
    index: number;
    close: Token | null;
  }
  const roots: Node[] = (n as Document).type === 'document' ? (n as Document).children : [n as Node];
  const stack: Frame[] = [{ children: roots, index: 0, close: null }];
  while (stack.length > 0) {
    const f = stack[stack.length - 1]!;
    if (f.index >= f.children.length) {
      if (f.close) parts.push(f.close.text);
      stack.pop();
      continue;
    }
    const x = f.children[f.index++]!;
    if (isToken(x)) parts.push(x.text);
    else if (isGroup(x)) {
      parts.push(x.open.text);
      stack.push({ children: x.children, index: 0, close: x.close });
    } else stack.push({ children: x.children, index: 0, close: null });
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Step 1: bracket matching

const OPEN_TO_CLOSE: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
const CLOSERS = new Set(['}', ')', ']']);

function buildGroups(tokens: Token[], errors: ParseIssue[]): Node[] {
  interface Frame {
    open: Token | null;
    children: Node[];
  }
  const stack: Frame[] = [{ open: null, children: [] }];
  const top = () => stack[stack.length - 1];
  for (const t of tokens) {
    if (t.kind === 'bad') {
      errors.push({ code: 'bad-token', offset: t.start, message: `unexpected ${JSON.stringify(t.text)}` });
    }
    if (t.kind === 'punct' && OPEN_TO_CLOSE[t.text]) {
      stack.push({ open: t, children: [] });
      continue;
    }
    if (t.kind === 'punct' && CLOSERS.has(t.text)) {
      const f = top();
      if (f.open && OPEN_TO_CLOSE[f.open.text] === t.text) {
        stack.pop();
        top().children.push(makeGroup(f.open, f.children, t));
        continue;
      }
      errors.push({ code: 'stray-closer', offset: t.start, message: `unmatched ${t.text}` });
      f.children.push(t);
      continue;
    }
    top().children.push(t);
  }
  while (stack.length > 1) {
    const f = stack.pop()!;
    errors.push({ code: 'unclosed-bracket', offset: f.open!.start, message: `unclosed ${f.open!.text}` });
    top().children.push(makeGroup(f.open!, f.children, null));
  }
  return stack[0].children;
}

function makeGroup(open: Token, children: Node[], close: Token | null): Group {
  const last = children.length ? nodeEnd(children[children.length - 1]) : open.start + 1;
  return {
    type: 'group',
    open,
    children,
    close,
    raw: false,
    structured: false,
    start: open.start,
    end: close ? close.start + close.text.length : last,
  };
}

// ---------------------------------------------------------------------------
// Step 2: statement splitting

const CONTINUATION_PUNCT = new Set(['=', ',', ':', '.', '+', '-', '*', '/', '&&', '||', '==', '!=', '<', '>', '<=', '>=', '->']);

function isPunct(n: Node | undefined, text?: string): boolean {
  return !!n && isToken(n) && n.kind === 'punct' && (text === undefined || n.text === text);
}
function isWord(n: Node | undefined): boolean {
  return !!n && isToken(n) && (n.kind === 'ident' || n.kind === 'string' || n.kind === 'number');
}
function isGroupOf(n: Node | undefined, open: string): n is Group {
  return !!n && isGroup(n) && n.open.text === open;
}

/** Split a flat run of tokens and groups into statements separated by trivia. */
function splitStatements(items: Node[]): Node[] {
  const out: Node[] = [];
  let i = 0;
  const n = items.length;
  const nextSig = (from: number): number => {
    let j = from;
    while (j < n && !isSignificant(items[j])) j++;
    return j;
  };
  const hasNewline = (from: number, to: number): boolean => {
    for (let k = from; k < to; k++) {
      const t = items[k];
      if (isToken(t) && (t.kind === 'nl' || (t.kind === 'blockComment' && /[\r\n]/.test(t.text)))) return true;
    }
    return false;
  };
  /** Is there a top-level `=` later on the same line? */
  const eqLaterOnLine = (from: number): boolean => {
    for (let k = from; k < n; k++) {
      const t = items[k];
      if (isToken(t) && t.kind === 'nl') return false;
      if (isPunct(t, '=')) return true;
    }
    return false;
  };

  while (i < n) {
    if (!isSignificant(items[i])) {
      out.push(items[i]);
      i++;
      continue;
    }
    const children: Node[] = [];
    let sawEq = false;
    let valueFirst: Node | null = null;
    let prevSig: Node | null = null;
    for (;;) {
      const cur = items[i];
      children.push(cur);
      if (sawEq && valueFirst === null && !isPunct(cur, '-') && !isPunct(cur, '+')) valueFirst = cur;
      if (isPunct(cur, '=') && !sawEq) sawEq = true;
      const j = nextSig(i + 1);
      if (j >= n) {
        i++;
        break;
      }
      const next = items[j];
      const nl = hasNewline(i + 1, j);
      let end = false;
      if (isPunct(cur, ';')) end = true;
      else if (isGroupOf(cur, '{') && !(prevSig && CONTINUATION_PUNCT.has(textOf(prevSig)))) end = true;
      else if (isPunct(next, ';')) end = false;
      else if (nl) {
        if (isGroupOf(next, '{') || isGroupOf(next, '(')) end = isGroupOf(cur, '(') && isGroupOf(next, '(');
        else if (isToken(cur) && cur.kind === 'punct' && CONTINUATION_PUNCT.has(cur.text)) end = false;
        else if (isPunct(next, '=')) end = false;
        else end = true;
      } else if (sawEq && valueFirst !== null) {
        // Same line, inside a property value.
        const curIsOp = isToken(cur) && cur.kind === 'punct';
        if (!curIsOp && isWord(next) && eqLaterOnLine(j)) end = true; // `type = text width = 200px`
        else if (cur === valueFirst && isToken(cur) && (cur.kind === 'string' || cur.kind === 'number') && isToken(next) && next.kind === 'ident')
          end = true; // `icon = "x"   show all rows from Y`
      } else if (!sawEq && isGroupOf(cur, '(') && isToken(next) && next.kind === 'ident') {
        end = true; // `submit (type = submit) reset (type = reset)`
      }
      prevSig = cur;
      if (end) {
        i++;
        break;
      }
      // absorb trivia up to the next significant item
      for (let k = i + 1; k < j; k++) children.push(items[k]);
      i = j;
    }
    out.push(makeStatement(children));
  }
  return out;
}

function textOf(n: Node): string {
  return isToken(n) ? n.text : '';
}

function makeStatement(children: Node[]): Statement {
  const s: Statement = {
    type: 'stmt',
    kind: 'unknown',
    children,
    start: nodeStart(children[0]),
    end: nodeEnd(children[children.length - 1]),
  };
  s.kind = classify(s);
  return s;
}

/** Significant children of a statement (no trivia). */
export function sig(s: Statement | Group): Node[] {
  return s.children.filter(isSignificant);
}

/** A header is one or more words, optionally joined by dots: `on user input of Sub.Field`. */
function headerLength(items: Node[]): number {
  let k = 0;
  while (k < items.length) {
    if (isWord(items[k])) k++;
    else if (k > 0 && isPunct(items[k], '.') && isWord(items[k + 1])) k += 2;
    else break;
  }
  return k;
}

function classify(s: Statement): StatementKind {
  const items = sig(s).filter((x) => !isPunct(x, ';'));
  if (items.length === 0) return 'unknown';
  const h = headerLength(items);
  const eq = items.findIndex((x) => isPunct(x, '='));
  if (eq > 0 && h === eq && eq < items.length - 1) return 'property';
  if (h > 0 && isPunct(items[h], ':')) return 'pairs';
  if (items.length === 1 && isGroup(items[0])) return 'group';
  const firstGroup = items.findIndex((x) => isGroup(x));
  if (firstGroup < 0) {
    // bare words, dotted references and comma lists: `Member.Name as "Name"`, `hide A,B;`
    return h > 0 && items.every((x) => isWord(x) || isPunct(x, '.') || isPunct(x, ',')) ? 'word' : 'unknown';
  }
  if (h === 0 || h !== firstGroup) return 'unknown';
  const g = items[firstGroup] as Group;
  if (g.open.text === '{') return firstGroup === items.length - 1 ? 'block' : 'unknown';
  if (g.open.text === '(' && isGroupOf(items[items.length - 1], '{') && items.length === firstGroup + 2) return 'block';
  return 'call';
}

/**
 * Header words of a statement (identifier/string/number text before the first
 * group, `=` or `:`). Dotted names are joined into one word: `Sub.Field`.
 */
export function headerWords(s: Statement): Token[] {
  const items = sig(s);
  const h = headerLength(items);
  const out: Token[] = [];
  for (let k = 0; k < h; k++) {
    const t = items[k] as Token;
    if (t.text === '.' && t.kind === 'punct') {
      const prev = out.pop()!;
      const next = items[++k] as Token;
      out.push({ kind: 'ident', text: prev.text + '.' + next.text, start: prev.start });
    } else out.push(t);
  }
  return out;
}

/** True for Deluge-bearing paren groups: `custom deluge script (...)`, `on click (...)`. */
function isRawParenHeader(words: string[]): boolean {
  const w = words.map((x) => x.toLowerCase());
  const last = w[w.length - 1];
  if (last === 'script') return true; // custom deluge script, deluge script
  if (w.length >= 2 && w[w.length - 2] === 'on' && last === 'click') return true;
  return false;
}

const DELUGE_KEYWORDS = new Set(['if', 'for', 'return', 'info', 'openurl', 'sendmail', 'insert', 'delete', 'alert']);

/**
 * Deluge written directly in a brace body (2016 exports, function bodies):
 * statements end in `;` and there is at least one call, member access or
 * Deluge keyword. Declarative bodies (`type = text; ...`) do not qualify.
 */
function looksLikeDeluge(g: Group): boolean {
  let semi = false;
  let code = false;
  for (const c of g.children) {
    if (isPunct(c, ';')) semi = true;
    else if (isPunct(c, '.') || isGroupOf(c, '(')) code = true;
    else if (isToken(c) && c.kind === 'ident' && DELUGE_KEYWORDS.has(c.text.toLowerCase())) code = true;
  }
  return semi && code;
}

/**
 * Events that wrap an `actions { ... }` list: the record events
 * (`on add { actions { ... } }`) and a button's `on click`.
 */
const ACTIONS_EVENT_HEADERS = new Set(['on add', 'on edit', 'on add or edit', 'on delete', 'on click']);

/** Recursively split structured bodies and mark raw ones. */
function structureBody(items: Node[], inRecordEvent = false): Node[] {
  const stmts = splitStatements(items);
  for (const s of stmts) if (isStatement(s)) structureStatement(s, inRecordEvent);
  return stmts;
}

function structureStatement(s: Statement, inRecordEvent = false): void {
  const items = sig(s);
  const eq = items.findIndex((x) => isPunct(x, '='));
  const h = headerLength(items);
  const words = headerWords(s).map(textOf);
  const header = words.join(' ').toLowerCase();
  const inRecord = ACTIONS_EVENT_HEADERS.has(header);
  for (let k = 0; k < items.length; k++) {
    const g = items[k];
    if (!isGroup(g)) continue;
    const inValue = eq >= 0 && eq < k;
    if (g.open.text === '(' && !inValue && h === k && k > 0 && isRawParenHeader(words)) {
      g.raw = true;
      continue;
    }
    if (g.open.text === '{' && !inValue && looksLikeDeluge(g)) {
      // `actions (criteria) { show X; on success ( ... ) }` and the `actions`
      // block directly under a record event are workflow blocks, not a Deluge
      // body. Marking the brace raw drops both the criteria and the body.
      const prev = items[k - 1];
      const criteriaActions = header === 'actions' && isGroup(prev) && prev.open.text === '(';
      const recordActions = inRecordEvent && header === 'actions';
      if (!criteriaActions && !recordActions) {
        g.raw = true; // `void name(args) { ... }`, `on load { input.X = 1; }`
        continue;
      }
    }
    if (inValue) continue; // values stay flat
    if (g.open.text === '(' && isGroupOf(items[k + 1], '{')) continue; // signatures and conditions: `f(args) {`, `actions (cond) {`
    if (g.open.text === '[' && s.kind !== 'group') continue; // criteria and index expressions stay flat
    if (g.open.text === '{' && k === 0) continue; // anonymous blobs (JSON etc.) stay flat
    g.structured = true;
    g.children = structureBody(g.children, inRecord);
  }
}

// ---------------------------------------------------------------------------
// Entry point

export function parseCst(source: string): Document {
  const errors: ParseIssue[] = [];
  const tokens = tokenize(source);
  const flat = buildGroups(tokens, errors);
  const children = structureBody(flat);
  return { type: 'document', source, children, errors };
}

/** Visit every statement in document order, with its ancestor statements. */
export function walkStatements(
  root: Document | Group,
  fn: (s: Statement, ancestors: Statement[]) => void,
  ancestors: Statement[] = [],
): void {
  for (const c of root.children) {
    if (!isStatement(c)) continue;
    fn(c, ancestors);
    for (const g of c.children) if (isGroup(g) && g.structured) walkStatements(g, fn, [...ancestors, c]);
  }
}
