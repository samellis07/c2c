/**
 * `c2c upgrade`: move a generated plan folder and React app from the c2c
 * version that made them to the running version. Offline: no store, no
 * network. A fetch that is called fails the test.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';
import { buildOfflinePlan, loadApp, writePlanTree } from '../../deploy/src/index.js';
import { c2cVersion } from '../../deploy/src/offline-plan.js';
import { generateReactApp, writeReactApp, planReactWrite } from '../../ui-react/src/index.js';
import { applyUpgrade, compareVersions, diffTablePlans, planUpgrade, upgradeAsText, upgradeCli, type UpgradeInput } from '../src/upgrade.js';

const LIBRARY = join(repoRoot(), 'fixtures/redistributable/library-application-system/library_application.ds');
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('upgrade must not use the network');
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = sha(readFileSync(path));
    }
  };
  walk(dir);
  return out;
}

function input(extra: Partial<UpgradeInput> = {}): UpgradeInput {
  return { app: loadApp(LIBRARY), dc: 'in', dcSource: '--dc', auth: true, ...extra };
}

/** A plan folder as an older c2c version left it. */
function oldPlan(version = '0.1.0'): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-upgrade-plan-'));
  const { files } = buildOfflinePlan(loadApp(LIBRARY), { dc: 'in', dcSource: '--dc', mail: false, newProject: true });
  writePlanTree(dir, files);
  const manifest = JSON.parse(readFileSync(join(dir, 'c2c-manifest.json'), 'utf8')) as { c2c: string };
  manifest.c2c = version;
  writeFileSync(join(dir, 'c2c-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

/** Make `path` look like an older version wrote different bytes, consistently with the manifest. */
function ageFile(dir: string, path: string, text: string): void {
  writeFileSync(join(dir, ...path.split('/')), text);
  const manifestPath = join(dir, 'c2c-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Record<string, string> };
  manifest.files[path] = `sha256:${sha(text)}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test('version comparison: older, equal, newer and unrecorded', () => {
  assert.equal(compareVersions('0.1.0', '0.2.0'), 'upgrade');
  assert.equal(compareVersions('0.2.0', '0.2.0'), 'same');
  assert.equal(compareVersions('0.10.0', '0.9.0'), 'downgrade');
  assert.equal(compareVersions(undefined, '0.2.0'), 'unknown');
});

test('a plan folder from an older version: regenerated files are listed, the customer files are kept', () => {
  const dir = oldPlan();
  ageFile(dir, 'plan.json', '{"old":true}\n');
  const edited = '{"MY_SECRET_KEY":"kept"}\n';
  writeFileSync(join(dir, 'function-env.json'), edited);
  const result = planUpgrade(input({ planDir: dir }));
  const plan = result.report.plan!;
  assert.equal(result.report.direction, 'upgrade');
  assert.equal(result.report.from, '0.1.0');
  assert.equal(result.report.to, c2cVersion());
  assert.deepEqual(plan.regenerated, ['plan.json']);
  assert.deepEqual(plan.handEdited, []);
  assert.ok(plan.preserved.includes('function-env.json'));
  assert.ok(plan.preserved.includes('provision/inputs.json'));
  assert.deepEqual(result.report.blocked, []);
  const before = tree(dir);
  assert.deepEqual(tree(dir), before, 'planning writes nothing');

  const done = applyUpgrade(input({ planDir: dir }), result);
  assert.ok(done.written.includes('plan.json'));
  assert.equal(readFileSync(join(dir, 'function-env.json'), 'utf8'), edited, 'function environment untouched');
  const fresh = buildOfflinePlan(loadApp(LIBRARY), { dc: 'in', dcSource: '--dc', mail: false, newProject: true }).files.find((f) => f.path === 'plan.json')!;
  assert.equal(readFileSync(join(dir, 'plan.json'), 'utf8'), fresh.data);
  const manifest = JSON.parse(readFileSync(join(dir, 'c2c-manifest.json'), 'utf8')) as { c2c: string; files: Record<string, string> };
  assert.equal(manifest.c2c, c2cVersion());
  assert.equal(manifest.files['function-env.json'], undefined, 'the manifest does not claim the customer file');
  // A second run finds nothing left to do.
  const again = planUpgrade(input({ planDir: dir }));
  assert.deepEqual(again.report.plan!.regenerated, []);
  assert.equal(again.report.direction, 'same');
});

test('a manifest or plan that names a path outside the plan folder is refused before anything is read, written or removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-upgrade-escape-'));
  const victim = join(root, 'victim.txt');
  writeFileSync(victim, 'keep me');
  const attempts: Record<string, string> = {
    '../victim.txt': 'a parent segment',
    '/abs/victim.txt': 'an absolute path',
    'a/../../victim.txt': 'a nested parent segment',
    'back\\slash': 'a backslash',
    'with\u0000nul': 'a control character',
    '': 'an empty path',
    'a//b': 'an empty segment',
  };
  for (const [path, why] of Object.entries(attempts)) {
    const dir = oldPlan();
    const manifestPath = join(dir, 'c2c-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Record<string, string> };
    manifest.files[path] = `sha256:${sha('keep me')}`;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => planUpgrade(input({ planDir: dir })), /upgrade refused: the plan names a path/, `${why} is refused at plan time`);
    assert.equal(readFileSync(victim, 'utf8'), 'keep me', `${why}: the victim is untouched`);
  }
  // A manifest path through a symlinked directory that leads outside the folder is refused too.
  const dir = oldPlan();
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'victim.txt'), 'keep me');
  symlinkSync(outside, join(dir, 'link'));
  const manifestPath = join(dir, 'c2c-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Record<string, string> };
  manifest.files['link/victim.txt'] = `sha256:${sha('keep me')}`;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => planUpgrade(input({ planDir: dir })), /upgrade refused/);
  assert.equal(readFileSync(join(outside, 'victim.txt'), 'utf8'), 'keep me');
  assert.equal(existsSync(victim), true);
});

test('a hand-edited generated file blocks the upgrade; --force discards it', () => {
  const dir = oldPlan();
  writeFileSync(join(dir, 'plan.md'), 'edited by hand\n');
  const result = planUpgrade(input({ planDir: dir }));
  assert.deepEqual(result.report.plan!.handEdited, ['plan.md']);
  assert.match(result.report.blocked.join('\n'), /edited by hand: plan\.md/);
  const before = tree(dir);
  assert.throws(() => applyUpgrade(input({ planDir: dir }), result), /upgrade blocked/);
  assert.deepEqual(tree(dir), before, 'a blocked upgrade writes nothing');
  const forced = planUpgrade(input({ planDir: dir, force: true }));
  assert.deepEqual(forced.report.blocked, []);
  applyUpgrade(input({ planDir: dir, force: true }), forced);
  assert.notEqual(readFileSync(join(dir, 'plan.md'), 'utf8'), 'edited by hand\n');
});

test('a folder made by a newer c2c is refused, and a folder without a manifest is not a plan folder', () => {
  const newer = planUpgrade(input({ planDir: oldPlan('99.0.0') }));
  assert.equal(newer.report.direction, 'downgrade');
  assert.match(newer.report.blocked.join('\n'), /never downgrade/);
  const empty = mkdtempSync(join(tmpdir(), 'c2c-upgrade-empty-'));
  const none = planUpgrade(input({ planDir: empty }));
  assert.match(none.report.blocked.join('\n'), /not a c2c plan folder/);
});

test('table changes: additive ones pass, breaking ones need a verified backup', () => {
  const additive = oldPlan();
  const tablesPath = join(additive, 'provision', 'tables.json');
  const steps = JSON.parse(readFileSync(tablesPath, 'utf8')) as { table: string; columns: { column_name: string }[] }[];
  const target = steps.find((s) => s.columns.length > 1)!;
  const dropped = target.columns.pop()!;
  ageFile(additive, 'provision/tables.json', `${JSON.stringify(steps, null, 2)}\n`);
  const ok = planUpgrade(input({ planDir: additive }));
  assert.ok(ok.report.schemaChange!.additive.some((line) => line.includes(`${target.table}.${dropped.column_name}`)), 'the new column is additive');
  assert.deepEqual(ok.report.schemaChange!.breaking, []);
  assert.deepEqual(ok.report.blocked, []);

  const breaking = oldPlan();
  const old = JSON.parse(readFileSync(join(breaking, 'provision', 'tables.json'), 'utf8')) as { table: string; columns: Record<string, unknown>[] }[];
  old[0]!.columns.push({ column_name: 'Gone_Column', data_type: 'varchar' });
  ageFile(breaking, 'provision/tables.json', `${JSON.stringify(old, null, 2)}\n`);
  const refused = planUpgrade(input({ planDir: breaking }));
  assert.ok(refused.report.schemaChange!.breaking.some((line) => line.includes('Gone_Column is dropped')));
  assert.match(refused.report.blocked.join('\n'), /breaking way/);
  assert.throws(() => applyUpgrade(input({ planDir: breaking }), refused), /upgrade blocked/);
  const allowed = planUpgrade(input({ planDir: breaking, allowDestructive: true }));
  assert.deepEqual(allowed.report.blocked, []);
});

test('diffTablePlans names type changes, tighter rules and new mandatory columns as breaking', () => {
  const before = [{ table: 'T', columns: [{ column_name: 'A', data_type: 'varchar' }, { column_name: 'B', data_type: 'int' }] }];
  const after = [
    { table: 'T', columns: [{ column_name: 'A', data_type: 'text', is_unique: true }, { column_name: 'B', data_type: 'int', is_mandatory: true }, { column_name: 'C', data_type: 'int', is_mandatory: true }, { column_name: 'D', data_type: 'int' }] },
    { table: 'U', columns: [{ column_name: 'X', data_type: 'int' }] },
  ];
  const diff = diffTablePlans(before, after);
  assert.deepEqual(diff.additive, ['new column T.D', 'new table U']);
  assert.equal(diff.breaking.length, 4);
  assert.match(diff.breaking.join('\n'), /T\.A changes type varchar -> text/);
  assert.match(diff.breaking.join('\n'), /T\.A becomes unique/);
  assert.match(diff.breaking.join('\n'), /T\.B becomes mandatory/);
  assert.match(diff.breaking.join('\n'), /new mandatory column T\.C/);
});

test('React app: generated and platform files are replaced, custom files and data stay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-upgrade-ui-'));
  const app = loadApp(LIBRARY);
  const files = generateReactApp(app, { auth: true });
  writeReactApp(dir, files);
  const custom = files.find((file) => file.owner === 'custom')!;
  writeFileSync(join(dir, custom.path), 'my customisation\n');
  const platform = files.find((file) => file.owner === 'platform')!;
  writeFileSync(join(dir, platform.path), 'older platform file\n');

  const result = planUpgrade(input({ uiDir: dir }));
  const changes = result.report.ui!.changes;
  assert.ok(changes.replaced.includes(platform.path), 'the platform file is upgraded');
  assert.ok(changes.kept.includes(custom.path), 'the custom file is kept');
  assert.deepEqual(changes.edited, []);
  const done = applyUpgrade(input({ uiDir: dir }), result);
  assert.ok(done.written.includes(`ui:${platform.path}`));
  assert.ok(done.kept.includes(`ui:${custom.path}`));
  assert.equal(readFileSync(join(dir, custom.path), 'utf8'), 'my customisation\n');
  assert.notEqual(readFileSync(join(dir, platform.path), 'utf8'), 'older platform file\n');
});

test('React app: a hand-edited generated file blocks the upgrade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-upgrade-ui-'));
  const files = generateReactApp(loadApp(LIBRARY), { auth: true });
  writeReactApp(dir, files);
  const generated = files.find((file) => file.owner === 'generated' && file.path !== 'src/generated/c2c-generated.json')!;
  writeFileSync(join(dir, generated.path), 'edited by hand\n');
  const result = planUpgrade(input({ uiDir: dir }));
  assert.deepEqual(result.report.ui!.changes.edited, [generated.path]);
  assert.match(result.report.blocked.join('\n'), new RegExp(`edited by hand: ${generated.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(readFileSync(join(dir, generated.path), 'utf8'), 'edited by hand\n');
});

test('the dry-run classification matches what writeReactApp does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-upgrade-ui-'));
  const files = generateReactApp(loadApp(LIBRARY), { auth: true });
  const first = planReactWrite(dir, files, { upgradePlatform: true });
  assert.equal(first.added.length, files.length);
  writeReactApp(dir, files);
  const platform = files.find((file) => file.owner === 'platform')!;
  writeFileSync(join(dir, platform.path), 'older\n');
  const preview = planReactWrite(dir, files, { upgradePlatform: true });
  const result = writeReactApp(dir, files, { upgradePlatform: true });
  assert.deepEqual([...preview.replaced, ...preview.unchanged, ...preview.added].sort(), [...result.written].sort());
  assert.deepEqual(preview.kept.sort(), [...result.kept].sort());
  assert.deepEqual(preview.removed, result.removed);
});

test('the command: usage, blocked exit, JSON report and apply', () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { stdout: (text: string) => lines.push(text), stderr: (text: string) => errors.push(text) };
  assert.equal(upgradeCli([], io), 2);
  assert.equal(upgradeCli([LIBRARY], io), 2, 'one of --plan or --ui is required');
  const empty = mkdtempSync(join(tmpdir(), 'c2c-upgrade-empty-'));
  assert.equal(upgradeCli([LIBRARY, '--plan', empty, '--dc', 'in'], io), 1, 'not a plan folder');

  const dir = oldPlan();
  ageFile(dir, 'plan.json', '{"old":true}\n');
  lines.length = 0;
  assert.equal(upgradeCli([LIBRARY, '--plan', dir, '--dc', 'in', '--json'], io), 0);
  const report = JSON.parse(lines.join('')) as { schema: string; plan: { regenerated: string[] } };
  assert.equal(report.schema, 'c2c-upgrade/1');
  assert.deepEqual(report.plan.regenerated, ['plan.json']);
  assert.equal(readFileSync(join(dir, 'plan.json'), 'utf8'), '{"old":true}\n', 'without --apply nothing is written');

  lines.length = 0;
  assert.equal(upgradeCli([LIBRARY, '--plan', dir, '--dc', 'in', '--apply'], io), 0);
  assert.match(lines.join(''), /upgrade applied: wrote \d+, removed 0, kept 2/);
  assert.notEqual(readFileSync(join(dir, 'plan.json'), 'utf8'), '{"old":true}\n');
  assert.equal(upgradeCli([LIBRARY, '--plan', dir, '--dc', 'in', '--allow-destructive'], io), 2, '--allow-destructive needs --backup');
});

test('the text report names the version, the changes and what is always kept', () => {
  const dir = oldPlan();
  ageFile(dir, 'plan.json', '{"old":true}\n');
  const text = upgradeAsText(planUpgrade(input({ planDir: dir })).report);
  assert.match(text, new RegExp(`version: 0\\.1\\.0 -> ${c2cVersion().replace(/\./g, '\\.')} \\(upgrade\\)`));
  assert.match(text, /regenerated \(1\):\n {4}- plan\.json/);
  assert.match(text, /data: no row is read or changed by the upgrade/);
  assert.match(text, /every row in the Data Store/);
});
