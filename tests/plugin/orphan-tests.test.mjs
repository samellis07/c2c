/**
 * CI check: No orphan test files.
 *
 * Ensures every test file in the repository is reached by `npm test`:
 * 1. Every *.test.ts under packages/<pkg>/test (mapped to dist/<pkg>/test/*.test.js)
 * 2. Every *.test.mjs under tests/
 * 3. Every *.test.mjs under tools/<tool>/test
 *
 * Any test file not reached by `scripts/test-files.txt` must be listed in the
 * explicit allowlist with a reason and no wildcards.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseTestList } from '../../scripts/test-list.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Explicit allowlist of test files that are deliberately excluded from the `npm test`
 * runner script. Each entry must map a relative path to a concrete reason string.
 * Wildcards are strictly prohibited.
 */
export const ALLOWLIST = {
  'tests/matrix/fixtures/passing.test.mjs': 'Fixture file used by tests/matrix/matrix-check.test.mjs; not an independent test suite',
};

function normalize(p) {
  return p.replace(/\\/g, '/');
}

function findFiles(dir, predicate) {
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist') {
        results.push(...findFiles(fullPath, predicate));
      }
    } else if (entry.isFile() && predicate(entry.name, fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

export function findCandidateTests(repoRoot = root) {
  const candidates = [];

  // 1. Every *.test.ts under packages/*/test
  const packagesDir = path.join(repoRoot, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const testDir = path.join(packagesDir, entry.name, 'test');
        if (existsSync(testDir)) {
          const files = findFiles(testDir, (name) => name.endsWith('.test.ts'));
          for (const file of files) {
            const rel = normalize(path.relative(repoRoot, file));
            const dist = rel.replace(/^packages\//, 'dist/').replace(/\.ts$/, '.js');
            candidates.push({ source: rel, dist });
          }
        }
      }
    }
  }

  // 2. Every *.test.mjs under tests/
  const testsDir = path.join(repoRoot, 'tests');
  if (existsSync(testsDir)) {
    const files = findFiles(testsDir, (name) => name.endsWith('.test.mjs'));
    for (const file of files) {
      const rel = normalize(path.relative(repoRoot, file));
      candidates.push({ source: rel, dist: rel });
    }
  }

  // 3. Every test under tools/*/test
  const toolsDir = path.join(repoRoot, 'tools');
  if (existsSync(toolsDir)) {
    for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const testDir = path.join(toolsDir, entry.name, 'test');
        if (existsSync(testDir)) {
          const files = findFiles(testDir, (name) => name.endsWith('.test.mjs') || name.endsWith('.test.js') || name.endsWith('.test.ts'));
          for (const file of files) {
            const rel = normalize(path.relative(repoRoot, file));
            candidates.push({ source: rel, dist: rel });
          }
        }
      }
    }
  }

  return candidates;
}

export function getTestScriptTargets(repoRoot = root) {
  const rel = 'scripts/test-files.txt';
  const text = readFileSync(path.join(repoRoot, rel), 'utf8');
  return parseTestList(text, rel).map((entry) => normalize(entry.path));
}

export function isReached(distPath, targets) {
  const normalizedDist = normalize(distPath);
  return targets.some((target) => {
    const normalizedTarget = normalize(target);
    if (normalizedDist === normalizedTarget) return true;
    if (normalizedDist.startsWith(`${normalizedTarget}/`)) return true;
    return false;
  });
}

test('allowlist entries have explicit reasons, no wildcards, and exist on disk', () => {
  for (const [filePath, reason] of Object.entries(ALLOWLIST)) {
    assert.ok(typeof reason === 'string' && reason.trim().length > 0, `Allowlist entry "${filePath}" must have a non-empty reason string`);
    assert.ok(!/[*?\[\]]/.test(filePath), `Allowlist entry "${filePath}" must not contain wildcards`);
    assert.ok(existsSync(path.resolve(root, filePath)), `Allowlist entry "${filePath}" does not exist on disk`);
  }
});

test('every test file in packages/*/test, tests/, and tools/*/test is reached by npm test', () => {
  const candidates = findCandidateTests(root);
  const targets = getTestScriptTargets(root);

  const orphans = [];
  for (const candidate of candidates) {
    if (ALLOWLIST[candidate.source]) {
      continue;
    }
    if (!isReached(candidate.dist, targets)) {
      orphans.push(candidate);
    }
  }

  if (orphans.length > 0) {
    const list = orphans.map((o) => `  - ${o.source} (mapped: ${o.dist})`).join('\n');
    assert.fail(
      `Found ${orphans.length} orphan test file(s) not reached by npm test:\n${list}\n\nAdd them to scripts/test-files.txt (one path per line) or to the allowlist with an explicit reason.`
    );
  }
});
