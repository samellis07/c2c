/**
 * The scorer reads inside the bundle only: a symlinked directory, an
 * absolute, encoded or backslash path, or a dot-dot import never reaches a
 * file outside the bundle's real root.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bundleFromDir } from '../src/score.js';

const page = (links: string[], script = 'index.js') =>
  `<!doctype html><html><head>${links.map((h) => `<link rel="stylesheet" href="${h}">`).join('')}</head><body><script type="module" src="${script}"></script></body></html>`;

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'c2c-realpath-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle');
  mkdirSync(join(bundle, 'slate'), { recursive: true });
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'x.css'), '.outside-marker{color:red}');
  writeFileSync(join(root, 'outside.css'), '.outside-marker{color:red}');
  writeFileSync(join(root, 'outside.js'), 'export const leaked = 1;');
  writeFileSync(join(bundle, 'slate', 'in.css'), '.inside-marker{color:blue}');
  return { root, bundle, slate: join(bundle, 'slate') };
}

test('a stylesheet through a symlinked directory that points outside is not read', (t) => {
  const { root, bundle, slate } = fixture(t);
  symlinkSync(join(root, 'outside'), join(slate, 'linked'), 'dir');
  writeFileSync(join(slate, 'index.html'), page(['in.css', 'linked/x.css', '/linked/x.css']));
  writeFileSync(join(slate, 'index.js'), 'export function boot() {}');
  const result = bundleFromDir(bundle);
  assert.ok(result.css.includes('inside-marker'));
  assert.ok(!result.css.includes('outside-marker'));
});

test('a stylesheet through a symlinked directory that stays inside the bundle is read', (t) => {
  const { bundle, slate } = fixture(t);
  mkdirSync(join(slate, 'real'));
  writeFileSync(join(slate, 'real', 'y.css'), '.alias-marker{color:green}');
  symlinkSync(join(slate, 'real'), join(slate, 'alias'), 'dir');
  writeFileSync(join(slate, 'index.html'), page(['alias/y.css']));
  writeFileSync(join(slate, 'index.js'), 'export function boot() {}');
  assert.ok(bundleFromDir(bundle).css.includes('alias-marker'));
});

test('absolute, encoded and backslash stylesheet hrefs outside the bundle are not read', (t) => {
  const { root, bundle, slate } = fixture(t);
  const dots = '%2e%2e';
  const bs = String.fromCharCode(92);
  const hrefs = [
    join(root, 'outside.css'),
    `${dots}/outside.css`,
    `./${dots}/${dots}/outside.css`,
    `${dots}${bs}outside.css`,
    `..${bs}outside.css`,
    `./x/..${bs}..${bs}outside.css`,
    `/${dots}/outside.css`,
  ];
  writeFileSync(join(slate, 'index.html'), page(['in.css', ...hrefs]));
  writeFileSync(join(slate, 'index.js'), 'export function boot() {}');
  const result = bundleFromDir(bundle);
  assert.ok(result.css.includes('inside-marker'));
  assert.ok(!result.css.includes('outside-marker'));
});

test('an entry script that leaves the bundle through a dot-dot path or a symlinked directory is refused', (t) => {
  const { root, bundle, slate } = fixture(t);
  mkdirSync(join(slate, 'm'));
  symlinkSync(join(root, 'outside'), join(slate, 'linked'), 'dir');
  writeFileSync(join(root, 'outside', 'index.js'), 'export function boot() {} export const leaked = 1;');
  for (const src of ['./m/../../outside.js', 'linked/index.js', `..${String.fromCharCode(92)}outside.js`]) {
    writeFileSync(join(slate, 'index.html'), page(['in.css'], src));
    const result = bundleFromDir(bundle);
    assert.ok(!Object.values(result.modules).some((m) => m.includes('leaked')), `${src}: no outside module loaded`);
    assert.equal(result.runtime, '', `${src}: entry not read`);
  }
});

test('a model import that climbs out of the bundle through the entry path is refused with a clear error', (t) => {
  const { root, bundle, slate } = fixture(t);
  symlinkSync(join(root, 'outside'), join(slate, 'linked'), 'dir');
  writeFileSync(join(root, 'outside', 'index.js'), 'import m from "./model.abc.js"; export function boot() {}');
  writeFileSync(join(root, 'outside', 'model.abc.js'), 'export default "leaked-model";');
  writeFileSync(join(slate, 'index.html'), page(['in.css'], 'linked/index.js'));
  let result;
  try {
    result = bundleFromDir(bundle);
  } catch (e) {
    assert.match(String(e), /outside the bundle/);
    return;
  }
  assert.ok(!result.model.includes('leaked-model'));
});
