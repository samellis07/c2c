import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fc from 'fast-check';
import type { Expr, Stmt } from '../src/ast.js';
import { parse } from '../src/parser.js';
import { translate } from '../src/translate.js';

// Fixed seed: CI runs are reproducible; counterexamples replay identically.
const SEED = 20261012;
const RUNS = 150;

/**
 * Deluge printer for the supported grammar subset, used to turn a generated
 * AST back into source for parse -> print -> parse round-trip checks.
 * Binary expressions are always parenthesised so precedence is explicit.
 */
function printExpr(e: Expr): string {
  switch (e.kind) {
    case 'number':
      return e.text;
    case 'string':
      return `"${e.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')}"`;
    case 'date':
      return `'${e.value}'`;
    case 'name':
      return e.name;
    case 'list':
      return `{${e.elements.map(printExpr).join(', ')}}`;
    case 'map':
      return `{${e.entries.map((en) => `${printExpr(en.key)}: ${printExpr(en.value)}`).join(', ')}}`;
    case 'unary':
      return `${e.op}${e.op === 'not' ? ' ' : ''}${printExpr(e.expr)}`;
    case 'binary':
      return `(${printExpr(e.left)} ${e.op} ${printExpr(e.right)})`;
    case 'member':
      return `${printExpr(e.object)}.${e.property}`;
    case 'call':
      return `${printExpr(e.callee)}(${e.args.map(printExpr).join(', ')})`;
    case 'index':
      return `${printExpr(e.object)}[${printExpr(e.index)}]`;
    case 'paren':
      return `(${printExpr(e.expr)})`;
    default:
      throw new Error(`printer: unsupported expr kind ${e.kind}`);
  }
}

function printStmt(s: Stmt, indent: string): string {
  switch (s.kind) {
    case 'block':
      return `{\n${s.body.map((b) => printStmt(b, indent + '  ')).join('')}${indent}}`;
    case 'assign':
      return `${indent}${s.declType ? `${s.declType} ` : ''}${printExpr(s.target)} ${s.op} ${printExpr(s.value)}\n`;
    case 'expr':
      return `${indent}${printExpr(s.expr)}\n`;
    case 'info':
      return `${indent}info ${printExpr(s.value)}\n`;
    case 'return':
      // `return` with no value must end with `;` — a following `{` block would
      // otherwise be read as the return value (a brace literal).
      return `${indent}return${s.value ? ` ${printExpr(s.value)}` : ';'}\n`;
    case 'break':
      return `${indent}break\n`;
    case 'continue':
      return `${indent}continue\n`;
    case 'if': {
      let out = `${indent}if (${printExpr(s.test)})\n${printStmt(s.then, indent + '  ')}`;
      for (const el of s.elifs) out += `${indent}elseif (${printExpr(el.test)})\n${printStmt(el.body, indent + '  ')}`;
      if (s.else) out += `${indent}else\n${printStmt(s.else, indent + '  ')}`;
      return out;
    }
    case 'while':
      return `${indent}while (${printExpr(s.test)})\n${printStmt(s.body, indent + '  ')}`;
    case 'forEach':
      return `${indent}for each ${s.name} in ${printExpr(s.collection)}\n${printStmt(s.body, indent + '  ')}`;
    default:
      throw new Error(`printer: unsupported stmt kind ${s.kind}`);
  }
}

/**
 * Strip spans (offsets differ after re-printing) and unwrap `paren` nodes —
 * parentheses are transparent to the parser, so re-printing can add a layer —
 * for structural equality.
 */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v.kind === 'paren') return strip(v.expr);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'span') out[k] = strip(x);
    return out;
  }
  return value;
}

// --- generators for the supported subset ---

const ident = fc
  .stringMatching(/^v_[a-z][a-z0-9]{0,7}$/)
  .filter((s) => !['v_in', 'v_if', 'v_or', 'v_not', 'v_is'].includes(s));

const declType = fc.constantFrom('string', 'int', 'float', 'bool', 'decimal', 'date', 'list', 'map');

const decimalText = fc
  .tuple(
    fc.stringMatching(/^[0-9]{1,6}$/),
    fc.stringMatching(/^[0-9]{1,18}$/),
  )
  .map(([a, b]) => `${a}.${b}`);

const numberText = fc.oneof(fc.stringMatching(/^[0-9]{1,9}$/), decimalText);

const stringValue = fc
  .string({ minLength: 0, maxLength: 12 })
  .filter((s) => !s.includes('"') && !s.includes('\\') && !/[\r\n]/.test(s) && /^[\x20-\x7e]*$/.test(s));

const dateValue = fc
  .tuple(
    fc.integer({ min: 1970, max: 2099 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

const binOp = fc.constantFrom('+', '-', '*', '==', '!=', '<', '>', '<=', '>=', '&&', '||', 'and', 'or', 'in');

interface GenExpr {
  ast: Expr;
}

const atom: fc.Arbitrary<Expr> = fc.oneof(
  numberText.map((text) => ({ kind: 'number', text, span: { start: 0, end: 0 } }) as Expr),
  stringValue.map((value) => ({ kind: 'string', value, span: { start: 0, end: 0 } }) as Expr),
  dateValue.map((value) => ({ kind: 'date', value, span: { start: 0, end: 0 } }) as Expr),
  ident.map((name) => ({ kind: 'name', name, span: { start: 0, end: 0 } }) as Expr),
);

const expr: fc.Arbitrary<Expr> = fc.letrec((tie) => ({
  expr: fc.oneof(
    { depthSize: 0.5, maxDepth: 5 },
    atom,
    fc.array(tie('expr'), { minLength: 0, maxLength: 3 }).map(
      (elements) => ({ kind: 'list', elements, span: { start: 0, end: 0 } }) as Expr,
    ),
    fc
      .array(
        fc.tuple(
          stringValue.map((value) => ({ kind: 'string', value, span: { start: 0, end: 0 } }) as Expr),
          tie('expr'),
        ),
        { minLength: 1, maxLength: 3 },
      )
      .map(
        (entries) =>
          ({
            kind: 'map',
            entries: entries.map(([key, value]) => ({ key, value })),
            span: { start: 0, end: 0 },
          }) as Expr,
      ),
    fc.tuple(fc.constantFrom('-', '!', 'not'), tie('expr')).map(
      ([op, inner]) => ({ kind: 'unary', op, expr: inner, span: { start: 0, end: 0 } }) as Expr,
    ),
    fc.tuple(binOp, tie('expr'), tie('expr')).map(
      ([op, left, right]) => ({ kind: 'binary', op, left, right, span: { start: 0, end: 0 } }) as Expr,
    ),
    fc.tuple(ident, ident).map(
      ([object, property]) =>
        ({
          kind: 'member',
          object: { kind: 'name', name: object, span: { start: 0, end: 0 } },
          property,
          span: { start: 0, end: 0 },
        }) as Expr,
    ),
    fc.tuple(ident, fc.array(tie('expr'), { minLength: 0, maxLength: 3 })).map(
      ([name, args]) =>
        ({
          kind: 'call',
          callee: { kind: 'name', name, span: { start: 0, end: 0 } },
          args,
          span: { start: 0, end: 0 },
        }) as Expr,
    ),
    fc.tuple(ident, tie('expr')).map(
      ([name, index]) =>
        ({
          kind: 'index',
          object: { kind: 'name', name, span: { start: 0, end: 0 } },
          index,
          span: { start: 0, end: 0 },
        }) as Expr,
    ),
  ),
})).expr;

/** Expression safe to use as a bare expression statement (a call, so the parser cannot read it as `name` + trailing task word). */
const exprStmtExpr: fc.Arbitrary<Expr> = fc
  .tuple(ident, fc.array(expr, { minLength: 0, maxLength: 3 }))
  .map(
    ([name, args]) =>
      ({
        kind: 'call',
        callee: { kind: 'name', name, span: { start: 0, end: 0 } },
        args,
        span: { start: 0, end: 0 },
      }) as Expr,
  );

const stmt: fc.Arbitrary<Stmt> = fc.letrec((tie) => ({
  stmt: fc.oneof(
    { depthSize: 0.4, maxDepth: 4 },
    fc.tuple(ident, expr).map(
      ([name, value]) =>
        ({
          kind: 'assign',
          op: '=',
          target: { kind: 'name', name, span: { start: 0, end: 0 } },
          value,
          span: { start: 0, end: 0 },
        }) as Stmt,
    ),
    fc.tuple(declType, ident, expr).map(
      ([declType, name, value]) =>
        ({
          kind: 'assign',
          declType,
          op: '=',
          target: { kind: 'name', name, span: { start: 0, end: 0 } },
          value,
          span: { start: 0, end: 0 },
        }) as Stmt,
    ),
    exprStmtExpr.map((e) => ({ kind: 'expr', expr: e, span: { start: 0, end: 0 } }) as Stmt),
    expr.map((value) => ({ kind: 'info', value, span: { start: 0, end: 0 } }) as Stmt),
    fc.option(expr, { nil: undefined }).map(
      (value) => ({ kind: 'return', ...(value ? { value } : {}), span: { start: 0, end: 0 } }) as Stmt,
    ),
    fc.constant({ kind: 'break', span: { start: 0, end: 0 } } as Stmt),
    fc.constant({ kind: 'continue', span: { start: 0, end: 0 } } as Stmt),
    fc.tuple(expr, tie('stmt'), fc.option(tie('stmt'), { nil: undefined })).map(
      ([test, then, els]) =>
        ({
          kind: 'if',
          test,
          then,
          elifs: [],
          ...(els ? { else: els } : {}),
          span: { start: 0, end: 0 },
        }) as Stmt,
    ),
    fc.tuple(expr, tie('stmt')).map(
      ([test, body]) => ({ kind: 'while', test, body, span: { start: 0, end: 0 } }) as Stmt,
    ),
    fc.tuple(ident, expr, tie('stmt')).map(
      ([name, collection, body]) => ({ kind: 'forEach', name, collection, body, span: { start: 0, end: 0 } }) as Stmt,
    ),
    fc.array(tie('stmt'), { minLength: 1, maxLength: 3 }).map(
      (body) => ({ kind: 'block', body, span: { start: 0, end: 0 } }) as Stmt,
    ),
  ),
})).stmt;

const scriptSrc = fc.array(stmt, { minLength: 0, maxLength: 6 }).map((body) => body.map((s) => printStmt(s, '')).join(''));

test('property: parse never throws on arbitrary input', () => {
  fc.assert(
    fc.property(fc.string(), (src) => {
      const script = parse(src);
      assert.equal(script.span.start, 0);
      assert.equal(script.span.end, src.length);
      assert.ok(Array.isArray(script.body));
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

test('property: parse -> print -> parse round-trips on the supported subset', () => {
  fc.assert(
    fc.property(scriptSrc, (src1) => {
      const ast1 = parse(src1);
      const src2 = ast1.body.map((s) => printStmt(s, '')).join('');
      const ast2 = parse(src2);
      assert.deepEqual(strip(ast2.body), strip(ast1.body));
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

test('property: translate is deterministic (byte-identical across runs)', () => {
  fc.assert(
    fc.property(scriptSrc, (src) => {
      const a = translate(src);
      const b = translate(src);
      assert.equal(a.server, b.server);
      assert.equal(a.client, b.client);
      assert.equal(a.prefetch, b.prefetch);
      assert.deepEqual(strip(a.todos), strip(b.todos));
      assert.deepEqual(strip(a.stats), strip(b.stats));
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

test('property: number/decimal literal text survives the parse without precision loss', () => {
  fc.assert(
    fc.property(decimalText, (text) => {
      const script = parse(`v_x = ${text}\n`);
      const stmt0 = script.body[0];
      assert.ok(stmt0 && stmt0.kind === 'assign', `expected assign, got ${stmt0?.kind}`);
      assert.equal(stmt0.value.kind, 'number');
      if (stmt0.value.kind === 'number') assert.equal(stmt0.value.text, text);
    }),
    { seed: SEED, numRuns: RUNS },
  );
});
