import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';
import { parseManifestFiles } from '../src/tree.js';

const root = repoRoot();
const DRIVER = join(root, 'tools/merge-generated.sh');
const INSTALLER = join(root, 'tools/install-merge-driver.sh');
const GIT = '/usr/bin/git';
const GENERATED_PATHS = [
  'packages/determinism/test/manifests/*.sha256',
  'docs/determinism-status.md',
  'docs/decimal-audit.md',
  'docs/quality-gate.md',
  'docs/coverage-gate.md',
];

function git(dir: string, args: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'c2c-merge-git-home-'));
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
    env.HOME = home;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
    writeFileSync(env.GIT_CONFIG_GLOBAL, '');
    return execFileSync(GIT, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('every committed generated artifact is covered by the c2c-generated merge driver', () => {
  const attrs = readFileSync(join(root, '.gitattributes'), 'utf8');
  for (const path of GENERATED_PATHS) {
    assert.match(
      attrs,
      new RegExp(`^${path.replace(/[*.]/g, (c) => `\\${c}`)}\\s+merge=c2c-generated$`, 'm'),
      `.gitattributes must route ${path} through merge=c2c-generated`,
    );
  }
});

test('merge driver and installer are executable and parse under bash', () => {
  for (const script of [DRIVER, INSTALLER]) {
    assert.ok(existsSync(script), `${script} missing`);
    assert.ok(statSync(script).mode & 0o111, `${script} must be executable`);
    execFileSync('bash', ['-n', script]);
  }
  const installer = readFileSync(INSTALLER, 'utf8');
  assert.match(installer, /merge\.c2c-generated\.driver .*%O %A %B %P/);
  const driver = readFileSync(DRIVER, 'utf8');
  for (const path of ['docs/determinism-status.md', 'docs/decimal-audit.md', 'docs/quality-gate.md']) {
    const branch = driver.slice(driver.indexOf(`  ${path})`));
    assert.match(branch.split('\n  *)')[0] ?? '', /C2C_MERGE_REGENERATE:-\}.*= "1"/, `${path} must require explicit regeneration opt-in`);
  }
});

test('the merge driver never runs repo code during an ordinary merge', () => {
  const driver = readFileSync(DRIVER, 'utf8');
  const body = driver.slice(driver.indexOf('case "$path"'));
  for (const branch of body.split(/^  (?=\S)/m).slice(1)) {
    if (!/\bnode\b/.test(branch)) continue;
    assert.match(
      branch,
      /C2C_MERGE_REGENERATE:-\}.*= "1"/,
      `driver branch runs node without the C2C_MERGE_REGENERATE=1 opt-in: ${branch.split(')')[0]})`,
    );
  }
});

test('a union-merged manifest is not canonical, so the staleness gate forces regeneration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-merge-union-'));
  try {
    const a = join(dir, 'a');
    const o = join(dir, 'o');
    const b = join(dir, 'b');
    const hex = (c: string) => c.repeat(64);
    writeFileSync(o, `${hex('a')}  p\n${hex('b')}  q\n`);
    writeFileSync(a, `${hex('a')}  p\n${hex('c')}  q\n`);
    writeFileSync(b, `${hex('a')}  p\n${hex('d')}  q\n`);
    const union = execFileSync('git', ['merge-file', '--union', '-p', a, o, b], { encoding: 'utf8' });
    assert.ok(union.includes(hex('c')) && union.includes(hex('d')), 'union keeps both sides');
    assert.throws(() => parseManifestFiles(union), /sorted and unique|not "<sha256>/, 'union output must fail the canonical check so determinism:check flags it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git merge resolves generated files through the driver without conflict markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-merge-driver-'));
  try {
    mkdirSync(join(dir, 'tools'));
    mkdirSync(join(dir, 'packages/determinism/test/manifests'), { recursive: true });
    writeFileSync(join(dir, 'tools/merge-generated.sh'), readFileSync(DRIVER));
    chmodSync(join(dir, 'tools/merge-generated.sh'), 0o755);
    writeFileSync(
      join(dir, '.gitattributes'),
      'generated.txt merge=c2c-generated\npackages/determinism/test/manifests/*.sha256 merge=c2c-generated\n',
    );
    writeFileSync(join(dir, 'generated.txt'), 'head\nmid\ntail\n');
    writeFileSync(join(dir, 'packages/determinism/test/manifests/app.sha256'), `${'a'.repeat(64)}  p\n${'b'.repeat(64)}  q\n`);
    const untouched = `${'e'.repeat(64)}  z\n`;
    writeFileSync(join(dir, 'packages/determinism/test/manifests/untouched.sha256'), untouched);
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'merge.c2c-generated.driver', 'bash tools/merge-generated.sh %O %A %B %P']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base']);
    git(dir, ['checkout', '-b', 'theirs']);
    writeFileSync(join(dir, 'generated.txt'), 'head\ntheirs-mid\ntail\n');
    writeFileSync(join(dir, 'packages/determinism/test/manifests/app.sha256'), `${'a'.repeat(64)}  p\n${'d'.repeat(64)}  q\n`);
    git(dir, ['commit', '-am', 'theirs']);
    git(dir, ['checkout', 'main']);
    writeFileSync(join(dir, 'generated.txt'), 'head\nours-mid\ntail\n');
    writeFileSync(join(dir, 'packages/determinism/test/manifests/app.sha256'), `${'a'.repeat(64)}  p\n${'c'.repeat(64)}  q\n`);
    git(dir, ['commit', '-am', 'ours']);

    git(dir, ['merge', '--no-edit', 'theirs']);

    const merged = readFileSync(join(dir, 'generated.txt'), 'utf8');
    assert.ok(merged.includes('ours-mid') && merged.includes('theirs-mid'), `union must keep both sides: ${merged}`);
    assert.doesNotMatch(merged, /<{7}|>{7}/, 'no conflict markers in a generated file');
    const manifest = readFileSync(join(dir, 'packages/determinism/test/manifests/app.sha256'), 'utf8');
    assert.ok(manifest.includes('c'.repeat(64)) && manifest.includes('d'.repeat(64)), `union keeps both manifest lines: ${manifest}`);
    assert.doesNotMatch(manifest, /<{7}|>{7}/);
    assert.equal(
      readFileSync(join(dir, 'packages/determinism/test/manifests/untouched.sha256'), 'utf8'),
      untouched,
      'the driver must not rewrite generated files beyond the merge result',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
