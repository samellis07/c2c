import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { SHELL_OVERLAY_CLASSES as BUILD_OVERLAY_CLASSES, sanitizeSnippet as buildSanitize } from '../../ui/src/pages.js';
import { BASE_CSS } from '../../ui/src/styles.js';
import { SHELL_OVERLAY_CLASSES, dangerousStyle, safeUrl, sanitizeSnippet } from '../template/lib/c2c-ui/pages/sanitize.js';

test('the three sanitizer copies reserve the same shell ids, and every id the runtime looks up is reserved', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
  const copies = ['packages/ui/src/pages.ts', 'packages/ui/src/client-runtime.js', 'packages/ui-react/template/lib/c2c-ui/pages/sanitize.ts'].map((path) => {
    const body = /SHELL_IDS = new Set\(\[([^\]]*)\]\)/.exec(read(path))?.[1] ?? '';
    return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
  });
  assert.ok(copies[0]!.length >= 20);
  assert.deepEqual(copies[1], copies[0]);
  assert.deepEqual(copies[2], copies[0]);
  // The runtime's own lookups: a snippet id that spells one would shadow it.
  const looked = new Set([...read('packages/ui/src/client-runtime.js').matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]!));
  for (const id of looked) assert.ok(copies[0]!.includes(id), `runtime looks up #${id} but it is not a reserved shell id`);
});

test('template sanitizer URL policy keeps navigation URLs and rejects dangerous variants', () => {
  // Non-ASCII hostnames are accepted: browsers normalize them to IDN/punycode,
  // and HTTPS remains an allowed navigation scheme under this policy.
  const kept = ['http://example.test', 'https://example.test/a', 'https://例え.テスト', 'https://ex.com/a%20b', 'mailto:a@example.test', 'mailto:x@y.z?subject=hi%20there', 'https://ex.com/?q=a%26b', '/p%2Fq', '#a%20b', 'tel:+15550123', '#route', '../x', '?q=1', '/path'];
  const rejected = ['file:///tmp/x', 'ftp://example.test', '//host/x', 'javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', 'blob:https://x', 'http:\u0000//x', 'http:\\x', 'java%73cript:alert(1)', '%0ajavascript:alert(1)', 'java%09script:alert(1)', '%2F%2Fhost', '%5C%5Chost', '%00https://host', 'java%2573cript:alert(1)', 'JAVASCRIPT:alert(1)'];
  for (const value of kept) assert.equal(safeUrl(value), true, value);
  for (const value of rejected) assert.equal(safeUrl(value), false, value);
  const dom = new JSDOM('');
  assert.equal(sanitizeSnippet('<a href="&#106;avascript:alert(1)">x</a>', dom.window.document as unknown as Document), '<a>x</a>');
});

test('template sanitizer CSS policy keeps plain properties and rejects executable syntax', () => {
  for (const value of ['color:red', 'margin: 0', 'background-color: white', 'font-size: 1rem']) assert.equal(dangerousStyle(value), false, value);
  for (const value of ['\\75 rl(x)', 'u\\72 l(x)', '\\000075rl(x)', '/*x*/color:red', 'image-set(url(x) 1x)', 'image("x")', 'cross-fade("x", "y", 50%)', '-webkit-cross-fade(red, blue)', '@import url(x)', 'expression(alert(1))', '-moz-binding:url(x)', 'attr(x)']) assert.equal(dangerousStyle(value), true, value);
});

test('template sanitizer keeps an exact inline raster image src on an img and nothing else with a data URL', () => {
  const dom = new JSDOM('');
  const doc = dom.window.document as unknown as Document;
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(sanitizeSnippet(`<img src="${png}">`, doc), `<img src="${png}">`);
  for (const kind of ['jpeg', 'gif', 'webp']) assert.match(sanitizeSnippet(`<img src="data:image/${kind};base64,AAAA">`, doc), /src=/, kind);
  const refused = [
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/png;base64,AAAA" onerror="alert(1)',
    'data:image/png;base64, AAAA',
    'data:image/png;base64,AA\nAA',
    'DATA:image/png;base64,AAAA',
    ' data:image/png;base64,AAAA',
    'data:image/png,AAAA',
    'data:image/png;base64,',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png;base64,AAAA#x<script>',
  ];
  for (const src of refused) assert.equal(sanitizeSnippet(`<img src="${src.replace(/"/g, '&quot;')}">`, doc), '<img>', src);
  assert.equal(sanitizeSnippet(`<a href="${png}">x</a>`, doc), '<a>x</a>');
});

test('snippet sanitizers keep checkbox labels while dropping hostile input attributes', async () => {
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as { sanitizeSnippet(raw: string, doc: unknown): string };
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  const safe = '<input id="checkbox_1" type="checkbox"><label for="checkbox_1">Expand</label>';
  assert.equal(sanitizeSnippet(safe, doc as unknown as Document), safe);
  assert.equal(buildSanitize(safe), safe);
  assert.equal(runtime.sanitizeSnippet(safe, doc), safe);
  const hostile = '<input id="x" type="checkbox" name="secret" value="1" checked onclick="alert(1)"><label for="x" onmouseover="alert(1)">x</label>';
  // `checked` is a boolean the sanitizer keeps with an empty value; every other attribute on the input is dropped.
  const expected = '<input id="x" type="checkbox" checked=""><label for="x">x</label>';
  assert.equal(sanitizeSnippet(hostile, doc as unknown as Document), expected);
  assert.equal(buildSanitize(hostile), expected);
  assert.equal(runtime.sanitizeSnippet(hostile, doc), expected);
  assert.equal(sanitizeSnippet('<input type="text" id="x">', doc as unknown as Document), '');
});

test('template sanitizer keeps a class token by the same rule as the generator and the browser runtime', async () => {
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    SHELL_OVERLAY_CLASSES: Set<string>;
    sanitizeSnippet(raw: string, doc: unknown): string;
  };
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  const htmls = [
    '<div class="card btn-primary active">x</div>',
    '<div class="a modal b">x</div>',
    '<div class="x&quot; onclick=&quot;alert(1)">x</div>',
    '<div class="a<script>">x</div>',
    '<div class="url(//x.test/a) ok caf\u00e9 1abc">x</div>',
    '<div class="   ">x</div>',
    `<div class="${'a'.repeat(65)} ${Array.from({ length: 200 }, (_, n) => `c${n}`).join(' ')}">x</div>`,
  ];
  for (const html of htmls) {
    const fromTemplate = sanitizeSnippet(html, doc as unknown as Document);
    assert.equal(fromTemplate, buildSanitize(html), html);
    assert.equal(fromTemplate, runtime.sanitizeSnippet(html, doc), html);
  }
  assert.equal(sanitizeSnippet('<div class="a modal skip-link b">x</div>', doc as unknown as Document), '<div class="a b">x</div>');
  assert.equal(sanitizeSnippet('<div class="a _overlay_abc123 b">x</div>', doc as unknown as Document), '<div class="a b">x</div>');
  // One list in three places, and it names every class either shell stylesheet lifts out of flow.
  assert.deepEqual([...SHELL_OVERLAY_CLASSES].sort(), [...BUILD_OVERLAY_CLASSES].sort());
  assert.deepEqual([...SHELL_OVERLAY_CLASSES].sort(), [...runtime.SHELL_OVERLAY_CLASSES].sort());
  const shellCss = readFileSync(join(process.cwd(), 'packages/ui-react/template/lib/c2c-ui/styles/shell.css'), 'utf8');
  const lifted = new Set<string>();
  for (const css of [BASE_CSS, shellCss]) {
    for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/position\s*:\s*(?:fixed|absolute|sticky)|z-index/i.test(rule[2]!)) continue;
      for (const cls of rule[1]!.matchAll(/\.([A-Za-z_][\w-]*)/g)) lifted.add(cls[1]!);
    }
  }
  assert.ok(lifted.size > 0);
  for (const cls of lifted) assert.ok(SHELL_OVERLAY_CLASSES.has(cls) || /^_overlay_[A-Za-z0-9_-]+$/i.test(cls), `${cls} is lifted out of flow by a shell stylesheet but not reserved`);
});
