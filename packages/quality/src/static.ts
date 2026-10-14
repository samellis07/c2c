/**
 * Quality gate Q2: generated code compiles.
 *
 *   1. `node --check` on every generated .mjs / .js.
 *   2. Free identifiers (scope.ts): a reference with no binding in scope and
 *      not an allowed global for the module kind.
 *   3. `tsc --checkJs --noEmit` over server and client handler modules, with
 *      the shim surface typed by the declarations tsc emits for packages/shims
 *      (dist/shims/src/*.d.ts, generated from source). Each exported
 *      `function name(ctx, ...)` gets a JSDoc `ShimContext` type for `ctx`, so a
 *      wrong shim member or arity is a type error.
 *
 * Counts only leave this module through the report; `details` stays in memory.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { markProgress } from './heartbeat.js';
import type { GeneratedModule, GeneratedTree, ModuleKind } from './modules.js';
import { BROWSER_GLOBALS, COMMONJS_GLOBALS, ES_GLOBALS, NODE_GLOBALS, freeIdentifiers } from './scope.js';

/** Repository root (holds package.json `creator-to-catalyst` with the ./shims export). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const SERVER_ALLOWED: ReadonlySet<string> = new Set([...ES_GLOBALS, ...NODE_GLOBALS]);
const COMMONJS_ALLOWED: ReadonlySet<string> = new Set([...SERVER_ALLOWED, ...COMMONJS_GLOBALS]);
const BROWSER_ALLOWED: ReadonlySet<string> = new Set([...ES_GLOBALS, ...BROWSER_GLOBALS]);

/** `path` decides CommonJS: a server `.js` / `.cjs` (the function packages carry no `"type": "module"`). */
export function allowedGlobals(kind: ModuleKind, path = ''): ReadonlySet<string> {
  if (kind !== 'server') return BROWSER_ALLOWED;
  return /\.c?js$/.test(path) ? COMMONJS_ALLOWED : SERVER_ALLOWED;
}

export interface StaticFinding {
  path: string;
  check: 'node-check' | 'free-identifier' | 'type' | 'type-advisory' | 'template-type';
  /** Identifier name, or `TS<code>`, or `syntax`. */
  key: string;
  line?: number;
  message?: string;
}

export interface CompilesReport {
  /** True when every count below is zero. */
  ok: boolean;
  modules: number;
  nodeCheckFailures: number;
  /** Modules scanned for free identifiers (Slate byte copies of client handlers are skipped). */
  scanned: number;
  freeIdentifiers: number;
  modulesWithFreeIdentifiers: number;
  /** Identifier name → occurrences. */
  freeByName: Record<string, number>;
  typeChecked: number;
  /** Gating type errors inside translated handler bodies (functions taking `ctx`; see isGating). */
  typeErrors: number;
  /** `TS<code>` → gating handler-body diagnostics. */
  typeByCode: Record<string, number>;
  /** Handler-body diagnostics that do not gate (dynamic-value arithmetic and inference). */
  typeAdvisories: number;
  /**
   * Type errors in template code outside handler bodies (request wrappers,
   * JSON policy literals). Reported, not gating: most are checkJs literal
   * widening, not runtime faults.
   */
  templateTypeErrors: number;
}

/** Write a generated tree to a fresh temp dir with `creator-to-catalyst` resolvable. Caller removes it. */
export function materialize(tree: GeneratedTree, prefix = 'c2c-quality-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const file of tree.files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.data);
  }
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(REPO_ROOT, join(dir, 'node_modules', 'creator-to-catalyst'), 'dir');
  return dir;
}

function nodeCheck(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--check', file], { encoding: 'utf8' }, (err, _out, stderr) => {
      markProgress();
      resolve(err ? (stderr || String(err)).split('\n').find((l) => /Error/.test(l)) ?? 'syntax' : null);
    });
  });
}

async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const CTX_FN = /^(export (?:default )?(?:async )?function\s+\w*\s*\(\s*)ctx\b/gm;
const SHIM_TYPE = 'import("creator-to-catalyst/shims").ShimContext';

/** Same text and line count, with `ctx` typed on exported functions. */
export function withCtxTypes(text: string): string {
  return text.replace(CTX_FN, (_m, head: string) => `/** @param {${SHIM_TYPE}} ctx */ ${head}ctx`);
}

let libCache: Map<string, ts.SourceFile | undefined> | undefined;

/** tsc --checkJs --noEmit over `paths` (relative to dir) with injected ctx types. */
export interface TypeDiagnostic {
  path: string;
  code: number;
  line: number;
  message: string;
  /** Inside a function whose first parameter is `ctx` (translated Deluge). Template code is outside. */
  inHandler: boolean;
}

function handlerRanges(sf: ts.SourceFile): [number, number][] {
  const out: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body) {
      const first = node.parameters[0];
      if (first && ts.isIdentifier(first.name) && first.name.text === 'ctx') out.push([node.body.pos, node.body.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * `node`: Catalyst function code, Node typings and no DOM. `dom`: client
 * handlers, DOM typings and no @types/node, so `process` or `Buffer` in a
 * client module is TS2304 (it throws in the browser).
 */
export type TypeEnv = 'node' | 'dom';

export function typecheck(dir: string, paths: readonly string[], env: TypeEnv = 'node'): TypeDiagnostic[] {
  if (paths.length === 0) return [];
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: env === 'dom' ? ['lib.es2022.d.ts', 'lib.dom.d.ts'] : ['lib.es2022.d.ts'],
    types: env === 'dom' ? [] : ['node'],
    typeRoots: [join(REPO_ROOT, 'node_modules', '@types')],
    skipLibCheck: true,
  };
  const roots = paths.map((p) => join(dir, p));
  const rootSet = new Set(roots);
  const host = ts.createCompilerHost(options, true);
  const baseGet = host.getSourceFile.bind(host);
  const baseRead = host.readFile.bind(host);
  libCache ??= new Map();
  const cache = libCache;
  host.readFile = (file) => {
    const text = baseRead(file);
    return text !== undefined && rootSet.has(file) ? withCtxTypes(text) : text;
  };
  host.getSourceFile = (file, lang, onError, create) => {
    if (rootSet.has(file)) {
      const text = host.readFile(file);
      return text === undefined ? undefined : ts.createSourceFile(file, text, lang, true, ts.ScriptKind.JS);
    }
    if (file.startsWith(dir)) return baseGet(file, lang, onError, create);
    if (!cache.has(file)) cache.set(file, baseGet(file, lang, onError, create));
    return cache.get(file);
  };
  const program = ts.createProgram({ rootNames: roots, options, host });
  const out: TypeDiagnostic[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!rootSet.has(sf.fileName)) continue;
    const ranges = handlerRanges(sf);
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
    for (const d of diags) {
      const start = d.start ?? -1;
      const line = d.file && start >= 0 ? d.file.getLineAndCharacterOfPosition(start).line + 1 : 0;
      out.push({
        path: sf.fileName.slice(dir.length + 1),
        code: d.code,
        line,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        inHandler: ranges.some(([a, b]) => start >= a && start < b),
      });
    }
  }
  return out;
}

/**
 * Handler-body diagnostics that gate Q2: an unbound name, a member the typed
 * surface does not have, a wrong arity, a wrong argument type, or a
 * temporal-dead-zone initialization. Arithmetic and comparison on values the
 * shim types as `unknown` (TS2362, TS2363, TS2365, TS2367), and assignability
 * of JS-inferred locals (TS2322, TS2403, TS2740), are advisories: checkJs
 * cannot type Deluge's dynamic values, so they are not evidence of a fault.
 */
export const GATING_CODES: ReadonlySet<number> = new Set([
  2304, 2552, 2339, 2551, 2554, 2555, 2556, 2345, 2349, 2351, 2481, 2448,
  // "Cannot find name 'process'. Do you need to install type definitions for node?" and kin.
  2580, 2581, 2582, 2583, 2584, 2591, 2592, 2593,
]);

export function isGating(code: number, message: string): boolean {
  if (code < 2000) return true;
  if (!GATING_CODES.has(code)) return false;
  const first = message.split('\n')[0]!;
  if ((code === 2339 || code === 2551) && /on type 'unknown'/.test(first)) return false;
  if (code === 2345 && /^Argument of type '(unknown|any)'/.test(first)) return false;
  return true;
}

/** Modules the type pass covers: server and client handler code, not Slate copies or the UI runtime. */
export function typedModules(modules: readonly GeneratedModule[]): GeneratedModule[] {
  return modules.filter((m) => !m.copyOf && m.kind !== 'ui');
}

export async function checkCompiles(
  tree: GeneratedTree,
  opts: { dir?: string; concurrency?: number } = {},
): Promise<{ report: CompilesReport; details: StaticFinding[] }> {
  const dir = opts.dir ?? materialize(tree);
  const details: StaticFinding[] = [];
  try {
    const modules = tree.modules;
    const checks = await pool(modules, opts.concurrency ?? 8, (m) => nodeCheck(join(dir, m.path)));
    checks.forEach((msg, i) => {
      if (msg !== null) details.push({ path: modules[i]!.path, check: 'node-check', key: 'syntax', message: msg });
    });

    const scanned = modules.filter((m) => !m.copyOf);
    const freeByName: Record<string, number> = {};
    let free = 0;
    let withFree = 0;
    for (const m of scanned) {
      const found = freeIdentifiers(m.text, allowedGlobals(m.kind, m.path), m.path);
      if (found.length) withFree++;
      for (const f of found) {
        free++;
        freeByName[f.name] = (freeByName[f.name] ?? 0) + 1;
        details.push({ path: m.path, check: 'free-identifier', key: f.name, line: f.line });
      }
    }

    const typed = typedModules(modules);
    const typeByCode: Record<string, number> = {};
    const all = [
      ...typecheck(
        dir,
        typed.filter((m) => m.kind === 'server').map((m) => m.path),
        'node',
      ),
      ...typecheck(
        dir,
        typed.filter((m) => m.kind !== 'server').map((m) => m.path),
        'dom',
      ),
    ];
    const diags = all.filter((d) => d.inHandler && isGating(d.code, d.message));
    let advisories = 0;
    for (const d of all) {
      const key = `TS${d.code}`;
      const gating = d.inHandler && isGating(d.code, d.message);
      if (gating) typeByCode[key] = (typeByCode[key] ?? 0) + 1;
      else if (d.inHandler) advisories++;
      details.push({ path: d.path, check: gating ? 'type' : d.inHandler ? 'type-advisory' : 'template-type', key, line: d.line, message: d.message });
    }

    const nodeCheckFailures = checks.filter((c) => c !== null).length;
    const report: CompilesReport = {
      ok: nodeCheckFailures === 0 && free === 0 && diags.length === 0,
      modules: modules.length,
      nodeCheckFailures,
      scanned: scanned.length,
      freeIdentifiers: free,
      modulesWithFreeIdentifiers: withFree,
      freeByName: sortedCounts(freeByName),
      typeChecked: typed.length,
      typeErrors: diags.length,
      typeByCode: sortedCounts(typeByCode),
      typeAdvisories: advisories,
      templateTypeErrors: all.length - diags.length - advisories,
    };
    return { report, details };
  } finally {
    if (!opts.dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** Keys by count descending, then name, so JSON output is stable. */
export function sortedCounts(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) out[k] = v;
  return out;
}
