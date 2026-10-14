/**
 * Free-identifier pass for generated JavaScript (quality gate Q2).
 *
 * A reference is free when no enclosing scope declares it and it is not an
 * allowed global. Parsing uses the TypeScript compiler API (already a
 * dependency); scoping is resolved here so the pass does not depend on lib
 * typings or on the type checker.
 *
 * Scopes: module, function (params, var, arguments), block (let, const,
 * class, function declarations), for/for-in/for-of heads, catch, switch case
 * block, named function and class expressions.
 */
import ts from 'typescript';
import vm from 'node:vm';

export interface FreeIdentifier {
  name: string;
  /** 1-based line in the module text. */
  line: number;
}

/** ECMAScript built-ins of the running Node (pinned in package.json engines). */
export const ES_GLOBALS: ReadonlySet<string> = new Set<string>([
  ...(vm.runInNewContext('Object.getOwnPropertyNames(globalThis)') as string[]),
  'undefined',
  'NaN',
  'Infinity',
  'globalThis',
]);

/** Globals both a Catalyst function (Node) and a browser page or service worker have. */
const WEB_PLATFORM_GLOBALS = [
  'console',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'structuredClone',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'AbortSignal',
  'fetch',
  'Headers',
  'Request',
  'Response',
  'FormData',
  'Blob',
  'CompressionStream',
  'crypto',
  'performance',
  'atob',
  'btoa',
];

/** Node globals a Catalyst function module may use without importing. */
export const NODE_GLOBALS: ReadonlySet<string> = new Set([...WEB_PLATFORM_GLOBALS, 'process', 'Buffer', 'setImmediate', 'clearImmediate']);

/** CommonJS module-wrapper bindings: only a server `.js` / `.cjs` module (a Catalyst function entry) has them. */
export const COMMONJS_GLOBALS: ReadonlySet<string> = new Set(['require', 'module', 'exports', '__dirname', '__filename']);

/**
 * Browser and service-worker globals for client handlers and the Slate runtime.
 * No Node-only names (`process`, `Buffer`, `setImmediate`, `require`, ...): a
 * client module that reads one throws in the browser even though Q4 runs it on Node.
 */
export const BROWSER_GLOBALS: ReadonlySet<string> = new Set([
  ...WEB_PLATFORM_GLOBALS,
  'window',
  'self',
  'document',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'clients',
  'registration',
  'alert',
  'confirm',
  'prompt',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'matchMedia',
  'Event',
  'CustomEvent',
  'EventTarget',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'HTMLFormElement',
  'HTMLButtonElement',
  'File',
  'FileReader',
  'Image',
  'MutationObserver',
  'CSS',
  'DOMParser',
]);

const enum ScopeKind {
  Function,
  Block,
}

interface Scope {
  kind: ScopeKind;
  names: Set<string>;
}

function scopeKindOf(node: ts.Node): ScopeKind | undefined {
  switch (node.kind) {
    case ts.SyntaxKind.SourceFile:
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.ClassStaticBlockDeclaration:
      return ScopeKind.Function;
    case ts.SyntaxKind.Block:
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.CatchClause:
    case ts.SyntaxKind.CaseBlock:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
      return ScopeKind.Block;
    default:
      return undefined;
  }
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    bindingNames(el.name, out);
  }
}

/** True when `id` names a binding, a property or a label rather than reading a variable. */
function isNonReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return true;
  switch (p.kind) {
    case ts.SyntaxKind.PropertyAccessExpression:
      return (p as ts.PropertyAccessExpression).name === id;
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.EnumMember:
      return (p as ts.NamedDeclaration).name === id;
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.Parameter:
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
    case ts.SyntaxKind.ImportClause:
    case ts.SyntaxKind.NamespaceImport:
      return (p as ts.NamedDeclaration).name === id;
    case ts.SyntaxKind.BindingElement: {
      const b = p as ts.BindingElement;
      return b.name === id || b.propertyName === id;
    }
    case ts.SyntaxKind.ImportSpecifier:
      return true;
    case ts.SyntaxKind.ExportSpecifier: {
      const e = p as ts.ExportSpecifier;
      const decl = e.parent.parent;
      if (decl.moduleSpecifier) return true;
      return id !== (e.propertyName ?? e.name);
    }
    case ts.SyntaxKind.LabeledStatement:
    case ts.SyntaxKind.BreakStatement:
    case ts.SyntaxKind.ContinueStatement:
      return true;
    case ts.SyntaxKind.MetaProperty:
      return true;
    default:
      return false;
  }
}

/**
 * Free identifiers in `text`, in source order. `allowed` names are skipped.
 * `arguments` is allowed inside a non-arrow function. Parse errors are not
 * reported here; run `node --check` for those.
 */
export function freeIdentifiers(text: string, allowed: ReadonlySet<string>, fileName = 'module.mjs'): FreeIdentifier[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const scopes = new Map<ts.Node, Scope>();
  const scopeOf = (node: ts.Node): Scope => {
    let s = scopes.get(node);
    if (!s) {
      s = { kind: scopeKindOf(node)!, names: new Set() };
      scopes.set(node, s);
    }
    return s;
  };
  const nearest = (from: ts.Node, fnOnly: boolean): ts.Node => {
    let n: ts.Node | undefined = from;
    while (n) {
      const k = scopeKindOf(n);
      if (k !== undefined && (!fnOnly || k === ScopeKind.Function)) return n;
      n = n.parent;
    }
    return sf;
  };
  const declare = (target: ts.Node, names: string[]) => {
    const s = scopeOf(target);
    for (const name of names) s.names.add(name);
  };

  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const names: string[] = [];
      bindingNames(node.name, names);
      if (ts.isCatchClause(node.parent)) declare(node.parent, names);
      else {
        const list = node.parent as ts.VariableDeclarationList;
        const blockScoped = (list.flags & ts.NodeFlags.BlockScoped) !== 0;
        declare(blockScoped ? nearest(list.parent, false) : nearest(list.parent, true), names);
      }
    } else if (ts.isParameter(node)) {
      const names: string[] = [];
      bindingNames(node.name, names);
      declare(node.parent, names);
    } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) declare(nearest(node.parent, false), [node.name.text]);
    } else if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
      if (node.name) declare(node, [node.name.text]);
    } else if (ts.isImportClause(node)) {
      const names: string[] = [];
      if (node.name) names.push(node.name.text);
      const nb = node.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) names.push(nb.name.text);
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.push(el.name.text);
      declare(sf, names);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const resolves = (id: ts.Identifier): boolean => {
    const name = id.text;
    let n: ts.Node | undefined = id.parent;
    while (n) {
      const s = scopes.get(n);
      if (s?.names.has(name)) return true;
      if (name === 'arguments' && scopeKindOf(n) === ScopeKind.Function && n.kind !== ts.SyntaxKind.ArrowFunction && n !== sf) return true;
      n = n.parent;
    }
    return false;
  };

  const out: FreeIdentifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isNonReference(node) && !allowed.has(node.text) && !resolves(node)) {
      out.push({ name: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
