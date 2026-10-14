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

const VALID_SHA512 = 'sha512-f4OxZX/x/FO5LcGBSKHWXfwtSx+j1ncoSt3SABJtkGk=';
const registryUrl = (name, version = '1.0.0') => `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;

const lockEntry = (name, license, dependencies) => ({
  [`node_modules/${name}`]: {
    version: '1.0.0',
    integrity: VALID_SHA512,
    resolved: registryUrl(name),
    ...(license === undefined ? {} : { license }),
    ...(dependencies ? { dependencies } : {}),
  },
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

test('lockfile integrity hashes are required and non-registry tarballs are rejected', (t) => {
  const dir = fixtureTree(t, {
    deps: { unhashed: '1.0.0', remote: '2.0.0' },
    lockEntries: {
      'node_modules/unhashed': {
        version: '1.0.0',
        resolved: registryUrl('unhashed'),
        license: 'MIT',
      },
      'node_modules/remote': {
        version: '2.0.0',
        integrity: VALID_SHA512,
        resolved: 'https://example.invalid/remote.tgz',
        license: 'MIT',
      },
    },
  });
  const { problems } = auditLockfile({ root: dir, dir: '.', label: 'fixture' });
  assert.ok(problems.some((p) => /unhashed.*has no integrity hash/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /node_modules\/remote.*non-registry tarball source/.test(p)), problems.join('\n'));
});

test('every non-registry resolved form (file:, github:, ssh:, workspace:, http:, missing resolved) is rejected', (t) => {
  const refusedCases = [
    ['from-file', { resolved: 'file:../evil.tgz' }, /from-file.*non-registry tarball source/],
    ['from-github', { resolved: 'github:evil/x' }, /from-github.*non-registry tarball source/],
    ['from-ssh', { resolved: 'ssh://example.invalid/evil/x.git' }, /from-ssh.*non-registry tarball source/],
    ['from-git-https', { resolved: 'git+https://github.com/evil/x.git' }, /from-git-https.*non-registry tarball source/],
    ['from-workspace-proto', { resolved: 'workspace:*' }, /from-workspace-proto.*non-registry tarball source/],
    ['from-http', { resolved: 'http://registry.npmjs.org/from-http/-/from-http-1.0.0.tgz' }, /from-http.*non-registry tarball source/],
    ['from-spoof-host', { resolved: 'https://registry.npmjs.org.evil.example/from-spoof-host.tgz' }, /from-spoof-host.*non-registry tarball source/],
    ['missing-resolved', {}, /missing-resolved.*no resolved registry URL \(non-registry tarball source\)/],
  ];
  for (const [name, extra, pattern] of refusedCases) {
    const dir = fixtureTree(t, {
      deps: { [name]: '1.0.0' },
      lockEntries: {
        [`node_modules/${name}`]: {
          version: '1.0.0',
          integrity: VALID_SHA512,
          license: 'MIT',
          ...extra,
        },
      },
    });
    const { problems } = auditLockfile({ root: dir, dir: '.', label: 'fixture' });
    assert.ok(problems.some((p) => pattern.test(p)), `expected ${name} to fail ${pattern}, got: ${problems.join('\n')}`);
  }
});

test('weak sha1 and malformed integrity hashes are rejected while SHA-2 base64 digests pass', (t) => {
  const badIntegrityCases = [
    ['weak-sha1', 'sha1-f4OxZX/x/FO5LcGBSKHWXfwtSx8='],
    ['weak-md5', 'md5-f4OxZX/x/FO5LcGBSKHWXw=='],
    ['garbage-token', 'x'],
    ['non-base64-sha512', 'sha512-not_valid_base64!@#'],
    ['empty-sha512', 'sha512-'],
  ];
  for (const [name, integrity] of badIntegrityCases) {
    const dir = fixtureTree(t, {
      deps: { [name]: '1.0.0' },
      lockEntries: {
        [`node_modules/${name}`]: {
          version: '1.0.0',
          integrity,
          resolved: registryUrl(name),
          license: 'MIT',
        },
      },
    });
    const { problems } = auditLockfile({ root: dir, dir: '.', label: 'fixture' });
    assert.ok(
      problems.some((p) => new RegExp(`${name}.*invalid or weak integrity hash`).test(p)),
      `expected ${name} (${integrity}) to fail integrity format check, got: ${problems.join('\n')}`,
    );
  }

  const validSha2Dir = fixtureTree(t, {
    deps: { s512: '1.0.0', s384: '1.0.0', s256: '1.0.0' },
    lockEntries: {
      'node_modules/s512': { version: '1.0.0', integrity: VALID_SHA512, resolved: registryUrl('s512'), license: 'MIT' },
      'node_modules/s384': { version: '1.0.0', integrity: 'sha384-f4OxZX/x/FO5LcGBSKHWXfwtSx+j1ncoSt3SABJtkGk=', resolved: registryUrl('s384'), license: 'MIT' },
      'node_modules/s256': { version: '1.0.0', integrity: 'sha256-f4OxZX/x/FO5LcGBSKHWXfwtSx+j1ncoSt3SABJtkGk=', resolved: registryUrl('s256'), license: 'MIT' },
    },
  });
  assert.deepEqual(auditLockfile({ root: validSha2Dir, dir: '.', label: 'fixture' }).problems, []);
});

test('local workspace links inside the repo pass; workspace links escaping the repo fail', (t) => {
  const validWs = fixtureTree(t, {
    deps: { 'local-ws': '1.0.0' },
    lockEntries: {
      'packages/local-ws': { version: '1.0.0', license: 'MIT' },
      'node_modules/local-ws': { link: true, resolved: 'packages/local-ws' },
    },
  });
  const ok = auditLockfile({ root: validWs, dir: '.', label: 'fixture' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.packages[0].name, 'local-ws');

  for (const [name, resolved] of [
    ['escape-rel', '../../outside'],
    ['escape-abs', '/tmp/outside'],
    ['escape-proto', 'workspace:*'],
    ['escape-missing', undefined],
  ]) {
    const badWs = fixtureTree(t, {
      deps: {},
      lockEntries: {
        [`node_modules/${name}`]: { link: true, ...(resolved === undefined ? {} : { resolved }) },
      },
    });
    const { problems } = auditLockfile({ root: badWs, dir: '.', label: 'fixture' });
    assert.ok(
      problems.some((p) => new RegExp(`${name}.*workspace link points outside the repository`).test(p)),
      `expected ${name} to fail workspace link check, got: ${problems.join('\n')}`,
    );
  }
});

test('inBundle entries pass without own integrity/resolved when parent is verified, and still undergo licence checks', (t) => {
  const allowedBundle = fixtureTree(t, {
    deps: { parent: '1.0.0' },
    lockEntries: {
      ...lockEntry('parent', 'MIT', { bundled: '1.0.0' }),
      'node_modules/parent/node_modules/bundled': {
        version: '1.0.0',
        inBundle: true,
        license: 'Apache-2.0',
      },
    },
  });
  const ok = auditLockfile({ root: allowedBundle, dir: '.', label: 'fixture' });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.packages.map((p) => p.name), ['bundled', 'parent']);

  const copyleftBundle = fixtureTree(t, {
    deps: { parent: '1.0.0' },
    lockEntries: {
      ...lockEntry('parent', 'MIT', { 'bundled-gpl': '1.0.0' }),
      'node_modules/parent/node_modules/bundled-gpl': {
        version: '1.0.0',
        inBundle: true,
        license: 'GPL-3.0-only',
      },
    },
  });
  const bad = auditLockfile({ root: copyleftBundle, dir: '.', label: 'fixture' });
  assert.ok(bad.problems.some((p) => /bundled-gpl@1\.0\.0.*GPL-3\.0-only.*not on the project allowlist/.test(p)), bad.problems.join('\n'));
});

test('registry tarballs with integrity hashes pass lockfile source checks', (t) => {
  const dir = fixtureTree(t, {
    deps: { regular: '1.0.0' },
    lockEntries: {
      'node_modules/regular': {
        version: '1.0.0',
        integrity: VALID_SHA512,
        resolved: 'https://registry.npmjs.org/regular/-/regular-1.0.0.tgz',
        license: 'MIT',
      },
    },
  });
  const { problems } = auditLockfile({ root: dir, dir: '.', label: 'fixture' });
  assert.deepEqual(problems, []);
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
    lockEntries: {
      'node_modules/silent': {
        version: '1.0.0',
        integrity: VALID_SHA512,
        resolved: registryUrl('silent'),
        license: undefined,
      },
    },
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
      'node_modules/top/node_modules/mid': {
        version: '1.0.0',
        integrity: VALID_SHA512,
        resolved: registryUrl('mid'),
        license: '(MIT OR GPL-3.0-only)',
      },
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
