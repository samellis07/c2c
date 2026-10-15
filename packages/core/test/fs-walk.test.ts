import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryKind, isSymlinkRefusedError, isUnopenableError, openKind } from '../src/fs-kind.js';
import { isDirectoryPath, listDsFiles, listWidgetSidecars, parseFileOrProjectWithSidecars } from '../src/parse.js';
import { repoRoot } from '../src/toolchain.js';
import { compareEnUs } from '../src/order.js';
import type { WidgetSidecar } from '../src/ir.js';

// Oracles: the lstat-based walkers (symlinks are not followed), copied
// verbatim. The descriptor and Dirent walks must return exactly what these
// return (or throw where these throw) for absent, directory, FIFO, socket,
// unreadable and symlink entries.
function lstatListDsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(d, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && name.toLowerCase().endsWith('.ds') && !name.toLowerCase().endsWith('.exported.ds')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const WIDGET_JSON_CAP = 1_000_000;

function widgetNamesInJson(text: string): string[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const modules = (parsed as { modules?: unknown }).modules;
  if (!modules || typeof modules !== 'object') return [];
  const widgets = (modules as { widgets?: unknown }).widgets;
  if (!Array.isArray(widgets)) return [];
  const names: string[] = [];
  for (const item of widgets) {
    if (!item || typeof item !== 'object') continue;
    const name = (item as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
  }
  return names;
}

function packageFlags(dir: string): { html: boolean; json: boolean; names: string[] } {
  let html = false;
  let json = false;
  const names: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(d, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!st.isFile()) continue;
      const lower = name.toLowerCase();
      if (lower.endsWith('.html') || lower.endsWith('.htm')) html = true;
      if (!lower.endsWith('.json')) continue;
      json = true;
      if (st.size > WIDGET_JSON_CAP) continue;
      names.push(...widgetNamesInJson(readFileSync(p, 'utf8')));
    }
  };
  walk(dir);
  return { html, json, names };
}

function lstatListWidgetSidecars(dir: string): WidgetSidecar[] {
  const out: WidgetSidecar[] = [];
  const walk = (d: string, rel: string[]) => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    if (rel.length >= 2 && rel[rel.length - 2] === 'sidecars' && rel[rel.length - 1] === 'widgets') {
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const p = join(d, name);
        const st = lstatSync(p, { throwIfNoEntry: false });
        if (!st?.isDirectory()) continue;
        const flags = packageFlags(p);
        const path = [...rel, name].join('/');
        for (const widgetName of [...new Set([name, ...flags.names])].sort(compareEnUs)) {
          out.push({ name: widgetName, path, html: flags.html, json: flags.json });
        }
      }
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
      const p = join(d, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st?.isDirectory()) continue;
      walk(p, [...rel, name]);
    }
  };
  walk(dir, []);
  out.sort((a, b) => compareEnUs(a.path, b.path) || compareEnUs(a.name, b.name));
  return out;
}

function withTree(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fs-walk-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mkfifo = (path: string) => execFileSync('mkfifo', [path]);

/**
 * A Unix socket file at `dir/name`. The child binds a relative name from
 * `dir` (sun_path is limited to about 104 bytes) and exits without closing,
 * so the socket file stays.
 */
const mksock = (dir: string, name: string) =>
  execFileSync(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(name)}, () => process.exit(0))`], { cwd: dir });

// Mode 0000 does not stop root, so the unreadable cases skip there.
const asRoot = process.getuid?.() === 0;

/** Run `fn`, then make every `locked` path readable again so the tree can be removed. */
function withLocked(locked: string[], fn: () => void): void {
  for (const p of locked) chmodSync(p, 0o000);
  try {
    fn();
  } finally {
    for (const p of locked) chmodSync(p, 0o755);
  }
}

test('isDirectoryPath reads the path without following links: only a real directory is true', () => {
  withTree((dir) => {
    const file = join(dir, 'a.ds');
    writeFileSync(file, 'x');
    mkdirSync(join(dir, 'sub'));
    symlinkSync(join(dir, 'sub'), join(dir, 'sub-link'));
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling'));
    const loop = join(dir, 'loop');
    symlinkSync(loop, loop);
    mkfifo(join(dir, 'pipe'));
    assert.equal(isDirectoryPath(dir), true);
    assert.equal(isDirectoryPath(join(dir, 'sub')), true);
    assert.equal(isDirectoryPath(join(dir, 'sub-link')), false);
    assert.equal(isDirectoryPath(join(dir, 'missing')), false);
    assert.equal(isDirectoryPath(file), false);
    assert.equal(isDirectoryPath(join(file, 'under-a-file')), false);
    assert.equal(isDirectoryPath(join(dir, 'dangling')), false);
    assert.equal(isDirectoryPath(loop), false);
    assert.equal(isDirectoryPath(join(dir, 'pipe')), false);
    assert.equal(openKind(join(dir, 'sub-link')), 'other');
    assert.equal(openKind(file), 'file');
  });
});

test('isDirectoryPath throws errors other than ENOENT, ENOTDIR and a refused link', { skip: asRoot }, () => {
  withTree((dir) => {
    mkdirSync(join(dir, 'locked'));
    mkdirSync(join(dir, 'locked', 'sub'));
    withLocked([join(dir, 'locked')], () => {
      assert.throws(() => isDirectoryPath(join(dir, 'locked', 'sub')), { code: 'EACCES' });
    });
  });
});

test('entryKind reads the Dirent only: a link to a directory or a file is other', () => {
  withTree((dir) => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'f.ds'), 'x');
    symlinkSync(join(dir, 'sub'), join(dir, 'sub-link'));
    symlinkSync(join(dir, 'f.ds'), join(dir, 'f-link.ds'));
    mkfifo(join(dir, 'pipe'));
    const kinds = Object.fromEntries(readdirSync(dir, { withFileTypes: true }).map((e) => [e.name, entryKind(e)]));
    assert.deepEqual(kinds, { 'f-link.ds': 'other', 'f.ds': 'file', pipe: 'other', sub: 'directory', 'sub-link': 'other' });
  });
});

test('listDsFiles walks Dirents, matches the lstat walk and follows no symlink', () => {
  withTree((dir) => {
    writeFileSync(join(dir, 'a.ds'), 'x');
    writeFileSync(join(dir, 'b.exported.ds'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'skip.ds'), 'x');
    mkdirSync(join(dir, 'dir.ds'));
    writeFileSync(join(dir, 'dir.ds', 'inner.ds'), 'x');
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'c.ds'), 'x');
    symlinkSync(join(dir, 'real'), join(dir, 'real-link'));
    symlinkSync(join(dir, 'a.ds'), join(dir, 'file-link.ds'));
    symlinkSync(join(dir, 'gone.ds'), join(dir, 'dangling.ds'));
    symlinkSync('.', join(dir, 'loop'));
    mkfifo(join(dir, 'pipe.ds'));
    symlinkSync(join(dir, 'pipe.ds'), join(dir, 'pipe-link.ds'));
    const got = listDsFiles(dir);
    assert.deepEqual(got, lstatListDsFiles(dir));
    assert.deepEqual(
      got.map((p) => p.slice(dir.length + 1)),
      ['a.ds', 'dir.ds/inner.ds', 'real/c.ds'],
    );
  });
});

test('listDsFiles does not read a directory or file outside the tree through a link', () => {
  withTree((root) => {
    const dir = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(dir);
    mkdirSync(outside);
    writeFileSync(join(dir, 'app.ds'), 'x');
    writeFileSync(join(outside, 'secret.ds'), 'x');
    symlinkSync(outside, join(dir, 'ext'));
    symlinkSync(join(outside, 'secret.ds'), join(dir, 'ext.ds'));
    assert.deepEqual(listDsFiles(dir), [join(dir, 'app.ds')]);
  });
});

test('listDsFiles still throws ENOENT for an absent directory and ENOTDIR for a file', () => {
  withTree((dir) => {
    writeFileSync(join(dir, 'a.ds'), 'x');
    assert.throws(() => listDsFiles(join(dir, 'missing')), { code: 'ENOENT' });
    assert.throws(() => listDsFiles(join(dir, 'a.ds')), { code: 'ENOTDIR' });
  });
});

test('listWidgetSidecars matches the lstat walk for linked, absent, file and FIFO package entries', () => {
  withTree((dir) => {
    const widgets = join(dir, 'sidecars', 'widgets');
    mkdirSync(join(widgets, 'full'), { recursive: true });
    writeFileSync(join(widgets, 'full', 'index.html'), '<p>');
    writeFileSync(join(widgets, 'full', 'plugin-manifest.json'), '{"modules":{"widgets":[{"name":"Shown"}]}}');
    // A FIFO named like a manifest must not block or count.
    mkdirSync(join(widgets, 'piped'));
    mkfifo(join(widgets, 'piped', 'plugin-manifest.json'));
    mkfifo(join(widgets, 'piped', 'index.html'));
    // Linked html and json are not followed, so they do not count.
    mkdirSync(join(widgets, 'linked'));
    symlinkSync(join(widgets, 'full', 'index.html'), join(widgets, 'linked', 'page.html'));
    symlinkSync(join(widgets, 'full', 'plugin-manifest.json'), join(widgets, 'linked', 'm.json'));
    symlinkSync(join(widgets, 'none.json'), join(widgets, 'linked', 'gone.json'));
    mkdirSync(join(dir, 'pkg-src', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'pkg-src', 'nested', 'w.json'), '{}');
    symlinkSync(join(dir, 'pkg-src'), join(widgets, 'via-link'));
    symlinkSync(join(dir, 'pkg-src'), join(dir, 'sidecars', 'linked-dir'));
    symlinkSync(join(dir, 'nowhere'), join(widgets, 'dangling'));
    writeFileSync(join(widgets, 'stray.html'), 'x');
    mkfifo(join(widgets, 'fifo-entry'));
    const got = listWidgetSidecars(dir);
    assert.deepEqual(got, lstatListWidgetSidecars(dir));
    assert.deepEqual(
      got.map((w) => `${w.path}:${w.name}:${w.html}:${w.json}`),
      [
        'sidecars/widgets/full:full:true:true',
        'sidecars/widgets/full:Shown:true:true',
        'sidecars/widgets/linked:linked:false:false',
        'sidecars/widgets/piped:piped:false:false',
      ],
    );
  });
});

test('listWidgetSidecars does not follow a sidecars/widgets link or a self-loop', () => {
  withTree((root) => {
    const dir = join(root, 'project');
    const real = join(root, 'real-widgets');
    mkdirSync(join(dir, 'sidecars'), { recursive: true });
    mkdirSync(join(real, 'w'), { recursive: true });
    writeFileSync(join(real, 'w', 'index.html'), '<p>');
    symlinkSync(real, join(dir, 'sidecars', 'widgets'));
    symlinkSync('.', join(dir, 'loop'));
    assert.deepEqual(listWidgetSidecars(dir), []);
    assert.deepEqual(lstatListWidgetSidecars(dir), []);
  });
});

test('listWidgetSidecars of an absent or file directory is empty, as before', () => {
  withTree((dir) => {
    writeFileSync(join(dir, 'a.ds'), 'x');
    assert.deepEqual(listWidgetSidecars(join(dir, 'missing')), []);
    assert.deepEqual(listWidgetSidecars(join(dir, 'a.ds')), []);
  });
});

test('openKind maps a socket to other by errno number, and a link to it to other without opening the socket', () => {
  withTree((dir) => {
    mksock(dir, 's.sock');
    symlinkSync(join(dir, 's.sock'), join(dir, 'sock-link'));
    assert.equal(openKind(join(dir, 's.sock')), 'other');
    assert.equal(openKind(join(dir, 'sock-link')), 'other');
    assert.equal(isDirectoryPath(join(dir, 'sock-link')), false);
    const [ent] = readdirSync(dir, { withFileTypes: true }).filter((e) => e.name === 'sock-link');
    assert.equal(entryKind(ent!), 'other');
  });
  // macOS reports a socket open as errno -102 with no errno name.
  assert.equal(isUnopenableError({ code: 'Unknown system error -102', errno: -osConstants.errno.EOPNOTSUPP }), true);
  assert.equal(isUnopenableError({ code: 'ENXIO', errno: -osConstants.errno.ENXIO }), true);
  assert.equal(isUnopenableError({ errno: -osConstants.errno.ENXIO }), true);
  assert.equal(isUnopenableError({ code: 'EACCES', errno: -osConstants.errno.EACCES }), false);
  assert.equal(isSymlinkRefusedError({ code: 'ELOOP', errno: -osConstants.errno.ELOOP }), true);
  assert.equal(isSymlinkRefusedError({ errno: -osConstants.errno.ELOOP }), true);
  assert.equal(isSymlinkRefusedError({ code: 'EACCES', errno: -osConstants.errno.EACCES }), false);
});

test('listDsFiles matches the lstat walk for links to a socket and to an unreadable file', { skip: asRoot }, () => {
  withTree((dir) => {
    writeFileSync(join(dir, 'a.ds'), 'x');
    mksock(dir, 's.sock');
    symlinkSync(join(dir, 's.sock'), join(dir, 'sock-link.ds'));
    symlinkSync(join(dir, 's.sock'), join(dir, 'sock-link'));
    writeFileSync(join(dir, 'locked.ds'), 'x');
    symlinkSync(join(dir, 'locked.ds'), join(dir, 'locked-link.ds'));
    withLocked([join(dir, 'locked.ds')], () => {
      const got = listDsFiles(dir);
      assert.deepEqual(got, lstatListDsFiles(dir));
      assert.deepEqual(
        got.map((p) => p.slice(dir.length + 1)),
        ['a.ds', 'locked.ds'],
      );
    });
  });
});

test('listDsFiles skips a link to an unreadable directory, and throws, like the lstat walk, on the directory itself', { skip: asRoot }, () => {
  withTree((root) => {
    const dir = join(root, 'project');
    mkdirSync(dir);
    mkdirSync(join(root, 'locked-dir'));
    writeFileSync(join(dir, 'a.ds'), 'x');
    symlinkSync(join(root, 'locked-dir'), join(dir, 'locked-link'));
    withLocked([join(root, 'locked-dir')], () => {
      assert.deepEqual(listDsFiles(dir), lstatListDsFiles(dir));
      assert.deepEqual(listDsFiles(dir), [join(dir, 'a.ds')]);
    });
    mkdirSync(join(dir, 'locked-in'));
    withLocked([join(dir, 'locked-in')], () => {
      assert.throws(() => lstatListDsFiles(dir), { code: 'EACCES' });
      assert.throws(() => listDsFiles(dir), { code: 'EACCES' });
    });
  });
});

test('listWidgetSidecars matches the lstat walk for links to sockets and unreadable directories anywhere in the walk', { skip: asRoot }, () => {
  withTree((dir) => {
    const widgets = join(dir, 'sidecars', 'widgets');
    mkdirSync(join(widgets, 'pkg'), { recursive: true });
    writeFileSync(join(widgets, 'pkg', 'plugin-manifest.json'), '{"modules":{"widgets":[{"name":"Shown"}]}}');
    mksock(dir, 's.sock');
    mkdirSync(join(dir, 'locked-dir'));
    writeFileSync(join(dir, 'locked.html'), 'x');
    // Outside sidecars/widgets: links to an unreadable directory and to a socket.
    symlinkSync(join(dir, 'locked-dir'), join(dir, 'locked-link'));
    symlinkSync(join(dir, 's.sock'), join(dir, 'sock-link'));
    // A package entry that links to an unreadable directory, and one to a socket.
    symlinkSync(join(dir, 'locked-dir'), join(widgets, 'locked-pkg'));
    symlinkSync(join(dir, 's.sock'), join(widgets, 'sock-pkg'));
    // Inside a package: socket manifest and page, unreadable directory, unreadable html.
    symlinkSync(join(dir, 's.sock'), join(widgets, 'pkg', 'm.json'));
    symlinkSync(join(dir, 's.sock'), join(widgets, 'pkg', 'page.html'));
    symlinkSync(join(dir, 'locked-dir'), join(widgets, 'pkg', 'assets'));
    mkdirSync(join(widgets, 'page-only'));
    symlinkSync(join(dir, 'locked.html'), join(widgets, 'page-only', 'index.html'));
    withLocked([join(dir, 'locked-dir'), join(dir, 'locked.html')], () => {
      const got = listWidgetSidecars(dir);
      assert.deepEqual(got, lstatListWidgetSidecars(dir));
      assert.deepEqual(
        got.map((w) => `${w.path}:${w.name}:${w.html}:${w.json}`),
        [
          'sidecars/widgets/page-only:page-only:false:false',
          'sidecars/widgets/pkg:pkg:false:true',
          'sidecars/widgets/pkg:Shown:false:true',
        ],
      );
    });
  });
});

test('a .ds next to links to an unreadable directory and a socket still parses with its sidecars', { skip: asRoot }, () => {
  withTree((dir) => {
    const ds = join(dir, 'app.ds');
    writeFileSync(ds, readFileSync(join(repoRoot(), 'fixtures/dialects/d1-minimal.ds')));
    mkdirSync(join(dir, 'sidecars', 'widgets', 'w'), { recursive: true });
    writeFileSync(join(dir, 'sidecars', 'widgets', 'w', 'index.html'), '<p>');
    mksock(dir, 's.sock');
    mkdirSync(join(dir, 'locked-dir'));
    symlinkSync(join(dir, 'locked-dir'), join(dir, 'locked-link'));
    symlinkSync(join(dir, 's.sock'), join(dir, 'sock-link'));
    withLocked([join(dir, 'locked-dir')], () => {
      const { ir } = parseFileOrProjectWithSidecars(ds);
      assert.deepEqual(ir.widgets, lstatListWidgetSidecars(dir));
      assert.deepEqual(ir.widgets?.map((w) => w.name), ['w']);
    });
  });
});
