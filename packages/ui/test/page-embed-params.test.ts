/**
 * Parameters passed to an embedded page (`page-embed` / `view-embed` iframe
 * query). Only names the target page declares, bounded literal values and
 * forwarded `<%=input.p%>` parameters of the embedding page are carried; the
 * included page's snippets receive them as page input and their server routes
 * re-check the caller. Every other shape stays the counted snippet.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';
import { compileHtmlpage } from '../src/htmlpage.js';

interface Runtime {
  renderPage(page: unknown, doc: unknown, appModel?: unknown): string;
  hydratePageIncludes(root: unknown, appModel: unknown, viewRef?: unknown): void;
  hydrateSnippets(root: unknown, appModel: unknown, viewRef?: unknown): void;
  parseIncludeSpec(spec: string): { name: string; params: unknown[] } | null;
}

async function loadRuntime(): Promise<Runtime> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as Runtime;
}

interface Win { document: { getElementById(id: string): unknown }; location: unknown }
const win = (dom: JSDOM) => dom.window as unknown as Win;
const literal = (zml: string) => JSON.stringify(zml);
function snippetPage(head: string, snippet: string): string {
  const zml = `<zml><layout><row><column width='100%'><dsp id='x1'><![CDATA[${snippet}]]></dsp></column></row></layout></zml>`;
  return `\t\tpage ${head}\n\t\t{\n\t\t\tContent=${literal(zml)}\n\t\t}`;
}
const appOf = (pages: string[]): App => deriveIr(parse(`application "Demo"\n{\n\tsection Front\n\t{\n${pages.join('\n')}\n\t}\n}\n`));
const inner = (body = '<p>Day <%=input.dayVal%> for <%=input.userMailID%></p>') => snippetPage('Inner(dayVal, userMailID)', `htmlpage Inner1(dayVal, userMailID)\ncontent\n${body}`);
const outerSnippet = (src: string, q = '"') => `htmlpage Outer1(usermailid)\ncontent\n<div><p>Before</p><iframe width=${q}100%${q} src=${q}${src}${q}></iframe></div>`;
const compileOuter = (src: string, q = '"') => compileHtmlpage(appOf([inner()]), 'Outer', 'Outer1', outerSnippet(src, q));

test('declared parameters with literal and forwarded values become an include spec', () => {
  const out = compileOuter('<%=zoho.appuri%>view-embed/Inner?dayVal=2024-01-05&&userMailID=<%=input.usermailid%>&zc_Header=false');
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.deepEqual(out.includes, ['Inner?dayVal=2024-01-05,userMailID=@usermailid']);
  assert.match(out.html ?? out.file?.source ?? '', /data-zml="page-include:Inner\?dayVal=2024-01-05,userMailID=@usermailid"/);
  // Parameter names fold to the declared spelling.
  const folded = compileOuter("<%=zoho.appuri%>page-embed/Inner?DAYVAL=x", "'");
  assert.deepEqual(folded.includes, ['Inner?dayVal=x']);
});

test('attack: parameter injection stays counted', () => {
  const refused = [
    // A name the target page does not declare (could steer a filter it never exposed).
    '<%=zoho.appuri%>view-embed/Inner?ownerEmail=a',
    // A repeated name.
    '<%=zoho.appuri%>view-embed/Inner?dayVal=a&dayVal=b',
    // A forwarded parameter the embedding page does not declare.
    '<%=zoho.appuri%>view-embed/Inner?dayVal=<%=input.other%>',
    // Expressions, system variables and statements are not forwarded.
    '<%=zoho.appuri%>view-embed/Inner?dayVal=<%=zoho.loginuser%>',
    '<%=zoho.appuri%>view-embed/Inner?dayVal=<%=input.usermailid + "x"%>',
    '<%=zoho.appuri%>view-embed/Inner?dayVal=<%=Orders[ID != 0].ID%>',
    '<%=zoho.appuri%>view-embed/Inner?dayVal=<%input.usermailid%>',
    // A value glued to an island, or a reserved key.
    '<%=zoho.appuri%>view-embed/Inner?dayVal=a<%=input.usermailid%>',
    '<%=zoho.appuri%>view-embed/Inner?__proto__=a',
    '<%=zoho.appuri%>view-embed/Inner?constructor=a',
    '<%=zoho.appuri%>view-embed/Inner?prototype=a',
    '<%=zoho.appuri%>view-embed/Inner?Constructor=a',
    '<%=zoho.appuri%>view-embed/Inner?=a',
    '<%=zoho.appuri%>view-embed/Inner?dayVal',
  ];
  for (const src of refused) {
    const out = compileOuter(src);
    assert.ok(!out.ok || !(out.includes ?? []).length, `${src} must not become an include`);
  }
});

test('a missing space between two quoted attributes before src still proves the embed', () => {
  // The HTML5 tokenizer starts a new attribute right after a quoted value's
  // closing quote even with no separating whitespace (a parse-error the
  // browser, and Creator's own renderer, still recovers from); the embed
  // must be recognized the same way.
  const glued = `htmlpage Outer1(usermailid)\ncontent\n<div><p>Before</p><iframe style="border:0;"width="100%" src="<%=zoho.appuri%>view-embed/Inner?dayVal=1&&userMailID=<%=input.usermailid%>"></iframe></div>`;
  const out = compileHtmlpage(appOf([inner()]), 'Outer', 'Outer1', glued);
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.deepEqual(out.includes, ['Inner?dayVal=1,userMailID=@usermailid']);
});

test('a missing space between an unquoted attribute value and the next attribute stays refused', () => {
  // Only a closing quote lets the tokenizer start a new attribute with no
  // whitespace; an unquoted value has no such terminator, so the text after
  // it is still part of the value and the embed stays unproven.
  const glued = `htmlpage Outer1(usermailid)\ncontent\n<div><p>Before</p><iframe width=100%src="<%=zoho.appuri%>view-embed/Inner?dayVal=1"></iframe></div>`;
  const out = compileHtmlpage(appOf([inner()]), 'Outer', 'Outer1', glued);
  assert.ok(!out.ok || !(out.includes ?? []).length);
});

test('declared zc parameters are passed, while undeclared display flags are ignored', () => {
  const target = snippetPage('Inner(zc_flag)', 'htmlpage Inner1(zc_flag)\ncontent\n<p>x</p>');
  const out = compileHtmlpage(appOf([target]), 'Outer', 'Outer1', outerSnippet('<%=zoho.appuri%>view-embed/Inner?zc_flag=on&zc_Header=false'));
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.deepEqual(out.includes, ['Inner?zc_flag=on']);
});

test('dynamic undeclared zc parameters keep the embed counted', () => {
  const out = compileHtmlpage(appOf([snippetPage('Inner', 'htmlpage Inner1()\ncontent\n<p>x</p>')]), 'Outer', 'Outer1', outerSnippet('<%=zoho.appuri%>view-embed/Inner?zc_Header=<%=input.usermailid%>'));
  assert.ok(!out.ok || !(out.includes ?? []).length);
});

test('attack: path traversal and cross-app targets stay counted', () => {
  for (const src of [
    '<%=zoho.appuri%>view-embed/../Inner?dayVal=a',
    '<%=zoho.appuri%>view-embed/Inner/../../other?dayVal=a',
    '<%=zoho.appuri%>view-embed/%2e%2e/Inner',
    '<%=zoho.appuri%>view-embed/<%=input.usermailid%>?dayVal=a',
    '<%=zoho.appuri%>view-embed/No_Such_Page?dayVal=a',
    'https://other.example.com<%=zoho.appuri%>view-embed/Inner?dayVal=a',
    '//other.example.com/<%=zoho.appuri%>view-embed/Inner',
    '<%=zoho.appuri%>../otherapp/view-embed/Inner?dayVal=a',
  ]) {
    const out = compileOuter(src);
    assert.ok(!out.ok || !(out.includes ?? []).length, `${src} must not become an include`);
  }
});

test('attack: encoded delimiters, schemes and attribute breakout stay counted', () => {
  for (const src of [
    '<%=zoho.appuri%>view-embed/Inner?dayVal=a%26userMailID%3Dx',
    '<%=zoho.appuri%>view-embed/Inner?dayVal=a&amp;userMailID=x',
    '<%=zoho.appuri%>view-embed/Inner?dayVal=javascript:alert(1)',
    '<%=zoho.appuri%>view-embed/Inner?dayVal=data:text/html,x',
    '<%=zoho.appuri%>view-embed/Inner?dayVal=a/b',
    '<%=zoho.appuri%>view-embed/Inner?dayVal=a#frag',
    `<%=zoho.appuri%>view-embed/Inner?dayVal=${'a'.repeat(65)}`,
  ]) {
    const out = compileOuter(src);
    assert.ok(!out.ok || !(out.includes ?? []).length, `${src} must not become an include`);
  }
  // Breakout through the quote or the tag: the value ends at the quote, so at
  // most the literal before it is carried, and the whole iframe (with any
  // handler written after it) is replaced by the marker.
  for (const [src, q] of [['<%=zoho.appuri%>view-embed/Inner?dayVal=a" onload="x', '"'], ["<%=zoho.appuri%>view-embed/Inner?dayVal=a' onload='x", "'"], ['<%=zoho.appuri%>view-embed/Inner?dayVal=a><script>x</script>', '"']]) {
    const out = compileOuter(src, q);
    for (const spec of out.includes ?? []) assert.equal(spec, 'Inner?dayVal=a', src);
    assert.doesNotMatch(`${out.html ?? ''}${out.file?.source ?? ''}`, /onload|<script/i, src);
  }
});

test('runtime spec grammar refuses anything the compiler would not emit', async () => {
  const runtime = await loadRuntime();
  assert.deepEqual(runtime.parseIncludeSpec('Inner?dayVal=x,userMailID=@usermailid'), {
    name: 'Inner',
    params: [{ key: 'dayVal', value: 'x' }, { key: 'userMailID', from: 'usermailid' }],
  });
  for (const bad of ['Inner?', 'Inner?a=b&c=d', 'Inner?a=b,a=c', 'Inner?__proto__=x', 'Inner?a=@constructor', 'Inner?a=java script', 'Inner?a=%22', '../Inner', 'Inner?a=b;c', 'Inner?a="x"']) {
    assert.equal(runtime.parseIncludeSpec(bad), null, bad);
  }
});

test('the included page snippets receive only the passed parameters as input', async () => {
  const runtime = await loadRuntime();
  const app = appOf([snippetPage('Outer(usermailid)', outerSnippet('<%=zoho.appuri%>view-embed/Inner?dayVal=2024-01-05&userMailID=<%=input.usermailid%>')), inner()]);
  const { model } = buildUi(app);
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', { url: 'http://localhost/?usermailid=me%40example.com&dayVal=evil&extra=1#/page/Outer' });
  const main = win(dom).document.getElementById('main') as unknown as { innerHTML: string; querySelector(s: string): unknown };
  const bodies: Array<{ url: string; input: Record<string, string> }> = [];
  const view = {
    location: win(dom).location,
    fetch: async (url: string, init: { body: string }) => {
      bodies.push({ url: String(url), input: JSON.parse(init.body).input });
      return { status: 404, ok: false };
    },
  };
  const page = model.pages.find((item) => item.name === 'Outer');
  main.innerHTML = runtime.renderPage(page, win(dom).document, model);
  assert.ok(main.querySelector('[data-page-includes="Inner?dayVal=2024-01-05,userMailID=@usermailid"]'), main.innerHTML);
  runtime.hydratePageIncludes(main, model, view);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const innerCall = bodies.find((b) => /inner/i.test(b.url));
  assert.ok(innerCall, JSON.stringify(bodies));
  assert.deepEqual({ ...innerCall.input }, { dayVal: '2024-01-05', userMailID: 'me@example.com' });
});

test('a marker whose parameters differ from the declared spec is never filled', async () => {
  const runtime = await loadRuntime();
  const app = appOf([inner()]);
  const { model } = buildUi(app);
  const dom = new JSDOM('<!doctype html><body><main id="main"><div class="snippet" data-page-includes="Inner?dayVal=x"><div data-zml="page-include:Inner?dayVal=x,userMailID=@admin"></div></div></main></body>');
  const main = win(dom).document.getElementById('main') as unknown as { innerHTML: string };
  runtime.hydratePageIncludes(main, model, {});
  assert.doesNotMatch(main.innerHTML, /page-include"|class="page-include/);
});
