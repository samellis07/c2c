/**
 * Whether a function body can write a collection its caller also holds.
 * Deluge passes lists and maps by reference, so a callee that runs
 * `p.add(x)`, `p.put(k, v)` or `p.get(0).remove(k)` on a parameter changes
 * the caller's value. A client call or page call runs the body on the server
 * against deserialized arguments, which would hide that write, so such a
 * function is not read-only.
 *
 * The scan tracks aliases separately from containers that hold tainted values.
 * Assignments and `for each` propagate aliases; mutation calls only mark the
 * receiver as containing tainted values. This avoids treating a fresh result
 * collection as an alias of a parameter just because a parameter value was
 * added to it. An unparsed node that names a mutator counts as a write.
 */
import type { Script } from './ast.js';
import { walk } from './connections.js';
import { parse } from './parser.js';
import { isCollectionMutator } from './translate.js';
import { normType } from './types.js';

/** Declared parameter types whose values are copied, never shared with the caller. */
const SCALAR_TYPES = new Set(['string', 'int', 'float', 'bool', 'date', 'datetime']);

const UNKNOWN_MUTATOR = /\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const UNKNOWN_WRITE = /[\]\w$]\s*\[[^\]]*\]\s*=[^=]|\.\s*[A-Za-z_$][\w$]*\s*=[^=]/;

type Node = { kind: string } & Record<string, unknown>;

/** Lower-cased names `node` reads anywhere inside it. */
function reads(node: unknown): string[] {
  const out: string[] = [];
  walk(node, (n) => {
    if (n.kind === 'name' && typeof n.name === 'string') out.push(n.name.toLowerCase());
  });
  return out;
}

function unknownMutates(text: string): boolean {
  if (UNKNOWN_WRITE.test(text)) return true;
  for (const m of text.matchAll(UNKNOWN_MUTATOR)) if (isCollectionMutator(m[1]!)) return true;
  return false;
}

/**
 * True when `scripts` may mutate a collection reachable from a parameter.
 * `params` are the declared `(type name)` pairs; a scalar-typed parameter is
 * a copy and does not seed the scan.
 */
export function mutatesParameters(scripts: readonly string[], params: readonly { type: string; name: string }[]): boolean {
  const tainted = new Set<string>(['input']);
  for (const p of params) if (!SCALAR_TYPES.has(normType(p.type) ?? '')) tainted.add(p.name.toLowerCase());
  const groups: string[][] = [];
  const elements: { target: string; sources: string[] }[] = [];
  const compoundAssignments: { root: string[]; sources: string[] }[] = [];
  const derived: { targets: string[]; sources: string[] }[] = [];
  const mutations: { receiver: string[]; args: string[] }[] = [];
  const writes: { root: string[]; compound: boolean }[] = [];
  let opaque = false;
  const mutation = (receiver: unknown, args: unknown) => {
    const root = reads(receiver);
    mutations.push({ receiver: root, args: reads(args) });
    writes.push({ root, compound: (receiver as Node | null)?.kind !== 'name' });
  };
  for (const text of scripts) {
    let script: Script;
    try {
      script = parse(text);
    } catch {
      return true;
    }
    walk(script.body, (n: Node) => {
      switch (n.kind) {
        case 'assign': {
          const target = n.target as Node;
          const targets = reads(target);
          const sources = reads(n.value);
          if (target.kind === 'name' && (n.value as Node).kind === 'name') groups.push([...targets, ...sources]);
          else if (target.kind === 'name') derived.push({ targets, sources });
          else compoundAssignments.push({ root: targets.slice(0, 1), sources });
          if (target.kind !== 'name') writes.push({ root: targets, compound: true });
          return;
        }
        case 'forEach':
          if (!n.iteratesIndex) elements.push({ target: String(n.name).toLowerCase(), sources: reads(n.collection) });
          return;
        case 'call': {
          const callee = n.callee as Node;
          if (callee.kind === 'member' && isCollectionMutator(String(callee.property))) mutation(callee.object, n.args);
          return;
        }
        case 'colonCall': {
          const path = n.path as string[];
          const method = path[path.length - 1];
          if (method && isCollectionMutator(method)) mutation(n.object, n.args);
          return;
        }
        case 'fn':
          // A nested function's parameters are inputs whose source the scan does not follow.
          for (const p of n.params as { name: string }[]) tainted.add(p.name.toLowerCase());
          return;
        case 'unknown':
          if (unknownMutates(String(n.text))) opaque = true;
          return;
        default:
          return;
      }
    });
  }
  if (opaque) return true;
  const containing = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const group of groups) {
      const propagateAlias = group.some((name) => tainted.has(name));
      const propagateContainer = group.some((name) => containing.has(name));
      if (!propagateAlias && !propagateContainer) continue;
      for (const name of group) {
        if (propagateAlias && !tainted.has(name)) {
          tainted.add(name);
          changed = true;
        }
        if (propagateContainer && !containing.has(name)) {
          containing.add(name);
          changed = true;
        }
      }
    }
    for (const { target, sources } of elements) {
      if (!sources.some((name) => tainted.has(name) || containing.has(name)) || tainted.has(target)) continue;
      tainted.add(target);
      changed = true;
    }
    for (const { receiver, args } of mutations) {
      if (!args.some((name) => tainted.has(name) || containing.has(name))) continue;
      for (const name of receiver) {
        if (!containing.has(name)) {
          containing.add(name);
          changed = true;
        }
      }
    }
    for (const { targets, sources } of derived) {
      if (!sources.some((name) => tainted.has(name) || containing.has(name))) continue;
      for (const name of targets) {
        if (!tainted.has(name)) {
          tainted.add(name);
          changed = true;
        }
      }
    }
    for (const { root, sources } of compoundAssignments) {
      if (!sources.some((name) => tainted.has(name) || containing.has(name))) continue;
      for (const name of root) {
        if (!containing.has(name)) {
          containing.add(name);
          changed = true;
        }
      }
    }
  }
  return writes.some(({ root, compound }) => root.some((name) => tainted.has(name) || (compound && containing.has(name))));
}
