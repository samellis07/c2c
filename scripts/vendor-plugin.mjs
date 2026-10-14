#!/usr/bin/env node
/**
 * Build plugin/vendor/c2c from the repo after `npm ci && npm run build`.
 *
 *   node scripts/vendor-plugin.mjs [--out dir]
 *   node scripts/vendor-plugin.mjs --check-versions [--root dir] [--require-vendor]
 *   node scripts/vendor-plugin.mjs --check-hygiene [--root dir] [--scan dir] [--require-vendor]
 *   node scripts/vendor-plugin.mjs --schema [--root dir]
 *
 * The vendor tree is generated. Do not commit it. Two runs on the same dist
 * write the same MANIFEST.sha256.
 *
 * MANIFEST.sha256: one line per file, `<sha256>  <relative posix path>`,
 * sorted bytewise, trailing newline. The manifest file itself is not listed.
 *
 * --schema is the CI stand-in when `claude` is not on PATH.
 * TODO: replace it with `claude plugin validate` wherever the CLI is installed.
 * The stand-in checks the fields Claude Code 2.1 strict mode requires.
 *
 * --check-hygiene applies scripts/check-hygiene.mjs to plugin/ (or --scan).
 * It refuses a home path, a non-placeholder email address, and a long numeric
 * id. It does not rewrite compiled files.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanDirectory, scanText } from './check-hygiene.mjs';
import { SHIPPED_LICENSES } from './licenses/allowed-licenses.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function refuseIfUnhygienic(label, text) {
  const hits = scanText(label, text);
  if (hits.length) throw new Error(`vendor-plugin: ${hits[0]}`);
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Scan `<root>/plugin` with the generic hygiene rules. */
export function pluginHygieneProblems(root, { requireVendor = false, scanDir, ignore, skipSegments } = {}) {
  const pluginDir = scanDir ?? path.join(root, 'plugin');
  if (!lstatSync(pluginDir, { throwIfNoEntry: false })?.isDirectory()) {
    return ['plugin-hygiene: plugin/ is missing'];
  }
  const errors = [];
  if (requireVendor && !scanDir) {
    const vendorDist = path.join(pluginDir, 'vendor/c2c/dist');
    if (!lstatSync(vendorDist, { throwIfNoEntry: false })?.isDirectory()) {
      errors.push('plugin-hygiene: plugin/vendor/c2c/dist is missing');
    }
  }
  for (const hit of scanDirectory(pluginDir, { ignore: ['vendor/c2c/node_modules', ...(ignore ?? [])], skipSegments })) {
    errors.push(`plugin-hygiene: ${hit}`);
  }
  return errors;
}

function skillVersion(text) {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return undefined;
  const match = frontmatter[1].match(/^metadata:\r?\n\s+version:\s*"([^"]+)"/m);
  return match ? match[1] : undefined;
}

/** Drop absolute home paths and source-map pointers from files that ship to a customer. */
export function sanitizeVendored(text) {
  const baseName = (value) => {
    const parts = value.split(/[/\\]/).filter(Boolean);
    return parts.at(-1) ?? value;
  };
  return text
    .replace(/\/Users\/\S+/g, (match) => baseName(match))
    .replace(/\/home\/[a-z]\S*/g, (match) => baseName(match))
    .replace(/(\r?\n)\/\/# sourceMappingURL=\S+\s*$/g, '$1');
}

function copyRuntimeDist(distDir, destDist) {
  const walk = (rel) => {
    const abs = rel ? path.join(distDir, rel) : distDir;
    for (const name of readdirSync(abs)) {
      if (name === 'test') continue;
      const child = rel ? `${rel}/${name}` : name;
      const from = path.join(distDir, child);
      const info = lstatSync(from);
      if (info.isSymbolicLink()) throw new Error(`vendor-plugin: refusing to vendor symlink ${child}`);
      if (info.isDirectory()) {
        walk(child);
        continue;
      }
      if (!info.isFile() || name.endsWith('.map')) continue;
      const target = path.join(destDist, child);
      mkdirSync(path.dirname(target), { recursive: true });
      if (name.endsWith('.js') || name.endsWith('.d.ts') || name.endsWith('.json')) {
        const cleaned = sanitizeVendored(readFileSync(from, 'utf8'));
        refuseIfUnhygienic(child, cleaned);
        writeFileSync(target, cleaned);
      } else {
        copyFileSync(from, target);
      }
    }
  };
  walk('');
}

function copyUiClientRuntime(root, out) {
  const sourceDir = path.join(root, 'packages/ui/src');
  const targetDir = path.join(out, 'dist/ui/src');
  for (const name of ['client-runtime.js']) {
    const source = path.join(sourceDir, name);
    const target = path.join(targetDir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  const sourceClient = path.join(sourceDir, 'client');
  const targetClient = path.join(targetDir, 'client');
  for (const name of readdirSync(sourceClient).filter((entry) => entry.endsWith('.js')).sort()) {
    mkdirSync(targetClient, { recursive: true });
    copyFileSync(path.join(sourceClient, name), path.join(targetClient, name));
  }
}

function copyFunctionRuntime(root, out) {
  const source = path.join(root, 'packages/deploy/fn');
  const target = path.join(out, 'dist/deploy/src/fn');
  const walk = (rel) => {
    const dir = rel ? path.join(source, rel) : source;
    for (const name of readdirSync(dir)) {
      const child = rel ? `${rel}/${name}` : name;
      const from = path.join(source, child);
      const info = lstatSync(from);
      if (info.isSymbolicLink()) throw new Error(`vendor-plugin: refusing to vendor symlink ${child}`);
      if (info.isDirectory()) walk(child);
      else if (info.isFile()) {
        const dest = path.join(target, child);
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(from, dest);
      }
    }
  };
  walk('');
}

function ensureMatrixSnapshot(root, outDir) {
  const dest = path.join(outDir, 'dist/cli/data/feature-matrix-v4.snapshot.json');
  if (lstatSync(dest, { throwIfNoEntry: false })?.isFile()) return;
  const source = path.join(root, 'packages/cli/data/feature-matrix-v4.snapshot.json');
  mkdirSync(path.dirname(dest), { recursive: true });
  const cleaned = sanitizeVendored(readFileSync(source, 'utf8'));
  refuseIfUnhygienic('feature-matrix-v4.snapshot.json', cleaned);
  writeFileSync(dest, cleaned);
}

/**
 * Installed packages the compiled code imports at runtime. They resolve from
 * <root>/node_modules like the repo build. Each entry is copied with its
 * whole dependency closure (dependencies + optionalDependencies in
 * package-lock.json); a package missing from node_modules fails the
 * vendoring step.
 */
const RUNTIME_PACKAGES = ['typescript', 'jsdom', 'lossless-json'];

/**
 * RUNTIME_PACKAGES plus their installed dependency closure, resolved from
 * package-lock.json so version bumps do not drift from what the plugin
 * ships. Peer-only optionals npm leaves uninstalled (canvas, bufferutil,
 * utf-8-validate) are not in the lock tree and are skipped.
 */
function runtimePackageNames(root) {
  let lock;
  try {
    lock = readJson(path.join(root, 'package-lock.json'));
  } catch {
    throw new Error('vendor-plugin: package-lock.json is missing or unreadable; cannot resolve runtime packages');
  }
  const packages = lock.packages ?? {};
  const names = new Set();
  const queue = [...RUNTIME_PACKAGES];
  while (queue.length) {
    const name = queue.shift();
    if (names.has(name)) continue;
    const entry = packages[`node_modules/${name}`];
    if (!entry) {
      throw new Error(`vendor-plugin: runtime package node_modules/${name} is missing from package-lock.json. Run npm ci first.`);
    }
    names.add(name);
    for (const dep of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) queue.push(dep);
  }
  return [...names];
}

/**
 * Licences allowed in code the plugin ships come from the single project
 * allowlist in scripts/licenses/allowed-licenses.mjs. Anything else needs an
 * approved exception in
 * scripts/licenses/exceptions.json.
 */
export { SHIPPED_LICENSES };

const LICENSE_FILE = /^(licen[cs]e|copying|notice|thirdpartynoticetext)([-.].*)?$/i;

/** Every installed package root under a node_modules dir, nested ones included, in path order. */
function packageRoots(nodeModulesDir, prefix = '') {
  const roots = [];
  const names = lstatSync(nodeModulesDir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(nodeModulesDir).sort() : [];
  for (const name of names) {
    if (name.startsWith('.') || !lstatSync(path.join(nodeModulesDir, name)).isDirectory()) continue;
    const rels = name.startsWith('@') ? readdirSync(path.join(nodeModulesDir, name)).sort().map((inner) => `${name}/${inner}`) : [name];
    for (const rel of rels) {
      const dir = path.join(nodeModulesDir, rel);
      if (!lstatSync(path.join(dir, 'package.json'), { throwIfNoEntry: false })?.isFile()) continue;
      roots.push({ id: `${prefix}${rel}`, dir });
      roots.push(...packageRoots(path.join(dir, 'node_modules'), `${prefix}${rel}/node_modules/`));
    }
  }
  return roots;
}

/**
 * Licence facts for every package under `nodeModulesDir`. The text comes from
 * the package's own licence file, else from scripts/licenses/<name>-<version>.txt
 * for tarballs that publish none.
 *
 * A licence outside SHIPPED_LICENSES passes only with an `APPROVED` entry for
 * that exact package, version and licence in the exceptions file. An entry
 * still marked `EXCEPTION_NEEDED` lands in `pending` (awaiting maintainer approval);
 * everything else that fails, including a missing licence text, lands in
 * `problems`.
 */
export function shippedLicenses(
  nodeModulesDir,
  { textsDir = path.join(repoRoot, 'scripts/licenses'), exceptionsFile = path.join(repoRoot, 'scripts/licenses/exceptions.json') } = {},
) {
  const exceptions = lstatSync(exceptionsFile, { throwIfNoEntry: false })?.isFile() ? readJson(exceptionsFile) : [];
  const packages = [];
  const problems = [];
  const pending = [];
  for (const { id, dir } of packageRoots(nodeModulesDir)) {
    const pkg = readJson(path.join(dir, 'package.json'));
    const license = typeof pkg.license === 'string' ? pkg.license : undefined;
    const fallback = `${String(pkg.name).replace('/', '__')}-${pkg.version}.txt`;
    const files = readdirSync(dir).filter((name) => LICENSE_FILE.test(name) && lstatSync(path.join(dir, name)).isFile()).sort();
    let texts = files.map((name) => ({ source: `node_modules/${id}/${name}`, text: readFileSync(path.join(dir, name), 'utf8') }));
    if (!texts.length && lstatSync(path.join(textsDir, fallback), { throwIfNoEntry: false })?.isFile()) {
      texts = [{ source: `upstream repository (the published package ships no licence file)`, text: readFileSync(path.join(textsDir, fallback), 'utf8') }];
    }
    if (!license || !SHIPPED_LICENSES.has(license)) {
      const exception = exceptions.find((entry) => entry.package === pkg.name && entry.version === pkg.version && entry.license === license);
      if (exception?.status === 'EXCEPTION_NEEDED') pending.push(`EXCEPTION_NEEDED ${id}@${pkg.version}: licence ${license} (${exception.reason})`);
      else if (exception?.status !== 'APPROVED') problems.push(`${id}@${pkg.version}: licence ${license ?? 'missing'} is not allowed in the plugin`);
    }
    if (!texts.length) problems.push(`${id}@${pkg.version}: no licence text; add scripts/licenses/${fallback}`);
    packages.push({ id, name: pkg.name, version: pkg.version, license, texts });
  }
  return { packages, problems, pending };
}

/** THIRD_PARTY_LICENSES.txt: one section per shipped package, in path order. */
export function licenseNoticeText(packages) {
  const rule = '='.repeat(78);
  const sections = packages.map((entry) => {
    const body = entry.texts.map(({ source, text }) => `[${source}]\n\n${text.replace(/\s+$/, '')}\n`).join('\n');
    return `${rule}\n${entry.name}@${entry.version} (${entry.license}) at node_modules/${entry.id}\n${rule}\n\n${body}`;
  });
  return `Licences of the npm packages shipped in vendor/c2c/node_modules/.\nGenerated by scripts/vendor-plugin.mjs from the shipped tree; do not edit.\n\n${sections.join('\n')}`;
}

/**
 * Refuse an unlisted licence or a textless package, then write the licence
 * bundle beside the packages. A pending exception does not block
 * vendoring; the packaging licence test fails on it until a maintainer
 * approves it.
 */
function writeLicenseNotices(outDir) {
  const { packages, problems } = shippedLicenses(path.join(outDir, 'node_modules'));
  if (problems.length) throw new Error(`vendor-plugin: ${problems.join('; ')}`);
  writeFileSync(path.join(outDir, 'node_modules', 'THIRD_PARTY_LICENSES.txt'), licenseNoticeText(packages));
}

/**
 * Runtime assets the compiled code reads from the source tree (each reader
 * falls back from its dist directory to <root>/packages/...). The vendored
 * tree keeps the same packages/ layout so the fallback resolves.
 */
const SOURCE_ASSETS = [
  'packages/ui/src/client-runtime.js',
  'packages/ui/src/client',
  'packages/deploy/fn',
  'packages/ui-score/rubric.json',
  'packages/ui-react/template',
];

const SANITIZED = /\.(js|mjs|cjs|json|ts|tsx|css|html|md|txt)$/;

function copySourceAssets(root, outDir) {
  const copy = (from, to, label) => {
    const info = lstatSync(from);
    if (info.isSymbolicLink()) throw new Error(`vendor-plugin: refusing to vendor symlink ${label}`);
    if (info.isDirectory()) {
      if (!label.startsWith('node_modules/') && (path.basename(from) === 'node_modules' || path.basename(from) === 'dist')) return;
      for (const name of readdirSync(from)) copy(path.join(from, name), path.join(to, name), `${label}/${name}`);
      return;
    }
    if (!info.isFile()) throw new Error(`vendor-plugin: runtime asset ${label} is not a file`);
    mkdirSync(path.dirname(to), { recursive: true });
    if (label.startsWith('node_modules/')) {
      // An installed package ships byte-identical; rewriting it would corrupt it.
      copyFileSync(from, to);
      return;
    }
    if (SANITIZED.test(label) || !readFileSync(from).includes(0)) {
      const cleaned = sanitizeVendored(readFileSync(from, 'utf8'));
      refuseIfUnhygienic(label, cleaned);
      writeFileSync(to, cleaned);
    } else {
      copyFileSync(from, to);
    }
  };
  for (const rel of SOURCE_ASSETS) {
    copy(path.join(root, rel), path.join(outDir, rel), rel);
  }
  for (const name of runtimePackageNames(root)) {
    const from = path.join(root, 'node_modules', name);
    if (!lstatSync(from, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`vendor-plugin: runtime package node_modules/${name} is missing. Run npm ci first.`);
    }
    copy(from, path.join(outDir, 'node_modules', name), `node_modules/${name}`);
  }
}

/** sha256 lines for every file under dir except MANIFEST.sha256. */
export function manifestText(dir) {
  const files = [];
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const name of readdirSync(abs)) {
      if (!rel && name === 'MANIFEST.sha256') continue;
      const child = rel ? `${rel}/${name}` : name;
      const info = lstatSync(path.join(dir, child));
      if (info.isSymbolicLink()) throw new Error(`vendor-plugin: symlink in vendor tree ${child}`);
      if (info.isDirectory()) walk(child);
      else if (info.isFile()) files.push(child);
      else throw new Error(`vendor-plugin: not a regular file ${child}`);
    }
  };
  walk('');
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = files.map((rel) => {
    const hash = createHash('sha256').update(readFileSync(path.join(dir, rel))).digest('hex');
    return `${hash}  ${rel}`;
  });
  return `${lines.join('\n')}\n`;
}

export function vendorPlugin({ root = repoRoot, outDir } = {}) {
  const distDir = path.join(root, 'dist');
  const out = outDir ?? path.join(root, 'plugin/vendor/c2c');
  if (!lstatSync(distDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('vendor-plugin: dist/ is missing. Run npm run build first.');
  }
  if (!lstatSync(path.join(distDir, 'cli/src/c2c.js'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('vendor-plugin: dist/cli/src/c2c.js is missing. Run npm run build first.');
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyRuntimeDist(distDir, path.join(out, 'dist'));
  copyUiClientRuntime(root, out);
  copyFunctionRuntime(root, out);
  ensureMatrixSnapshot(root, out);
  copySourceAssets(root, out);
  writeLicenseNotices(out);
  const packageJson = readFileSync(path.join(root, 'package.json'));
  const version = JSON.parse(packageJson.toString('utf8')).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('vendor-plugin: package.json version must be plain semver');
  }
  writeFileSync(path.join(out, 'package.json'), packageJson);
  writeFileSync(path.join(out, 'VERSION'), `${version}\n`);
  writeFileSync(path.join(out, 'MANIFEST.sha256'), manifestText(out));
  return out;
}

export function versionProblems(root, { requireVendor = false } = {}) {
  const errors = [];
  let expected;
  try {
    expected = readJson(path.join(root, 'package.json')).version;
  } catch {
    return ['package.json is missing or unreadable'];
  }
  if (typeof expected !== 'string' || !expected) return ['package.json version is missing'];

  const compare = (label, got) => {
    if (got !== expected) errors.push(`${label} ${got ?? 'missing'} != package.json ${expected}`);
  };

  const pluginJson = path.join(root, 'plugin/.claude-plugin/plugin.json');
  const cursorJson = path.join(root, 'plugin/.cursor-plugin/plugin.json');
  const marketJson = path.join(root, 'plugin/.claude-plugin/marketplace.json');
  const compatJson = path.join(root, 'plugin/references/compat.json');
  try {
    compare('plugin/.claude-plugin/plugin.json', readJson(pluginJson).version);
  } catch {
    errors.push(`plugin/.claude-plugin/plugin.json unreadable != package.json ${expected}`);
  }
  try {
    compare('plugin/.cursor-plugin/plugin.json', readJson(cursorJson).version);
  } catch {
    errors.push(`plugin/.cursor-plugin/plugin.json unreadable != package.json ${expected}`);
  }
  try {
    const market = readJson(marketJson);
    const entries = Array.isArray(market.plugins) ? market.plugins : [];
    if (!entries.length) errors.push(`marketplace.json has no plugins != package.json ${expected}`);
    entries.forEach((entry, index) => compare(`marketplace.json plugins[${index}].version`, entry?.version));
  } catch {
    errors.push(`marketplace.json unreadable != package.json ${expected}`);
  }
  try {
    compare('plugin/references/compat.json c2c', readJson(compatJson).c2c);
  } catch {
    errors.push(`plugin/references/compat.json unreadable != package.json ${expected}`);
  }

  const skillsDir = path.join(root, 'plugin/skills');
  let skills = [];
  try {
    skills = readdirSync(skillsDir).filter((name) => lstatSync(path.join(skillsDir, name)).isDirectory()).sort();
  } catch {
    errors.push(`plugin/skills is missing != package.json ${expected}`);
  }
  if (!skills.length) errors.push(`plugin/skills has no skills != package.json ${expected}`);
  for (const name of skills) {
    const skillFile = path.join(skillsDir, name, 'SKILL.md');
    let version;
    try {
      version = skillVersion(readFileSync(skillFile, 'utf8'));
    } catch {
      version = undefined;
    }
    compare(`skills/${name}/SKILL.md`, version);
  }

  const versionFile = path.join(root, 'plugin/vendor/c2c/VERSION');
  const versionInfo = lstatSync(versionFile, { throwIfNoEntry: false });
  if (!versionInfo?.isFile()) {
    if (requireVendor) errors.push(`plugin/vendor/c2c/VERSION missing != package.json ${expected}`);
  } else {
    compare('plugin/vendor/c2c/VERSION', readFileSync(versionFile, 'utf8').trim());
  }
  return errors;
}

export function schemaProblems(root) {
  const errors = [];
  let plugin;
  let market;
  try {
    plugin = readJson(path.join(root, 'plugin/.claude-plugin/plugin.json'));
  } catch {
    errors.push('plugin.json unreadable');
  }
  try {
    market = readJson(path.join(root, 'plugin/.claude-plugin/marketplace.json'));
  } catch {
    errors.push('marketplace.json unreadable');
  }
  if (plugin) {
    if (typeof plugin.name !== 'string' || !plugin.name.trim()) errors.push('plugin.json name: expected a non-empty string');
    if (typeof plugin.version !== 'string' || !plugin.version.trim()) errors.push('plugin.json version: expected a string');
    if (typeof plugin.description !== 'string' || !plugin.description.trim()) errors.push('plugin.json description: expected a string');
    if (!plugin.author || typeof plugin.author !== 'object' || typeof plugin.author.name !== 'string' || !plugin.author.name.trim()) {
      errors.push('plugin.json author.name: expected a string');
    }
  }
  if (market) {
    if (typeof market.name !== 'string' || !market.name.trim()) errors.push('marketplace.json name: expected a non-empty string');
    if (!market.owner || typeof market.owner !== 'object' || typeof market.owner.name !== 'string' || !market.owner.name.trim()) {
      errors.push('marketplace.json owner.name: expected a string');
    }
    if (typeof market.description !== 'string' || !market.description.trim()) errors.push('marketplace.json description: expected a string');
    if (!Array.isArray(market.plugins) || market.plugins.length === 0) errors.push('marketplace.json plugins: expected a non-empty array');
    else {
      market.plugins.forEach((entry, index) => {
        if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) errors.push(`marketplace.json plugins[${index}].name: expected a non-empty string`);
        if (!entry || typeof entry.source !== 'string' || !entry.source.trim()) errors.push(`marketplace.json plugins[${index}].source: expected a string`);
      });
    }
  }
  return errors;
}

function fail(errors) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const root = path.resolve(flag(args, '--root') ?? repoRoot);
  if (args.includes('--check-versions')) {
    const errors = versionProblems(root, { requireVendor: args.includes('--require-vendor') });
    if (errors.length) fail(errors);
    process.stdout.write('versions: equal\n');
    return;
  }
  if (args.includes('--check-hygiene')) {
    try {
      const scan = flag(args, '--scan');
      const errors = pluginHygieneProblems(root, {
        requireVendor: args.includes('--require-vendor'),
        scanDir: scan ? path.resolve(scan) : undefined,
      });
      if (errors.length) fail(errors);
      process.stdout.write('plugin-hygiene: clean\n');
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'plugin-hygiene failed'}\n`);
      process.exit(1);
    }
    return;
  }
  if (args.includes('--schema')) {
    const errors = schemaProblems(root);
    if (errors.length) fail(errors);
    process.stdout.write('schema: ok\n');
    return;
  }
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write('usage: node scripts/vendor-plugin.mjs [--out dir]\n       node scripts/vendor-plugin.mjs --check-versions [--root dir] [--require-vendor]\n       node scripts/vendor-plugin.mjs --check-hygiene [--root dir] [--scan dir] [--require-vendor]\n       node scripts/vendor-plugin.mjs --schema [--root dir]\n');
    return;
  }
  try {
    const out = vendorPlugin({ root, outDir: flag(args, '--out') ? path.resolve(flag(args, '--out')) : undefined });
    process.stdout.write(`vendored ${out}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'vendor-plugin failed'}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
