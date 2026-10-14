/**
 * Licence gate. The allowlist is the project list; the gate must fail a
 * planted copyleft/non-OSI licence, a missing licence, and an unprovable
 * SPDX expression, and pass an OR that chooses an allowed licence and an
 * APPROVED exceptions.json entry.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { licenseAllowed, SHIPPED_LICENSES } from '../../scripts/licenses/allowed-licenses.mjs';
import { auditLockfile, declaredFunctionDependencies } from '../../tools/licence-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixtureTree(t, { deps, lockEntries, exceptions = [] }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-licence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'scripts/licenses'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts/licenses/exceptions.json'), `${JSON.stringify(exceptions)}\n`);
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'fixture', dependencies: deps })}\n`);
  writeFileSync(path.join(dir, 'package-lock.json'), `${JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...lockEntries } })}\n`);
  return dir;
}

const lockEntry = (name, license, dependencies) => ({
  [`node_modules/${name}`]: { version: '1.0.0', ...(license === undefined ? {} : { license }), ...(dependencies ? { dependencies } : {}) },
});

test('allowlist contains the project list and nothing else', () => {
  assert.deepEqual([...SHIPPED_LICENSES].sort(), ['0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'ISC', 'MIT', 'MIT-0', 'Unlicense']);
});

test('MIT-0 and 0BSD are on the list', () => {
  assert.equal(licenseAllowed('MIT-0'), true);
  assert.equal(licenseAllowed('0BSD'), true);
});

test('GPL and SSPL are not allowed', () => {
  assert.equal(licenseAllowed('GPL-3.0-only'), false);
  assert.equal(licenseAllowed('SSPL-1.0'), false);
  assert.equal(licenseAllowed('LGPL-3.0-or-later'), false);
});

test('an OR expression that chooses an allowed licence passes; AND needs all', () => {
  assert.equal(licenseAllowed('(MIT OR GPL-3.0-only)'), true);
  assert.equal(licenseAllowed('MIT OR Apache-2.0'), true);
  assert.equal(licenseAllowed('MIT AND GPL-3.0-only'), false);
  assert.equal(licenseAllowed('MIT AND ISC'), true);
  assert.equal(licenseAllowed('WTFPL'), false);
  assert.equal(licenseAllowed('SEE LICENSE IN README'), false);
  assert.equal(licenseAllowed(undefined), false);
});

test('planted GPL dependency fails the lockfile audit', (t) => {
  const dir = fixtureTree(t, {
    deps: { evil: '1.0.0' },
    lockEntries: lockEntry('evil', 'GPL-3.0-only'),
  });
  const { problems } = auditLockfile({ root: dir, dir: '.', label: 'fixture' });
  assert.ok(problems.some((p) => /evil@1\.0\.0.*GPL-3\.0-only.*not on the project allowlist/.test(p)), problems.join('\n'));
});

test('planted SSPL dependency fails the lockfile audit', (t) => {
  const dir = fixtureTree(t, {
    deps: { mongoish: '1.0.0' },
    lockEntries: lockEntry('mongoish', 'SSPL-1.0'),
  });
  const { problems } = auditLockfile({ root: dir, dir: '.', label: 'fixture' });
  assert.ok(problems.some((p) => /SSPL-1\.0.*not on the project allowlist/.test(p)), problems.join('\n'));
});

test('a dependency with no licence fails', (t) => {
  const dir = fixtureTree(t, {
    deps: { silent: '1.0.0' },
    lockEntries: lockEntry('silent', undefined),
  });
  const { problems } = auditLockfile({ root: dir, dir: '.', label: 'fixture' });
  assert.ok(problems.some((p) => /silent@1\.0\.0 declares no licence/.test(p)), problems.join('\n'));
});

test('an APPROVED exceptions.json entry passes; EXCEPTION_NEEDED fails', (t) => {
  const approved = fixtureTree(t, {
    deps: { rare: '1.0.0' },
    lockEntries: lockEntry('rare', 'CC-BY-4.0'),
    exceptions: [{ package: 'rare', version: '1.0.0', license: 'CC-BY-4.0', status: 'APPROVED', reason: 'docs asset only', approved: '2026-01-01' }],
  });
  const ok = auditLockfile({ root: approved, dir: '.', label: 'fixture' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.packages[0].verdict, 'exception (approved 2026-01-01)');

  const pending = fixtureTree(t, {
    deps: { rare: '1.0.0' },
    lockEntries: lockEntry('rare', 'CC-BY-4.0'),
    exceptions: [{ package: 'rare', version: '1.0.0', license: 'CC-BY-4.0', status: 'EXCEPTION_NEEDED', reason: 'awaiting approval' }],
  });
  const { problems } = auditLockfile({ root: pending, dir: '.', label: 'fixture' });
  assert.ok(problems.some((p) => /EXCEPTION_NEEDED/.test(p)), problems.join('\n'));
});

test('transitive deps and nested lockfile paths are walked; dev entries are not', (t) => {
  const dir = fixtureTree(t, {
    deps: { top: '1.0.0', devtool: '1.0.0' },
    lockEntries: {
      ...lockEntry('top', 'MIT', { mid: '1.0.0' }),
      'node_modules/top/node_modules/mid': { version: '1.0.0', license: '(MIT OR GPL-3.0-only)' },
      'node_modules/devtool': { version: '1.0.0', dev: true, license: 'GPL-3.0-only' },
    },
  });
  const { packages, problems } = auditLockfile({ root: dir, dir: '.', label: 'fixture' });
  assert.deepEqual(problems, []);
  assert.deepEqual(packages.map((p) => p.name), ['mid', 'top']);
});

test('the committed function-runtime mirror still matches FUNCTION_DEPENDENCIES', () => {
  const declared = declaredFunctionDependencies(root);
  assert.ok(declared && Object.keys(declared).length > 0);
});

test('no second literal copy of the project licence list outside the shared module', () => {
  const sharedModule = path.join('scripts', 'licenses', 'allowed-licenses.mjs');
  const ids = [...SHIPPED_LICENSES];
  const quoted = (id) => new RegExp(`['"\`]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
  const offenders = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'c2c-fixtures-local'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.[cm]?[jt]s$/.test(entry.name)) continue;
      const rel = path.relative(root, full);
      if (rel === sharedModule) continue;
      // Test files legitimately carry licence ids as fixture data; a copied
      // allowlist in shipped code is the defect this guards.
      if (/\.(test|spec)\.[cm]?[jt]s$/.test(entry.name) || rel.split(path.sep).includes('test')) continue;
      const text = readFileSync(full, 'utf8');
      const hits = ids.filter((id) => quoted(id).test(text));
      if (hits.length >= 5) offenders.push(`${rel} (${hits.length} allowlisted ids: ${hits.join(', ')})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `second licence allowlist(s) found; import SHIPPED_LICENSES from ${sharedModule} instead:\n${offenders.join('\n')}`,
  );
});
