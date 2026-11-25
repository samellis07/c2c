/**
 * A literal `href="<%=zoho.appuri%>#Page:<Page>?param=..."` link to another
 * page of the same app — written by hand, not through a `page-embed` iframe
 * — becomes a generated `#/page/<Page>?param=...` link. A value is a bounded
 * literal or a forwarded `<%=input.p%>` naming a parameter the embedding
 * page (or its own `htmlpage` function) already declares; a forwarded value
 * is percent-encoded (`encodeUrl`) so it can never widen the query past the
 * one key it is bound to. Page parameters have no declared type in Creator —
 * `input.<name>` is always the raw decoded query string — so there is
 * nothing to type-check: int-looking, text and date-looking values all take
 * the same path. Anything the compiler cannot prove safe (an unknown page,
 * an undeclared or repeated parameter, any other expression, the page
 * linking to itself) must never fall through to a working-but-unvalidated
 * link: the whole snippet stays the counted TODO.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { compileHtmlpage } from '../src/htmlpage.js';

const ADMIN = { name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } };

function appOf(pages: string): App {
  const app = deriveIr(parse(`application "Demo"\n{\n\tpages\n\t{\n${pages}\n\t}\n}\n`));
  app.profiles.push(ADMIN);
  return app;
}

const page = (head: string) => `\t\tpage ${head}\n\t\t{\n\t\t\tContent="<zml></zml>"\n\t\t}`;

/** `Outer` links to `Inner(date)`; `Inner` is the only declared target page. */
const APP = appOf(`${page('Inner(date)')}\n${page('Outer(date)')}`);

function linkSnippet(href: string): string {
  return `htmlpage Outer1()\ncontent\n<%{\n%>\n<a href="${href}">go</a>\n<%\n}%>`;
}

function compile(href: string) {
  return compileHtmlpage(APP, 'Outer', 'Outer1', linkSnippet(href));
}

test('a forwarded page parameter becomes a generated link with an encodeUrl island', () => {
  const out = compile('<%=zoho.appuri%>#Page:Inner?date=<%=input.date%>');
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.match(out.file?.source ?? '', /shim\.string\.encodeUrl\(shim\.input\.get\(ctx, "date"\)\)/);
  assert.match(out.file?.source ?? '', /"#\/page\/Inner\?date="/);
});

test('a literal page parameter becomes a fully static generated link', () => {
  const out = compile('<%=zoho.appuri%>#Page:Inner?date=2024-01-05');
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.match(out.html ?? '', /href="#\/page\/Inner\?date=2024-01-05"/);
  assert.doesNotMatch(out.file?.source ?? '', /shim\.string\.encodeUrl/);
});

test('an int-looking, a text-looking and a date-looking literal value all take the same path', () => {
  for (const value of ['42', 'Ann-Doe_1', '2024-01-05']) {
    const out = compile(`<%=zoho.appuri%>#Page:Inner?date=${value}`);
    assert.equal(out.ok, true, `${value}: ${out.reason ?? ''}`);
    assert.match(out.html ?? '', new RegExp(`href="#/page/Inner\\?date=${value}"`));
  }
});

test('a missing page parameter in the query stays a plain page link with no query', () => {
  const out = compile('<%=zoho.appuri%>#Page:Inner');
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.match(out.html ?? '', /href="#\/page\/Inner"/);
});

test('attack: a hostile forwarded value is percent-encoded, never concatenated raw into the query', () => {
  // The forward grammar only ever carries the *name* `date` into the
  // generated link, never a caller-supplied value — the hostile content
  // would have to come through `input.date` itself at request time, and the
  // generated call wraps it in `encodeUrl` before it ever reaches the href.
  const out = compile('<%=zoho.appuri%>#Page:Inner?date=<%=input.date%>');
  assert.equal(out.ok, true);
  assert.match(out.file?.source ?? '', /shim\.string\.encodeUrl/);
});

test('attack: an undeclared or repeated query parameter keeps the whole snippet counted, never a silent drop', () => {
  for (const href of [
    '<%=zoho.appuri%>#Page:Inner?date=1&passdate=false',
    '<%=zoho.appuri%>#Page:Inner?date=1&date=2',
    '<%=zoho.appuri%>#Page:Inner?__proto__=1',
  ]) {
    const out = compile(href);
    assert.equal(out.ok, false, href);
    assert.doesNotMatch(out.html ?? '', /#Page:/, href);
  }
});

test('attack: an unknown page, an expression other than a bare forward, and path traversal all stay refused', () => {
  for (const href of [
    '<%=zoho.appuri%>#Page:No_Such_Page?date=1',
    '<%=zoho.appuri%>#Page:Inner?date=<%=input.date+"x"%>',
    '<%=zoho.appuri%>#Page:Inner?date=<%=zoho.loginuser%>',
    '<%=zoho.appuri%>#Page:../Inner?date=1',
    '<%=zoho.appuri%>#Page:Inner?date=%22',
  ]) {
    const out = compile(href);
    assert.equal(out.ok, false, href);
  }
});

test('a hardcoded host written ahead of the appuri island never survives into the generated link', () => {
  // Authors sometimes hardcode a host (matching Creator's own platform
  // domain) in front of `<%=zoho.appuri%>` as a defensive habit. Whatever
  // that literal text says, the rewrite only ever recognizes the `#Page:`
  // marker after the island and emits a fresh same-app fragment from
  // scratch — the written host text is discarded, never carried through.
  const out = compile('https://other.example.com<%=zoho.appuri%>#Page:Inner?date=1');
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.match(out.html ?? '', /href="#\/page\/Inner\?date=1"/);
  assert.equal((out.html ?? '').split('other.example.com').length, 1, 'the written host text is never carried');
});

test('a page linking to itself with a different parameter value is a generated link too', () => {
  // A tabbed or filtered detail page commonly re-links to its own route with
  // a different query value (e.g. switching which tab renders); this is not
  // a reload loop, just ordinary same-page navigation, and is just as safe
  // as linking to any other declared page.
  const snippet = linkSnippet('<%=zoho.appuri%>#Page:Inner?date=<%=input.date%>').replace('Outer1', 'Inner1');
  const out = compileHtmlpage(APP, 'Inner', 'Inner1', snippet);
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.match(out.file?.source ?? '', /"#\/page\/Inner\?date="/);
});

test('a page-embed iframe to the same target is unaffected: both shapes carry parameters independently', () => {
  const out = compileHtmlpage(
    APP,
    'Outer',
    'Outer1',
    `htmlpage Outer1()\ncontent\n<%{\n%>\n<a href="<%=zoho.appuri%>#Page:Inner?date=<%=input.date%>">link</a>\n<iframe src="<%=zoho.appuri%>page-embed/Inner?date=2024-02-02"></iframe>\n<%\n}%>`,
  );
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.deepEqual(out.includes, ['Inner?date=2024-02-02']);
  assert.match(out.file?.source ?? '', /"#\/page\/Inner\?date="/);
});
