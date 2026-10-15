/**
 * Deluge parser.
 *
 * Never throws to the caller. A statement that cannot be parsed becomes an
 * `unknown` node covering the source through the next statement boundary, so
 * every untranslated construct still has a span.
 *
 * Semicolons are optional. `=` inside brackets is equality (`Status = "Open"`
 * and `Status == "Open"` both occur). `=` outside brackets ends an expression
 * so assignment can see it. `is` / `is not` are null tests.
 */

import type { Expr, MailAttachment, Param, Script, Span, Stmt } from './ast.js';
import { lex, type Token } from './lexer.js';

const PREC: Record<string, number> = {
  '||': 1,
  or: 1,
  '&&': 2,
  and: 2,
  '==': 3,
  '!=': 3,
  '=': 3,
  is: 3,
  'is not': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  in: 4,
  'not in': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

/** sendmail `attachments:` spec item keywords. */
const MAIL_ATTACHMENT_KINDS = new Set(['file', 'view', 'report', 'template']);

/** Two-word param keys in task param blocks (`reply to`, `content type`, `sender type`). */
const TWO_WORD_PARAM_KEYS = new Set(['reply to', 'content type', 'sender type']);

const TYPES = new Set([
  'void',
  'int',
  'string',
  'text',
  'date',
  'float',
  'bool',
  'boolean',
  'bigint',
  'decimal',
  'list',
  'map',
  'collection',
  'object',
  'time',
]);

const CRITERIA_METHODS = new Set([
  'contains',
  'notcontains',
  'startswith',
  'endswith',
  'equals',
  'equalsignorecase',
  'isempty',
  'isnull',
  'isblank',
]);

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

class Fail extends Error {}

interface ExprOpts {
  /** Treat a following `[ ident = … ]` as not part of this expression (update field blocks). */
  stopBeforeFieldBlock?: boolean;
  /**
   * `{key: value}` — the colon is the map separator, not a `field:ui.*` task.
   * https://www.zoho.com/deluge/help/datatypes/map.html
   */
  stopBeforeColon?: boolean;
}

export function parse(src: string): Script {
  const p = new Parser(src, lex(src));
  const body = p.script(false);
  return { body, span: { start: 0, end: src.length } };
}

/**
 * Parse one expression. Unknown input becomes an `unknown` expr rather than throwing.
 * `relative` is for report criteria and for a criteria bracket: multi-word dates
 * (`this month`, `last 7 days`) become one phrase. A free script expression
 * leaves those words as separate tokens.
 */
export function parseExpression(src: string, relative = false): Expr {
  const p = new Parser(src, lex(src), relative);
  try {
    return p.topExpr();
  } catch {
    return { kind: 'unknown', text: src.trim(), reason: 'expr', span: { start: 0, end: src.length } };
  }
}

class Parser {
  private i = 0;

  /**
   * Nesting depth of statements and expressions. Past this the input is
   * pathological (real scripts nest a handful deep); failing into an
   * `unknown` node keeps the no-throw contract instead of overflowing the
   * call stack (fuzz: `'(' * 1500`).
   */
  private static readonly MAX_DEPTH = 200;
  private depth = 0;

  /** Run `fn` one nesting level deeper, failing with `reason` when too deep. */
  private nest<T>(fn: () => T, reason: 'too-deeply-nested'): T {
    if (++this.depth > Parser.MAX_DEPTH) {
      this.depth--;
      this.fail(reason);
    }
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  /** Used by `parseExpression`. */
  topExpr(): Expr {
    return this.expr(0, {});
  }

  constructor(
    private src: string,
    private t: Token[],
    private allowRelative = false,
  ) {}

  private peek(n = 0): Token {
    return this.t[Math.min(this.i + n, this.t.length - 1)]!;
  }

  private get eof(): boolean {
    return this.peek().kind === 'eof';
  }

  private is(kind: Token['kind'], text?: string, n = 0): boolean {
    const tok = this.peek(n);
    return tok.kind === kind && (text === undefined || tok.text === text);
  }

  private eat(kind: Token['kind'], text?: string): Token | undefined {
    if (!this.is(kind, text)) return undefined;
    return this.t[this.i++]!;
  }

  private fail(reason: string): never {
    throw new Fail(reason);
  }

  private span(start: number, end: number): Span {
    return { start, end };
  }

  script(inBlock: boolean): Stmt[] {
    const out: Stmt[] = [];
    while (!this.eof) {
      if (this.is('punct', '}')) {
        if (inBlock) break;
        // stray closer: one unknown token so we always advance
        const tok = this.t[this.i++]!;
        out.push({ kind: 'unknown', text: tok.text, reason: 'stray-closer', span: this.span(tok.start, tok.end) });
        continue;
      }
      if (this.is('punct', ';')) {
        this.i++;
        continue;
      }
      out.push(this.statement());
    }
    return out;
  }

  private statement(): Stmt {
    const startI = this.i;
    try {
      const s = this.nest(() => this.statementInner(), 'too-deeply-nested');
      if (this.i === startI) this.fail('no-progress');
      this.eat('punct', ';');
      return s;
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      return this.recover(startI, e.message);
    }
  }

  private recover(startI: number, reason: string): Stmt {
    this.i = startI;
    const start = this.peek().start;
    let depth = 0;
    while (!this.eof) {
      const tok = this.peek();
      if (depth === 0 && (tok.text === ';' || tok.text === '}')) {
        const end = tok.text === ';' ? tok.end : tok.start;
        if (tok.text === ';') this.i++;
        if (this.i === startI) this.i++;
        const at = Math.max(this.i, startI + 1);
        this.i = Math.max(this.i, at);
        const endTok = this.t[this.i - 1]!;
        return {
          kind: 'unknown',
          text: this.src.slice(start, end),
          reason,
          span: this.span(start, end || endTok.end),
        };
      }
      if (tok.text === '{' || tok.text === '(' || tok.text === '[') depth++;
      else if (tok.text === '}' || tok.text === ')' || tok.text === ']') depth = Math.max(0, depth - 1);
      this.i++;
    }
    if (this.i === startI) this.i++;
    const end = this.peek().start;
    return { kind: 'unknown', text: this.src.slice(start, end), reason, span: this.span(start, end) };
  }

  private statementInner(): Stmt {
    if (this.is('punct', '{')) return this.block();
    if (this.is('ident', 'if')) return this.ifStmt();
    if (this.is('ident', 'for')) return this.forStmt();
    if (this.is('ident', 'while')) return this.whileStmt();
    if (this.is('ident', 'try')) return this.tryStmt();
    if (this.is('ident', 'return')) return this.returnStmt();
    if (this.is('ident', 'break')) return this.wordStmt('break');
    if (this.is('ident', 'continue')) return this.wordStmt('continue');
    if (this.is('ident', 'info') && this.startsExpr(1)) return this.valueTask('info');
    if (this.is('ident', 'alert') && this.startsExpr(1)) return this.valueTask('alert');
    if (this.is('ident', 'cancel')) return this.cancelStmt();
    if (this.is('ident', 'success') && this.is('ident', 'message', 1)) return this.successMessageStmt();
    if (this.is('ident', 'reload')) return this.wordStmt('reload');
    // Deluge names are case-insensitive: `openURL(...)` is the openUrl task.
    if (this.is('ident') && this.peek().text.toLowerCase() === 'openurl' && this.is('punct', '(', 1)) return this.openUrlStmt();
    if (
      (this.is('ident', 'show') || this.is('ident', 'hide') || this.is('ident', 'enable') || this.is('ident', 'disable') || this.is('ident', 'clear')) &&
      !(this.peek(1).kind === 'op' && ASSIGN_OPS.has(this.peek(1).text)) &&
      this.peek(1).text !== '.'
    ) {
      return this.uiStmt();
    }
    if (this.is('ident', 'delete') && this.startsExpr(1)) return this.deleteStmt();
    if (this.is('ident', 'update') && this.is('ident', undefined, 1)) return this.updateStmt();
    // `actions { … }` inside a workflow event is a container keyword, not a name.
    if (this.is('ident', 'actions') && this.is('punct', '{', 1)) {
      this.eat('ident', 'actions');
      return this.block();
    }
    if (this.is('ident') && this.peek().text.toLowerCase() === 'function' && this.is('ident', undefined, 1) && this.is('punct', '(', 2)) return this.functionStmt();
    if (this.looksLikeFunction()) return this.functionStmt();
    return this.assignOrExpr();
  }

  private block(): Stmt {
    const open = this.eat('punct', '{') ?? this.fail('block');
    const body = this.script(true);
    const close = this.eat('punct', '}') ?? this.fail('block-end');
    return { kind: 'block', body, span: this.span(open.start, close.end) };
  }

  private body(): Stmt {
    if (this.is('punct', '{')) return this.block();
    return this.statement();
  }

  private ifStmt(): Stmt {
    const start = this.peek().start;
    this.eat('ident', 'if');
    // expression-if used where a statement was expected: if(c, a, b)
    if (this.is('punct', '(') && this.parenHasComma()) {
      const expr = this.ifExpr(start, true);
      this.eat('punct', ';');
      return this.exprStmt(expr, start);
    }
    const test = this.parenExpr();
    const then = this.body();
    const elifs: { test: Expr; body: Stmt }[] = [];
    let els: Stmt | undefined;
    while (this.is('ident', 'else') || this.is('ident', 'elseif')) {
      if (this.is('ident', 'elseif') || (this.is('ident', 'else') && this.is('ident', 'if', 1))) {
        this.eat('ident');
        if (this.is('ident', 'if')) this.eat('ident', 'if');
        elifs.push({ test: this.parenExpr(), body: this.body() });
        continue;
      }
      this.eat('ident', 'else');
      els = this.body();
      break;
    }
    const end = (els ?? elifs[elifs.length - 1]?.body ?? then).span.end;
    return { kind: 'if', test, then, elifs, ...(els ? { else: els } : {}), span: this.span(start, end) };
  }

  /** True when the `(...)` at `at` has a top-level comma (the 2- or 3-arg `if`). */
  private parenHasComma(at = this.i): boolean {
    if (this.t[at]?.text !== '(') return false;
    let depth = 0;
    for (let k = at; k < this.t.length; k++) {
      const tok = this.t[k]!;
      // `[`/`{` count too — `if(x in {"a","b"})` is a statement-if, not `if(t, a, b)`.
      if (tok.text === '(' || tok.text === '[' || tok.text === '{') depth++;
      else if (tok.text === ')' || tok.text === ']' || tok.text === '}') {
        depth--;
        if (depth === 0) return false;
      } else if (tok.text === ',' && depth === 1) return true;
      if (tok.kind === 'eof') return false;
    }
    return false;
  }

  private forStmt(): Stmt {
    const start = this.peek().start;
    this.eat('ident', 'for');
    if (!this.eat('ident', 'each')) this.fail('for-each');
    let index: string | undefined;
    // `for each index i item in coll` — i is the index, item the element; the
    // documented `for each index i in coll` binds a single 0-based index variable
    // (deluge-docs/pages/list-manipulations__for-each-index.html).
    if (this.is('ident', 'index') && this.is('ident', undefined, 1) && this.peek(1).text !== 'in') {
      this.i++;
      const first = this.expectIdent();
      if (this.eat('ident', 'in')) {
        const collection = this.expr(0, {});
        const body = this.body();
        return { kind: 'forEach', name: first, iteratesIndex: true, collection, body, span: this.span(start, body.span.end) };
      }
      index = first;
    }
    const name = this.expectIdent();
    if (!this.eat('ident', 'in')) this.fail('for-in');
    const collection = this.expr(0, {});
    const body = this.body();
    return {
      kind: 'forEach',
      ...(index ? { index } : {}),
      name,
      collection,
      body,
      span: this.span(start, body.span.end),
    };
  }

  private whileStmt(): Stmt {
    const start = this.peek().start;
    this.eat('ident', 'while');
    const test = this.parenExpr();
    const body = this.body();
    return { kind: 'while', test, body, span: this.span(start, body.span.end) };
  }

  private tryStmt(): Stmt {
    const start = this.peek().start;
    this.eat('ident', 'try');
    const body = this.body();
    let catchName: string | undefined;
    let catchBody: Stmt | undefined;
    if (this.eat('ident', 'catch')) {
      if (this.eat('punct', '(')) {
        catchName = this.expectIdent();
        if (!this.eat('punct', ')')) this.fail('catch');
      }
      catchBody = this.body();
    }
    const end = (catchBody ?? body).span.end;
    return { kind: 'try', body, ...(catchName ? { catchName } : {}), ...(catchBody ? { catchBody } : {}), span: this.span(start, end) };
  }

  private returnStmt(): Stmt {
    const startTok = this.eat('ident', 'return') ?? this.fail('return');
    const returningIfExpr = this.is('ident', 'if') && this.parenHasComma(this.i + 1);
    if (!returningIfExpr && (this.is('punct', ';') || this.is('punct', '}') || this.eof || this.startsStatement())) {
      return { kind: 'return', span: this.span(startTok.start, startTok.end) };
    }
    const value = this.expr(0, {});
    return { kind: 'return', value, span: this.span(startTok.start, value.span.end) };
  }

  private wordStmt(kind: 'break' | 'continue' | 'reload'): Stmt {
    const tok = this.eat('ident') ?? this.fail(kind);
    if (kind === 'reload') return { kind: 'reload', span: this.span(tok.start, tok.end) };
    return { kind, span: this.span(tok.start, tok.end) };
  }

  private valueTask(kind: 'info' | 'alert'): Stmt {
    const tok = this.eat('ident') ?? this.fail(kind);
    const value = this.argOrExpr();
    return { kind, value, span: this.span(tok.start, value.span.end) };
  }

  private cancelStmt(): Stmt {
    const tok = this.eat('ident', 'cancel') ?? this.fail('cancel');
    if (this.is('ident', 'delete')) {
      const del = this.eat('ident', 'delete') ?? this.fail('cancel-delete');
      return { kind: 'cancelDelete', span: this.span(tok.start, del.end) };
    }
    const sub = this.eat('ident', 'submit') ?? this.fail('cancel-submit');
    return { kind: 'cancelSubmit', span: this.span(tok.start, sub.end) };
  }

  private successMessageStmt(): Stmt {
    const tok = this.eat('ident', 'success') ?? this.fail('success');
    this.eat('ident', 'message') ?? this.fail('success-message');
    const value = this.argOrExpr();
    return { kind: 'successMessage', value, span: this.span(tok.start, value.span.end) };
  }

  private openUrlStmt(): Stmt {
    const tok = this.eat('ident') ?? this.fail('openUrl');
    if (!this.eat('punct', '(')) this.fail('openUrl');
    const args = this.argList();
    const end = args.length ? args[args.length - 1]!.span.end : tok.end;
    return { kind: 'openUrl', args, span: this.span(tok.start, end) };
  }

  private uiStmt(): Stmt {
    const tok = this.eat('ident') ?? this.fail('ui');
    const action = tok.text as 'show' | 'hide' | 'enable' | 'disable' | 'clear';
    const targets: Expr[] = [];
    if (!this.is('punct', ';') && !this.is('punct', '}') && !this.eof && !this.startsStatement()) {
      targets.push(this.expr(0, { stopBeforeFieldBlock: true }));
      while (this.eat('punct', ',')) targets.push(this.expr(0, { stopBeforeFieldBlock: true }));
    }
    const end = targets.length ? targets[targets.length - 1]!.span.end : tok.end;
    return { kind: 'ui', action, targets, span: this.span(tok.start, end) };
  }

  private deleteStmt(): Stmt {
    const tok = this.eat('ident', 'delete') ?? this.fail('delete');
    this.eat('ident', 'from');
    const target = this.expr(0, {});
    return { kind: 'deleteFrom', target, span: this.span(tok.start, target.span.end) };
  }

  private updateStmt(): Stmt {
    const tok = this.eat('ident', 'update') ?? this.fail('update');
    const formName = this.dottedIdent();
    const formStart = tok.end;
    let target: Expr = { kind: 'name', name: formName, span: this.span(formStart, this.prevEnd()) };
    if (this.is('punct', '[') && this.bracketIsCriteria()) {
      target = this.criteriaBracket(target);
      this.attachSortRange(target);
    }
    if (!this.is('punct', '[') && !this.is('punct', '(')) this.fail('update-fields');
    const entries = this.paramBlock();
    const end = entries.length ? entries[entries.length - 1]!.span.end : target.span.end;
    return { kind: 'update', target, entries, span: this.span(tok.start, end) };
  }

  /** The `[...]` after `update Form` is criteria when another field block follows, or when it is not a pure assignment list. */
  private bracketIsCriteria(): boolean {
    const end = this.matchBracket(this.i);
    if (end < 0) return true;
    const after = this.t[end + 1];
    if (after && (after.text === '[' || after.text === '(')) return true;
    // A single bracket of `Field = value` pairs is the field block (no separate criteria).
    return !this.looksLikeParam(this.i);
  }

  private matchBracket(openAt: number): number {
    const open = this.t[openAt]?.text;
    const close = open === '[' ? ']' : open === '(' ? ')' : open === '{' ? '}' : '';
    if (!close) return -1;
    let depth = 0;
    for (let k = openAt; k < this.t.length; k++) {
      const tok = this.t[k]!;
      if (tok.text === open) depth++;
      else if (tok.text === close) {
        depth--;
        if (depth === 0) return k;
      }
      if (tok.kind === 'eof') return -1;
    }
    return -1;
  }

  private looksLikeParam(bracketAt: number): boolean {
    const a = this.t[bracketAt + 1];
    if (!a || a.kind !== 'ident') return false;
    // dotted or hyphenated key
    let k = bracketAt + 1;
    while (this.t[k]?.kind === 'ident' && (this.t[k + 1]?.text === '.' || this.t[k + 1]?.text === '-') && this.t[k + 2]?.kind === 'ident') k += 2;
    const sep = this.t[k + 1];
    return sep?.text === '=' || sep?.text === ':';
  }

  private looksLikeFunction(): boolean {
    // <type> [<ns>.]*<name> ( ... ) — type names are case-insensitive
    // (`String`, `Int`, `Map`; deluge-docs call_function examples use them) and
    // the function may be namespace-qualified (`automation.fn`, `thisapp.f`).
    const first = this.peek();
    if (first.kind !== 'ident' || !TYPES.has(first.text.toLowerCase())) return false;
    let k = this.i + 1;
    if (this.t[k]?.kind !== 'ident' || TYPES.has(this.t[k]!.text.toLowerCase())) return false;
    k++;
    while (this.t[k]?.kind === 'punct' && this.t[k]?.text === '.' && this.t[k + 1]?.kind === 'ident') k += 2;
    return this.t[k]?.kind === 'punct' && this.t[k]?.text === '(';
  }

  private functionStmt(): Stmt {
    const start = this.peek().start;
    // `function name(...) { ... }` — Cliq/SalesIQ dialect seen in the corpus.
    const kw = this.peek().text.toLowerCase() === 'function';
    if (kw) this.i++;
    const retType = kw ? undefined : this.expectIdent();
    const name = this.dottedIdent();
    if (!this.eat('punct', '(')) this.fail('fn');
    const params: { type?: string; name: string }[] = [];
    if (!this.is('punct', ')')) {
      do {
        if (this.is('punct', ')')) break;
        const a = this.expectIdent();
        if (this.is('ident')) params.push({ type: a, name: this.expectIdent() });
        else params.push({ name: a });
      } while (this.eat('punct', ','));
    }
    if (!this.eat('punct', ')')) this.fail('fn');
    // Real declarations have a `{…}` body; `Type f(…);` prototypes (Java etc.) stay unknown.
    if (!this.is('punct', '{')) this.fail('fn-body');
    const body = this.body();
    return { kind: 'fn', ...(retType ? { retType } : {}), name, params, body, span: this.span(start, body.span.end) };
  }

  private assignOrExpr(): Stmt {
    const startI = this.i;
    const start = this.peek().start;
    let declType: string | undefined;
    if (this.is('ident') && TYPES.has(this.peek().text.toLowerCase()) && this.is('ident', undefined, 1) && !this.is('punct', '(', 2)) {
      declType = this.expectIdent();
    }
    const target = this.expr(0, { stopBeforeFieldBlock: true });
    const op = this.peek();
    if (op.kind === 'op' && ASSIGN_OPS.has(op.text) && this.assignable(target)) {
      this.i++;
      const value = this.expr(0, {});
      return { kind: 'assign', ...(declType ? { declType } : {}), op: op.text, target, value, span: this.span(start, value.span.end) };
    }
    if (declType) this.fail('decl');
    // A following statement keyword means we only consumed a name; if that name
    // is not a call, keep it as an expression statement (the caller loops).
    if (this.i === startI) this.fail('empty');
    // `shareTo unknownThing` is one unrecognised task, not two expression statements.
    if ((target.kind === 'name' || target.kind === 'member') && this.is('ident') && !this.startsStatement()) {
      this.fail('task');
    }
    return this.exprStmt(target, start);
  }

  /**
   * A statement-position expression with no side effect is pseudo-code, not
   * Deluge (`SELECT * FROM users;` reads as `SELECT * FROM` + `users`) — flag
   * it as unknown so it surfaces as untranslated instead of silently emitting
   * a discarded JS expression.
   */
  private exprStmt(expr: Expr, start: number): Stmt {
    if (expr.kind === 'unknown') return { kind: 'unknown', text: expr.text, reason: expr.reason, span: expr.span };
    if (this.hasEffect(expr)) return { kind: 'expr', expr, span: expr.span };
    return { kind: 'unknown', text: this.src.slice(start, expr.span.end), reason: 'no-effect', span: expr.span };
  }

  /** True when evaluating `e` could do something — a call or a task expression. */
  private hasEffect(e: Expr): boolean {
    switch (e.kind) {
      case 'call':
      case 'insert':
      case 'invokeurl':
      case 'sendmail':
      case 'pushnotification':
      case 'colonCall':
        return true;
      case 'list':
        return e.elements.some((el) => this.hasEffect(el));
      case 'map':
        return e.entries.some((en) => this.hasEffect(en.key) || this.hasEffect(en.value));
      case 'unary':
        return this.hasEffect(e.expr);
      case 'binary':
        return this.hasEffect(e.left) || this.hasEffect(e.right);
      case 'member':
        return this.hasEffect(e.object);
      case 'index':
        return this.hasEffect(e.object) || this.hasEffect(e.index);
      case 'criteria':
        return this.hasEffect(e.object);
      case 'paren':
        return this.hasEffect(e.expr);
      case 'ifExpr':
        return this.hasEffect(e.test) || this.hasEffect(e.then) || (!!e.else && this.hasEffect(e.else));
      default:
        return false;
    }
  }

  private assignable(e: Expr): boolean {
    return e.kind === 'name' || e.kind === 'member' || e.kind === 'index';
  }

  private startsStatement(): boolean {
    const t = this.peek();
    if (t.kind !== 'ident') return false;
    return (
      t.text === 'if' ||
      t.text === 'for' ||
      t.text === 'while' ||
      t.text === 'try' ||
      t.text === 'return' ||
      t.text === 'else' ||
      t.text === 'elseif' ||
      (t.text === 'cancel' && (this.is('ident', 'submit', 1) || this.is('ident', 'delete', 1))) ||
      (t.text === 'success' && this.is('ident', 'message', 1))
    );
  }

  /** Can the token at `n` begin an expression? Keeps `update`/`delete`/`info` usable as variable names (`update = Map()`). */
  private startsExpr(n = 0): boolean {
    const t = this.peek(n);
    return (
      t.kind === 'ident' ||
      t.kind === 'number' ||
      t.kind === 'string' ||
      t.kind === 'date' ||
      (t.kind === 'punct' && (t.text === '(' || t.text === '{')) ||
      (t.kind === 'op' && (t.text === '!' || t.text === '-'))
    );
  }

  private parenExpr(): Expr {
    if (!this.eat('punct', '(')) this.fail('paren');
    const e = this.exprEq();
    if (!this.eat('punct', ')')) this.fail('paren-end');
    return e;
  }

  private argOrExpr(): Expr {
    if (this.is('punct', '(')) {
      const start = this.peek().start;
      this.i++;
      const args = this.argList();
      if (args.length === 1) return args[0]!;
      // alert() with several args: keep as a list-like paren chain via binary? wrap as list
      return { kind: 'list', elements: args, span: this.span(start, this.prevEnd()) };
    }
    return this.expr(0, {});
  }

  expr(min: number, opts: ExprOpts): Expr {
    return this.nest(() => this.binary(min, opts), 'too-deeply-nested');
  }

  private binary(min: number, opts: ExprOpts): Expr {
    let left = this.unary(opts);
    for (;;) {
      const op = this.infix(opts);
      if (!op || op.prec < min) break;
      this.i++;
      let text = op.text;
      if (text === 'is' && this.is('ident', 'not')) {
        this.i++;
        text = 'is not';
      }
      if (text === 'not' && this.is('ident', 'in')) {
        this.i++;
        text = 'not in';
      }
      const right = this.expr(op.prec + 1, opts);
      left = { kind: 'binary', op: text, left, right, span: this.span(left.span.start, right.span.end) };
    }
    return left;
  }

  private infix(opts: ExprOpts): { text: string; prec: number } | null {
    const t = this.peek();
    if (t.kind === 'op') {
      if (t.text === '=' && !this.eqOk(opts)) return null;
      if (ASSIGN_OPS.has(t.text) && t.text !== '=') return null;
      const prec = PREC[t.text];
      if (prec === undefined) return null;
      return { text: t.text, prec };
    }
    if (t.kind === 'ident' && (t.text === 'in' || t.text === 'and' || t.text === 'or' || t.text === 'is' || (t.text === 'not' && this.is('ident', 'in', 1)))) {
      const prec = PREC[t.text === 'not' ? 'in' : t.text]!;
      return { text: t.text, prec };
    }
    return null;
  }

  /** `=` is equality inside criteria brackets and parenthesised contexts (`if (x = "y")`), which set this via exprEq. */
  private eqMode = false;
  private eqOk(_opts: ExprOpts): boolean {
    return this.eqMode;
  }

  /** Parse an expression where a single `=` is equality (inside `(…)`/`[…]`). */
  private exprEq(): Expr {
    const prev = this.eqMode;
    this.eqMode = true;
    try {
      return this.expr(0, {});
    } finally {
      this.eqMode = prev;
    }
  }

  private unary(opts: ExprOpts): Expr {
    // Iterative: the recursive form overflowed the call stack on long prefix
    // runs (fuzz: `'!' * 5000`). Collect the prefixes, parse one operand, fold.
    const ops: Token[] = [];
    while (this.is('op', '!') || this.is('op', '-') || this.is('ident', 'not')) ops.push(this.t[this.i++]!);
    let out = this.postfix(this.primary(), opts);
    for (let k = ops.length - 1; k >= 0; k--) {
      const tok = ops[k]!;
      out = { kind: 'unary', op: tok.text, expr: out, span: this.span(tok.start, out.span.end) };
    }
    return out;
  }

  /**
   * A criteria bracket accepts `this week` as one phrase. A free expression does not,
   * so `if (Due is this week)` stays separate tokens.
   */
  private exprCriteria(): Expr {
    const prev = this.allowRelative;
    this.allowRelative = true;
    try {
      return this.exprEq();
    } finally {
      this.allowRelative = prev;
    }
  }

  /** `this month`, `last 7 days`, `3 weeks ago`. Only when a criteria asked for it. */
  private relativePhrase(): Expr | null {
    const unitOf = (token: Token): string | null => {
      if (token.kind !== 'ident') return null;
      switch (token.text.toLowerCase()) {
        case 'day':
        case 'days':
          return 'days';
        case 'week':
        case 'weeks':
          return 'weeks';
        case 'month':
        case 'months':
          return 'months';
        case 'year':
        case 'years':
          return 'years';
        default:
          return null;
      }
    };
    const natural = (token: Token): string | null => (token.kind === 'number' && /^[1-9]\d*$/.test(token.text) ? token.text : null);
    const t0 = this.peek(0);
    const start = t0.start;
    if (t0.kind === 'number') {
      const n = natural(t0);
      const unit = n ? unitOf(this.peek(1)) : null;
      if (n && unit && this.peek(2).kind === 'ident' && this.peek(2).text.toLowerCase() === 'ago') {
        this.i += 3;
        return { kind: 'relative', spec: `${n} ${unit} ago`, span: this.span(start, this.prevEnd()) };
      }
      return null;
    }
    if (t0.kind !== 'ident') return null;
    const head = t0.text.toLowerCase();
    if (head !== 'this' && head !== 'last' && head !== 'next') return null;
    const second = this.peek(1);
    const period = second.kind === 'ident' ? second.text.toLowerCase() : '';
    if (period === 'week' || period === 'month' || period === 'year') {
      this.i += 2;
      return { kind: 'relative', spec: `${head} ${period}`, span: this.span(start, this.prevEnd()) };
    }
    if (head === 'last' || head === 'next') {
      const n = natural(second);
      const unit = n ? unitOf(this.peek(2)) : null;
      if (n && unit) {
        this.i += 3;
        return { kind: 'relative', spec: `${head} ${n} ${unit}`, span: this.span(start, this.prevEnd()) };
      }
    }
    return null;
  }

  private primary(): Expr {
    if (this.allowRelative) {
      const rel = this.relativePhrase();
      if (rel) return rel;
    }
    const t = this.peek();
    if (t.kind === 'number') {
      this.i++;
      return { kind: 'number', text: t.text, span: this.span(t.start, t.end) };
    }
    if (t.kind === 'string') {
      this.i++;
      return { kind: 'string', value: t.value ?? '', span: this.span(t.start, t.end) };
    }
    if (t.kind === 'date') {
      this.i++;
      return { kind: 'date', value: t.value ?? t.text, span: this.span(t.start, t.end) };
    }
    if (t.kind === 'ident') {
      if (t.text === 'if') return this.ifExpr(t.start);
      const taskWord = t.text.toLowerCase();
      if (taskWord === 'insert' && this.is('ident', undefined, 1)) return this.insertExpr();
      // invokeUrl/sendMail casing varies in the wild; a following `[`/`(` keeps
      // `invokeurl`/`sendmail` usable as variable names.
      if (taskWord === 'invokeurl' && (this.is('punct', '[', 1) || this.is('punct', '(', 1))) return this.invokeExpr();
      if (taskWord === 'sendmail' && (this.is('punct', '[', 1) || this.is('punct', '(', 1))) return this.sendmailExpr();
      if (taskWord === 'pushnotification' && (this.is('punct', '[', 1) || this.is('punct', '(', 1))) return this.pushnotificationExpr();
      const name = t.text;
      const start = t.start;
      this.i++;
      if ((name === 'List' || name === 'Map' || name === 'Collection') && this.is('punct', ':')) {
        this.i++;
        const typeArg = this.dottedIdent();
        if (!this.eat('punct', '(')) this.fail('typed-list');
        const args = this.argList();
        const end = this.prevEnd();
        return {
          kind: 'call',
          callee: { kind: 'name', name, span: this.span(start, start + name.length) },
          args,
          typeArgs: [typeArg],
          span: this.span(start, end),
        };
      }
      return { kind: 'name', name, span: this.span(start, t.end) };
    }
    if (t.text === '(') {
      this.i++;
      const inner = this.exprEq();
      const close = this.eat('punct', ')') ?? this.fail('paren');
      return { kind: 'paren', expr: inner, span: this.span(t.start, close.end) };
    }
    if (t.text === '{') return this.braceLiteral();
    this.fail('primary');
  }

  private ifExpr(start: number, alreadyAte = false): Expr {
    if (!alreadyAte) this.eat('ident', 'if');
    if (!this.eat('punct', '(')) this.fail('if-expr');
    const test = this.exprEq();
    if (!this.eat('punct', ',')) this.fail('if-expr');
    const then = this.expr(0, {});
    let els: Expr | undefined;
    if (this.eat('punct', ',')) els = this.expr(0, {});
    const close = this.eat('punct', ')') ?? this.fail('if-expr');
    return { kind: 'ifExpr', test, then, ...(els ? { else: els } : {}), span: this.span(start, close.end) };
  }

  private insertExpr(): Expr {
    const tok = this.eat('ident', 'insert') ?? this.fail('insert');
    this.eat('ident', 'into');
    const formName = this.dottedIdent();
    const form: Expr = { kind: 'name', name: formName, span: this.span(tok.end, this.prevEnd()) };
    const entries = this.paramBlock();
    const end = this.prevEnd();
    return { kind: 'insert', form, entries, span: this.span(tok.start, end) };
  }

  private invokeExpr(): Expr {
    const tok = this.t[this.i++]!; // caller verified the `invokeurl` keyword (any case)
    let entries: Param[];
    if (this.is('punct', '(') && this.is('punct', '[', 1)) {
      // `invokeurl( [k: v] )` — a param block wrapped in parens
      this.i++;
      entries = this.paramBlock();
      if (!this.eat('punct', ')')) this.fail('invokeurl');
    } else if (this.is('punct', '(') && !this.looksLikeParam(this.i)) {
      // positional `invokeUrl(url, type, [body], [headerMap], [boolean])`
      // (deluge-docs/pages/web-data__invokeurl-function.html). A map-shaped
      // third argument is request parameters; anything else is a raw body.
      this.i++;
      const args: Expr[] = [];
      if (!this.is('punct', ')')) {
        args.push(this.exprEq());
        while (this.eat('punct', ',')) args.push(this.exprEq());
      }
      if (!this.eat('punct', ')')) this.fail('invokeurl');
      const keys = ['url', 'type', 'parameters', 'headers', 'simple'];
      entries = args.map((value, ix) => ({
        key: ix === 2 && value.kind !== 'map' && value.kind !== 'list' && value.kind !== 'name' ? 'body' : (keys[ix] ?? `arg${ix}`),
        value,
        span: value.span,
      }));
    } else {
      entries = this.paramBlock();
    }
    return { kind: 'invokeurl', entries, span: this.span(tok.start, this.prevEnd()) };
  }

  private sendmailExpr(): Expr {
    const tok = this.t[this.i++]!; // caller verified `sendmail` + `[`/`(`
    const entries = this.mailParamBlock();
    return { kind: 'sendmail', entries, span: this.span(tok.start, this.prevEnd()) };
  }

  private pushnotificationExpr(): Expr {
    const tok = this.t[this.i++]!; // caller verified `pushnotification` + `[`/`(`
    const entries = this.mailParamBlock();
    return { kind: 'pushnotification', entries, span: this.span(tok.start, this.prevEnd()) };
  }

  /**
   * sendmail params differ from the insert/invokeurl block
   * (https://www.zoho.com/deluge/help/misc-statements/send-mail.html):
   * `reply to` and `content type` are two-word keys, `to`/`cc`/`bcc`/
   * `reply to` take comma-separated addresses, and `attachments` is a typed
   * spec list (`file:`, `view:`/`report:` `as PDF`, `template:` `as inline`).
   */
  private mailParamBlock(): Param[] {
    const open = this.peek();
    if (open.text !== '[' && open.text !== '(') this.fail('param');
    this.i++;
    const close = open.text === '[' ? ']' : ')';
    const entries: Param[] = [];
    while (!this.eof && !this.is('punct', close)) {
      if (this.is('punct', ',') || this.is('punct', ';')) {
        this.i++;
        continue;
      }
      const ks = this.peek().start;
      const key = this.mailKey();
      if (!this.is('op', '=') && !this.is('punct', ':')) this.fail('param-sep');
      this.i++;
      const value = /^attachments?$/i.test(key) ? this.mailAttachments() : this.mailValueList();
      entries.push({ key, value, span: this.span(ks, value.span.end) });
    }
    if (!this.eat('punct', close)) this.fail('param-end');
    return entries;
  }

  private mailKey(): string {
    const a = this.peek().text.toLowerCase();
    const b = this.peek(1).text.toLowerCase();
    if (this.is('ident') && this.is('ident', undefined, 1) && TWO_WORD_PARAM_KEYS.has(`${a} ${b}`)) {
      const first = this.expectIdent();
      const second = this.expectIdent();
      return `${first} ${second}`;
    }
    return this.paramKey();
  }

  /** `key: a, b, c` — commas continue the value unless a `key :`/`key =` follows. */
  private mailValueList(): Expr {
    const elements = [this.expr(0, {})];
    while (this.is('punct', ',') && !this.paramAhead(this.i + 1)) {
      this.i++;
      elements.push(this.expr(0, {}));
    }
    const first = elements[0]!;
    if (elements.length === 1) return first;
    return { kind: 'list', elements, span: this.span(first.span.start, elements[elements.length - 1]!.span.end) };
  }

  /** True when the token at `pos` begins another `key : value` entry. */
  private paramAhead(pos: number): boolean {
    const isSep = (p: number): boolean =>
      (this.t[p]?.kind === 'punct' && this.t[p]?.text === ':') || (this.t[p]?.kind === 'op' && this.t[p]?.text === '=');
    const a = this.t[pos];
    if (a?.kind !== 'ident') return false;
    const b = this.t[pos + 1];
    // two-word keys: `reply to :`, `content type :`, `sender type :`
    if (b?.kind === 'ident' && TWO_WORD_PARAM_KEYS.has(`${a.text.toLowerCase()} ${b.text.toLowerCase()}`)) {
      if (isSep(pos + 2)) return true;
    }
    let p = pos + 1;
    while ((this.t[p]?.text === '.' || this.t[p]?.text === '-') && this.t[p + 1]?.kind === 'ident') p += 2;
    return isSep(p);
  }

  /** True when the token at `pos` begins another `file:`/`view:`/`report:`/`template:` item. */
  private attachmentAhead(pos: number): boolean {
    const kw = this.t[pos];
    return kw?.kind === 'ident' && MAIL_ATTACHMENT_KINDS.has(kw.text.toLowerCase()) && this.t[pos + 1]?.kind === 'punct' && this.t[pos + 1]?.text === ':';
  }

  private mailAttachments(): Expr {
    const start = this.peek().start;
    const items: MailAttachment[] = [];
    for (;;) {
      const kw = this.peek();
      const kind = kw.kind === 'ident' ? kw.text.toLowerCase() : '';
      if (!MAIL_ATTACHMENT_KINDS.has(kind)) this.fail('mail-attachment');
      this.i++;
      if (!this.eat('punct', ':')) this.fail('mail-attachment');
      if (kind === 'file') {
        const value = this.expr(0, {});
        items.push({ type: 'file', value, span: this.span(kw.start, value.span.end) });
      } else if (kind === 'view' || kind === 'report') {
        const name = this.dottedIdent();
        let criteria: Expr | null = null;
        if (kind === 'view' && this.is('punct', '[')) criteria = this.mailCriteria();
        const format = this.asFormat();
        items.push({ type: kind, name, criteria, format, span: this.span(kw.start, this.prevEnd()) });
      } else {
        // `template: T as pdf|inline` (form workflow) or `template: T: Form recId as fmt` (custom function)
        const name = this.dottedIdent();
        let form: string | null = null;
        let record: Expr | null = null;
        if (this.eat('punct', ':')) {
          form = this.dottedIdent();
          record = this.expr(0, {});
        }
        const format = this.asFormat();
        items.push({ type: 'template', name, form, record, format, span: this.span(kw.start, this.prevEnd()) });
      }
      if (this.is('punct', ',') && this.attachmentAhead(this.i + 1)) {
        this.i++;
        continue;
      }
      break;
    }
    return { kind: 'mailAttachments', items, span: this.span(start, this.prevEnd()) };
  }

  private mailCriteria(): Expr {
    this.i++; // caller checked `[`
    const inner = this.exprCriteria();
    this.eat('punct', ']') ?? this.fail('criteria-end');
    return inner;
  }

  /** `as <format>` — pdf, inline, xls, tsv, csv (case-insensitive). */
  private asFormat(): string {
    if (this.peek().text.toLowerCase() !== 'as') this.fail('mail-attachment-as');
    this.i++;
    return this.expectIdent().toLowerCase();
  }

  private paramBlock(): Param[] {
    const open = this.peek();
    if (open.text !== '[' && open.text !== '(') this.fail('param');
    this.i++;
    const close = open.text === '[' ? ']' : ')';
    const entries: Param[] = [];
    while (!this.eof && !this.is('punct', close)) {
      if (this.is('punct', ',') || this.is('punct', ';')) {
        this.i++;
        continue;
      }
      const ks = this.peek().start;
      const key = this.paramKey();
      if (!this.is('op', '=') && !this.is('punct', ':')) this.fail('param-sep');
      this.i++;
      const value = this.expr(0, {});
      entries.push({ key, value, span: this.span(ks, value.span.end) });
    }
    if (!this.eat('punct', close)) this.fail('param-end');
    return entries;
  }

  /** Param key: `a`, `a.b`, or a hyphenated `response-format`/`content-type` (invokeurl task syntax). */
  private paramKey(): string {
    let name = this.expectIdent();
    while ((this.is('punct', '.') || this.is('op', '-')) && this.is('ident', undefined, 1)) {
      name += this.t[this.i++]!.text + this.expectIdent();
    }
    return name;
  }

  private braceLiteral(): Expr {
    const open = this.eat('punct', '{') ?? this.fail('brace');
    if (this.eat('punct', '}')) return { kind: 'list', elements: [], span: this.span(open.start, this.prevEnd()) };
    // Keys stop before `:`. Otherwise `"rate":pc.List_Price` is read as a colon-call
    // (`:` + ident + `.`) and the statement is dropped. Field tasks stay `field:ui.method()`
    // outside a map (https://www.zoho.com/deluge/help/datatypes/map.html).
    const keyOpts: ExprOpts = { stopBeforeColon: true };
    const first = this.expr(0, keyOpts);
    if (this.is('punct', ':')) {
      const entries: { key: Expr; value: Expr }[] = [];
      this.i++;
      entries.push({ key: first, value: this.expr(0, {}) });
      while (this.eat('punct', ',') || (this.is('punct') === false && this.braceContinues())) {
        if (this.is('punct', '}')) break;
        // comma already eaten, or newline-separated
        if (this.is('punct', ',')) this.i++;
        if (this.is('punct', '}')) break;
        const key = this.expr(0, keyOpts);
        if (!this.eat('punct', ':')) this.fail('map');
        entries.push({ key, value: this.expr(0, {}) });
      }
      const close = this.eat('punct', '}') ?? this.fail('map-end');
      return { kind: 'map', entries, span: this.span(open.start, close.end) };
    }
    const elements = [first];
    while (this.eat('punct', ',')) {
      if (this.is('punct', '}')) break;
      elements.push(this.expr(0, {}));
    }
    const close = this.eat('punct', '}') ?? this.fail('list-end');
    return { kind: 'list', elements, span: this.span(open.start, close.end) };
  }

  private braceContinues(): boolean {
    // newline then a value before `}` — only used after a map entry when the comma was omitted
    return false;
  }

  private postfix(expr: Expr, opts: ExprOpts): Expr {
    for (;;) {
      if (this.is('punct', '(')) {
        const open = this.peek();
        this.i++;
        const args = this.argList();
        expr = { kind: 'call', callee: expr, args, span: this.span(expr.span.start, Math.max(this.prevEnd(), open.end)) };
        continue;
      }
      if (this.is('punct', '.')) {
        this.i++;
        const prop = this.expectIdent();
        expr = { kind: 'member', object: expr, property: prop, span: this.span(expr.span.start, this.prevEnd()) };
        continue;
      }
      if (this.is('punct', '[')) {
        if (opts.stopBeforeFieldBlock && this.looksLikeParam(this.i)) break;
        this.i++;
        if (this.is('punct', ']')) {
          const close = this.t[this.i++]!;
          const criteria: Expr = { kind: 'name', name: 'true', span: this.span(close.start, close.end) };
          expr = { kind: 'criteria', object: expr, criteria, span: this.span(expr.span.start, close.end) };
          continue;
        }
        const inner = this.exprCriteria();
        const close = this.eat('punct', ']') ?? this.fail('bracket');
        if (this.isCriteria(inner)) {
          expr = { kind: 'criteria', object: expr, criteria: inner, span: this.span(expr.span.start, close.end) };
        } else {
          expr = { kind: 'index', object: expr, index: inner, span: this.span(expr.span.start, close.end) };
        }
        continue;
      }
      const tail = this.criteriaTail(expr);
      if (tail && this.is('ident', 'sort') && this.is('ident', 'by', 1)) {
        this.attachSortRange(tail);
        expr.span = this.span(expr.span.start, this.prevEnd());
        continue;
      }
      if (tail && this.is('ident', 'range') && this.is('ident', 'from', 1)) {
        this.attachSortRange(tail);
        expr.span = this.span(expr.span.start, this.prevEnd());
        continue;
      }
      if (!opts.stopBeforeColon && this.isColonCall()) {
        expr = this.colonCall(expr);
        continue;
      }
      break;
    }
    return expr;
  }

  /**
   * `Form[crit].Field` keeps the record fetch under the member (or index)
   * postfix chain; a trailing `sort by`/`range` clause binds that fetch, not
   * the projected field. Returns the criteria node to attach to, or null.
   */
  private criteriaTail(expr: Expr): Expr | null {
    let e: Expr = expr;
    while (e.kind === 'member' || e.kind === 'paren' || e.kind === 'index') {
      e = e.kind === 'paren' ? e.expr : e.object;
    }
    return e.kind === 'criteria' ? e : null;
  }

  private isColonCall(): boolean {
    if (!this.is('punct', ':') || !this.is('ident', undefined, 1)) return false;
    const n = this.peek(2);
    return n.text === '(' || n.text === '.';
  }

  private colonCall(object: Expr): Expr {
    this.eat('punct', ':');
    const path = [this.expectIdent()];
    while (this.is('punct', '.') && this.is('ident', undefined, 1)) {
      this.i++;
      path.push(this.expectIdent());
    }
    if (!this.eat('punct', '(')) this.fail('colon-call');
    const args = this.argList();
    return { kind: 'colonCall', object, path, args, span: this.span(object.span.start, this.prevEnd()) };
  }

  private criteriaBracket(object: Expr): Expr {
    if (!this.eat('punct', '[')) this.fail('criteria');
    const inner = this.is('punct', ']')
      ? ({ kind: 'name', name: 'true', span: this.span(this.peek().start, this.peek().end) } satisfies Expr)
      : this.exprCriteria();
    const close = this.eat('punct', ']') ?? this.fail('criteria-end');
    return { kind: 'criteria', object, criteria: inner, span: this.span(object.span.start, close.end) };
  }

  private attachSortRange(expr: Expr): void {
    if (expr.kind !== 'criteria') return;
    if (this.is('ident', 'sort') && this.is('ident', 'by', 1)) {
      this.i += 2;
      const keys: { field: string; dir?: string }[] = [];
      for (;;) {
        let field = this.expectIdent();
        while (this.is('punct', '.') && this.is('ident', undefined, 1)) {
          this.i++;
          field += '.' + this.expectIdent();
        }
        let dir: string | undefined;
        if (this.is('ident', 'asc') || this.is('ident', 'desc') || this.is('ident', 'ascending') || this.is('ident', 'descending')) {
          dir = this.t[this.i++]!.text;
        }
        keys.push({ field, ...(dir ? { dir } : {}) });
        if (!this.eat('punct', ',')) break;
      }
      const first = keys[0]!;
      expr.sort = { field: first.field, ...(first.dir ? { dir: first.dir } : {}), ...(keys.length > 1 ? { fields: keys } : {}) };
      expr.span = this.span(expr.span.start, this.prevEnd());
    }
    if (this.is('ident', 'range') && this.is('ident', 'from', 1)) {
      this.i += 2;
      const from = this.expr(0, {});
      if (!this.eat('ident', 'to')) this.fail('range');
      const to = this.expr(0, {});
      expr.range = { from, to };
      expr.span = this.span(expr.span.start, to.span.end);
    }
  }

  private isCriteria(e: Expr): boolean {
    if (e.kind === 'binary') {
      return e.op === '==' || e.op === '!=' || e.op === '=' || e.op === '<' || e.op === '>' || e.op === '<=' || e.op === '>=' || e.op === '&&' || e.op === '||' || e.op === 'and' || e.op === 'or' || e.op === 'in' || e.op === 'not in' || e.op === 'is' || e.op === 'is not';
    }
    if (e.kind === 'unary' && (e.op === '!' || e.op === 'not')) return this.isCriteria(e.expr);
    if (e.kind === 'paren') return this.isCriteria(e.expr);
    if (e.kind === 'call' && e.callee.kind === 'member' && CRITERIA_METHODS.has(e.callee.property.toLowerCase())) return true;
    return false;
  }

  private argList(): Expr[] {
    const args: Expr[] = [];
    if (this.is('punct', ')')) {
      this.i++;
      return args;
    }
    const prev = this.eqMode;
    this.eqMode = true;
    try {
      args.push(this.expr(0, {}));
      while (this.eat('punct', ',')) {
        if (this.is('punct', ')')) break;
        args.push(this.expr(0, {}));
      }
    } finally {
      this.eqMode = prev;
    }
    if (!this.eat('punct', ')')) this.fail('args');
    return args;
  }

  private expectIdent(): string {
    const t = this.eat('ident');
    if (!t) this.fail('ident');
    return t.text;
  }

  private dottedIdent(): string {
    let name = this.expectIdent();
    while (this.is('punct', '.') && this.is('ident', undefined, 1)) {
      this.i++;
      name += '.' + this.expectIdent();
    }
    return name;
  }

  private prevEnd(): number {
    const tok = this.t[Math.max(0, this.i - 1)];
    return tok ? tok.end : 0;
  }
}
