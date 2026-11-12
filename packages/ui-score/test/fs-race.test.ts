import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, lstatSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildUi } from '../../ui/src/index.js';
import { deriveIr, parse } from '../../core/src/index.js';
import { galleryTargets } from '../src/gallery.js';
import { bundleFromDir, bundleFromFiles } from '../src/score.js';

/** galleryTargets as it was, by lstat: a symlinked entry is skipped, never followed. */
function statGalleryTargets(dir: string): string[] {
  // fs-race-allow: test oracle over a private scratch tree; nothing else writes it between the lstat and the read.
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return [];
  if (st.isFile() && dir.toLowerCase().endsWith('.ds')) return [dir];
  if (st.isDirectory() && readdirSync(dir).some((child) => child.toLowerCase().endsWith('.ds'))) {
    const entries = readdirSync(dir).filter((name) => !name.startsWith('.'));
    const subApp = entries.some((child) => {
      const p = join(dir, child);
      // fs-race-allow: test oracle over a private scratch tree; nothing else writes it between the lstat and the read.
      return lstatSync(p, { throwIfNoEntry: false })?.isDirectory() && readdirSync(p).some((c) => c.toLowerCase().endsWith('.ds'));
    });
    if (!subApp) return [dir];
  }
  const names = readdirSync(dir).filter((name) => !name.startsWith('.')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    // fs-race-allow: test oracle over a private scratch tree; nothing else writes it between the lstat and the read.
    const s = lstatSync(path, { throwIfNoEntry: false });
    if (s?.isDirectory() && readdirSync(path).some((child) => child.toLowerCase().endsWith('.ds'))) out.push(path);
    else if (s?.isFile() && name.toLowerCase().endsWith('.ds')) out.push(path);
  }
  return out;
}

function same(path: string): void {
  let expected: unknown;
  try {
    expected = statGalleryTargets(path);
  } catch (err) {
    assert.throws(() => galleryTargets(path), { code: (err as { code?: string }).code }, path);
    return;
  }
  assert.deepEqual(galleryTargets(path), expected, path);
}

test('galleryTargets matches the lstat classification for absent, file, FIFO, folder and linked targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-ui-fs-'));
  try {
    const gallery = join(dir, 'gallery');
    mkdirSync(join(gallery, 'a-app'), { recursive: true });
    writeFileSync(join(gallery, 'a-app', 'A.ds'), 'x');
    mkdirSync(join(gallery, 'empty'));
    writeFileSync(join(gallery, 'c.ds'), 'x');
    writeFileSync(join(gallery, 'notes.txt'), 'x');
    execFileSync('mkfifo', [join(gallery, 'pipe.ds')]);
    symlinkSync(join(gallery, 'a-app'), join(gallery, 'linked-app'));
    symlinkSync(join(gallery, 'c.ds'), join(gallery, 'linked.ds'));
    symlinkSync(join(gallery, 'gone'), join(gallery, 'dangling.ds'));
    // One app folder whose only sub-folder holds no .ds: the folder is the app.
    mkdirSync(join(dir, 'single', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'single', 'S.ds'), 'x');
    symlinkSync(join(dir, 'single', 'assets'), join(dir, 'single', 'assets-link'));
    // A loose .ds beside a linked sub-app: the link is not followed, so the folder is the app.
    mkdirSync(join(dir, 'mixed'));
    writeFileSync(join(dir, 'mixed', 'M.ds'), 'x');
    symlinkSync(join(gallery, 'a-app'), join(dir, 'mixed', 'sub'));
    assert.deepEqual(
      galleryTargets(gallery).map((p) => p.slice(gallery.length + 1)),
      ['a-app', 'c.ds'],
    );
    assert.deepEqual(galleryTargets(join(dir, 'single')), [join(dir, 'single')]);
    assert.deepEqual(galleryTargets(join(dir, 'mixed')), [join(dir, 'mixed')]);
    // A linked gallery folder named on the command line is still read; a linked .ds is not a file target.
    assert.deepEqual(galleryTargets(join(gallery, 'linked-app')), [join(gallery, 'linked-app')]);
    assert.throws(() => galleryTargets(join(gallery, 'linked.ds')), { code: 'ENOTDIR' });
    assert.deepEqual(galleryTargets(join(dir, 'missing')), []);
    assert.deepEqual(galleryTargets(join(gallery, 'c.ds')), [join(gallery, 'c.ds')]);
    assert.throws(() => galleryTargets(join(gallery, 'notes.txt')), { code: 'ENOTDIR' });
    assert.throws(() => galleryTargets(join(gallery, 'pipe.ds')), { code: 'ENOTDIR' });
    for (const p of [gallery, join(dir, 'single'), join(dir, 'mixed'), join(dir, 'missing'), join(gallery, 'c.ds'), join(gallery, 'dangling.ds'), join(gallery, 'notes.txt'), join(gallery, 'pipe.ds'), join(gallery, 'empty')]) same(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SOURCE = 'application "Desk"\n{\n\tsection Main\n\t{\n\t\tform Task\n\t\t{\n\t\t\tdisplayname = "Task"\n\t\t\tTitle\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t}\n\t}\n}\n';

test('bundleFromDir treats a directory or FIFO index.html as missing without blocking, and skips non-file assets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-ui-bundle-'));
  try {
    const files = buildUi(deriveIr(parse(SOURCE))).files;
    for (const f of files) {
      if (!f.path.startsWith('slate/')) continue;
      const dest = join(dir, 'ok', f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.data);
    }
    assert.deepEqual(bundleFromDir(join(dir, 'ok')), bundleFromFiles(files));
    mkdirSync(join(dir, 'as-dir', 'slate', 'index.html'), { recursive: true });
    assert.throws(() => bundleFromDir(join(dir, 'as-dir')), /index\.html not found/);
    mkdirSync(join(dir, 'as-fifo', 'slate'), { recursive: true });
    execFileSync('mkfifo', [join(dir, 'as-fifo', 'slate', 'index.html')]);
    assert.throws(() => bundleFromDir(join(dir, 'as-fifo')), /index\.html not found/);
    // The slate check only asks whether the entry exists: a dangling link does not.
    mkdirSync(join(dir, 'dangling', 'slate'), { recursive: true });
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling', 'slate', 'index.html'));
    assert.throws(() => bundleFromDir(join(dir, 'dangling')), /index\.html not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
