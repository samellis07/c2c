import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, parseExpression } from '../src/parser.js';

// Seeded fuzzing found stack overflows on deeply nested input
// (`'(' * 1500`, `'!' * 5000`, 60k unclosed brackets in deriveIr).
// The parser must return coded, located `unknown` nodes instead of throwing.

type AnyNode = { kind: string; reason?: string; span?: { start: number; end: number } } & Record<string, unknown>;

/** Iteratively collect every `too-deeply-nested` reason in a statement tree. */
function deepReasons(body: unknown[]): string[] {
  const out: string[] = [];
  const stack: AnyNode[] = body as AnyNode[];
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

test('long prefix runs still parse fully (iterative unary)', () => {
  const script = parse('x = ' + '!'.repeat(5000) + 'y;');
  assert.equal(script.body[0]?.kind, 'assign');
  let depth = 0;
  let e: AnyNode = (script.body[0] as AnyNode).value as AnyNode;
  while (e?.kind === 'unary') {
    depth++;
    e = e.expr as AnyNode;
  }
  assert.equal(depth, 5000);
  assert.equal(e?.kind, 'name');
});

test('ordinary nesting still parses exactly (no guard trip)', () => {
  const script = parse('x = -(a + b) * !flag;\nif (x == 1) {\ninfo "yes";\n}');
  assert.deepEqual(deepReasons(script.body), []);
  assert.equal(script.body.length, 2);
  const expr = parseExpression('-(a + b)');
  assert.equal(expr.kind, 'unary');
});

test('parseExpression on deep input returns unknown instead of throwing', () => {
  const expr = parseExpression('('.repeat(5000) + '1' + ')'.repeat(5000)) as AnyNode;
  assert.equal(expr.kind, 'unknown');
  assert.ok(typeof expr.span?.start === 'number' && typeof expr.span?.end === 'number');
});
