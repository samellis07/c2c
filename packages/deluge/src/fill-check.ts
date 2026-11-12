/**
 * Gates for an accepted fill. The fill is host-authored JavaScript that
 * replaces one `shim.todo` hole. It must parse as the body of one wrapper
 * function, call only the allowlisted shim API, and pass the codegen lint
 * (no clock, random, localeCompare, or unordered iteration).
 *
 * Acceptance is static. The fill is not executed here, in the CLI process,
 * or in a child. A dry-run used to spawn `node` on the fill; a fill that
 * closed the wrapper ran at module scope on the accept host. `node --permission`
 * would still execute that code, so a sandbox miss is code execution.
 * The wrapper-shape check plus this walk rejects the fill without running it.
 * Golden-vector checks (below) evaluate catalogue cases, not the fill text.
 * Nothing in this file calls Catalyst, Creator, or a model.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { repoRoot } from '../../core/src/toolchain.js';
import { scanSource } from '../../determinism/src/lint.js';

const BANNED_IDENT = new Set([
  'Function',
  'XMLHttpRequest',
  'WebSocket',
  'child_process',
  'dgram',
  'dns',
  'eval',
  'fetch',
  'fs',
  'global',
  'globalThis',
  'http',
  'https',
  'net',
  'process',
  'require',
  'tls',
  'window',
]);

const WRAP_PREFIX = '(async function __fill(ctx, shim){';
const WRAP_SUFFIX = '})';

/**
 * Caps on one fill. Accept and replay both call `fillLimitRefusal`.
 * A fill over a cap is refused and is never shortened.
 *
 * maxBytes is 8192 because a fill replaces one hole and 8192 UTF-8 bytes holds a short shim block with literals.
 * maxStatements is 32 because every statement node in the fill counts, including nested ones, and a short sequence fits in 32 statements.
 * maxLoops is 2 because a fill may contain one traversal and one nested scan.
 */
export const FILL_LIMITS = {
  maxBytes: 8192,
  maxStatements: 32,
  maxLoops: 2,
} as const;

const LOOP_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);

/**
 * Null when `fill` is within every cap. Otherwise one line per exceeded cap,
 * each naming the limit and the measured value. Statement and loop counts
 * need a parseable wrapper body; the byte cap applies to the text either way.
 */
export function fillLimitRefusal(fill: string): string | null {
  const problems: string[] = [];
  const bytes = Buffer.byteLength(fill, 'utf8');
  if (bytes > FILL_LIMITS.maxBytes) {
    problems.push(`fill limit maxBytes: measured ${bytes}, limit ${FILL_LIMITS.maxBytes}`);
  }
  const body = fillWrapperBody(fill);
  if (body) {
    const measured = measureFillBody(body);
    if (measured.statements > FILL_LIMITS.maxStatements) {
      problems.push(`fill limit maxStatements: measured ${measured.statements}, limit ${FILL_LIMITS.maxStatements}`);
    }
    if (measured.loops > FILL_LIMITS.maxLoops) {
      problems.push(`fill limit maxLoops: measured ${measured.loops}, limit ${FILL_LIMITS.maxLoops}`);
    }
  }
  return problems.length ? problems.join('\n') : null;
}

/** The wrapper body, or null when the fill does not parse as that one function. */
function fillWrapperBody(fill: string): ts.Block | null {
  const source = WRAP_PREFIX + fill + WRAP_SUFFIX;
  const fillStart = WRAP_PREFIX.length;
  const fillEnd = fillStart + fill.length;
  const sourceFile = ts.createSourceFile('fill.mjs', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  return wrapperBody(sourceFile, source, fillStart, fillEnd);
}

/** Statement nodes inside the fill, and loop statements among them. The wrapper body itself is not a fill statement. */
function measureFillBody(body: ts.Block): { statements: number; loops: number } {
  let statements = 0;
  let loops = 0;
  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isStatement(node)) statements += 1;
    if (LOOP_KINDS.has(node.kind)) loops += 1;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return { statements, loops };
}

/**
 * Problems that block acceptance. Empty means the fill passed static checks.
 * The fill is parsed as the body of `(async function __fill(ctx, shim){ <fill> })`.
 * The program must be that one function, and the fill's characters must be
 * exactly the function body. Anything that closes the wrapper is rejected.
 */
export function lintFill(fill: string, role: 'expression' | 'statement', shimApi: readonly string[]): string[] {
  const problems: string[] = [];
  const badCharMatch = new RegExp('[[\\p{Cf}\\p{Zs}\\u0085\\u2028\\u2029\\ufeff]--[\\u0020]]', 'v').exec(fill);
  if (badCharMatch) {
    const codePoint = badCharMatch[0].codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0');
    problems.push(`parse: invalid whitespace/format character U+${codePoint} at offset ${badCharMatch.index}`);
    return problems;
  }
  const findings = scanSource('fill.mjs', fill);
  for (const finding of findings) problems.push(`codegen-lint: ${finding.message}`);
  const source = WRAP_PREFIX + fill + WRAP_SUFFIX;
  const fillStart = WRAP_PREFIX.length;
  const fillEnd = fillStart + fill.length;
  const sourceFile = ts.createSourceFile('fill.mjs', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  // parseDiagnostics is set by the parser but is not on the public SourceFile type (TS 5.9).
  const parsed = sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  for (const diagnostic of parsed.parseDiagnostics ?? []) {
    problems.push(`parse: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
  }
  const body = wrapperBody(sourceFile, source, fillStart, fillEnd);
  if (!body) {
    problems.push('parse: fill escapes the __fill wrapper');
    return problems;
  }
  if (problems.some((problem) => problem.startsWith('parse:'))) return problems;
  if (role === 'expression') {
    const statements = body.statements.filter((statement) => statement.kind !== ts.SyntaxKind.EmptyStatement);
    if (statements.length !== 1 || !ts.isExpressionStatement(statements[0]!)) {
      problems.push('parse: expression fill must be a single expression');
    }
  }
  const locals = new Set<string>();
  collectLocals(body, locals, problems);
  walkFill(body, locals, shimApi, problems);
  return problems;
}

/** The wrapper function body, or null when the program is not exactly that function. */
function wrapperBody(sourceFile: ts.SourceFile, source: string, fillStart: number, fillEnd: number): ts.Block | null {
  if (sourceFile.end !== source.length) return null;
  if (sourceFile.statements.length !== 1) return null;
  const statement = sourceFile.statements[0]!;
  if (!ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression)) return null;
  const fn = statement.expression.expression;
  if (!ts.isFunctionExpression(fn) || fn.name?.text !== '__fill' || fn.asteriskToken) return null;
  const asyncMod = fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  if (!asyncMod || !fn.body) return null;
  if (fn.parameters.length !== 2) return null;
  const [ctx, shim] = fn.parameters;
  if (!ctx || !shim || ctx.initializer || shim.initializer || ctx.dotDotDotToken || shim.dotDotDotToken || ctx.questionToken || shim.questionToken) {
    return null;
  }
  if (!ts.isIdentifier(ctx.name) || ctx.name.text !== 'ctx' || !ts.isIdentifier(shim.name) || shim.name.text !== 'shim') return null;
  const interiorStart = fn.body.getStart(sourceFile) + 1;
  const interiorEnd = fn.body.getEnd() - 1;
  if (interiorStart !== fillStart || interiorEnd !== fillEnd) return null;
  return fn.body;
}

function collectLocals(node: ts.Node, locals: Set<string>, problems: string[]): void {
  if (ts.isVariableDeclaration(node)) {
    if (!ts.isIdentifier(node.name)) problems.push('forbidden destructuring');
    else if (BANNED_IDENT.has(node.name.text) || node.name.text === 'shim' || node.name.text === 'ctx') {
      problems.push(`forbidden binding ${node.name.text}`);
    } else locals.add(node.name.text);
    if (node.initializer && rootedAtShim(node.initializer)) problems.push('forbidden shim alias');
  }
  ts.forEachChild(node, (child) => collectLocals(child, locals, problems));
}

/** True when the expression is `shim` or a member chain on `shim`, not a call. */
function rootedAtShim(expression: ts.Expression): boolean {
  let current: ts.Node = expression;
  while (ts.isParenthesizedExpression(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) && current.text === 'shim';
}

function walkFill(node: ts.Node, locals: Set<string>, shimApi: readonly string[], problems: string[]): void {
  if (node.kind === ts.SyntaxKind.ImportKeyword) {
    problems.push('forbidden import');
    return;
  }
  // A binary expression is allowed as a whole. Its operator token is not a separate construct.
  if (node.parent && ts.isBinaryExpression(node.parent) && node.parent.operatorToken === node) return;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    let left: ts.Expression = node.left;
    while (ts.isParenthesizedExpression(left)) left = left.expression;
    if (ts.isIdentifier(left) && (left.text === 'shim' || left.text === 'ctx')) problems.push(`forbidden binding ${left.text}`);
  }
  if (ts.isCallExpression(node)) {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      problems.push('forbidden import');
      return;
    }
    const classified = classifyCallee(node.expression);
    if (classified.kind === 'computed') problems.push('forbidden computed member');
    else if (classified.kind !== 'path' || !shimApi.includes(classified.path)) {
      problems.push(`not a shim API: ${classified.kind === 'path' ? classified.path : callText(node.expression)}`);
    }
    if (classified.kind === 'other') walkFill(node.expression, locals, shimApi, problems);
    for (const arg of node.arguments) walkFill(arg, locals, shimApi, problems);
    return;
  }
  if (ts.isElementAccessExpression(node)) {
    problems.push('forbidden computed member');
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (!insideShimCall(node)) problems.push(`not a shim API: ${callText(node)}`);
    return;
  }
  if (ts.isIdentifier(node)) {
    if (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
    const name = node.text;
    if (BANNED_IDENT.has(name)) {
      problems.push(`forbidden ${name}`);
      return;
    }
    if (name === 'shim' || name === 'ctx' || name === 'undefined' || locals.has(name)) return;
    problems.push(`forbidden identifier ${name}`);
    return;
  }
  if (ts.isNewExpression(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassExpression(node)) {
    problems.push(`forbidden ${ts.SyntaxKind[node.kind]}`);
    return;
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
    problems.push(`forbidden ${ts.SyntaxKind[node.kind]}`);
    return;
  }
  if (isAllowed(node)) {
    ts.forEachChild(node, (child) => walkFill(child, locals, shimApi, problems));
    return;
  }
  if (ts.isFunctionDeclaration(node) || ts.isBlock(node)) {
    ts.forEachChild(node, (child) => walkFill(child, locals, shimApi, problems));
    return;
  }
  problems.push(`forbidden syntax ${ts.SyntaxKind[node.kind]}`);
}

function isAllowed(node: ts.Node): boolean {
  switch (node.kind) {
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.TemplateHead:
    case ts.SyntaxKind.TemplateMiddle:
    case ts.SyntaxKind.TemplateSpan:
    case ts.SyntaxKind.TemplateTail:
    case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.BinaryExpression:
    case ts.SyntaxKind.PrefixUnaryExpression:
    case ts.SyntaxKind.ConditionalExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.AwaitExpression:
    case ts.SyntaxKind.ExpressionStatement:
    case ts.SyntaxKind.ReturnStatement:
    case ts.SyntaxKind.VariableStatement:
    case ts.SyntaxKind.VariableDeclarationList:
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.IfStatement:
    case ts.SyntaxKind.Block:
    case ts.SyntaxKind.EmptyStatement:
    case ts.SyntaxKind.ThrowStatement:
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement:
    case ts.SyntaxKind.Parameter:
      return true;
    default:
      return false;
  }
}

function insideShimCall(node: ts.PropertyAccessExpression): boolean {
  let current: ts.Node = node;
  while (current.parent && ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
    current = current.parent;
  }
  return !!current.parent && ts.isCallExpression(current.parent) && current.parent.expression === current;
}

/**
 * Quoted and computed members (`shim["datastore"]["delete"]`, `shim['mail'].send`)
 * are rejected, not resolved. A dotted `shim.*` path is the only accepted callee.
 */
function classifyCallee(expression: ts.Expression): { kind: 'path'; path: string } | { kind: 'computed' } | { kind: 'other' } {
  const parts: string[] = [];
  let current: ts.Expression = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      if (current.questionDotToken) return { kind: 'other' };
      parts.unshift(current.name.text);
      current = current.expression;
      continue;
    }
    if (ts.isElementAccessExpression(current)) return { kind: 'computed' };
    break;
  }
  if (!ts.isIdentifier(current) || current.text !== 'shim') return { kind: 'other' };
  parts.unshift('shim');
  return { kind: 'path', path: parts.join('.') };
}

function callText(expression: ts.Node): string {
  return expression.getText().slice(0, 80);
}

interface GoldenCase {
  id: string;
  builtin: string;
  capture: string;
  script: string;
}

interface ParityModule {
  evaluateCase(entry: GoldenCase): Promise<unknown>;
  loadBaselineIds(): string[];
  loadVectorText(): string;
  parityVerdict(compared: boolean, matches: boolean, inBaseline: boolean): string;
  sameValue(actual: unknown, expected: unknown): boolean;
  vectorStatus(text: string, artifactIds: readonly string[]): { cases: Record<string, unknown>; pending: Set<string> };
  BOOL_CAPTURE_ARTIFACTS: string[];
}

/**
 * D3 gate for the builtin this hole names.
 * `fail` blocks acceptance. Pending, known-gap, pass, and shrink do not:
 * shrink is a baseline-hygiene fact about the shim, not about this fill.
 * No cases means there is nothing to compare.
 */
export async function goldenProblems(builtin: string | null, caseIds: readonly string[]): Promise<string[]> {
  if (!builtin || !caseIds.length) return [];
  const root = repoRoot();
  const parity = (await import(pathToFileURL(join(root, 'tests/golden/parity.mjs')).href)) as ParityModule;
  const doc = JSON.parse(readFileSyncCases(root)) as { cases: GoldenCase[] };
  const byId: Record<string, GoldenCase> = {};
  for (const entry of doc.cases) byId[entry.id] = entry;
  const status = parity.vectorStatus(parity.loadVectorText(), parity.BOOL_CAPTURE_ARTIFACTS);
  const baseline = new Set(parity.loadBaselineIds());
  const problems: string[] = [];
  for (const id of caseIds) {
    const entry = byId[id];
    if (!entry) {
      problems.push(`golden-vectors: missing case ${id}`);
      continue;
    }
    let actual: unknown;
    try {
      actual = await parity.evaluateCase(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      problems.push(`golden-vectors: ${id} threw ${message}`);
      continue;
    }
    const compared = !status.pending.has(id);
    const matches = compared && parity.sameValue(actual, status.cases[id]);
    const verdict = parity.parityVerdict(compared, matches, baseline.has(id));
    if (verdict === 'fail') problems.push(`golden-vectors: ${id} does not match its Creator vector`);
  }
  return problems;
}

function readFileSyncCases(root: string): string {
  return readFileSync(join(root, 'tests/golden/cases.json'), 'utf8');
}
