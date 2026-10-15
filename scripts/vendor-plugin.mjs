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
import { closeSync, constants, copyFileSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanDirectory, scanText } from './check-hygiene.mjs';
import { SHIPPED_LICENSES } from './licenses/allowed-licenses.mjs';

/**
 * Open `p` without following a final symlink, for a classify-then-read on one
 * descriptor. Returns null where `lstat(p, { throwIfNoEntry: false })` would
 * report nothing or a symlink (ENOENT, ELOOP) or a socket (ENXIO,
 * EOPNOTSUPP); any other error throws, as lstat did. O_NONBLOCK keeps a FIFO
 * from blocking the open; callers fstat and refuse it as not a regular file.
 */
function openNoFollow(p) {
  try {
    return openSync(p, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (err) {
    const code = err?.code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENXIO' || code === 'EOPNOTSUPP') return null;
    throw err;
  }
}

/** True when `p` is a real directory (a symlink to one is not), checked on a descriptor. */
function isRealDirectory(p) {
  const fd = openNoFollow(p);
  if (fd === null) return false;
  try {
    return fstatSync(fd).isDirectory();
  } finally {
    closeSync(fd);
  }
}

/** True when `p` is a regular file (a symlink to one is not), checked on a descriptor. */
function isRegularFile(p) {
  const fd = openNoFollow(p);
  if (fd === null) return false;
  try {
    return fstatSync(fd).isFile();
  } finally {
    closeSync(fd);
  }
}

/** The contents of `p` when it is a regular file (not a symlink), read on the descriptor that was checked; otherwise null. */
function readRegularFile(p, encoding) {
  const fd = openNoFollow(p);
  if (fd === null) return null;
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd, encoding) : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Open a path whose symlink is refused with `symlinkMessage`: O_NOFOLLOW makes
 * the open itself the symlink check, so a swap after a listing or a check
 * cannot slip a link through. Returns null for a socket (it cannot be
 * opened); callers fstat the descriptor for everything else.
 */
function openRefusingSymlink(p, symlinkMessage) {
  try {
    return openSync(p, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (err) {
    if (err?.code === 'ELOOP') throw new Error(symlinkMessage);
    if (err?.code === 'ENXIO' || err?.code === 'EOPNOTSUPP') return null;
    throw err;
  }
}

/** A walked entry the listing reported as a regular file, opened; null if it is no longer one. */
function openListedFile(p, symlinkMessage) {
  const fd = openRefusingSymlink(p, symlinkMessage);
  if (fd === null) return null;
  if (fstatSync(fd).isFile()) return fd;
  closeSync(fd);
  return null;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** copyFileSync from an open descriptor: same bytes, same permission bits. `bytes` is the descriptor's contents when already read. */
function copyFromDescriptor(fd, to, bytes = readFileSync(fd)) {
  const out = openSync(to, 'w');
  try {
    writeFileSync(out, bytes);
    fchmodSync(out, fstatSync(fd).mode & 0o7777);
  } finally {
    closeSync(out);
  }
}

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
  if (!isRealDirectory(pluginDir)) {
    return ['plugin-hygiene: plugin/ is missing'];
  }
  const errors = [];
  if (requireVendor && !scanDir) {
    const vendorDist = path.join(pluginDir, 'vendor/c2c/dist');
    if (!isRealDirectory(vendorDist)) {
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
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const name = entry.name;
      if (name === 'test') continue;
      const child = rel ? `${rel}/${name}` : name;
      const from = path.join(distDir, child);
      const symlinkMessage = `vendor-plugin: refusing to vendor symlink ${child}`;
      if (entry.isSymbolicLink()) throw new Error(symlinkMessage);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.isFile() || name.endsWith('.map')) continue;
      const fd = openListedFile(from, symlinkMessage);
      if (fd === null) continue;
      try {
        const target = path.join(destDist, child);
        mkdirSync(path.dirname(target), { recursive: true });
        if (name.endsWith('.js') || name.endsWith('.d.ts') || name.endsWith('.json')) {
          const cleaned = sanitizeVendored(readFileSync(fd, 'utf8'));
          refuseIfUnhygienic(child, cleaned);
          writeFileSync(target, cleaned);
        } else {
          copyFromDescriptor(fd, target);
        }
      } finally {
        closeSync(fd);
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
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      const from = path.join(source, child);
      const symlinkMessage = `vendor-plugin: refusing to vendor symlink ${child}`;
      if (entry.isSymbolicLink()) throw new Error(symlinkMessage);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const fd = openListedFile(from, symlinkMessage);
        if (fd === null) continue;
        try {
          const dest = path.join(target, child);
          mkdirSync(path.dirname(dest), { recursive: true });
          copyFromDescriptor(fd, dest);
        } finally {
          closeSync(fd);
        }
      }
    }
  };
  walk('');
}

function ensureMatrixSnapshot(root, outDir) {
  const dest = path.join(outDir, 'dist/cli/data/feature-matrix-v4.snapshot.json');
  const existing = openNoFollow(dest);
  if (existing !== null) {
    let keep;
    try {
      keep = fstatSync(existing).isFile();
    } finally {
      closeSync(existing);
    }
    if (keep) return;
  }
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
  const entries = isRealDirectory(nodeModulesDir) ? readdirSync(nodeModulesDir, { withFileTypes: true }).sort(byName) : [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.') || !entry.isDirectory()) continue;
    const rels = name.startsWith('@') ? readdirSync(path.join(nodeModulesDir, name)).sort().map((inner) => `${name}/${inner}`) : [name];
    for (const rel of rels) {
      const dir = path.join(nodeModulesDir, rel);
      const pkgText = readRegularFile(path.join(dir, 'package.json'), 'utf8');
      if (pkgText === null) continue;
      roots.push({ id: `${prefix}${rel}`, dir, pkg: JSON.parse(pkgText) });
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
  const exceptionsText = readRegularFile(exceptionsFile, 'utf8');
  const exceptions = exceptionsText === null ? [] : JSON.parse(exceptionsText);
  const packages = [];
  const problems = [];
  const pending = [];
  for (const { id, dir, pkg } of packageRoots(nodeModulesDir)) {
    const license = typeof pkg.license === 'string' ? pkg.license : undefined;
    const fallback = `${String(pkg.name).replace('/', '__')}-${pkg.version}.txt`;
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => LICENSE_FILE.test(entry.name) && entry.isFile())
      .map((entry) => entry.name)
      .sort();
    const texts = [];
    for (const name of files) {
      const text = readRegularFile(path.join(dir, name), 'utf8');
      if (text !== null) texts.push({ source: `node_modules/${id}/${name}`, text });
    }
    if (!texts.length) {
      const text = readRegularFile(path.join(textsDir, fallback), 'utf8');
      if (text !== null) texts.push({ source: `upstream repository (the published package ships no licence file)`, text });
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
    const fd = openRefusingSymlink(from, `vendor-plugin: refusing to vendor symlink ${label}`);
    if (fd === null) throw new Error(`vendor-plugin: runtime asset ${label} is not a file`);
    try {
      const info = fstatSync(fd);
      if (info.isDirectory()) {
        if (!label.startsWith('node_modules/') && (path.basename(from) === 'node_modules' || path.basename(from) === 'dist')) return;
        for (const name of readdirSync(from)) copy(path.join(from, name), path.join(to, name), `${label}/${name}`);
        return;
      }
      if (!info.isFile()) throw new Error(`vendor-plugin: runtime asset ${label} is not a file`);
      mkdirSync(path.dirname(to), { recursive: true });
      if (label.startsWith('node_modules/')) {
        // An installed package ships byte-identical; rewriting it would corrupt it.
        copyFromDescriptor(fd, to);
        return;
      }
      const bytes = readFileSync(fd);
      if (SANITIZED.test(label) || !bytes.includes(0)) {
        const cleaned = sanitizeVendored(bytes.toString('utf8'));
        refuseIfUnhygienic(label, cleaned);
        writeFileSync(to, cleaned);
      } else {
        copyFromDescriptor(fd, to, bytes);
      }
    } finally {
      closeSync(fd);
    }
  };
  for (const rel of SOURCE_ASSETS) {
    copy(path.join(root, rel), path.join(outDir, rel), rel);
  }
  for (const name of runtimePackageNames(root)) {
    const from = path.join(root, 'node_modules', name);
    if (!isRealDirectory(from)) {
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
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const name = entry.name;
      if (!rel && name === 'MANIFEST.sha256') continue;
      const child = rel ? `${rel}/${name}` : name;
      const symlinkMessage = `vendor-plugin: symlink in vendor tree ${child}`;
      if (entry.isSymbolicLink()) throw new Error(symlinkMessage);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      const fd = entry.isFile() ? openListedFile(path.join(dir, child), symlinkMessage) : null;
      if (fd === null) throw new Error(`vendor-plugin: not a regular file ${child}`);
      try {
        files.push({ name: child, hash: createHash('sha256').update(readFileSync(fd)).digest('hex') });
      } finally {
        closeSync(fd);
      }
    }
  };
  walk('');
  files.sort(byName);
  const lines = files.map(({ name, hash }) => `${hash}  ${name}`);
  return `${lines.join('\n')}\n`;
}

export function vendorPlugin({ root = repoRoot, outDir } = {}) {
  const distDir = path.join(root, 'dist');
  const out = outDir ?? path.join(root, 'plugin/vendor/c2c');
  if (!isRealDirectory(distDir)) {
    throw new Error('vendor-plugin: dist/ is missing. Run npm run build first.');
  }
  if (!isRegularFile(path.join(distDir, 'cli/src/c2c.js'))) {
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
    skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
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
  const versionText = readRegularFile(versionFile, 'utf8');
  if (versionText === null) {
    if (requireVendor) errors.push(`plugin/vendor/c2c/VERSION missing != package.json ${expected}`);
  } else {
    compare('plugin/vendor/c2c/VERSION', versionText.trim());
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
