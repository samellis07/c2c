import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { sanitizeSnippet as buildSanitize } from '../../ui/src/pages.js';
import { sanitizeSnippet as templateSanitize } from '../template/lib/c2c-ui/pages/sanitize.js';

// The R5b hostile corpus (representations the three sanitizer copies once disagreed on): every copy must give the same output.
const corpus = JSON.parse(readFileSync(join(process.cwd(), 'packages/ui/test/fixtures/sanitizer-hostile-corpus.json'), 'utf8')) as string[];

test('build, browser runtime and React template sanitizers agree on every hostile representation', async () => {
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as { sanitizeSnippet(raw: string, doc: unknown): string };
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  assert.ok(corpus.length >= 100, 'corpus is the full R5b set');
  const differ: string[] = [];
  for (const input of corpus) {
    const build = buildSanitize(input);
    const browser = runtime.sanitizeSnippet(input, doc);
    const template = templateSanitize(input, doc as unknown as Document);
    if (build !== browser || build !== template) differ.push(`${JSON.stringify(input)} build=${JSON.stringify(build)} runtime=${JSON.stringify(browser)} template=${JSON.stringify(template)}`);
  }
  assert.deepEqual(differ, []);
});

test('no copy keeps an executable element, handler or hostile URL from any hostile representation', () => {
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document as unknown as Document;
  for (const input of corpus) {
    const host = doc.createElement('div');
    host.innerHTML = templateSanitize(input, doc);
    for (const el of Array.from(host.querySelectorAll('*'))) {
      const tag = el.tagName.toLowerCase();
      assert.ok(!['script', 'style', 'object', 'embed', 'svg', 'math', 'link', 'meta', 'base', 'form', 'textarea', 'select', 'template'].includes(tag), `${tag} from ${input}`);
      for (const attr of Array.from(el.attributes)) {
        assert.ok(!/^on|^srcdoc$/i.test(attr.name), `${attr.name} from ${input}`);
        if (attr.name === 'href' || attr.name === 'src') {
          const flat = attr.value.replace(/[\u0000-\u0020]/g, '').toLowerCase();
          const rasterImage = tag === 'img' && /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(attr.value);
          assert.ok(rasterImage || !/^(?:javascript|vbscript|data|file|ftp|blob|about|view-source):|^\/\//.test(flat), `${attr.name}=${attr.value} from ${input}`);
        }
      }
    }
  }
});
