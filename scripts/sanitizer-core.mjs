// Derives the sanitizer copies from packages/ui/src/sanitizer-core.ts, the one source:
//  - packages/ui/src/client-runtime.js carries the transpiled core between its sanitizer-core markers;
//  - the React template's pages/sanitize.ts is the core verbatim under a generated banner.
// `node scripts/sanitizer-core.mjs` rewrites both; `--check` exits 1 when either differs from the core.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CORE = join(root, 'packages/ui/src/sanitizer-core.ts');
export const RUNTIME = join(root, 'packages/ui/src/client-runtime.js');
export const REACT = join(root, 'packages/ui-react/template/lib/c2c-ui/pages/sanitize.ts');
export const BEGIN = '// <<< sanitizer-core:begin (generated from packages/ui/src/sanitizer-core.ts by scripts/sanitizer-core.mjs; edit the core, not this block) >>>';
export const END = '// <<< sanitizer-core:end >>>';

const GENERATED = '// GENERATED from packages/ui/src/sanitizer-core.ts by scripts/sanitizer-core.mjs. Do not edit: change the core and run `npm run build`.\n';

export function reactSource(core) {
  return GENERATED + core;
}

export function runtimeBlock(core) {
  const ts = createRequire(import.meta.url)('typescript');
  const js = ts.transpileModule(core, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: false } }).outputText;
  return `${BEGIN}\n${js.trimEnd()}\n${END}`;
}

export function spliceRuntime(runtime, block) {
  const a = runtime.indexOf(BEGIN);
  const b = runtime.indexOf(END);
  if (a < 0 || b < a) throw new Error('client-runtime.js has no sanitizer-core markers');
  return runtime.slice(0, a) + block + runtime.slice(b + END.length);
}

export function expected() {
  const core = readFileSync(CORE, 'utf8');
  return { runtime: spliceRuntime(readFileSync(RUNTIME, 'utf8'), runtimeBlock(core)), react: reactSource(core) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const want = expected();
  if (process.argv.includes('--check')) {
    const stale = [];
    if (readFileSync(RUNTIME, 'utf8') !== want.runtime) stale.push('packages/ui/src/client-runtime.js');
    if (readFileSync(REACT, 'utf8') !== want.react) stale.push('packages/ui-react/template/lib/c2c-ui/pages/sanitize.ts');
    if (stale.length) {
      console.error(`sanitizer copies drifted from sanitizer-core.ts: ${stale.join(', ')}; run node scripts/sanitizer-core.mjs`);
      process.exit(1);
    }
  } else {
    writeFileSync(RUNTIME, want.runtime);
    writeFileSync(REACT, want.react);
  }
}
