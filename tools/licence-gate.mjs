#!/usr/bin/env node
/**
 * Licence gate. Fails when the PRODUCTION dependency closure of any shipped
 * tree carries a licence outside the project allowlist
 * (scripts/licenses/allowed-licenses.mjs), when a
 * licence is missing/UNKNOWN, or when an SPDX expression cannot be proven
 * allowed (an OR that chooses an allowed licence passes; AND needs all).
 *
 *   node tools/licence-gate.mjs [--root dir]
 *   node tools/licence-gate.mjs --write-function-lock [--root dir]
 *
 * Trees checked:
 *   root                 package.json + package-lock.json (CLI/plugin runtime)
 *   plugin vendor        plugin/vendor/c2c/node_modules, when vendored
 *   ui-react template    packages/ui-react/template
 *   function runtime     scripts/licenses/function-runtime, the committed
 *                        lockfile mirroring FUNCTION_DEPENDENCIES in
 *                        packages/deploy/src/function-dir.ts (CI is offline,
 *                        so the lockfile is regenerated with
 *                        --write-function-lock and committed, not fetched)
 *
 * Exceptions: scripts/licenses/exceptions.json, one entry per exact
 * {package, version, license} with status APPROVED (plus reason and the
 * maintainer approval date) or EXCEPTION_NEEDED (records the ask, still fails).
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { licenseAllowed, licenseOf } from '../scripts/licenses/allowed-licenses.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function loadExceptions(root = repoRoot) {
  const file = path.join(root, 'scripts/licenses/exceptions.json');
  const entries = existsSync(file) ? readJson(file) : [];
  const problems = [];
  if (!Array.isArray(entries)) return { entries: [], problems: [`${file} must be a JSON array`] };
  for (const [i, entry] of entries.entries()) {
    for (const key of ['package', 'version', 'license', 'status', 'reason']) {
      if (typeof entry?.[key] !== 'string' || !entry[key]) problems.push(`exceptions.json[${i}]: ${key} must be a non-empty string`);
    }
    if (!['APPROVED', 'EXCEPTION_NEEDED'].includes(entry?.status)) problems.push(`exceptions.json[${i}]: status must be APPROVED or EXCEPTION_NEEDED`);
    if (entry?.status === 'APPROVED' && (typeof entry.approved !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.approved))) {
      problems.push(`exceptions.json[${i}]: APPROVED entries need an "approved" YYYY-MM-DD maintainer approval date`);
    }
  }
  return { entries, problems };
}

/** key in lockfile.packages for `name` as required from parent key `from`. */
function resolveKey(packages, name, from) {
  let dir = from || '';
  for (;;) {
    const candidate = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const cut = dir.lastIndexOf('/node_modules/');
    if (cut < 0) {
      if (!dir) return undefined;
      dir = '';
      continue;
    }
    dir = dir.slice(0, cut);
  }
}

/**
 * Walk the production dependency closure of one package.json + package-lock
 * pair. Returns { packages, problems }: every reachable prod package with its
 * licence verdict. `deps` overrides the starting dependencies (defaults to the
 * manifest's `dependencies`).
 */
export function auditLockfile({ root = repoRoot, dir, label, deps } = {}) {
  const manifestPath = path.join(root, dir ?? '', 'package.json');
  const lockPath = path.join(root, dir ?? '', 'package-lock.json');
  const problems = [];
  if (!existsSync(manifestPath)) return { label, packages: [], problems: [`${label}: ${manifestPath} is missing`] };
  const manifest = readJson(manifestPath);
  const lock = existsSync(lockPath) ? readJson(lockPath) : undefined;
  const packages = lock?.packages ?? {};
  if (!existsSync(lockPath)) problems.push(`${label}: ${lockPath} is missing; licences cannot be verified deterministically`);
  for (const [key, entry] of Object.entries(packages)) {
    if (!key || entry.link === true || entry.dev === true) continue;
    const id = `${key} (${entry.version ?? 'unknown version'})`;
    if (typeof entry.integrity !== 'string' || !entry.integrity.trim()) {
      problems.push(`${label}: ${id} has no integrity hash`);
    }
    if (typeof entry.resolved === 'string' && /^(?:git(?:\+[^:]+)?:|https?:)/i.test(entry.resolved)
      && !/^https:\/\/(?:registry\.npmjs\.org|registry\.yarnpkg\.com)\//i.test(entry.resolved)) {
      problems.push(`${label}: ${id} uses a non-registry tarball source ${entry.resolved}`);
    }
  }
  const exceptions = loadExceptions(root);
  problems.push(...exceptions.problems.map((p) => `${label}: ${p}`));
  const findException = (name, version, license) =>
    exceptions.entries.find((e) => e.package === name && e.version === version && e.license === license);

  const seen = new Map();
  const results = [];
  const visit = (name, from) => {
    const key = resolveKey(packages, name, from);
    if (key === undefined) {
      problems.push(`${label}: ${name} (required by ${from || 'manifest'}) has no locked entry`);
      return;
    }
    const entry = packages[key];
    if (entry.dev === true) return; // dev-only, not shipped
    const id = `${name}@${entry.version}`;
    if (seen.has(id)) return;
    seen.set(id, true);
    let license = entry.license;
    if (typeof license !== 'string' || !license.trim()) {
      const installed = path.join(root, dir ?? '', key, 'package.json');
      license = existsSync(installed) ? licenseOf(readJson(installed)) : undefined;
    }
    license = typeof license === 'string' ? license.trim() : undefined;
    const exception = license === undefined ? undefined : findException(name, entry.version, license);
    const record = { name, version: entry.version, license, via: key };
    if (exception?.status === 'APPROVED') {
      record.verdict = `exception (approved ${exception.approved})`;
    } else if (license === undefined) {
      record.verdict = 'VIOLATION';
      problems.push(`${label}: ${id} declares no licence`);
    } else if (!licenseAllowed(license)) {
      record.verdict = 'VIOLATION';
      const note = exception?.status === 'EXCEPTION_NEEDED' ? ` [EXCEPTION_NEEDED: ${exception.reason}]` : '';
      problems.push(`${label}: ${id} licence ${license} is not on the project allowlist${note}`);
    } else {
      record.verdict = 'ok';
    }
    results.push(record);
    for (const dep of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) visit(dep, key);
  };
  for (const name of Object.keys(deps ?? manifest.dependencies ?? {})) visit(name, '');
  results.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { label, packages: results, problems };
}

/** Audit every installed package under a vendored node_modules tree. */
export function auditVendorDir({ root = repoRoot, dir } = {}) {
  const base = path.join(root, dir);
  const label = dir;
  if (!lstatSync(base, { throwIfNoEntry: false })?.isDirectory()) {
    return { label, packages: [], problems: [], skipped: true };
  }
  const exceptions = loadExceptions(root);
  const problems = exceptions.problems.map((p) => `${label}: ${p}`);
  const results = [];
  const nm = path.join(base, 'node_modules');
  if (!lstatSync(nm, { throwIfNoEntry: false })?.isDirectory()) {
    return { label, packages: [], problems, skipped: true };
  }
  {
    const queue = [nm];
    const seen = new Set();
    while (queue.length) {
      const dirPath = queue.pop();
      for (const name of readdirSync(dirPath)) {
        if (name.startsWith('.')) continue;
        const pkgDir = path.join(dirPath, name);
        if (name.startsWith('@')) {
          if (lstatSync(pkgDir).isDirectory()) queue.push(pkgDir);
          continue;
        }
        const manifest = path.join(pkgDir, 'package.json');
        if (!existsSync(manifest)) continue;
        const pkg = readJson(manifest);
        const id = `${pkg.name ?? name}@${pkg.version ?? '?'}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const license = licenseOf(pkg);
        const exception = license === undefined ? undefined : exceptions.entries.find((e) => e.package === pkg.name && e.version === pkg.version && e.license === license);
        const record = { name: pkg.name ?? name, version: pkg.version, license, via: path.relative(base, pkgDir) };
        if (exception?.status === 'APPROVED') record.verdict = `exception (approved ${exception.approved})`;
        else if (license === undefined) {
          record.verdict = 'VIOLATION';
          problems.push(`${label}: ${id} declares no licence`);
        } else if (!licenseAllowed(license)) {
          record.verdict = 'VIOLATION';
          const note = exception?.status === 'EXCEPTION_NEEDED' ? ` [EXCEPTION_NEEDED: ${exception.reason}]` : '';
          problems.push(`${label}: ${id} licence ${license} is not on the project allowlist${note}`);
        } else record.verdict = 'ok';
        results.push(record);
      }
    }
  }
  results.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { label, packages: results, problems };
}

/** FUNCTION_DEPENDENCIES literal from packages/deploy/src/function-dir.ts. */
export function declaredFunctionDependencies(root = repoRoot) {
  const source = readFileSync(path.join(root, 'packages/deploy/src/function-dir.ts'), 'utf8');
  const match = source.match(/FUNCTION_DEPENDENCIES[^=]*=\s*\{([^}]*)\}/);
  if (!match) return undefined;
  const deps = {};
  for (const pair of match[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) deps[pair[1]] = pair[2];
  return deps;
}

export function auditAll(root = repoRoot) {
  const trees = [
    auditLockfile({ root, dir: '.', label: 'root (CLI/plugin runtime)' }),
    auditVendorDir({ root, dir: 'plugin/vendor/c2c' }),
    auditLockfile({ root, dir: 'packages/ui-react/template', label: 'packages/ui-react/template' }),
    auditLockfile({ root, dir: 'scripts/licenses/function-runtime', label: 'generated function runtime' }),
  ];
  const declared = declaredFunctionDependencies(root);
  const mirrored = readJson(path.join(root, 'scripts/licenses/function-runtime/package.json')).dependencies ?? {};
  const drift = trees[3];
  if (declared === undefined) drift.problems.push('generated function runtime: FUNCTION_DEPENDENCIES not found in packages/deploy/src/function-dir.ts');
  else if (JSON.stringify(Object.entries(declared).sort()) !== JSON.stringify(Object.entries(mirrored).sort())) {
    drift.problems.push(`generated function runtime: lockfile manifest ${JSON.stringify(mirrored)} != FUNCTION_DEPENDENCIES ${JSON.stringify(declared)}; run node tools/licence-gate.mjs --write-function-lock`);
  }
  return trees;
}

export function writeFunctionLock(root = repoRoot) {
  const declared = declaredFunctionDependencies(root);
  if (declared === undefined) throw new Error('FUNCTION_DEPENDENCIES not found in packages/deploy/src/function-dir.ts');
  const dir = path.join(root, 'scripts/licenses/function-runtime');
  const manifest = {
    name: 'c2c-function-runtime-deps',
    private: true,
    description: 'Lockfile mirror of FUNCTION_DEPENDENCIES in packages/deploy/src/function-dir.ts; regenerated by tools/licence-gate.mjs --write-function-lock',
    dependencies: Object.fromEntries(Object.entries(declared).sort()),
  };
  const manifestPath = path.join(dir, 'package.json');
  if (JSON.stringify(readJson(manifestPath).dependencies) !== JSON.stringify(manifest.dependencies)) {
    throw new Error(`${manifestPath} dependencies differ; update it to ${JSON.stringify(manifest.dependencies)}`);
  }
  const res = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`npm install --package-lock-only failed:\n${res.stdout}${res.stderr}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const root = path.resolve(flag(args, '--root') ?? repoRoot);
  try {
    if (args.includes('--write-function-lock')) writeFunctionLock(root);
    const trees = auditAll(root);
    let violations = 0;
    for (const tree of trees) {
      if (tree.skipped) {
        process.stdout.write(`${tree.label}: skipped (not vendored)\n`);
        continue;
      }
      process.stdout.write(`${tree.label}: ${tree.packages.length} production packages\n`);
      for (const pkg of tree.packages) process.stdout.write(`  ${pkg.name}@${pkg.version}  ${pkg.license ?? 'UNKNOWN'}  ${pkg.verdict}\n`);
      violations += tree.problems.length;
    }
    if (violations) {
      process.stderr.write(`\nlicence-gate: ${violations} violation(s)\n`);
      for (const tree of trees) for (const p of tree.problems) process.stderr.write(`  ${p}\n`);
      process.exit(1);
    }
    process.stdout.write('\nlicence-gate: all shipped licences allowed\n');
  } catch (error) {
    process.stderr.write(`licence-gate: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
