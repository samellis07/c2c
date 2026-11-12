import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, lstatSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NotFileError, parseFile, parseProject } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { lintCodegen } from '../src/lint.js';
import { updateManifests } from '../src/manifests.js';
import { main as statusMain } from '../src/status.js';
import { computeTableBudget } from '../src/table-budget.js';
import { digestOf, loadApp, manifestFor } from '../src/tree.js';

const ROOT = repoRoot();
const FIXTURE_DS = join(ROOT, 'fixtures/redistributable/library-application-system/library_application.ds');
const DIST = join(ROOT, 'dist/determinism/src');
const GALLERY_NOT_FOUND = 'gallery not found; pass --dir or set C2C_FIXTURES_DIR or C2C_GALLERY_DIR';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'c2c-det-fs-'));
}

/** A gallery with one app folder, one loose .ds, a symlinked app, a dangling link and noise. */
function gallery(): string {
  const dir = scratch();
  mkdirSync(join(dir, 'app-dir'));
  copyFileSync(FIXTURE_DS, join(dir, 'app-dir', 'library_application.ds'));
  copyFileSync(FIXTURE_DS, join(dir, 'loose.ds'));
  symlinkSync(join(dir, 'app-dir'), join(dir, 'linked-app'));
  symlinkSync(join(dir, 'gone'), join(dir, 'dangling.ds'));
  symlinkSync(join(dir, 'gone-dir'), join(dir, 'dangling-dir'));
  mkdirSync(join(dir, 'no-app'));
  writeFileSync(join(dir, 'no-app', 'notes.txt'), 'x');
  writeFileSync(join(dir, 'README.txt'), 'x');
  copyFileSync(FIXTURE_DS, join(dir, '.hidden.ds'));
  return dir;
}

/** The stat-based listing the Dirent walk replaced, with lstat: a symlink is skipped, never followed. */
function statListTargets(dir: string): string[] {
  const names = readdirSync(dir).filter((name) => !name.startsWith('.'));
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    // fs-race-allow: test oracle over a private scratch tree; nothing else writes it between the lstat and the read.
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (readdirSync(path).some((child) => child.toLowerCase().endsWith('.ds'))) out.push(path);
    } else if (name.toLowerCase().endsWith('.ds')) out.push(path);
  }
  return out;
}

test('determinism:gallery --digest lists the same targets as the lstat walk and skips every link', () => {
  const dir = gallery();
  try {
    const expected = statListTargets(dir);
    assert.deepEqual(
      expected.map((p) => p.slice(dir.length + 1)),
      ['app-dir', 'loose.ds'],
    );
    const lines = expected.map((target) => digestOf(manifestFor(target)));
    const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
    const res = spawnSync(process.execPath, [join(DIST, 'gallery.js'), '--digest', dir], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `${digest}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadApp reads a file as parseFile and a folder as parseProject; absent and FIFO throw as before', () => {
  const dir = gallery();
  try {
    execFileSync('mkfifo', [join(dir, 'pipe.ds')]);
    assert.deepEqual(loadApp(join(dir, 'loose.ds')).forms, parseFile(join(dir, 'loose.ds')).ir.forms);
    assert.deepEqual(loadApp(join(dir, 'app-dir')).forms, parseProject(join(dir, 'app-dir')).ir.forms);
    assert.throws(() => loadApp(join(dir, 'missing.ds')), { code: 'ENOENT' });
    assert.throws(() => loadApp(join(dir, 'pipe.ds')), NotFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeTableBudget parses folder and file apps by their opened kind', () => {
  const dir = gallery();
  try {
    const rows = computeTableBudget(dir);
    assert.ok(rows.length >= 2);
    const tables = new Set(rows.map((row) => row.appTables));
    assert.equal(tables.size, 1, 'the folder app and the loose copy count the same tables');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function gateCases(): { dir: string; cases: [string, string][] } {
  const dir = scratch();
  writeFileSync(join(dir, 'file'), 'x');
  execFileSync('mkfifo', [join(dir, 'pipe')]);
  symlinkSync(join(dir, 'gone'), join(dir, 'dangling'));
  return {
    dir,
    cases: [
      ['absent', join(dir, 'missing')],
      ['file', join(dir, 'file')],
      ['FIFO', join(dir, 'pipe')],
      ['dangling link', join(dir, 'dangling')],
      ['under a file', join(dir, 'file', 'x')],
    ],
  };
}

test('tables:budget --dir refuses absent, file, FIFO and dangling targets with exit 1 and the same message', () => {
  const { dir, cases } = gateCases();
  try {
    for (const [label, target] of cases) {
      const res = spawnSync(process.execPath, [join(DIST, 'table-budget.js'), '--dir', target, '--out', join(dir, 'out.md')], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(res.status, 1, label);
      assert.equal(res.stderr, `tables:budget: ${GALLERY_NOT_FOUND}\n`, label);
    }
    mkdirSync(join(dir, 'empty'));
    const empty = spawnSync(process.execPath, [join(DIST, 'table-budget.js'), '--dir', join(dir, 'empty'), '--out', join(dir, 'out.md')], { encoding: 'utf8' });
    assert.equal(empty.status, 1);
    assert.equal(empty.stderr, 'tables:budget: no apps in the gallery directory\n', 'a directory passes the gate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('determinism:status --dir refuses absent, file, FIFO and dangling targets with exit 1; a directory passes', () => {
  const { dir, cases } = gateCases();
  const stderr = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    for (const [label, target] of cases) {
      lines.length = 0;
      assert.equal(statusMain(['--dir', target, '--out', join(dir, 'out.md')]), 1, label);
      assert.deepEqual(lines, [`determinism:status: ${GALLERY_NOT_FOUND}\n`], label);
    }
    mkdirSync(join(dir, 'empty'));
    lines.length = 0;
    assert.equal(statusMain(['--dir', join(dir, 'empty'), '--out', join(dir, 'out.md')]), 1);
    assert.deepEqual(lines, ['determinism:status: no apps in the gallery directory\n']);
  } finally {
    process.stderr.write = stderr;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateManifests writes a missing manifest, rewrites nothing when current, and throws EISDIR for a directory', () => {
  const dir = scratch();
  try {
    const fixtures = join(dir, 'fixtures');
    const manifests = join(dir, 'manifests');
    mkdirSync(join(fixtures, 'lib'), { recursive: true });
    copyFileSync(FIXTURE_DS, join(fixtures, 'lib', 'library_application.ds'));
    assert.deepEqual(updateManifests(fixtures, manifests).written, ['lib']);
    const text = readFileSync(join(manifests, 'lib.sha256'), 'utf8');
    assert.deepEqual(updateManifests(fixtures, manifests).written, []);
    assert.equal(readFileSync(join(manifests, 'lib.sha256'), 'utf8'), text);
    rmSync(join(manifests, 'lib.sha256'));
    mkdirSync(join(manifests, 'lib.sha256'));
    // The read refuses the directory, before any write is attempted.
    assert.throws(() => updateManifests(fixtures, manifests), { code: 'EISDIR', syscall: 'read' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lintCodegen skips absent roots and symlinks, and throws on a directory locale file', () => {
  const root = scratch();
  try {
    assert.deepEqual(lintCodegen(root), [], 'no root exists');
    const real = join(root, 'real-src');
    mkdirSync(real);
    writeFileSync(join(real, 'sort.ts'), "export const s = (a: string, b: string) => a.localeCompare(b);\n");
    mkdirSync(join(root, 'packages/schema'), { recursive: true });
    // A linked root is not followed.
    symlinkSync(real, join(root, 'packages/schema/src'));
    assert.deepEqual(lintCodegen(root), []);
    rmSync(join(root, 'packages/schema/src'));
    mkdirSync(join(root, 'packages/schema/src'));
    writeFileSync(join(root, 'packages/schema/src/sort.ts'), "export const s = (a: string, b: string) => a.localeCompare(b);\n");
    // Linked and dangling entries in the walk are skipped; the real file is scanned.
    symlinkSync(join(real, 'sort.ts'), join(root, 'packages/schema/src/linked.ts'));
    symlinkSync(join(real, 'gone.ts'), join(root, 'packages/schema/src/dangling.ts'));
    symlinkSync(real, join(root, 'packages/schema/src/linked-dir'));
    const found = lintCodegen(root);
    assert.deepEqual(found.map((f) => f.file), ['packages/schema/src/sort.ts'], JSON.stringify(found));
    assert.equal(found[0]!.kind, 'locale');
    mkdirSync(join(root, 'packages/deluge/scripts/scrape-builtin-docs.mjs'), { recursive: true });
    assert.throws(() => lintCodegen(root), { code: 'EISDIR' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--sites resolves a symlink chain to its final target and refuses one that ends in the repo', () => {
  const dir = scratch();
  const stderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    symlinkSync(join(ROOT, 'docs', 'never-written.json'), join(dir, 'hop2'));
    symlinkSync(join(dir, 'hop2'), join(dir, 'hop1'));
    assert.equal(statusMain(['--dir', join(dir, 'missing'), '--out', join(dir, 'out.md'), '--sites', join(dir, 'hop1')]), 2);
  } finally {
    process.stderr.write = stderr;
    rmSync(dir, { recursive: true, force: true });
  }
});
