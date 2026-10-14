#!/usr/bin/env node
/**
 * Committed determinism manifests: one "<sha256>  <path>" line per generated
 * file under packages/determinism/test/manifests/<fixture>.sha256, in the
 * canonical form renderManifest emits.
 *
 *   node dist/determinism/src/manifests.js --check   compare committed vs regenerated
 *   node dist/determinism/src/manifests.js --update  rewrite committed manifests
 *
 * The manifest set mirrors fixtures/redistributable: a fixture without a
 * committed manifest, or a committed manifest without a fixture, is drift.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../../core/src/toolchain.js';
import { diffManifest, manifestFor, parseManifestFiles, renderManifest, type FileHash } from './tree.js';

export const MANIFEST_EXT = '.sha256';
export const FIXTURES_DIR = 'fixtures/redistributable';
export const MANIFESTS_DIR = 'packages/determinism/test/manifests';

/** Fixture names = directory names under the redistributable fixtures dir, sorted. */
export function fixtureNames(fixturesDir: string): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Committed manifest names (without the .sha256 suffix), sorted. */
export function manifestNames(manifestsDir: string): string[] {
  return readdirSync(manifestsDir)
    .filter((name) => name.endsWith(MANIFEST_EXT))
    .map((name) => name.slice(0, -MANIFEST_EXT.length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function manifestPath(manifestsDir: string, name: string): string {
  return join(manifestsDir, `${name}${MANIFEST_EXT}`);
}

/** One problem line per drifted fixture or committed-file defect. */
export function checkManifests(fixturesDir: string, manifestsDir: string): string[] {
  const fixtures = fixtureNames(fixturesDir);
  const committed = manifestNames(manifestsDir);
  const fixtureSet = new Set(fixtures);
  const committedSet = new Set(committed);
  const problems: string[] = [];
  for (const name of committed) {
    if (!fixtureSet.has(name)) problems.push(`${name}: committed manifest has no fixture`);
  }
  for (const name of fixtures) {
    if (!committedSet.has(name)) {
      problems.push(`${name}: fixture has no committed manifest`);
      continue;
    }
    let expected: FileHash[];
    try {
      expected = parseManifestFiles(readFileSync(manifestPath(manifestsDir, name), 'utf8'));
    } catch (error) {
      problems.push(`${name}: committed manifest is not canonical: ${(error as Error).message}`);
      continue;
    }
    const actual = manifestFor(join(fixturesDir, name));
    const lines = diffManifest({ node: actual.node, typescript: actual.typescript, files: expected }, actual);
    if (lines.length > 0) problems.push(`${name}: committed manifest is stale\n  ${lines.slice(0, 30).join('\n  ')}`);
  }
  return problems;
}

/** Rewrite every fixture's manifest and drop manifests whose fixture is gone. */
export function updateManifests(fixturesDir: string, manifestsDir: string): { written: string[]; removed: string[] } {
  const fixtures = fixtureNames(fixturesDir);
  const keep = new Set(fixtures.map((name) => `${name}${MANIFEST_EXT}`));
  mkdirSync(manifestsDir, { recursive: true });
  const removed: string[] = [];
  for (const entry of readdirSync(manifestsDir)) {
    if (entry.endsWith(MANIFEST_EXT) && !keep.has(entry)) {
      rmSync(join(manifestsDir, entry));
      removed.push(entry.slice(0, -MANIFEST_EXT.length));
    }
  }
  const written: string[] = [];
  for (const name of fixtures) {
    const out = manifestPath(manifestsDir, name);
    const text = renderManifest(manifestFor(join(fixturesDir, name)));
    const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
    if (current !== text) {
      writeFileSync(out, text);
      written.push(name);
    }
  }
  return { written, removed };
}

/** Copy the committed manifests into a scratch dir (test helper for drift cases). */
export function copyManifests(fromDir: string, toDir: string): void {
  mkdirSync(toDir, { recursive: true });
  for (const name of manifestNames(fromDir)) copyFileSync(manifestPath(fromDir, name), join(toDir, `${name}${MANIFEST_EXT}`));
}

function main(argv: string[]): number {
  const root = repoRoot();
  const fixturesDir = join(root, FIXTURES_DIR);
  const manifestsDir = join(root, MANIFESTS_DIR);
  if (argv.includes('--check')) {
    const problems = checkManifests(fixturesDir, manifestsDir);
    if (problems.length > 0) {
      process.stderr.write(`determinism:check FAIL\n${problems.join('\n')}\nrun npm run determinism:update to refresh the committed manifests\n`);
      return 1;
    }
    process.stdout.write(`determinism:check fixtures=${fixtureNames(fixturesDir).length} manifests=current\n`);
    return 0;
  }
  if (argv.includes('--update')) {
    const { written, removed } = updateManifests(fixturesDir, manifestsDir);
    process.stdout.write(`determinism:update written=${written.length} removed=${removed.length} fixtures=${fixtureNames(fixturesDir).length}\n`);
    for (const name of written) process.stdout.write(`  updated ${name}${MANIFEST_EXT}\n`);
    for (const name of removed) process.stdout.write(`  removed ${name}${MANIFEST_EXT}\n`);
    return 0;
  }
  process.stderr.write('usage: manifests.js --check | --update\n');
  return 2;
}

const invoked = process.argv[1]?.endsWith('/manifests.js') ?? false;
if (invoked) process.exitCode = main(process.argv.slice(2));
