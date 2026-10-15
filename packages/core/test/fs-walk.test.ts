import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDirectoryPath, listDsFiles, listWidgetSidecars } from '../src/parse.js';
import { compareEnUs } from '../src/order.js';
import type { WidgetSidecar } from '../src/ir.js';

// Stat-based walkers kept as oracles: the descriptor and Dirent walks must
// return exactly what these return for absent, directory, FIFO and symlink
// entries.
function statListDsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(d, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && name.toLowerCase().endsWith('.ds') && !name.toLowerCase().endsWith('.exported.ds')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function statPackageFlags(dir: string): { html: boolean; json: boolean; names: string[] } {
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
      const st = statSync(p, { throwIfNoEntry: false });
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
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { modules?: { widgets?: { name?: string }[] } };
      for (const item of parsed.modules?.widgets ?? []) if (item.name) names.push(item.name);
    }
  };
  walk(dir);
  return { html, json, names };
}

function statListWidgetSidecars(dir: string): WidgetSidecar[] {
  const out: WidgetSidecar[] = [];
  const walk = (d: string, rel: string[]) => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    const inWidgets = rel.length >= 2 && rel[rel.length - 2] === 'sidecars' && rel[rel.length - 1] === 'widgets';
    for (const name of names) {
      if (inWidgets ? name.startsWith('.') : name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (!statSync(p, { throwIfNoEntry: false })?.isDirectory()) continue;
      if (!inWidgets) {
        walk(p, [...rel, name]);
        continue;
      }
      const flags = statPackageFlags(p);
      const path = [...rel, name].join('/');
      for (const widgetName of [...new Set([name, ...flags.names])].sort(compareEnUs)) {
        out.push({ name: widgetName, path, html: flags.html, json: flags.json });
      }
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

test('isDirectoryPath reads the path: directory and directory link are true; absent, file, FIFO, dangling are false', () => {
  withTree((dir) => {
    const file = join(dir, 'a.ds');
    writeFileSync(file, 'x');
    mkdirSync(join(dir, 'sub'));
    symlinkSync(join(dir, 'sub'), join(dir, 'sub-link'));
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling'));
    mkfifo(join(dir, 'pipe'));
    assert.equal(isDirectoryPath(dir), true);
    assert.equal(isDirectoryPath(join(dir, 'sub-link')), true);
    assert.equal(isDirectoryPath(join(dir, 'missing')), false);
    assert.equal(isDirectoryPath(file), false);
    assert.equal(isDirectoryPath(join(file, 'under-a-file')), false);
    assert.equal(isDirectoryPath(join(dir, 'dangling')), false);
    assert.equal(isDirectoryPath(join(dir, 'pipe')), false);
  });
});

test('isDirectoryPath throws errors other than ENOENT and ENOTDIR', () => {
  withTree((dir) => {
    const link = join(dir, 'loop');
    symlinkSync(link, link);
    assert.throws(() => isDirectoryPath(link), { code: 'ELOOP' });
  });
});

test('listDsFiles walks Dirents and matches the stat walk for absent, directory, FIFO and symlink entries', () => {
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
    mkfifo(join(dir, 'pipe.ds'));
    symlinkSync(join(dir, 'pipe.ds'), join(dir, 'pipe-link.ds'));
    const got = listDsFiles(dir);
    assert.deepEqual(got, statListDsFiles(dir));
    assert.deepEqual(
      got.map((p) => p.slice(dir.length + 1)),
      ['a.ds', 'dir.ds/inner.ds', 'file-link.ds', 'real/c.ds', 'real-link/c.ds'],
    );
  });
});

test('listDsFiles still throws ENOENT for an absent directory and ENOTDIR for a file', () => {
  withTree((dir) => {
    writeFileSync(join(dir, 'a.ds'), 'x');
    assert.throws(() => listDsFiles(join(dir, 'missing')), { code: 'ENOENT' });
    assert.throws(() => listDsFiles(join(dir, 'a.ds')), { code: 'ENOTDIR' });
  });
});

test('listWidgetSidecars matches the stat walk for linked, absent, file and FIFO package entries', () => {
  withTree((dir) => {
    const widgets = join(dir, 'sidecars', 'widgets');
    mkdirSync(join(widgets, 'full'), { recursive: true });
    writeFileSync(join(widgets, 'full', 'index.html'), '<p>');
    writeFileSync(join(widgets, 'full', 'plugin-manifest.json'), '{"modules":{"widgets":[{"name":"Shown"}]}}');
    // A FIFO named like a manifest must not block or count.
    mkdirSync(join(widgets, 'piped'));
    mkfifo(join(widgets, 'piped', 'plugin-manifest.json'));
    mkfifo(join(widgets, 'piped', 'index.html'));
    // Linked html and json count; a dangling json link does not.
    mkdirSync(join(widgets, 'linked'));
    symlinkSync(join(widgets, 'full', 'index.html'), join(widgets, 'linked', 'page.html'));
    symlinkSync(join(widgets, 'full', 'plugin-manifest.json'), join(widgets, 'linked', 'm.json'));
    symlinkSync(join(widgets, 'none.json'), join(widgets, 'linked', 'gone.json'));
    mkdirSync(join(dir, 'pkg-src', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'pkg-src', 'nested', 'w.json'), '{}');
    symlinkSync(join(dir, 'pkg-src'), join(widgets, 'via-link'));
    symlinkSync(join(dir, 'nowhere'), join(widgets, 'dangling'));
    writeFileSync(join(widgets, 'stray.html'), 'x');
    mkfifo(join(widgets, 'fifo-entry'));
    const got = listWidgetSidecars(dir);
    assert.deepEqual(got, statListWidgetSidecars(dir));
    assert.deepEqual(
      got.map((w) => `${w.path}:${w.name}:${w.html}:${w.json}`),
      [
        'sidecars/widgets/full:full:true:true',
        'sidecars/widgets/full:Shown:true:true',
        'sidecars/widgets/linked:linked:true:true',
        'sidecars/widgets/linked:Shown:true:true',
        'sidecars/widgets/piped:piped:false:false',
        'sidecars/widgets/via-link:via-link:false:true',
      ],
    );
  });
});

test('listWidgetSidecars of an absent or file directory is empty, as before', () => {
  withTree((dir) => {
    writeFileSync(join(dir, 'a.ds'), 'x');
    assert.deepEqual(listWidgetSidecars(join(dir, 'missing')), []);
    assert.deepEqual(listWidgetSidecars(join(dir, 'a.ds')), []);
  });
});
