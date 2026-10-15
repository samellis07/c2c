/**
 * The deployable Catalyst function directory: functions/c2c_api/.
 *
 * One Advanced I/O function serves every generated endpoint. Its folder holds
 * catalyst-config.json (deployment + execution), package.json with exact pins,
 * index.js (the module.exports(req, res) entry), routes.json, the principal
 * resolver, the zcatalyst-sdk datastore adapter, and the generated handlers.
 * The shims are vendored into vendor/shims (an ES module package), so no
 * handler imports the creator-to-catalyst workspace package.
 *
 * Every byte comes from the generator, the compiled shims, packages/deploy/fn, and the
 * console environment the user passes to keep (FunctionDirOptions.env).
 * Nothing reads the clock or the environment, so two runs write identical trees.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zohoConnectionHostModuleSource } from '../../core/src/dc.js';
import { limitValue } from '../../schema/src/limits.js';
import { API_FUNCTION } from '../../ui/src/generate.js';

export { API_FUNCTION };
export const FUNCTION_DIR = `functions/${API_FUNCTION}`;
export const SHIMS_IMPORT = 'creator-to-catalyst/shims';
/** Catalyst runtime stack for catalyst-config.json; the generator's toolchain pins Node 20. */
export const FUNCTION_STACK = 'node20';
/**
 * Exact dependency pins. zcatalyst-sdk-node 3.4.0 was dist-tags.latest in the npm
 * registry when pinned; the tarball
 * integrity is sha512-+hjLHve+BeQdSd9rt8MgugMrfVKfBO9kZO58e+Uwakmn7SrasqOJDyWffECxMAVfemMPSSQOpRx/aAbghdOQIA==.
 */
export const FUNCTION_DEPENDENCIES: Readonly<Record<string, string>> = { 'zcatalyst-sdk-node': '3.4.0' };
/**
 * Generated htmlpage endpoints re-parse their rendered HTML through parse5
 * before returning it, so a function that ships htmlpages/ handlers also
 * pins the parser. Functions without them keep FUNCTION_DEPENDENCIES only.
 */
export const HTMLPAGE_DEPENDENCIES: Readonly<Record<string, string>> = { ...FUNCTION_DEPENDENCIES, parse5: '7.3.0' };
/** The only Catalyst role -> Creator profile mapping. A role named like a profile is not mapped by its name. */
export const DEFAULT_ROLE_MAP: Readonly<Record<string, string>> = { 'App Administrator': 'Administrator', 'App User': 'User' };

const RUNTIME_ASSETS = ['index.js', 'c2c-field-values.mjs', 'c2c-principal.mjs', 'c2c-sdk-datastore.mjs'] as const;

/**
 * The shipped adapter is a runtime asset, so it cannot import the limits table.
 * Its copy of the unverified select cap is written here, at generation time,
 * from zcql.select_columns; the literal in the source file only keeps the
 * module loadable when it is imported unbundled.
 */
export function injectSelectColumnCap(source: string): string {
  const cap = `selectColumns: ${limitValue('zcql.select_columns')}`;
  const out = source.replace(/selectColumns: \d+/, cap);
  if (out === source && !source.includes(cap)) {
    throw new Error('c2c-sdk-datastore.mjs has no selectColumns entry; the select cap cannot be injected');
  }
  return out;
}

export interface FunctionFile {
  path: string;
  data: string | Buffer;
}

export interface FunctionDirOptions {
  mode: 'live' | 'dry-run';
  /** Data Store column types per table, written to c2c-columns.json for the datastore adapter. */
  columns?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * The function's console environment to keep. `catalyst deploy` replaces the console
   * environment with catalyst-config.json env_variables, so every key here is carried.
   */
  env?: Readonly<Record<string, string>>;
  /** Verified Catalyst Mail sender, set as C2C_MAIL_FROM. Absent when the owner named none. */
  mailFrom?: string;
  /** Custom Catalyst role -> Creator profile entries from the auth apply plan. Built-ins stay authoritative. */
  roleMap?: Readonly<Record<string, string>>;
  /** Spike: copy only the subset of shim modules imported by the app's generated code. Off by default. */
  subsetShims?: boolean;
}

/** Column types the adapter converts by type. Other columns are written and read as they are. */
export const TYPED_COLUMNS: readonly string[] = ['BigInt', 'Boolean', 'Date', 'DateTime', 'Double', 'Foreign Key', 'Int'];
/** Creator field types whose BigInt column holds a number, not an id. */
const NUMBER_FIELDS: readonly string[] = ['number', 'auto-number'];
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The adapter type of one column: its Data Store type, except that an Int column
 * (subform row order) and a BigInt column holding a Creator number or auto-number
 * are `Number`. ZCQL returns BigInt and Int as text, so the adapter reads a
 * `Number` column as a JS number (a bigint past 2^53) while a BigInt id (users,
 * an unresolved lookup) stays a digit string. An exact-decimal varchar (a Creator
 * decimal, currency or percent) is `Decimal`. The entry reads posted values by
 * these types too (c2c-field-values.mjs).
 */
function adapterType(column: { dataType: string; matrixId?: string; exactDecimal?: boolean }): string {
  if (column.dataType === 'Int' || (column.dataType === 'BigInt' && NUMBER_FIELDS.includes(column.matrixId ?? ''))) return 'Number';
  if (column.exactDecimal) return 'Decimal';
  return column.dataType;
}

/** { table: { column: type } } for the typed columns of every Data Store (not NoSQL) table, keys sorted. */
export function columnTypes(
  tables: readonly { name: string; nosql: boolean; columns: readonly { name: string; dataType: string; matrixId?: string; exactDecimal?: boolean }[] }[],
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const table of [...tables].sort((a, b) => byPath(a.name, b.name))) {
    if (table.nosql) continue;
    const typed = table.columns.filter((column) => TYPED_COLUMNS.includes(column.dataType) || column.exactDecimal).sort((a, b) => byPath(a.name, b.name));
    const entry: Record<string, string> = {};
    for (const column of typed) entry[column.name] = adapterType(column);
    out[table.name] = entry;
  }
  return out;
}

/**
 * catalyst-config.json env_variables: the kept console environment plus C2C_DEPLOY_MODE,
 * which this deploy always sets. Keys sorted, so the bytes do not depend on input order.
 */
export function envVariables(mode: 'live' | 'dry-run', env: Readonly<Record<string, string>> = {}): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(env).sort(([a], [b]) => byPath(a, b))) {
    if (!ENV_KEY.test(key)) throw new Error(`function env: ${JSON.stringify(key)} is not an environment variable name`);
    if (typeof value !== 'string') throw new Error(`function env: ${key} must be a string`);
    merged[key] = value;
  }
  merged.C2C_DEPLOY_MODE = mode;
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(merged).sort(byPath)) ordered[key] = merged[key] as string;
  return ordered;
}

function here(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function assetDir(): string {
  const candidates = [join(here(), 'fn'), join(here(), '../fn'), join(here(), '../../../packages/deploy/fn')];
  for (const dir of candidates) if (existsSync(join(dir, 'index.js'))) return dir;
  throw new Error('function runtime assets missing (packages/deploy/fn)');
}

function shimsDir(): string {
  const dir = join(here(), '../../shims/src');
  if (!existsSync(join(dir, 'index.js'))) throw new Error('compiled shims missing; run npm run build');
  return dir;
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const CORE_DC_SPEC = /from (['"])(?:\.\.\/)+core\/src\/dc\.js\1/g;

/**
 * Compute the subset of compiled shim modules imported by an app's generated
 * function files, including transitive dependencies between shims.
 * Returns null when imports cannot be resolved safely (failing closed to copying all shims).
 */
export function computeShimModules(generated: readonly FunctionFile[], dir = shimsDir()): Set<string> | null {
  const indexFile = join(dir, 'index.js');
  if (!existsSync(indexFile)) return null;
  const indexContent = readFileSync(indexFile, 'utf8');

  // Map each symbol exported by index.js to its defining module (.js)
  const symbolToModule: Record<string, string> = {};
  const exportRegex = /export\s*\{([^}]+)\}\s*from\s*['"]\.\/([a-z0-9\-]+)(?:\.js)?['"]/g;
  for (const match of indexContent.matchAll(exportRegex)) {
    const mod = `${match[2]}.js`;
    const syms = match[1]!
      .split(',')
      .map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean);
    for (const sym of syms) {
      symbolToModule[sym] = mod;
    }
  }

  const allShimNames = readdirSync(dir).filter((name) => name.endsWith('.js') && name !== 'index.js');

  // Dependency map between shim modules
  const shimDeps: Record<string, string[]> = {};
  for (const name of allShimNames) {
    const content = readFileSync(join(dir, name), 'utf8');
    const matches = [...content.matchAll(/from\s+['"]\.\/([a-z0-9\-]+)(?:\.js)?['"]/g)];
    shimDeps[name] = [...new Set(matches.map((m) => `${m[1]}.js`))].sort();
  }

  const directRoots = new Set<string>();

  // fn/index.js imports this module when mapping datastore errors to HTTP errors.
  directRoots.add('store-errors.js');

  // If write rules are present in the deployed function, fn/index.js loads write-rules.js
  if (generated.some((f) => f.path.endsWith('c2c-rules.json'))) {
    directRoots.add('write-rules.js');
  }

  for (const file of generated) {
    if (!file.path.endsWith('.mjs') && !file.path.endsWith('.js')) continue;
    if (typeof file.data !== 'string') continue;
    const text = file.data;

    // Check dynamic imports: fail closed if an argument could refer to shims.
    const dynMatches = [...text.matchAll(/import\s*\(([\s\S]*?)\)/g)];
    for (const m of dynMatches) {
      const arg = m[1]!.trim();
      const isKnownStatic =
        arg === 'spec' ||
        arg === '"zcatalyst-sdk-node"' ||
        arg === "'zcatalyst-sdk-node'" ||
        /^["']\.\.?\/[a-zA-Z0-9_\-\.\/]+\.mjs["']$/.test(arg);
      if (!isKnownStatic) return null;
    }

    // Check static named imports from creator-to-catalyst/shims or vendor/shims/index.js.
    // Any other occurrence of the package specifier below fails closed, including
    // re-exports, require(), side-effect imports, and namespace/default imports.
    const staticImports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:creator-to-catalyst\/shims|(?:\.\.?\/)*vendor\/shims(?:\/index(?:\.js)?)?)['"]/g)];
    const unparsedSpecifiers = text.replace(
      /import\s*\{[^}]*\}\s*from\s*['"](?:creator-to-catalyst\/shims|(?:\.\.?\/)*vendor\/shims(?:\/index(?:\.js)?)?)['"]/g,
      '',
    );
    if (unparsedSpecifiers.includes(SHIMS_IMPORT)) return null;
    if (/['"](?:\.\.?\/)*vendor\/shims(?:\/index(?:\.js)?)?['"]/.test(unparsedSpecifiers)) return null;
    for (const m of staticImports) {
      const syms = m[1]!
        .split(',')
        .map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim())
        .filter(Boolean);
      for (const sym of syms) {
        const mod = symbolToModule[sym];
        if (!mod || !allShimNames.includes(mod)) return null;
        directRoots.add(mod);
      }
    }

    // Check direct imports of vendor/shims or creator-to-catalyst/shims
    const directShims = [...text.matchAll(/from\s*['"](?:(?:\.\.?\/)+vendor\/shims\/|vendor\/shims\/|creator-to-catalyst\/shims\/)([a-z0-9\-]+)(?:\.js)?['"]/g)];
    for (const m of directShims) {
      const mod = `${m[1]}.js`;
      if (!allShimNames.includes(mod)) return null;
      directRoots.add(mod);
    }
  }

  // Transitive closure
  const closure = new Set<string>(directRoots);
  const queue = [...directRoots].sort();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const deps = shimDeps[cur] ?? [];
    for (const dep of deps) {
      if (!closure.has(dep)) {
        closure.add(dep);
        queue.push(dep);
      }
    }
  }

  return closure;
}

/**
 * Compiled shims, without source-map comments (the maps are not shipped).
 * When `modules` is specified, only that subset of modules is shipped (plus index.js
 * filtered to re-export only the shipped modules).
 * A shim that imports the DC table is rewritten onto a vendored copy of that
 * table so the function bundle does not import packages/core.
 */
export function vendoredShims(modules?: ReadonlySet<string>): FunctionFile[] {
  const dir = shimsDir();
  const allNames = readdirSync(dir).filter((name) => name.endsWith('.js')).sort(byPath);
  const names = modules ? allNames.filter((name) => name === 'index.js' || modules.has(name)) : allNames;
  let needsDcTable = false;
  const files: FunctionFile[] = [];

  for (const name of names) {
    let data = readFileSync(join(dir, name), 'utf8').replace(/\n\/\/# sourceMappingURL=[^\n]*\n?$/, '\n');
    if (name === 'index.js' && modules) {
      const keptLines: string[] = [];
      for (const line of data.split('\n')) {
        const match = /export\s*\{[\s\S]*?\}\s*from\s*['"]\.\/([a-z0-9\-]+)(?:\.js)?['"]/.exec(line);
        if (match) {
          const mod = `${match[1]}.js`;
          if (modules.has(mod)) keptLines.push(line);
        }
      }
      data = keptLines.length ? `${keptLines.join('\n')}\n` : 'export {};\n';
    }
    if (data.includes('/core/src/dc.js')) {
      needsDcTable = true;
      data = data.replace(CORE_DC_SPEC, 'from $1./zoho-dc-table.js$1');
    }
    files.push({ path: `vendor/shims/${name}`, data });
  }

  if (needsDcTable) {
    files.push({ path: 'vendor/shims/zoho-dc-table.js', data: zohoConnectionHostModuleSource() });
  }
  files.push({ path: 'vendor/shims/package.json', data: `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n` });
  return files;
}

/** Rewrite the workspace import to the vendored copy, relative to the file inside the function folder. */
export function rewriteShimsImport(source: string, fileInFunction: string): string {
  const from = posix.dirname(fileInFunction);
  let spec = posix.relative(from, 'vendor/shims/index.js');
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return source.split(`"${SHIMS_IMPORT}"`).join(JSON.stringify(spec)).split(`'${SHIMS_IMPORT}'`).join(JSON.stringify(spec));
}

/**
 * "METHOD /path" -> module, from each handler's exported endpoint.
 * Parameterised paths ("/lookups/:form/:field") are kept verbatim: the entry
 * matches `:param` segments and hands them to the handler as req.params.
 * Dropping them unroutes lookups, so every lookup select stays empty.
 */
export function routeTable(files: readonly FunctionFile[]): Record<string, string> {
  const routes: Record<string, string> = {};
  const sorted = [...files].sort((a, b) => byPath(a.path, b.path));
  const add = (method: string, path: string, spec: string) => {
    if (!path.startsWith('/')) return;
    const key = `${method} ${path}`;
    if (!(key in routes)) routes[key] = spec;
  };
  for (const file of sorted) {
    if (!file.path.endsWith('.mjs') || typeof file.data !== 'string') continue;
    const spec = `./${file.path}`;
    const line = /^export const endpoint = \{([^\n]*)\};$/m.exec(file.data)?.[1];
    if (line) {
      const method = /\bmethod:\s*"([A-Z]+)"/.exec(line)?.[1] ?? 'POST';
      // `path` is the primary route; `paths` adds aliases (a state machine's
      // /flows/<name>/approve|reject|transition suffixes route to one module).
      // Parameterised paths stay: the entry matches :param segments.
      const paths = [/\bpath:\s*"([^"]+)"/.exec(line)?.[1]];
      const extra = /\bpaths:\s*\[([^\]]*)\]/.exec(line)?.[1];
      if (extra) for (const match of extra.matchAll(/"([^"]+)"/g)) paths.push(match[1]);
      for (const path of paths) {
        if (path) add(method, path, spec);
      }
    }
    // A state machine declares its approve/reject/transition paths on the
    // exported machine object; its default export dispatches on the suffix.
    const machine = /^export const machine = (\{[\s\S]*?\n\});$/m.exec(file.data)?.[1];
    if (machine) {
      try {
        const parsed = JSON.parse(machine) as { endpoints?: Record<string, unknown> };
        const endpoints = parsed.endpoints ?? {};
        for (const key of Object.keys(endpoints).sort()) {
          const value = endpoints[key];
          if (typeof value === 'string') add('POST', value, spec);
        }
      } catch {
        /* a malformed machine literal is not a route source */
      }
    }
  }
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(routes).sort(byPath)) ordered[key] = routes[key] as string;
  return ordered;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Build functions/c2c_api from the generated functions/* files (paths relative to the
 * project root). Returns project-root paths.
 */
export function functionDir(generated: readonly FunctionFile[], opts: FunctionDirOptions): FunctionFile[] {
  const inner: FunctionFile[] = [];
  for (const file of generated) {
    if (!file.path.startsWith('functions/')) continue;
    const rel = file.path.slice('functions/'.length);
    if (rel === 'manifest.json') continue;
    let data = file.data;
    if (rel === 'c2c-deploy.json' && typeof data === 'string') {
      data = json({ ...(JSON.parse(data) as Record<string, unknown>), mode: opts.mode });
    } else if (typeof data === 'string' && rel.endsWith('.mjs')) {
      data = rewriteShimsImport(data, rel);
    }
    inner.push({ path: rel, data });
  }
  for (const file of inner) {
    if (typeof file.data === 'string' && file.data.includes(SHIMS_IMPORT)) {
      throw new Error(`${file.path} still imports ${SHIMS_IMPORT}`);
    }
  }
  const assets = assetDir();
  for (const name of RUNTIME_ASSETS) {
    let data = readFileSync(join(assets, name), 'utf8');
    if (name === 'c2c-sdk-datastore.mjs') data = injectSelectColumnCap(data);
    inner.push({ path: name, data });
  }
  const subset = opts.subsetShims ?? false;
  let shims: FunctionFile[];
  if (subset) {
    const modules = computeShimModules(generated);
    shims = modules ? vendoredShims(modules) : vendoredShims();
  } else {
    shims = vendoredShims();
  }
  inner.push(...shims);
  inner.push({ path: 'routes.json', data: json(routeTable(inner)) });
  const extra = opts.roleMap ?? {};
  const merged: Record<string, string> = {};
  for (const key of Object.keys(extra).sort(byPath)) merged[key] = extra[key] as string;
  for (const key of Object.keys(DEFAULT_ROLE_MAP).sort(byPath)) merged[key] = DEFAULT_ROLE_MAP[key] as string;
  const roles: Record<string, string> = {};
  for (const key of Object.keys(merged).sort(byPath)) roles[key] = merged[key] as string;
  inner.push({ path: 'principal-map.json', data: json({ roles }) });
  inner.push({ path: 'c2c-columns.json', data: json(opts.columns ?? {}) });
  inner.push({
    path: 'catalyst-config.json',
    data: json({
      deployment: {
        name: API_FUNCTION,
        stack: FUNCTION_STACK,
        type: 'advancedio',
        // The verified sender (--mail-from) is set by this deploy, like C2C_DEPLOY_MODE; without it a kept console C2C_MAIL_FROM stays.
        env_variables: envVariables(opts.mode, { ...opts.env, ...(opts.mailFrom ? { C2C_MAIL_FROM: opts.mailFrom } : {}) }),
      },
      execution: { main: 'index.js' },
    }),
  });
  inner.push({
    path: 'package.json',
    data: json({
      name: API_FUNCTION,
      version: '1.0.0',
      private: true,
      main: 'index.js',
      dependencies: inner.some((file) => file.path.startsWith('htmlpages/')) ? HTMLPAGE_DEPENDENCIES : FUNCTION_DEPENDENCIES,
    }),
  });
  // The function ships its lockfile, so the transitive dependencies pinned in
  // packages/deploy/fn/package-lock.json are what deploys — nothing floats.
  // The lock root carries the same name, version, and exact pins as
  // package.json above; the grep gate in test/function-dir.test.ts enforces it.
  const htmlpages = inner.some((file) => file.path.startsWith('htmlpages/'));
  inner.push({ path: 'package-lock.json', data: readFileSync(join(assets, htmlpages ? 'package-lock-htmlpage.json' : 'package-lock.json'), 'utf8') });
  const paths = inner.map((file) => file.path).sort(byPath);
  inner.push({ path: 'c2c-manifest.json', data: json({ function: API_FUNCTION, files: paths }) });
  return inner
    .sort((a, b) => byPath(a.path, b.path))
    .map((file) => ({ path: `${FUNCTION_DIR}/${file.path}`, data: file.data }));
}
