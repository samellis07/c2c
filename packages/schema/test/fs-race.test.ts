import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, lstatSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { listDsFiles, parseFile, parseProject } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { loadCorpusApps } from '../src/corpus.js';
import { loadSyntheticApps } from '../src/measure.js';

const FIXTURE_DS = join(repoRoot(), 'fixtures/redistributable/library-application-system/library_application.ds');

/** Entries every walk below must classify as lstat does: links, a dangling link, a FIFO, noise. */
function tree(dir: string): void {
  mkdirSync(join(dir, 'app'));
  copyFileSync(FIXTURE_DS, join(dir, 'app', 'library_application.ds'));
  mkdirSync(join(dir, 'empty'));
  copyFileSync(FIXTURE_DS, join(dir, 'loose.ds'));
  writeFileSync(join(dir, 'notes.txt'), 'x');
  execFileSync('mkfifo', [join(dir, 'pipe.ds')]);
  symlinkSync(join(dir, 'app'), join(dir, 'linked-app'));
  symlinkSync(join(dir, 'loose.ds'), join(dir, 'linked.ds'));
  symlinkSync(join(dir, 'gone'), join(dir, 'dangling.ds'));
  symlinkSync(join(dir, 'gone'), join(dir, 'dangling-dir'));
}

/** loadCorpusApps as it was, by lstat: a symlink is skipped, never followed. */
function statCorpus(dir: string): { link: string; tables: number }[] {
  const apps: { link: string; tables: number }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!listDsFiles(path).length) continue;
      apps.push({ link: name, tables: parseProject(path).ir.forms.length });
    } else if (st.isFile() && name.toLowerCase().endsWith('.ds')) {
      apps.push({ link: basename(name, '.ds'), tables: parseFile(path).ir.forms.length });
    }
  }
  return apps;
}

test('loadCorpusApps keeps folder and file apps, and skips FIFOs and every link as lstat does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-schema-corpus-'));
  try {
    tree(dir);
    const expected = statCorpus(dir);
    assert.deepEqual(expected.map((a) => a.link), ['app', 'loose']);
    assert.deepEqual(loadCorpusApps(dir).map((a) => ({ link: a.link, tables: a.ir.forms.length })), expected);
    assert.throws(() => loadCorpusApps(join(dir, 'missing')), { code: 'ENOENT' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSyntheticApps skips linked folders, linked files and dangling links; a FIFO .ds is still handed to the parser', () => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-schema-synth-'));
  try {
    const dir = join(root, 'synthetic');
    mkdirSync(dir);
    tree(dir);
    mkdirSync(join(dir, 'sidecars'));
    copyFileSync(FIXTURE_DS, join(dir, 'sidecars', 'skip.ds'));
    copyFileSync(FIXTURE_DS, join(dir, 'app', 'app.exported.ds'));
    // A FIFO named .ds is a target, as with stat: the parser refuses it.
    assert.throws(() => loadSyntheticApps(root), { name: 'NotFileError' });
    rmSync(join(dir, 'pipe.ds'));
    const links = loadSyntheticApps(root).map((a) => a.link);
    assert.deepEqual(links, ['app/library_application.ds', 'loose.ds']);
    assert.ok(links.every((link) => relative(dir, join(dir, link)) === link));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
