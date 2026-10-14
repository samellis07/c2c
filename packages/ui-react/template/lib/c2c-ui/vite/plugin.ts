/**
 * Build-time guarantees for a generated app, as one Vite plugin:
 *
 * 1. Bundle contract. The build emits one entry module (assets/runtime.<hash>.js)
 *    that exports boot(spec, document) and imports the app spec from the model
 *    module, assets/model.<hash>.js, which exports `model`. Heavy field widgets
 *    sit in deferred chunks the entry reaches only through import(), so the
 *    boot graph stays lean; every other chunk is a lazy one. A harness can load
 *    the entry and model modules and boot the app into any document; the UI
 *    scorer does exactly that.
 * 2. Bundle budget. Gzipped JavaScript the entry loads eagerly (entry, model
 *    and the chunks they statically import) plus all CSS must stay under the
 *    budget, or the build fails. For the sample apps in
 *    route-chunk-budgets.json (built with C2C_BUDGET_STRICT=1) every emitted
 *    chunk must also match a budget entry by its stable route name, without
 *    the content hash: an unbudgeted, over-budget or missing chunk fails the
 *    build with the chunk name and size. dist/c2c-build.json records the
 *    sizes.
 * 3. Offline. dist/sw.js is the c2c service worker (same rules as the vanilla
 *    target: network-first shell, cache-first hashed assets, never the sign-in,
 *    SDK or API paths) with this build's precache list and cache id.
 *
 * 4. index.html. The build input is src/main.tsx (an HTML entry would hide the
 *    entry's exports behind a facade module), so the plugin writes
 *    dist/index.html from the source index.html: the dev script tag becomes the
 *    hashed runtime and the stylesheet link is added.
 *
 * Everything here is deterministic: no clock, no randomness, sorted lists.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Plugin, ResolvedConfig } from 'vite';

export interface Budget {
  /** Gzipped bytes of the JavaScript the entry loads eagerly; deferred widget chunks do not count. */
  js: number;
  /** Gzipped bytes of all CSS. */
  css: number;
}

// Aggregate ceiling for arbitrary apps; sample apps also have per-chunk gates below.
export const DEFAULT_BUDGET: Budget = { js: 224 * 1024, css: 28 * 1024 };
/**
 * Per-chunk gzip budgets, reviewed as one file: route-chunk-budgets.json is the
 * only budget source, no tool rewrites it, and raising a budget means editing
 * that file in a reviewed pull request (see CONTRIBUTING.md, "Bundle budget").
 * `samples` names the repository apps the CI check builds with the strict
 * gate: every emitted chunk must be budgeted and every budgeted chunk emitted.
 */
interface RouteChunkBudgets {
  version: number;
  tolerance: number;
  samples: string[];
  chunks: Record<string, number>;
}

export const ROUTE_CHUNK_BUDGETS: RouteChunkBudgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('./route-chunk-budgets.json', import.meta.url)), 'utf8'),
) as RouteChunkBudgets;

function stableChunkName(fileName: string): string {
  return fileName.replace(/\.[A-Za-z0-9_-]{8}(?=\.(?:js|css)$)/, '');
}

/**
 * The strict per-chunk gate, applied to the budget file's sample apps. Every
 * emitted chunk must have a budget entry (matched by stable route name, not
 * the content hash), every budgeted chunk must be emitted, and no chunk may
 * exceed its budget by more than `tolerance`. Arbitrary apps are not gated
 * per chunk — their chunk mix differs from the samples by design; the
 * aggregate DEFAULT_BUDGET ceiling still applies to every build.
 */
export function chunkBudgetProblems(
  sizes: Record<string, number>,
  budgets: RouteChunkBudgets = ROUTE_CHUNK_BUDGETS,
): string[] {
  const stableSizes = Object.fromEntries(Object.entries(sizes).map(([name, size]) => [stableChunkName(name.split('/').pop() ?? name), size]));
  const problems: string[] = [];
  for (const [name, actual] of Object.entries(stableSizes).sort(([a], [b]) => a.localeCompare(b))) {
    const limit = budgets.chunks[name];
    if (limit === undefined) {
      problems.push(`unbudgeted route chunk ${name} (${actual} bytes gzipped)`);
    } else if (actual > limit * (1 + budgets.tolerance)) {
      problems.push(`${name} is ${actual} bytes gzipped, over its ${limit} byte budget by more than 5%`);
    }
  }
  for (const name of Object.keys(budgets.chunks).sort()) {
    if (stableSizes[name] === undefined) problems.push(`missing budgeted route chunk ${name}`);
  }
  return problems;
}

/** Files under public/ that keep a stable URL and are not precached: c2c deploy rewrites them. */
const STABLE = new Set(['c2c-config.js']);

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

function publicFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path).split('\\').join('/'));
    }
  };
  try {
    walk(dir);
  } catch {
    return [];
  }
  return out;
}

export function c2cBuild(opts: { budget?: Budget; swTemplate: string }): Plugin {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  let config: ResolvedConfig;
  return {
    name: 'c2c-build',
    enforce: 'post',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    generateBundle(_options, bundle) {
      const sourceHtml = readFileSync(join(config.root, 'index.html'), 'utf8');
      const chunks = Object.values(bundle).filter((file) => file.type === 'chunk');
      const entries = chunks.filter((chunk) => chunk.type === 'chunk' && chunk.isEntry);
      const models = chunks.filter((chunk) => /(^|\/)model\.[^/]+\.js$/.test(chunk.fileName));
      const problems: string[] = [];
      if (entries.length !== 1) problems.push(`expected one entry chunk, found ${entries.length}`);
      if (models.length !== 1) problems.push(`expected one model chunk, found ${models.length}`);
      const entry = entries[0];
      const model = models[0];
      // One canonical spelling for the spec import, whatever the minifier wrote (runs after minification).
      if (entry && entry.type === 'chunk') entry.code = entry.code.replace(/from\s*"\.\/(model\.[^"]+\.js)"/g, 'from "./$1"');
      if (entry && entry.type === 'chunk') {
        if (!entry.exports.includes('boot')) problems.push('the entry does not export boot');
        const relativeImports = [...entry.code.matchAll(/(?:from|import)\s*"(\.\/[^"]+)"/g)].map((m) => m[1]!);
        const modelName = model ? `./${model.fileName.split('/').pop()}` : undefined;
        if (!modelName || !relativeImports.includes(modelName)) {
          problems.push(`the entry must import the model module, found ${relativeImports.join(', ') || 'none'}`);
        }
      }
      if (model && model.type === 'chunk' && !model.exports.includes('model')) problems.push('the model module does not export model');
      // The boot graph is the entry plus every chunk it statically imports
      // (model and any code shared with lazy chunks). Everything else is
      // deferred widget code loaded through import().
      const eager = new Set<string>();
      const visit = (name: string) => {
        if (eager.has(name)) return;
        eager.add(name);
        for (const dep of chunks.find((chunk) => chunk.fileName === name)?.imports ?? []) visit(dep);
      };
      if (entry) visit(entry.fileName);

      let js = 0;
      let deferredJs = 0;
      let css = 0;
      const sizes: Record<string, number> = {};
      for (const file of Object.values(bundle)) {
        const data = file.type === 'chunk' ? file.code : file.source;
        if (!/\.(js|css)$/.test(file.fileName)) continue;
        const gz = gzipSync(typeof data === 'string' ? Buffer.from(data) : Buffer.from(data), { level: 9 }).length;
        sizes[file.fileName] = gz;
        if (file.fileName.endsWith('.js')) {
          if (eager.has(file.fileName)) js += gz;
          else deferredJs += gz;
        } else css += gz;
      }
      // C2C_BUDGET_STRICT=1 (set by tools/ui-react-check.mjs for the budget
      // file's `samples`) gates every emitted chunk against the budgets.
      if (process.env.C2C_BUDGET_STRICT === '1') problems.push(...chunkBudgetProblems(sizes));
      if (js > budget.js) problems.push(`JavaScript is ${js} bytes gzipped, over the ${budget.js} byte budget`);
      if (css > budget.css) problems.push(`CSS is ${css} bytes gzipped, over the ${budget.css} byte budget`);
      const styles = Object.values(bundle).filter((file) => file.type === 'asset' && file.fileName.endsWith('.css')).map((file) => file.fileName).sort();
      const devScript = /<script type="module" src="\/src\/main\.tsx"><\/script>/;
      if (!devScript.test(sourceHtml)) problems.push('index.html must load /src/main.tsx with one module script');
      if (problems.length) this.error(`c2c build contract:\n- ${problems.join('\n- ')}`);
      const links = styles.map((name) => `<link rel="stylesheet" href="/${name}" />`).join('\n    ');
      const indexText = sourceHtml
        .replace(devScript, `<script type="module" src="/${entry!.fileName}"></script>`)
        .replace('</head>', `  ${links}\n  </head>`);
      this.emitFile({ type: 'asset', fileName: 'index.html', source: indexText });

      // Service worker: precache every emitted file and the public files, except stable-URL config.
      const emitted = Object.keys(bundle).filter((name) => name !== 'index.html');
      const extra = publicFiles(config.publicDir).filter((name) => !STABLE.has(name));
      const precache = [...new Set([...emitted, ...extra])].map((name) => `./${name}`).sort();
      precache.push('./index.html');
      const cacheId = sha(`${sha(opts.swTemplate)}\n${sha(indexText)}\n${precache.join('\n')}`).slice(0, 10);
      const sw = opts.swTemplate
        .replaceAll('@@precache@@', JSON.stringify(precache))
        .replaceAll('@@cache@@', cacheId)
        .replaceAll('@@index@@', sha(indexText));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
      const report = { budget, routeChunkBudget: ROUTE_CHUNK_BUDGETS, gzip: { js, deferredJs, css }, files: Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => (a < b ? -1 : 1))) };
      this.emitFile({ type: 'asset', fileName: 'c2c-build.json', source: `${JSON.stringify(report, null, 2)}\n` });
    },
  };
}

export function readSwTemplate(path: string): string {
  return readFileSync(path, 'utf8');
}
