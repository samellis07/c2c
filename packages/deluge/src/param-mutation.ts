/**
 * Whether a function body can write a collection its caller also holds.
 * Deluge passes lists and maps by reference, so a callee that runs
 * `p.add(x)`, `p.put(k, v)` or `p.get(0).remove(k)` on a parameter changes
 * the caller's value. A client call or page call runs the body on the server
 * against deserialized arguments, which would hide that write, so such a
 * function is not read-only.
 *
 * The scan works on the Deluge AST. Names that share a value are grouped:
 * an assignment ties its target to every name its value reads, a `for each`
 * ties the element to the iterated collection, and a mutating call ties its
 * receiver to its arguments (the argument is now reachable through the
 * receiver). Starting from the collection-typed parameters and `input`, any
 * group that touches a tainted name is tainted. A mutator or a member/index
 * assignment whose receiver reads a tainted name is a parameter write. An
 * unparsed node that names a mutator counts as one.
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
  const writes: string[][] = [];
  let opaque = false;
  const mutation = (receiver: unknown, args: unknown) => {
    const root = reads(receiver);
    writes.push(root);
    groups.push([...root, ...reads(args)]);
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
          groups.push([...reads(target), ...reads(n.value)]);
          if (target.kind !== 'name') writes.push(reads(target));
          return;
        }
        case 'forEach':
          if (!n.iteratesIndex) groups.push([String(n.name).toLowerCase(), ...reads(n.collection)]);
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
  for (let changed = true; changed; ) {
    changed = false;
    for (const group of groups) {
      if (!group.some((name) => tainted.has(name))) continue;
      for (const name of group) {
        if (!tainted.has(name)) {
          tainted.add(name);
          changed = true;
        }
      }
    }
  }
  return writes.some((root) => root.some((name) => tainted.has(name)));
}
