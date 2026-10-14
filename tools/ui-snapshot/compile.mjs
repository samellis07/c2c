/**
 * Compile step for the ui-snapshot harness. The template library
 * (packages/ui-react/template/lib/c2c-ui) and one app's generated modules are
 * transpiled with the repo's own TypeScript (no bundler, no browser) into a
 * temp dir, so the snapshots render the same bytes a generated app ships.
 * Bare imports (react, lucide-react, motion, radix) resolve through a
 * node_modules symlink at the compile root; .css imports become a stub module
 * (jsdom has no stylesheet cascade — the snapshot records the final class
 * attributes instead).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

export const TEMPLATE_DIR = new URL('../../packages/ui-react/template/', import.meta.url);
export const LIB_DIR = new URL('../../packages/ui-react/template/lib/', import.meta.url);

function templatePath(...parts) {
  return join(new URL(TEMPLATE_DIR).pathname, ...parts);
}

export function templateReady() {
  const modules = templatePath('node_modules');
  return existsSync(join(modules, 'react')) && existsSync(join(modules, 'react-dom'));
}

export const MISSING_DEPS =
  'the React template runtime is not installed; run `npm ci --prefix packages/ui-react/template` (or node scripts/ensure-ui-react-template.mjs)';

function emitJs(root, outFile, sourceText, fileName) {
  const { outputText } = ts.transpileModule(sourceText, {
    fileName,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  // The css stub lives at the compile root; compute per-file relative path.
  const stub = `${relative(dirname(outFile), join(root, 'css-stub.mjs')).replace(/\\/g, '/')}`;
  const fixed = stub.startsWith('.') ? stub : `./${stub}`;
  const fix = (spec) => {
    if (spec === '@c2c/ui') {
      const to = relative(dirname(outFile), join(root, 'lib', 'c2c-ui', 'index.js')).replace(/\\/g, '/');
      return to.startsWith('.') ? to : `./${to}`;
    }
    if (spec.endsWith('.css')) return fixed;
    return /\.[a-z]+$/.test(spec) ? spec : `${spec}.js`;
  };
  const rewritten = outputText
    .replace(/^(\s*(?:import|export)\s[^'"]*?\bfrom\s*)['"](\.{1,2}\/[^'"]+|@c2c\/ui)['"]/gm, (_a, pre, spec) => `${pre}'${fix(spec)}'`)
    .replace(/^(\s*import\s*)['"](\.{1,2}\/[^'"]+)['"]/gm, (_a, pre, spec) => `${pre}'${fix(spec)}'`)
    // Dynamic imports (React.lazy): import('./path') needs the same rewrite.
    .replace(/\bimport\(\s*['"](\.{1,2}\/[^'"]+|@c2c\/ui)['"]\s*\)/g, (_a, spec) => `import('${fix(spec)}')`);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, rewritten);
}

/**
 * Compile the whole lib/c2c-ui tree plus one app's generated files
 * (from generateReactApp) into <out>. Returns { bootUrl, routesUrl }.
 */
export function compileApp(out, generatedFiles) {
  if (!templateReady()) throw new Error(MISSING_DEPS);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'css-stub.mjs'), 'export default new Proxy({}, { get: (_, key) => String(key) });\n');
  const link = join(out, 'node_modules');
  if (!existsSync(link)) symlinkSync(templatePath('node_modules'), link, 'dir');

  const walk = (dir) => {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walk(path));
      else if (/\.[jt]sx?$/.test(entry.name)) found.push(path);
    }
    return found;
  };
  const libRoot = new URL(LIB_DIR).pathname;
  for (const file of walk(libRoot)) {
    const rel = relative(libRoot, file);
    emitJs(out, join(out, 'lib', rel.replace(/\.[jt]sx?$/, '.js')), readFileSync(file, 'utf8'), file);
  }
  for (const file of generatedFiles) {
    if (!file.path.startsWith('src/generated/')) continue;
    if (!/\.[jt]sx?$/.test(file.path)) continue;
    const rel = file.path.slice('src/generated/'.length).replace(/\.[jt]sx?$/, '.js');
    emitJs(out, join(out, 'app', rel), String(file.data), file.path);
  }
  return { bootUrl: join(out, 'lib', 'c2c-ui', 'boot.js'), routesUrl: join(out, 'app', 'routes.js'), modelUrl: join(out, 'app', 'model.js') };
}
