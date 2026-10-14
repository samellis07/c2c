/**
 * Packaging: vendored plugin tree, version equality, and the doctor launcher.
 * npm test builds first, so dist/ exists before these run.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanDirectory } from '../../scripts/check-hygiene.mjs';
import { shippedLicenses } from '../../scripts/vendor-plugin.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const node = process.execPath;
const script = path.join(repo, 'scripts/vendor-plugin.mjs');
// The plugin runs on this Node only; bin/c2c refuses any other version.
const PINNED_NODE = '20.20.1';
const onPinnedNode = process.versions.node === PINNED_NODE;
const PINNED_SKIP = 'pinned-node check runs on the Node 20 leg';

function run(args, cwd = repo) {
  return spawnSync(node, [script, ...args], { cwd, encoding: 'utf8' });
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Minimal tree the version check reads. `pkg` is package.json's version; the rest share `pluginVersion`. */
function fixtureRoot(pkg, pluginVersion) {
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-ver-'));
  writeJson(path.join(root, 'package.json'), { name: 'creator-to-catalyst', version: pkg, private: true });
  writeJson(path.join(root, 'plugin/.claude-plugin/plugin.json'), {
    name: 'c2c',
    version: pluginVersion,
    description: 'fixture',
    author: { name: 'c2c-test' },
  });
  writeJson(path.join(root, 'plugin/.cursor-plugin/plugin.json'), {
    name: 'c2c',
    version: pluginVersion,
    description: 'fixture',
  });
  writeJson(path.join(root, 'plugin/.claude-plugin/marketplace.json'), {
    name: 'creator-to-catalyst',
    owner: { name: 'c2c-test' },
    description: 'fixture',
    plugins: [{ name: 'c2c', source: './', version: pluginVersion }],
  });
  writeJson(path.join(root, 'plugin/references/compat.json'), { c2c: pluginVersion });
  const skill = path.join(root, 'plugin/skills/c2c-migrate/SKILL.md');
  mkdirSync(path.dirname(skill), { recursive: true });
  writeFileSync(skill, `---\nname: c2c-migrate\ndescription: fixture\nmetadata:\n  version: "${pluginVersion}"\n---\n\n# fixture\n`);
  return root;
}

test('node is the pinned 20.20.1', (t) => {
  if (!onPinnedNode) {
    t.skip(PINNED_SKIP);
    return;
  }
  assert.equal(process.versions.node, PINNED_NODE);
});

test('version-mismatch fixture fails the check', () => {
  const root = fixtureRoot('0.1.0', '0.2.0');
  try {
    const res = run(['--check-versions', '--root', root]);
    assert.notEqual(res.status, 0, res.stdout);
    const text = `${res.stdout}\n${res.stderr}`;
    assert.match(text, /0\.1\.0/);
    assert.match(text, /0\.2\.0/);
    assert.match(text, /plugin\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('matching version fixture passes the check', () => {
  const root = fixtureRoot('1.2.3', '1.2.3');
  try {
    const res = run(['--check-versions', '--root', root]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('vendor-plugin twice writes identical manifests', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'c2c-vendor-'));
  try {
    const first = path.join(out, 'a');
    const second = path.join(out, 'b');
    const run1 = run(['--out', first]);
    assert.equal(run1.status, 0, run1.stderr || run1.stdout);
    const run2 = run(['--out', second]);
    assert.equal(run2.status, 0, run2.stderr || run2.stdout);
    const manifest1 = readFileSync(path.join(first, 'MANIFEST.sha256'), 'utf8');
    const manifest2 = readFileSync(path.join(second, 'MANIFEST.sha256'), 'utf8');
    assert.equal(manifest1, manifest2);
    assert.match(manifest1, /^[0-9a-f]{64}  \S+\n/);
    const again = run(['--out', first]);
    assert.equal(again.status, 0, again.stderr || again.stdout);
    assert.equal(readFileSync(path.join(first, 'MANIFEST.sha256'), 'utf8'), manifest1);
    for (const dir of [first, second]) {
      const version = readFileSync(path.join(dir, 'VERSION'), 'utf8').trim();
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      assert.equal(pkg.version, version);
      assert.equal(pkg.private, true);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('repo versions match and bin/c2c doctor --local starts', (t) => {
  const vendor = run([]);
  assert.equal(vendor.status, 0, vendor.stderr || vendor.stdout);
  const versions = run(['--check-versions', '--require-vendor']);
  assert.equal(versions.status, 0, versions.stderr || versions.stdout);
  assert.deepEqual(scanDirectory(path.join(repo, 'plugin'), { ignore: ['vendor/c2c/node_modules'] }), []);
  // bin/c2c refuses to start on any Node but the pinned one.
  if (!onPinnedNode) {
    t.skip(PINNED_SKIP);
    return;
  }

  const workspace = mkdtempSync(path.join(tmpdir(), 'c2c-ws-'));
  try {
    const bin = path.join(repo, 'plugin/bin/c2c');
    const res = spawnSync(bin, ['doctor', '--local'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: workspace,
        CODEX_HOME: workspace,
        C2C_WORKSPACE: workspace,
      },
    });
    assert.ok(res.status === 0 || res.status === 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
    assert.match(res.stdout, /local run; doctor\.json not updated/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('vendored plugin analyze matches the repo build', (t) => {
  // The vendored tree sits outside this repo, so nothing resolves into the
  // repo's node_modules or source files — exactly what a plugin install sees.
  if (!onPinnedNode) {
    t.skip(PINNED_SKIP);
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-vendor-parity-'));
  try {
    const pluginDir = path.join(root, 'plugin');
    const vendorOut = path.join(pluginDir, 'vendor', 'c2c');
    const vendored = run(['--out', vendorOut]);
    assert.equal(vendored.status, 0, vendored.stderr || vendored.stdout);
    const binDir = path.join(pluginDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, 'c2c');
    copyFileSync(path.join(repo, 'plugin/bin/c2c'), bin);
    chmodSync(bin, 0o755);

    const workspace = path.join(root, 'ws');
    mkdirSync(workspace);
    const env = {
      ...process.env,
      PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: workspace,
      CODEX_HOME: workspace,
      C2C_WORKSPACE: workspace,
    };
    const fixture = path.join(repo, 'packages/cli/test/fixtures/precheck/clean.ds');
    const viaPlugin = spawnSync(bin, ['analyze', fixture], { cwd: workspace, env, encoding: 'utf8' });
    const viaDist = spawnSync(node, [path.join(repo, 'dist/cli/src/c2c.js'), 'analyze', fixture], {
      cwd: workspace,
      env,
      encoding: 'utf8',
    });
    assert.equal(viaDist.status, 0, viaDist.stderr || viaDist.stdout);
    assert.equal(viaPlugin.status, viaDist.status, `stdout=${viaPlugin.stdout}\nstderr=${viaPlugin.stderr}`);
    assert.equal(viaPlugin.stdout, viaDist.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A notes widget whose value carries HTML: analyze runs the sanitizer, which needs a DOM. */
const NOTES_HTML_DS = `application "Notes_Html"
{
	forms
	{
		form Item
		{
			Title
			(
				type = text
				displayname = "Title"
			)
			Body
			(
				type = add-notes
				displayname = "Body"
				value = "<b style=width:expression(1)>hi</b>"
			)
		}
	}
	reports
	{
		list All_Items
		{
			displayName = "All Items"
			show all rows from Item
			(
				Title as "Title"
			)
		}
	}
}
`;

test('vendored plugin customer verbs match the repo build on notes-HTML', (t) => {
  // A notes widget whose value carries HTML drives the sanitizer, which needs
  // a DOM. The vendored tree must ship that DOM (jsdom) — nothing may resolve
  // back into this repo's node_modules.
  if (!onPinnedNode) {
    t.skip(PINNED_SKIP);
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-vendor-dom-'));
  try {
    const pluginDir = path.join(root, 'plugin');
    const vendored = run(['--out', path.join(pluginDir, 'vendor', 'c2c')]);
    assert.equal(vendored.status, 0, vendored.stderr || vendored.stdout);
    const binDir = path.join(pluginDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, 'c2c');
    copyFileSync(path.join(repo, 'plugin/bin/c2c'), bin);
    chmodSync(bin, 0o755);

    const fixture = path.join(root, 'notes.ds');
    writeFileSync(fixture, NOTES_HTML_DS);

    const verbs = [
      ['analyze', [fixture]],
      ['plan', [fixture, '--out', 'plan', '--dc', 'us']],
      ['ui', [fixture, '--out', 'ui']],
      ['ui-react', [fixture, '--out', 'app']],
      ['deploy', [fixture, '--project', '123', '--org', '456', '--out', 'dep']],
    ];
    for (const [verb, args] of verbs) {
      const wsPlugin = path.join(root, `ws-p-${verb}`);
      const wsDist = path.join(root, `ws-d-${verb}`);
      mkdirSync(wsPlugin, { recursive: true });
      mkdirSync(wsDist, { recursive: true });
      const envFor = (ws) => ({
        ...process.env,
        PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: ws,
        CODEX_HOME: ws,
        C2C_WORKSPACE: ws,
      });
      const viaPlugin = spawnSync(bin, [verb, ...args], { cwd: wsPlugin, env: envFor(wsPlugin), encoding: 'utf8' });
      const viaDist = spawnSync(node, [path.join(repo, 'dist/cli/src/c2c.js'), verb, ...args], {
        cwd: wsDist,
        env: envFor(wsDist),
        encoding: 'utf8',
      });
      assert.equal(viaDist.status, 0, `${verb} via dist: ${viaDist.stderr || viaDist.stdout}`);
      assert.equal(viaPlugin.status, viaDist.status, `${verb} via plugin: stdout=${viaPlugin.stdout}\nstderr=${viaPlugin.stderr}`);
      assert.equal(viaPlugin.stdout, viaDist.stdout, `${verb} stdout`);
      assert.doesNotMatch(`${viaPlugin.stderr}\n${viaPlugin.stdout}`, /Cannot find module|MODULE_NOT_FOUND/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every package the plugin ships has an allowlisted licence and its text', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-vendor-lic-'));
  try {
    const out = path.join(root, 'c2c');
    const vendored = run(['--out', out]);
    assert.equal(vendored.status, 0, vendored.stderr || vendored.stdout);
    const { packages, problems, pending } = shippedLicenses(path.join(out, 'node_modules'));
    assert.deepEqual(problems, []);
    // Project allowlist only: a licence outside it fails here until a maintainer
    // turns its scripts/licenses/exceptions.json entry to APPROVED.
    assert.deepEqual(pending, [], `licences awaiting an approved exception:\n${pending.join('\n')}`);
    for (const name of ['typescript', 'jsdom', 'saxes', '@csstools/color-helpers', 'cssstyle/node_modules/rrweb-cssom']) {
      assert.ok(packages.some((entry) => entry.id === name), `${name} is shipped and checked`);
    }
    const notices = readFileSync(path.join(out, 'node_modules/THIRD_PARTY_LICENSES.txt'), 'utf8');
    for (const entry of packages) {
      assert.ok(notices.includes(`${entry.name}@${entry.version} (${entry.license}) at node_modules/${entry.id}\n`), `${entry.id} in THIRD_PARTY_LICENSES.txt`);
    }
    // saxes publishes no licence file; its ISC text must still ship.
    assert.match(notices, /saxes@6\.0\.0 \(ISC\)[^=]+={78}\n\n\[upstream repository[^\]]*\]\n\nThe ISC License/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the plugin licence check enforces the project allowlist plus explicit exceptions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-lic-fixture-'));
  try {
    const nodeModules = path.join(root, 'node_modules');
    const pkg = (name, version, license, text) => {
      writeJson(path.join(nodeModules, name, 'package.json'), { name, version, license });
      if (text) writeFileSync(path.join(nodeModules, name, 'LICENSE'), text);
    };
    pkg('copyleft', '1.0.0', 'GPL-3.0-only', 'GPL text\n');
    pkg('lgpl', '1.0.0', 'LGPL-3.0-only', 'LGPL text\n');
    pkg('agpl', '1.0.0', 'AGPL-3.0-only', 'AGPL text\n');
    pkg('sspl', '1.0.0', 'SSPL-1.0', 'SSPL text\n');
    pkg('unknown', '1.0.0', 'Foo-1.0', 'Foo text\n');
    pkg('@scope/bare', '2.0.0', 'MIT');
    pkg('ok', '1.0.0', 'BSD-3-Clause', 'BSD text\n');
    pkg('zero-bsd', '1.0.0', '0BSD', '0BSD text\n');
    pkg('noattr', '1.0.0', 'MIT-0', 'MIT No Attribution\n');
    pkg('pubdom', '1.0.0', 'Unlicense', 'Unlicense text\n');
    pkg('cc0', '1.0.0', 'CC0-1.0', 'CC0 text\n');
    pkg('approved', '1.0.0', 'EPL-2.0', 'EPL text\n');
    pkg('waiting', '1.0.0', 'EPL-2.0', 'EPL text\n');
    pkg('stale', '2.0.0', 'EPL-2.0', 'EPL text\n');
    const exceptionsFile = path.join(root, 'exceptions.json');
    writeJson(exceptionsFile, [
      { package: 'approved', version: '1.0.0', license: 'EPL-2.0', status: 'APPROVED', reason: 'maintainer ok' },
      { package: 'waiting', version: '1.0.0', license: 'EPL-2.0', status: 'EXCEPTION_NEEDED', reason: 'needs approval' },
      { package: 'stale', version: '1.0.0', license: 'EPL-2.0', status: 'APPROVED', reason: 'older version only' },
    ]);
    const { problems, pending } = shippedLicenses(nodeModules, { textsDir: path.join(root, 'none'), exceptionsFile });
    assert.deepEqual(problems, [
      '@scope/bare@2.0.0: no licence text; add scripts/licenses/@scope__bare-2.0.0.txt',
      'agpl@1.0.0: licence AGPL-3.0-only is not allowed in the plugin',
      'copyleft@1.0.0: licence GPL-3.0-only is not allowed in the plugin',
      'lgpl@1.0.0: licence LGPL-3.0-only is not allowed in the plugin',
      'sspl@1.0.0: licence SSPL-1.0 is not allowed in the plugin',
      'stale@2.0.0: licence EPL-2.0 is not allowed in the plugin',
      'unknown@1.0.0: licence Foo-1.0 is not allowed in the plugin',
    ]);
    assert.deepEqual(pending, ['EXCEPTION_NEEDED waiting@1.0.0: licence EPL-2.0 (needs approval)']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a vendored CLI with no jsdom exits 1 with one clean DomUnavailableError line', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-vendor-nodom-'));
  try {
    const out = path.join(root, 'c2c');
    const vendored = run(['--out', out]);
    assert.equal(vendored.status, 0, vendored.stderr || vendored.stdout);
    rmSync(path.join(out, 'node_modules/jsdom'), { recursive: true, force: true });
    const fixture = path.join(root, 'notes.ds');
    writeFileSync(fixture, NOTES_HTML_DS);
    const ws = path.join(root, 'ws');
    mkdirSync(ws, { recursive: true });
    const res = spawnSync(node, [path.join(out, 'dist/cli/src/c2c.js'), 'analyze', fixture], {
      cwd: ws,
      env: { ...process.env, HOME: ws, CODEX_HOME: ws, C2C_WORKSPACE: ws },
      encoding: 'utf8',
    });
    assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
    assert.equal(
      res.stderr,
      'c2c: a DOM is required to sanitize notes/print-template HTML but jsdom could not be loaded; reinstall the plugin or run npm ci [C2C-CLI-001]\nSee plugin/references/error-index.md#c2c-cli-001\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('vendored analyze and plan run without a repo-root .nvmrc', () => {
  const fixture = path.join(repo, 'fixtures/redistributable/library-application-system/library_application.ds');
  const temp = mkdtempSync(path.join(tmpdir(), 'c2c-plugin-smoke-'));
  const vendor = path.join(temp, 'plugin/vendor/c2c');
  try {
    const built = run(['--out', vendor]);
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const bin = path.join(repo, 'plugin/bin/c2c');
    const analyze = spawnSync(bin, ['analyze', fixture], {
      cwd: temp,
      encoding: 'utf8',
      env: { ...process.env, HOME: temp, C2C_WORKSPACE: temp, C2C_QUIET_NODE_WARN: '1' },
    });
    assert.equal(analyze.status, 0, analyze.stderr || analyze.stdout);
    const plan = spawnSync(bin, ['plan', fixture, '--dc', 'us', '--out', path.join(temp, 'plan')], {
      cwd: temp,
      encoding: 'utf8',
      env: { ...process.env, HOME: temp, C2C_WORKSPACE: temp, C2C_QUIET_NODE_WARN: '1' },
    });
    assert.equal(plan.status, 0, plan.stderr || plan.stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('schema stand-in rejects a plugin manifest with no name', () => {
  const root = fixtureRoot('1.2.3', '1.2.3');
  try {
    const pluginJson = path.join(root, 'plugin/.claude-plugin/plugin.json');
    const parsed = JSON.parse(readFileSync(pluginJson, 'utf8'));
    delete parsed.name;
    writeFileSync(pluginJson, `${JSON.stringify(parsed)}\n`);
    const res = run(['--schema', '--root', root]);
    assert.notEqual(res.status, 0);
    assert.match(`${res.stdout}\n${res.stderr}`, /plugin\.json name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
