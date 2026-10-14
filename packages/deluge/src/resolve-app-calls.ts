import type { FunctionDef } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import type { TodoItem } from './translate.js';
import { loadDocs } from './catalogue.js';
import { parse } from './parser.js';

let cataloguedBuiltins: Set<string> | undefined;

function isCataloguedBuiltin(name: string): boolean {
  cataloguedBuiltins ??= new Set(loadDocs().map((entry) => entry.name.toLowerCase()));
  return cataloguedBuiltins.has(name.toLowerCase());
}

/**
 * Rewrites only an unresolved bare call whose target is one declared app
 * function and whose declared signature has the same arity. Qualified calls,
 * ambiguous declarations, and signatures we cannot count stay untouched.
 */
export function resolveAppCalls(source: string, functions: FunctionDef[], todos: readonly TodoItem[]): string {
  const declarations = new Map<string, FunctionDef[]>();
  for (const fn of functions) {
    const name = fn.name.toLowerCase();
    declarations.set(name, [...(declarations.get(name) ?? []), fn]);
  }
  const holes = new Set(todos.filter((todo) => todo.construct.startsWith('call:')).map((todo) => todo.construct));
  if (!holes.size) return source;

  const edits: number[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node.kind === 'call' && node.callee && typeof node.callee === 'object') {
      const call = node as unknown as { callee: { kind: string; name?: string; span?: { start: number; end: number } }; args: unknown[]; span: { start: number; end: number } };
      const callee = call.callee;
      if (callee.kind === 'name' && callee.name && callee.span && holes.has(`call:${callee.name}`) && !isCataloguedBuiltin(callee.name)) {
        const matches = declarations.get(callee.name.toLowerCase()) ?? [];
        if (matches.length === 1 && parameterCount(matches[0]!.signature) === call.args.length) edits.push(callee.span.start);
      }
    }
    for (const key of Object.keys(node).sort((a, b) => compareEnUs(a, b))) {
      if (key !== 'span') visit(node[key]);
    }
  };
  visit(parse(source));
  if (!edits.length) return source;
  edits.sort((a, b) => b - a);
  let resolved = source;
  for (const offset of edits) resolved = `${resolved.slice(0, offset)}thisapp.${resolved.slice(offset)}`;
  return resolved;
}

function parameterCount(signature: string | undefined): number | null {
  if (!signature) return null;
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const params = signature.slice(open + 1, close).trim();
  if (!params) return 0;
  let depth = 0;
  let count = 1;
  for (const char of params) {
    if (char === '(' || char === '[' || char === '<') depth++;
    else if (char === ')' || char === ']' || char === '>') depth--;
    else if (char === ',' && depth === 0) count++;
  }
  return depth === 0 ? count : null;
}
