/**
 * Filesystem classification in scripts/check-hygiene.mjs and
 * scripts/vendor-plugin.mjs: missing paths, directories where a file is
 * expected, symlinks and FIFOs. Each check is made on the descriptor or the
 * directory listing that is then used, so these pin the outcome for every
 * kind of entry rather than the order of calls.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scanDirectory, scanTree } from '../../scripts/check-hygiene.mjs';
import { manifestText, pluginHygieneProblems, shippedLicenses, vendorPlugin, versionProblems } from '../../scripts/vendor-plugin.mjs';

function tempDir(t, label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function fifo(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('mkfifo', [file]);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(cwd, '.no-global'), GIT_DIR: path.join(cwd, '.git'), GIT_WORK_TREE: cwd },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('scanDirectory refuses a symlink and a FIFO, walks real directories', (t) => {
  const dir = tempDir(t, 'hygiene-walk');
  write(path.join(dir, 'a/b/clean.txt'), 'plain text\n');
  assert.deepEqual(scanDirectory(dir), []);

  symlinkSync('a', path.join(dir, 'link'));
  assert.throws(() => scanDirectory(dir), { message: 'check-hygiene: symlink link' });
  unlinkSync(path.join(dir, 'link'));

  fifo(path.join(dir, 'a/pipe'));
  assert.throws(() => scanDirectory(dir), { message: 'check-hygiene: not a regular file a/pipe' });
});

test('scanTree skips a tracked file that is gone or under a file, and throws on one that is now a directory', (t) => {
  const dir = tempDir(t, 'hygiene-tree');
  git(dir, ['init', '-q']);
  write(path.join(dir, 'kept.txt'), 'plain\n');
  write(path.join(dir, 'gone.txt'), 'plain\n');
  write(path.join(dir, 'sub/inner.txt'), 'plain\n');
  write(path.join(dir, 'now-dir.txt'), 'plain\n');
  git(dir, ['add', '-A']);

  unlinkSync(path.join(dir, 'gone.txt'));
  rmSync(path.join(dir, 'sub'), { recursive: true });
  write(path.join(dir, 'sub'), 'plain\n');
  assert.deepEqual(scanTree(dir), []);

  unlinkSync(path.join(dir, 'now-dir.txt'));
  mkdirSync(path.join(dir, 'now-dir.txt'));
  assert.throws(() => scanTree(dir), { code: 'EISDIR' });
});

test('pluginHygieneProblems: plugin/ that is missing, a file, a FIFO or a symlink is missing', (t) => {
  const missing = ['plugin-hygiene: plugin/ is missing'];
  const root = tempDir(t, 'plugin-dir');
  assert.deepEqual(pluginHygieneProblems(root), missing);

  write(path.join(root, 'plugin'), 'not a dir\n');
  assert.deepEqual(pluginHygieneProblems(root), missing);
  unlinkSync(path.join(root, 'plugin'));

  fifo(path.join(root, 'plugin'));
  assert.deepEqual(pluginHygieneProblems(root), missing);
  unlinkSync(path.join(root, 'plugin'));

  write(path.join(root, 'real/clean.txt'), 'plain\n');
  symlinkSync('real', path.join(root, 'plugin'));
  assert.deepEqual(pluginHygieneProblems(root), missing);
  unlinkSync(path.join(root, 'plugin'));

  write(path.join(root, 'plugin/clean.txt'), 'plain\n');
  assert.deepEqual(pluginHygieneProblems(root), []);
  const distMissing = 'plugin-hygiene: plugin/vendor/c2c/dist is missing';
  assert.ok(pluginHygieneProblems(root, { requireVendor: true }).includes(distMissing));
  mkdirSync(path.join(root, 'plugin/vendor/c2c'), { recursive: true });
  symlinkSync('../../../real', path.join(root, 'plugin/vendor/c2c/dist'));
  assert.ok(pluginHygieneProblems(root, { requireVendor: true, ignore: ['vendor/c2c/dist'] }).includes(distMissing));
  unlinkSync(path.join(root, 'plugin/vendor/c2c/dist'));
  mkdirSync(path.join(root, 'plugin/vendor/c2c/dist'));
  assert.ok(!pluginHygieneProblems(root, { requireVendor: true }).includes(distMissing));
});

function writePackage(nodeModules, rel, { license = 'MIT', licenseFile = 'LICENSE' } = {}) {
  write(path.join(nodeModules, rel, 'package.json'), JSON.stringify({ name: rel, version: '1.0.0', license }));
  if (licenseFile) write(path.join(nodeModules, rel, licenseFile), `${rel} licence text\n`);
}

test('shippedLicenses: only real package directories with a regular package.json and licence file count', (t) => {
  const dir = tempDir(t, 'licences');
  const nodeModules = path.join(dir, 'node_modules');
  const textsDir = path.join(dir, 'texts');
  const exceptionsFile = path.join(dir, 'exceptions.json');
  mkdirSync(textsDir);
  writePackage(nodeModules, 'plain');
  writePackage(nodeModules, '@scope/inner');
  writePackage(nodeModules, 'plain/node_modules/nested');
  // A symlinked unscoped package directory is not a package root.
  writePackage(dir, 'linked-target');
  symlinkSync(path.join(dir, 'linked-target'), path.join(nodeModules, 'linked'));
  // package.json that is a symlink, a directory or a FIFO: not a package root.
  write(path.join(dir, 'pkg.json'), JSON.stringify({ name: 'x', version: '1.0.0', license: 'MIT' }));
  mkdirSync(path.join(nodeModules, 'pkg-link'));
  symlinkSync(path.join(dir, 'pkg.json'), path.join(nodeModules, 'pkg-link/package.json'));
  mkdirSync(path.join(nodeModules, 'pkg-dir/package.json'), { recursive: true });
  fifo(path.join(nodeModules, 'pkg-fifo/package.json'));
  // Licence candidates that are a symlink, a directory or a FIFO are not texts.
  writePackage(nodeModules, 'odd-licences', { licenseFile: null });
  symlinkSync(path.join(nodeModules, 'plain/LICENSE'), path.join(nodeModules, 'odd-licences/LICENSE'));
  mkdirSync(path.join(nodeModules, 'odd-licences/COPYING'));
  fifo(path.join(nodeModules, 'odd-licences/NOTICE'));
  // The fallback text is used only when it is a regular file.
  writePackage(nodeModules, 'fallback-file', { licenseFile: null });
  write(path.join(textsDir, 'fallback-file-1.0.0.txt'), 'fallback text\n');
  writePackage(nodeModules, 'fallback-link', { licenseFile: null });
  symlinkSync(path.join(textsDir, 'fallback-file-1.0.0.txt'), path.join(textsDir, 'fallback-link-1.0.0.txt'));
  writePackage(nodeModules, 'fallback-dir', { licenseFile: null });
  mkdirSync(path.join(textsDir, 'fallback-dir-1.0.0.txt'));

  const run = () => shippedLicenses(nodeModules, { textsDir, exceptionsFile });
  const { packages, problems, pending } = run();
  assert.deepEqual(
    packages.map((entry) => entry.id ?? entry.name).sort(),
    ['@scope/inner', 'fallback-dir', 'fallback-file', 'fallback-link', 'odd-licences', 'plain', 'plain/node_modules/nested'],
  );
  assert.deepEqual(problems.sort(), [
    'fallback-dir@1.0.0: no licence text; add scripts/licenses/fallback-dir-1.0.0.txt',
    'fallback-link@1.0.0: no licence text; add scripts/licenses/fallback-link-1.0.0.txt',
    'odd-licences@1.0.0: no licence text; add scripts/licenses/odd-licences-1.0.0.txt',
  ]);
  assert.deepEqual(pending, []);

  // The exceptions file counts only as a regular file: missing, a directory
  // or a symlink means no exceptions.
  writePackage(nodeModules, 'odd-licence', { license: 'Odd-1.0' });
  const refused = 'odd-licence@1.0.0: licence Odd-1.0 is not allowed in the plugin';
  assert.ok(run().problems.includes(refused));
  mkdirSync(exceptionsFile);
  assert.ok(run().problems.includes(refused));
  rmSync(exceptionsFile, { recursive: true });
  const approved = path.join(dir, 'approved.json');
  write(approved, JSON.stringify([{ package: 'odd-licence', version: '1.0.0', license: 'Odd-1.0', status: 'APPROVED' }]));
  symlinkSync(approved, exceptionsFile);
  assert.ok(run().problems.includes(refused));
  unlinkSync(exceptionsFile);
  write(exceptionsFile, readFileSync(approved, 'utf8'));
  assert.ok(!run().problems.includes(refused));

  // A node_modules that is missing, a file or a symlink holds no packages.
  assert.deepEqual(shippedLicenses(path.join(dir, 'absent'), { textsDir, exceptionsFile }).packages, []);
  assert.deepEqual(shippedLicenses(path.join(dir, 'pkg.json'), { textsDir, exceptionsFile }).packages, []);
  symlinkSync(nodeModules, path.join(dir, 'nm-link'));
  assert.deepEqual(shippedLicenses(path.join(dir, 'nm-link'), { textsDir, exceptionsFile }).packages, []);
});

test('manifestText hashes regular files in name order and refuses a symlink or a FIFO', (t) => {
  const dir = tempDir(t, 'manifest');
  write(path.join(dir, 'b.txt'), 'b\n');
  write(path.join(dir, 'a/z.txt'), 'z\n');
  write(path.join(dir, 'MANIFEST.sha256'), 'ignored\n');
  const lines = manifestText(dir).trimEnd().split('\n');
  assert.deepEqual(lines.map((line) => line.split('  ')[1]), ['a/z.txt', 'b.txt']);
  assert.match(lines[0], /^[0-9a-f]{64} {2}a\/z\.txt$/);

  symlinkSync('b.txt', path.join(dir, 'a/link'));
  assert.throws(() => manifestText(dir), { message: 'vendor-plugin: symlink in vendor tree a/link' });
  unlinkSync(path.join(dir, 'a/link'));
  fifo(path.join(dir, 'a/pipe'));
  assert.throws(() => manifestText(dir), { message: 'vendor-plugin: not a regular file a/pipe' });
});

test('versionProblems: a VERSION that is missing, a directory or a symlink is missing', (t) => {
  const root = tempDir(t, 'version');
  write(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const versionFile = path.join(root, 'plugin/vendor/c2c/VERSION');
  const missing = 'plugin/vendor/c2c/VERSION missing != package.json 1.2.3';
  const versionErrors = (opts) => versionProblems(root, opts).filter((line) => line.startsWith('plugin/vendor/c2c/VERSION'));
  assert.deepEqual(versionErrors({ requireVendor: true }), [missing]);
  assert.deepEqual(versionErrors(), []);
  mkdirSync(versionFile, { recursive: true });
  assert.deepEqual(versionErrors({ requireVendor: true }), [missing]);
  rmSync(versionFile, { recursive: true });
  write(path.join(root, 'real-version'), '1.2.3\n');
  symlinkSync(path.join(root, 'real-version'), versionFile);
  assert.deepEqual(versionErrors({ requireVendor: true }), [missing]);
  unlinkSync(versionFile);
  write(versionFile, '9.9.9\n');
  assert.deepEqual(versionErrors(), ['plugin/vendor/c2c/VERSION 9.9.9 != package.json 1.2.3']);
  write(versionFile, '1.2.3\n');
  assert.deepEqual(versionErrors({ requireVendor: true }), []);
});

test('versionProblems lists only real skill directories', (t) => {
  const root = tempDir(t, 'skills');
  write(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  write(path.join(root, 'plugin/skills/real/SKILL.md'), '---\nname: real\n---\n');
  write(path.join(root, 'plugin/skills/file.md'), 'x\n');
  write(path.join(root, 'elsewhere/SKILL.md'), '---\nname: x\n---\n');
  symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'plugin/skills/linked'));
  const skillErrors = versionProblems(root).filter((line) => line.startsWith('skills/'));
  assert.deepEqual(skillErrors.map((line) => line.split('/')[1]), ['real']);
});

/** The smallest tree vendorPlugin accepts. */
function fakeRoot(t) {
  const root = tempDir(t, 'vendor-root');
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'fake', version: '1.2.3' }));
  const lock = { packages: {} };
  for (const name of ['typescript', 'jsdom', 'lossless-json']) {
    lock.packages[`node_modules/${name}`] = { version: '1.0.0' };
    writePackage(path.join(root, 'node_modules'), name);
  }
  write(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  write(path.join(root, 'dist/cli/src/c2c.js'), 'export {};\n');
  write(path.join(root, 'packages/ui/src/client-runtime.js'), 'export {};\n');
  write(path.join(root, 'packages/ui/src/client/a.js'), 'export {};\n');
  write(path.join(root, 'packages/deploy/fn/index.js'), 'export {};\n');
  write(path.join(root, 'packages/ui-score/rubric.json'), '{}\n');
  write(path.join(root, 'packages/ui-react/template/index.html'), '<!doctype html>\n');
  write(path.join(root, 'packages/cli/data/feature-matrix-v4.snapshot.json'), '{"source":true}\n');
  return root;
}

test('vendorPlugin: dist/ and dist/cli/src/c2c.js must be real, not missing, a symlink or the wrong kind', (t) => {
  const root = tempDir(t, 'vendor-guards');
  const distMissing = { message: 'vendor-plugin: dist/ is missing. Run npm run build first.' };
  const cliMissing = { message: 'vendor-plugin: dist/cli/src/c2c.js is missing. Run npm run build first.' };
  assert.throws(() => vendorPlugin({ root }), distMissing);
  write(path.join(root, 'dist'), 'file\n');
  assert.throws(() => vendorPlugin({ root }), distMissing);
  unlinkSync(path.join(root, 'dist'));
  write(path.join(root, 'real-dist/cli/src/c2c.js'), 'export {};\n');
  symlinkSync('real-dist', path.join(root, 'dist'));
  assert.throws(() => vendorPlugin({ root }), distMissing);
  unlinkSync(path.join(root, 'dist'));

  mkdirSync(path.join(root, 'dist/cli/src'), { recursive: true });
  assert.throws(() => vendorPlugin({ root }), cliMissing);
  mkdirSync(path.join(root, 'dist/cli/src/c2c.js'));
  assert.throws(() => vendorPlugin({ root }), cliMissing);
  rmSync(path.join(root, 'dist/cli/src/c2c.js'), { recursive: true });
  fifo(path.join(root, 'dist/cli/src/c2c.js'));
  assert.throws(() => vendorPlugin({ root }), cliMissing);
  unlinkSync(path.join(root, 'dist/cli/src/c2c.js'));
  symlinkSync(path.join(root, 'real-dist/cli/src/c2c.js'), path.join(root, 'dist/cli/src/c2c.js'));
  assert.throws(() => vendorPlugin({ root }), cliMissing);
});

test('vendorPlugin copies regular files with their mode, skips a FIFO in dist/, writes the manifest', (t) => {
  const root = fakeRoot(t);
  write(path.join(root, 'dist/cli/src/tool.bin'), 'bin\n');
  chmodSync(path.join(root, 'dist/cli/src/tool.bin'), 0o750);
  write(path.join(root, 'packages/deploy/fn/run.sh'), 'echo\n');
  chmodSync(path.join(root, 'packages/deploy/fn/run.sh'), 0o751);
  write(path.join(root, 'node_modules/jsdom/bin.js'), 'bin\n');
  chmodSync(path.join(root, 'node_modules/jsdom/bin.js'), 0o711);
  fifo(path.join(root, 'dist/cli/src/pipe'));
  const out = vendorPlugin({ root });
  const mode = (rel) => statSync(path.join(out, rel)).mode & 0o777;
  assert.equal(mode('dist/cli/src/tool.bin'), 0o750);
  assert.equal(mode('dist/deploy/src/fn/run.sh'), 0o751);
  assert.equal(mode('node_modules/jsdom/bin.js'), 0o711);
  assert.equal(readFileSync(path.join(out, 'dist/cli/data/feature-matrix-v4.snapshot.json'), 'utf8'), '{"source":true}\n');
  assert.throws(() => statSync(path.join(out, 'dist/cli/src/pipe')), { code: 'ENOENT' });
  assert.equal(readFileSync(path.join(out, 'MANIFEST.sha256'), 'utf8'), manifestText(out));
});

test('vendorPlugin keeps a matrix snapshot already in dist/ and fails on one that is a directory', (t) => {
  const root = fakeRoot(t);
  write(path.join(root, 'dist/cli/data/feature-matrix-v4.snapshot.json'), '{"dist":true}\n');
  const out = vendorPlugin({ root });
  assert.equal(readFileSync(path.join(out, 'dist/cli/data/feature-matrix-v4.snapshot.json'), 'utf8'), '{"dist":true}\n');

  rmSync(path.join(root, 'dist/cli/data/feature-matrix-v4.snapshot.json'));
  write(path.join(root, 'dist/cli/data/feature-matrix-v4.snapshot.json/inner.json'), '{}\n');
  assert.throws(() => vendorPlugin({ root }), { code: 'EISDIR' });
});

test('vendorPlugin refuses a symlink anywhere it copies from, and a FIFO runtime asset', (t) => {
  const cases = [
    ['dist/cli/src/link.js', 'vendor-plugin: refusing to vendor symlink cli/src/link.js'],
    ['packages/deploy/fn/link.js', 'vendor-plugin: refusing to vendor symlink link.js'],
    ['packages/ui-react/template/link.js', 'vendor-plugin: refusing to vendor symlink packages/ui-react/template/link.js'],
    ['node_modules/jsdom/link.js', 'vendor-plugin: refusing to vendor symlink node_modules/jsdom/link.js'],
  ];
  for (const [rel, message] of cases) {
    const root = fakeRoot(t);
    symlinkSync(path.join(root, 'package.json'), path.join(root, rel));
    assert.throws(() => vendorPlugin({ root }), { message }, rel);
  }

  const root = fakeRoot(t);
  rmSync(path.join(root, 'packages/ui-score/rubric.json'));
  symlinkSync(path.join(root, 'package.json'), path.join(root, 'packages/ui-score/rubric.json'));
  assert.throws(() => vendorPlugin({ root }), { message: 'vendor-plugin: refusing to vendor symlink packages/ui-score/rubric.json' });
  unlinkSync(path.join(root, 'packages/ui-score/rubric.json'));
  fifo(path.join(root, 'packages/ui-score/rubric.json'));
  assert.throws(() => vendorPlugin({ root }), { message: 'vendor-plugin: runtime asset packages/ui-score/rubric.json is not a file' });
  unlinkSync(path.join(root, 'packages/ui-score/rubric.json'));
  assert.throws(() => vendorPlugin({ root }), { code: 'ENOENT' });

  // packages/deploy/fn is walked as function runtime and again as a source
  // asset: the second copy refuses the FIFO the first one skips.
  const fnRoot = fakeRoot(t);
  fifo(path.join(fnRoot, 'packages/deploy/fn/pipe'));
  assert.throws(() => vendorPlugin({ root: fnRoot }), { message: 'vendor-plugin: runtime asset packages/deploy/fn/pipe is not a file' });
});

test('vendorPlugin: a runtime package that is missing, a file or a symlink is missing', (t) => {
  const message = 'vendor-plugin: runtime package node_modules/jsdom is missing. Run npm ci first.';
  const root = fakeRoot(t);
  rmSync(path.join(root, 'node_modules/jsdom'), { recursive: true });
  assert.throws(() => vendorPlugin({ root }), { message });
  write(path.join(root, 'node_modules/jsdom'), 'file\n');
  assert.throws(() => vendorPlugin({ root }), { message });
  unlinkSync(path.join(root, 'node_modules/jsdom'));
  writePackage(root, 'jsdom-real');
  symlinkSync(path.join(root, 'jsdom-real'), path.join(root, 'node_modules/jsdom'));
  assert.throws(() => vendorPlugin({ root }), { message });
});
