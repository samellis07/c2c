import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseFileOrProjectWithSidecars } from '../../core/src/index.js';
import { solidPng } from '../src/build.js';
import { buildModel } from '../src/model.js';
import { buildUi } from '../src/generate.js';
import { generateReactApp } from '../../ui-react/src/index.js';

// A remote CSS background is fetched at migration time into a same-origin file
// recorded in c2c-assets.lock.json; the generator then rewrites a literal url
// to that file offline. Anything not fetched stays a counted TODO.

const HTTPS_URL = 'https://img.example.com/a.png';
const PNG = solidPng(2, [10, 20, 30]);
const SHA = createHash('sha256').update(PNG).digest('hex');

function delugeString(text: string): string {
  return text.replace(/[\\"]/g, (ch) => `\\${ch}`);
}

function ds(zml: string): string {
  return `application "Demo"\n{\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tdisplayname = "Home"\n\t\t\tContent="${delugeString(zml)}"\n\t\t}\n\t}\n}\n`;
}

interface Entry {
  url: string;
  status: 'fetched' | 'refused' | 'failed';
  sha256?: string;
  ext?: string;
  size?: number;
  reason?: string;
}

function project(zml: string, entries: Entry[], cache: Array<[string, Buffer]> = []): { dir: string; load: () => ReturnType<typeof parseFileOrProjectWithSidecars>['ir'] } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-bg-'));
  writeFileSync(join(dir, 'Demo.ds'), ds(zml));
  if (entries.length) writeFileSync(join(dir, 'c2c-assets.lock.json'), JSON.stringify({ version: 1, entries }, null, 2) + '\n');
  if (cache.length) {
    mkdirSync(join(dir, 'c2c-assets'));
    for (const [name, bytes] of cache) writeFileSync(join(dir, 'c2c-assets', name), bytes);
  }
  return { dir, load: () => parseFileOrProjectWithSidecars(join(dir, 'Demo.ds')).ir };
}

const fetched: Entry = { url: HTTPS_URL, status: 'fetched', sha256: SHA, ext: 'png', size: PNG.length };

const STATIC = `<zml><dsp id='h'><![CDATA[<style>.hero { background: url('${HTTPS_URL}') no-repeat; }</style><div class="hero">x</div>]]></dsp></zml>`;
const INLINE = `<zml><dsp id='h'><![CDATA[<div style="background-image:url('${HTTPS_URL}')">x</div>]]></dsp></zml>`;
const ESCAPED = `<zml><dsp id='h'>&lt;div style=&quot;background-image:url(&apos;${HTTPS_URL}&apos;);width:5px&quot;&gt;x&lt;/div&gt;</dsp></zml>`;

function todosOf(ir: ReturnType<ReturnType<typeof project>['load']>) {
  return buildModel(ir).todos.filter((todo) => todo.area === 'zml');
}

test('a fetched https background in a static style rule is rewritten to the same-origin file and counts no TODO', () => {
  const p = project(STATIC, [fetched], [[`${SHA}.png`, PNG]]);
  try {
    const model = buildModel(p.load());
    assert.deepEqual(model.todos.filter((todo) => todo.area === 'zml'), []);
    assert.match(model.pages[0]?.scopedCss ?? '', new RegExp(`url\\(bg/${SHA}\\.png\\)`));
    assert.doesNotMatch(JSON.stringify(model), /img\.example\.com/);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('a fetched background in an inline style, plain or entity-escaped, is carried', () => {
  for (const zml of [INLINE, ESCAPED]) {
    const p = project(zml, [fetched], [[`${SHA}.png`, PNG]]);
    try {
      const model = buildModel(p.load());
      assert.deepEqual(model.todos.filter((todo) => todo.area === 'zml'), [], zml);
      assert.match(JSON.stringify(model), new RegExp(`background-image:\\s*url\\(bg/${SHA}\\.png\\)`));
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  }
});

test('without a lock entry the remote background stays a counted TODO', () => {
  for (const zml of [STATIC, INLINE]) {
    const p = project(zml, []);
    try {
      assert.equal(todosOf(p.load()).length, 1, zml);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  }
});

test('a refused or failed entry stays a counted TODO and its manual step names the reason', () => {
  const p = project(STATIC, [{ url: HTTPS_URL, status: 'refused', reason: 'host resolves to a private address' }]);
  try {
    const todos = todosOf(p.load());
    assert.equal(todos.length, 1);
    assert.match(todos[0]?.manualStep ?? '', /host resolves to a private address/);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('a cached file whose bytes do not match the locked hash is not used', () => {
  const p = project(STATIC, [fetched], [[`${SHA}.png`, solidPng(2, [1, 1, 1])]]);
  try {
    assert.equal(todosOf(p.load()).length, 1);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('a cached file that is not an image of the locked type is not used', () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const sha = createHash('sha256').update(html).digest('hex');
  const p = project(STATIC, [{ url: HTTPS_URL, status: 'fetched', sha256: sha, ext: 'png', size: html.length }], [[`${sha}.png`, html]]);
  try {
    assert.equal(todosOf(p.load()).length, 1);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('a url built from record data is never rewritten, even when a lock entry exists for its literal prefix', () => {
  const zml = `<zml><dsp id='h'><![CDATA[<div style="background-image:url('https://img.example.com/<%=image_new%>')">x</div>]]></dsp></zml>`;
  const p = project(zml, [fetched, { url: 'https://img.example.com/', status: 'fetched', sha256: SHA, ext: 'png', size: PNG.length }], [[`${SHA}.png`, PNG]]);
  try {
    const model = buildModel(p.load());
    assert.doesNotMatch(JSON.stringify(model), /bg\//);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('a lock entry does not widen other properties: a list-style or content url stays remote and dropped', () => {
  const zml = `<zml><dsp id='h'><![CDATA[<ul style="list-style-image:url('${HTTPS_URL}')"><li>x</li></ul>]]></dsp></zml>`;
  const p = project(zml, [fetched], [[`${SHA}.png`, PNG]]);
  try {
    const model = buildModel(p.load());
    assert.doesNotMatch(JSON.stringify(model), /bg\//);
    assert.equal(model.todos.filter((todo) => todo.area === 'zml').length, 1);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('the vanilla and React bundles ship the fetched bytes as a content-named file, deterministically', () => {
  const p = project(STATIC, [fetched], [[`${SHA}.png`, PNG]]);
  try {
    const ir = p.load();
    const vanilla = buildUi(ir).files.find((file) => file.path === `slate/bg/${SHA}.png`);
    assert.ok(vanilla, 'vanilla bundle carries the image');
    assert.ok(Buffer.from(vanilla.data as Buffer).equals(PNG));
    const react = generateReactApp(ir).find((file) => file.path === `public/bg/${SHA}.png`);
    assert.ok(react, 'react bundle carries the image');
    assert.ok(Buffer.from(react.data as Buffer).equals(PNG));
    const again = buildUi(p.load()).files.map((file) => [file.path, createHash('sha256').update(file.data).digest('hex')]);
    const first = buildUi(ir).files.map((file) => [file.path, createHash('sha256').update(file.data).digest('hex')]);
    assert.deepEqual(again, first);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('an unused locked asset is not emitted', () => {
  const p = project('<zml><dsp id=\'h\'><![CDATA[<p>plain</p>]]></dsp></zml>', [fetched], [[`${SHA}.png`, PNG]]);
  try {
    assert.equal(buildUi(p.load()).files.some((file) => file.path.includes('/bg/')), false);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});
