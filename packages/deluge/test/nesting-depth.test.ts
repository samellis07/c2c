import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, parseExpression } from '../src/parser.js';
import { translate } from '../src/translate.js';

// Seeded fuzzing found stack overflows on deeply nested input
// (`'(' * 1500`, `'!' * 5000`, 60k unclosed brackets in deriveIr).
// The parser must return coded, located `unknown` nodes instead of throwing.

type AnyNode = { kind: string; reason?: string; span?: { start: number; end: number } } & Record<string, unknown>;

/** Iteratively collect every `too-deeply-nested` reason in a statement tree. */
function deepReasons(body: unknown[]): string[] {
  const out: string[] = [];
  const stack: AnyNode[] = [...(body as AnyNode[])];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (typeof n !== 'object' || n === null) continue;
    if (n.kind === 'unknown' && typeof n.reason === 'string') {
      out.push(n.reason);
      if (n.span) assert.ok(n.span.start >= 0 && n.span.end >= n.span.start);
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) for (const x of v) stack.push(x as AnyNode);
      else if (v !== null && typeof v === 'object' && 'kind' in (v as Record<string, unknown>)) stack.push(v as AnyNode);
    }
  }
  return out;
}

test('deeply nested parens fail as located unknown instead of throwing', () => {
  const src = 'x = ' + '('.repeat(5000) + '1' + ')'.repeat(5000) + ';';
  const script = parse(src);
  assert.equal(script.body.length, 1);
  assert.equal(script.body[0]?.kind, 'unknown');
  assert.deepEqual(deepReasons(script.body), ['too-deeply-nested']);
});

test('unclosed parens fail as located unknown instead of throwing', () => {
  const src = 'x = ' + '('.repeat(5000) + '1;';
  const script = parse(src);
  assert.ok(script.body.length >= 1);
  assert.ok(deepReasons(script.body).includes('too-deeply-nested'));
});

test('deeply nested blocks keep outer structure and mark the core unknown', () => {
  const src = 'if (a) ' + '{ if (b) '.repeat(1000) + 'x = 1;' + '}'.repeat(1000);
  const script = parse(src);
  assert.equal(script.body[0]?.kind, 'if');
  assert.ok(deepReasons(script.body).includes('too-deeply-nested'));
});

test('long prefix runs fail as a located too-deeply-nested unknown', () => {
  const src = 'x = ' + '!'.repeat(5000) + 'y;';
  const script = parse(src);
  assert.equal(script.body.length, 1);
  const stmt = script.body[0] as AnyNode;
  assert.equal(stmt.kind, 'unknown');
  assert.equal(stmt.reason, 'too-deeply-nested');
  assert.equal(stmt.span?.start, 0);
  assert.equal(stmt.span?.end, src.length);
  const tr = translate(src);
  assert.ok(tr.stats.todo >= 1);
  assert.ok(tr.todos.some((t) => t.start === 0 && t.end === src.length));
  assert.match(tr.server, /shim\.todo\(ctx, "task:x", \{ start: 0, end: \d+ \}\)/);
});

test('short prefix runs still parse exactly', () => {
  const expr = parseExpression('!!-x') as AnyNode;
  assert.equal(expr.kind, 'unary');
  assert.equal(expr.op, '!');
  const mid = expr.expr as AnyNode;
  assert.equal(mid.kind, 'unary');
  assert.equal(mid.op, '!');
  const inner = mid.expr as AnyNode;
  assert.equal(inner.kind, 'unary');
  assert.equal(inner.op, '-');
  const name = inner.expr as AnyNode;
  assert.equal(name.kind, 'name');
  assert.equal(name.name, 'x');
  assert.equal(expr.span?.start, 0);
});

test('ordinary nesting still parses exactly (no guard trip)', () => {
  const script = parse('x = -(a + b) * !flag;\nif (x == 1) {\ninfo "yes";\n}');
  assert.deepEqual(deepReasons(script.body), []);
  assert.equal(script.body.length, 2);
  const expr = parseExpression('-(a + b)');
  assert.equal(expr.kind, 'unary');
});

test('parseExpression on deep input returns located too-deeply-nested', () => {
  const src = '('.repeat(5000) + '1' + ')'.repeat(5000);
  const expr = parseExpression(src) as AnyNode;
  assert.equal(expr.kind, 'unknown');
  assert.equal(expr.reason, 'too-deeply-nested');
  // The cap trips on the 201st paren (offset 200), not on a generic catch-all.
  assert.equal(expr.span?.start, 200);
  assert.equal(expr.span?.end, src.length);
});

test('flat addition chains translate without throwing', () => {
  const tr = translate('x = ' + Array.from({ length: 10000 }, () => 'a').join(' + ') + ';');
  assert.equal(tr.stats.todo, 0);
  assert.match(tr.server, /\(\(a \+ a\) \+ a\)/);
  assert.ok(!tr.server.includes('shim.todo'));
});

test('short addition chain is left-associative', () => {
  const tr = translate('x = a + b + c;');
  assert.match(tr.server, /\(\(a \+ b\) \+ c\)/);
  assert.equal(tr.stats.todo, 0);
});

test('long get chains translate without throwing', () => {
  let call = 'a';
  for (let i = 0; i < 10000; i++) call += '.get(0)';
  const tr = translate(`x = ${call};`);
  assert.equal(tr.stats.todo, 0);
  assert.ok(tr.server.includes('shim.list.get'));
  assert.ok(!tr.server.includes('shim.todo'));
});

test('short get chain folds inside out', () => {
  const tr = translate('x = a.get(0).get(1);');
  assert.match(tr.server, /shim\.list\.get\(shim\.list\.get\(a, 0\), 1\)/);
  assert.equal(tr.stats.todo, 0);
});
