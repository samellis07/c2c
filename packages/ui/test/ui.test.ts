import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { implForWrapper } = require('jsdom/lib/jsdom/living/generated/utils.js') as {
  implForWrapper(value: object): { push(item: unknown): number };
};
import { deriveIr, parse, parseProject, type App } from '../../core/src/index.js';
import { parseZml } from '../../core/src/zml.js';
import { FIELD_TYPES } from '../../schema/src/mapping.js';
import { LIMITS } from '../../shims/src/index.js';
import { buildSlate, buildUi, elementsFromZml, generateUi, sanitizeSnippet, type UiModel } from '../src/index.js';
import { leaves } from '../src/pages.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = '', modifiers = ''): string {
  const head = modifiers ? `${modifiers} ${name}` : name;
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${head}\n\t\t(\n${lines}\n\t\t)`;
}

function oneField(type: string, extra = ''): UiModel {
  return buildUi(appOf(`\tform Item\n\t{\n${field('F', type, extra)}\n\t}`)).model;
}

test('every mapped field type becomes a widget or an explicit TODO', () => {
  for (const row of FIELD_TYPES) {
    for (const token of row.tokens) {
      const extra = token === 'grid' || token === 'subform' || token === 'inline subform' ? '\t\t\tQty\n\t\t\t(\n\t\t\t\ttype = number\n\t\t\t)' : '';
      const model = oneField(token, extra);
      const ui = model.forms[0].fields[0];
      assert.ok(ui, token);
      assert.equal(ui.matrixId, row.id, token);
      if (row.id === 'prediction' || row.id === 'geolocation') assert.equal(ui.status, 'todo', token);
      else assert.equal(ui.status, 'generated', token);
    }
  }
});

test('validation rules and the lookup, subform, and upload widgets', () => {
  const model = buildUi(
    appOf(`\tform Item
\t{
${field('Title', 'text', '\t\t\tmaxchar = 12\n\t\t\tregex = "^[A-Z]+$"', 'must have unique')}
${field('Email', 'email', '', 'must have')}
${field('About', 'textarea')}
${field('Author', 'picklist', '\t\t\tvalues = Author.Name')}
${field('Lines', 'grid', '\t\t\tmust have Qty\n\t\t\t(\n\t\t\t\ttype = number\n\t\t\t)')}
${field('Photo', 'image')}
${field('Sign', 'signature')}
${field('Guess', 'prediction')}
${field('Where', 'geolocation')}
\t}`),
  ).model;
  const byName = Object.fromEntries(model.forms[0].fields.map((item) => [item.name, item]));
  assert.equal(byName.Title.required, true);
  assert.equal(byName.Title.unique, true);
  assert.equal(byName.Title.maxLength, 12);
  assert.equal(byName.Title.pattern, '^[A-Z]+$');
  assert.equal(byName.Email.widget, 'email');
  assert.equal(byName.About.maxLength, 10000);
  assert.equal(byName.Author.widget, 'lookup');
  assert.equal(byName.Author.lookup?.endpoint, '/lookups/Author/Name');
  assert.equal(byName.Lines.widget, 'subform');
  assert.equal(byName.Lines.subfields?.[0].required, true);
  assert.match(byName.Photo.uploadEndpoint ?? '', /^\/uploads\//);
  assert.match(byName.Sign.note ?? '', /strokes as JSON/);
  assert.equal(byName.Guess.status, 'todo');
  assert.equal(byName.Where.status, 'todo');
  assert.equal(model.pageSize, LIMITS.zcqlRowsPerQuery);
});

test('report types, custom actions, and ZML elements', () => {
  const model = buildUi(
    appOf(`\tform Item
\t{
${field('Name', 'text')}
${field('Status', 'picklist', '\t\t\tvalues = {"Open","Closed"}')}
${field('Due', 'date')}
${field('Place', 'address', '\t\t\tlatitude\n\t\t\t(\n\t\t\t\ttype = decimal\n\t\t\t)\n\t\t\tlongitude\n\t\t\t(\n\t\t\t\ttype = decimal\n\t\t\t)')}
\t}
\tlist All_Items
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tName
\t\t\tStatus
\t\t)
\t\tfilters
\t\t{
\t\t\tStatus
\t\t}
\t\tsort by
\t\t{
\t\t\tName ascending
\t\t}
\t\tcustom actions
\t\t{
\t\t\t"Mark done"
\t\t\t(
\t\t\t\tworkflow = Close
\t\t\t)
\t\t}
\t\tdetailview
\t\t(
\t\t)
\t}
\tkanban Board
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tStatus
\t\t)
\t\tgroup by
\t\t{
\t\t\tStatus
\t\t}
\t}
\tcalendar When
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tName
\t\t)
\t\tbased on Due
\t}
\ttimeline Story
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tName
\t\t)
\t\tbased on Due
\t}
\tmap Where
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tName
\t\t)
\t}
\tpivottable Totals
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tStatus
\t\t)
\t\tgroup by
\t\t{
\t\t\tStatus
\t\t}
\t}
\tpivotchart Chart
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tStatus
\t\t)
\t\tgroup by
\t\t{
\t\t\tStatus
\t\t}
\t}
\tspreadsheet Sheet
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tName
\t\t)
\t}
\tsummary Sum
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tStatus
\t\t)
\t}
\tgantt Later
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tName
\t\t)
\t}
\tkanban Bare
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tName
\t\t)
\t}
\tpage Home
\t{
\t\tContent="<zml><layout><panel elementName=\\"P\\"><report linkName=\\"All_Items\\"/><chart linkName=\\"Chart\\"/><form linkName=\\"Item\\"/><text value=\\"Hello\\"/><button url=\\"https://example.com\\">Go</button><html value=\\"ok\\"/><unknown-widget/></panel></layout></zml>"
\t}`),
  ).model;
  const view = Object.fromEntries(model.reports.map((report) => [report.name, report]));
  assert.equal(view.All_Items.view, 'list');
  assert.equal(view.All_Items.pageSize, 300);
  assert.equal(view.All_Items.detail, true);
  assert.equal(view.All_Items.customActions[0].endpoint, '/reports/All_Items/actions/mark-done');
  assert.equal(view.Board.view, 'kanban');
  assert.equal(view.When.view, 'calendar');
  assert.equal(view.Story.view, 'timeline');
  assert.equal(view.Where.status, 'generated');
  assert.equal(view.Totals.view, 'pivot');
  assert.equal(view.Chart.view, 'chart');
  assert.equal(view.Sheet.view, 'spreadsheet');
  assert.equal(view.Sheet.editEndpoint, '/reports/Sheet/rows');
  assert.equal(view.Sum.view, 'summary');
  assert.equal(view.Later.status, 'todo');
  assert.equal(view.Bare.status, 'todo');
  const page = model.pages[0];
  assert.equal(page.status, 'partial');
  const tags = JSON.stringify(page.elements);
  assert.match(tags, /"kind":"report"/);
  assert.match(tags, /"kind":"chart"/);
  assert.match(tags, /"kind":"form"/);
  assert.match(tags, /"kind":"text"/);
  assert.match(tags, /"kind":"button"/);
  assert.match(tags, /"kind":"html"/);
  assert.match(tags, /"kind":"todo"/);
  assert.equal(sanitizeSnippet('<script>bad()</script><b onclick="x">ok</b>'), '<b>ok</b>');
  const snippet = elementsFromZml(
    parseZml(`<html value="<script>bad()</script><b onclick='x'>ok</b>"/><unknown-widget/>`),
  );
  assert.equal(snippet[0].kind, 'html');
  assert.equal(snippet[0].html, '<b>ok</b>');
  assert.equal(snippet[1].kind, 'todo');

  const dspSnippet = elementsFromZml(
    parseZml(`<dspZml value="<b>ok</b>"/><html value="<% deluge %>"/><html value="htmlpage\nhi"/>`),
  );
  assert.equal(dspSnippet[0].kind, 'html');
  assert.equal(dspSnippet[0].html, '<b>ok</b>');
  assert.equal(dspSnippet[1].kind, 'html');
  assert.equal(dspSnippet[1].children?.[0]?.kind, 'todo');
  assert.equal(dspSnippet[1].children?.[0]?.todo, 'Server-side Deluge snippet requires manual translation');
  assert.equal(dspSnippet[2].kind, 'html');
  assert.equal(dspSnippet[2].children?.[0]?.kind, 'todo');
  assert.equal(dspSnippet[2].children?.[0]?.todo, 'Server-side Deluge snippet requires manual translation');

  // Hostile markup must not survive the shared `html` branch of either snippet tag.
  for (const tag of ['dspZml', 'htmlsnippet']) {
    for (const hostile of [
      '<script>bad()</script>',
      '<img src="x" onerror="alert(1)">',
      '<a href="javascript:alert(1)">j</a>',
      '<a href="JaVaScRiPt:alert(1)">k</a>',
      '<a href="&#106;avascript:alert(1)">m</a>',
      '<iframe src="data:text/html,hi"></iframe>',
      '<b OnClick="x">ok</b>',
      '<svg onload="alert(1)"></svg>',
      '<svg/onload="alert(1)">',
    ]) {
      const [el] = elementsFromZml(parseZml(`<${tag} value='${hostile}'/>`));
      assert.equal(el.kind, 'html', `${tag} ${hostile}`);
      const html = el.html ?? '';
      assert.doesNotMatch(html, /script/i, `${tag} ${hostile}`);
      assert.doesNotMatch(html, /onerror|onclick|onload/i, `${tag} ${hostile}`);
      assert.doesNotMatch(html, /javascript:|data:|vbscript:/i, `${tag} ${hostile}`);
      assert.doesNotMatch(html, /<svg|<iframe/i, `${tag} ${hostile}`);
    }
    const [benign] = elementsFromZml(parseZml(`<${tag} value="<b>ok</b>"/>`));
    assert.equal(benign.html, '<b>ok</b>', tag);
  }

  // A ZML <embed> with a static http(s) URL is an iframe; a templated or
  // missing URL stays a manual TODO.
  const embeds = elementsFromZml(
    parseZml(
      `<embed elementName="Map" url="https://example.com/map.pdf" width="300" height="800"/>` +
        `<embed url="javascript:alert(1)"/>` +
        `<embed url="<%=dynamic%>"/>` +
        `<embed/>`,
    ),
  );
  assert.equal(embeds[0].kind, 'embed');
  assert.deepEqual(embeds[0].embed, { url: 'https://example.com/map.pdf', width: '300', height: '800' });
  assert.equal(embeds[1].kind, 'todo');
  assert.equal(embeds[2].kind, 'todo');
  assert.equal(embeds[3].kind, 'todo');

  // Inner tags of a named widget (searchbar/searchbutton inside <search>) are
  // parts of that widget, not missing components: they stay off the leaf list.
  const searchTree = elementsFromZml(
    parseZml(`<search linkName="Book_Report"><searchbar/><searchbutton/></search>`),
  );
  assert.equal(searchTree[0].kind, 'search');
  assert.equal(leaves(searchTree).length, 1);
  assert.equal(leaves(searchTree)[0].kind, 'search');

  // A server-side dspZml whose island the compiler cannot prove nests a manual TODO that counts on the page.
  const snippetPage = buildUi(
    appOf(`\tpage Home
\t{
\t\tContent="<zml><layout><panel><dspZml name=\\"Snippet\\" value=\\"<% while (x < 1) { z = 1; } %>\\"/></panel></layout></zml>"
\t}`),
  );
  assert.equal(snippetPage.model.pages[0].status, 'partial');
  assert.equal(snippetPage.summary.pageElementsTodo, 1);
  assert.ok(snippetPage.model.todos.some((todo) => todo.area === 'zml' && todo.name === 'Home.dspZml'));

  assert.ok(model.todos.some((todo) => todo.area === 'report' && todo.name === 'Later'));
  assert.ok(model.todos.some((todo) => todo.area === 'zml'));
});

test('built PWA hashes assets, checks, renders, and validates', async () => {
  const built = buildUi(
    appOf(`\tsection Main
\t{
\t\tform Item
\t\t{
\t\t\tdisplayname = "Item"
${field('Name', 'text', '', 'must have')}
${field('Email', 'email', '', 'must have')}
${field('Qty', 'number')}
\t\t}
\t\tlist All_Items
\t\t{
\t\t\tshow all rows from Item
\t\t\t(
\t\t\t\tName
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\tform
\t{
\t\tCheck as "Check"
\t\t{
\t\t\ttype = form
\t\t\tform = Item
\t\t\ton add
\t\t\t{
\t\t\t\tactions
\t\t\t\t{
\t\t\t\ton validate
\t\t\t\t(
\t\t\t\t\talert "no";
\t\t\t\t)
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\t}`),
  );
  const files = new Map(built.files.map((file) => [file.path, file.data]));
  assert.equal(typeof files.get('slate/index.html'), 'string');
  assert.equal(typeof files.get('slate/sw.js'), 'string');
  const index = String(files.get('slate/index.html'));
  const sw = String(files.get('slate/sw.js'));
  assert.match(index, /max-age=31536000/);
  assert.match(index, /Install app/);
  assert.match(index, /src="\.\/assets\/runtime\.[0-9a-f]{10}\.js"/);
  assert.doesNotMatch(index, /@@asset:/);
  assert.match(sw, /req\.method !== "GET"/);
  assert.match(sw, /SHELL\.has\(url\.pathname\)/, 'only shell files are answered from the cache');
  assert.doesNotMatch(sw, /@@precache@@/);
  const runtimePath = [...files.keys()].find((path) => /slate\/assets\/runtime\.[0-9a-f]{10}\.js$/.test(path));
  const modelPath = [...files.keys()].find((path) => /slate\/assets\/model\.[0-9a-f]{10}\.js$/.test(path));
  assert.ok(runtimePath && modelPath);
  assert.match(index, new RegExp(runtimePath.slice('slate/'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const precache = sw.slice(sw.indexOf('const PRECACHE = ') + 'const PRECACHE = '.length, sw.indexOf(';', sw.indexOf('const PRECACHE')));
  const urls = JSON.parse(precache) as string[];
  assert.ok(urls.includes('./index.html'));
  assert.ok(urls.some((url) => url.includes('/runtime.')));
  for (const url of urls) {
    if (url === './index.html') continue;
    assert.ok(files.has(`slate/${url.slice(2)}`), url);
  }

  const dir = mkdtempSync(join(tmpdir(), 'c2c-ui-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    for (const [path, data] of files) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
    }
    for (const path of [runtimePath, modelPath, 'slate/sw.js', 'functions/uploads/stratus-upload.mjs', 'functions/lookups/lookup.mjs']) {
      const checked = spawnSync(process.execPath, ['--check', join(dir, path)], { encoding: 'utf8' });
      assert.equal(checked.status, 0, `${path}\n${checked.stderr}`);
    }
    const runtime = await import(pathToFileURL(join(dir, runtimePath)).href);
    const loaded = await import(pathToFileURL(join(dir, modelPath)).href);
    const form = loaded.model.forms.find((item: { name: string }) => item.name === 'Item');
    const html = runtime.renderForm(form);
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    const document = dom.window.document;
    assert.ok(document.querySelector('input[name="Name"]'));
    assert.equal(document.querySelector('input[name="Email"]')?.getAttribute('type'), 'email');
    assert.equal(document.querySelector('input[name="Qty"]')?.getAttribute('type'), 'text');
    assert.equal(runtime.validateForm(form, {}).Name, 'This field is required.');
    assert.equal(runtime.validateForm(form, { Name: 'Ada', Email: 'nope' }).Email, 'Enter an email address.');
    assert.equal(runtime.validateForm(form, { Name: 'Ada', Email: 'ada@example.com', Qty: '2' }).Qty, undefined);
    assert.equal(runtime.validateForm(form, { Name: 'Ada', Email: 'ada@example.com', Qty: '2.5' }).Qty, 'Enter a whole number.');
    const handler = loaded.model.handlers.find((item: { when: string }) => item.when === 'validate');
    assert.ok(handler);
    const actions = await runtime.runHandler(handler, { record: {}, shim: runtime.browserShim() });
    assert.equal(actions[0].op, 'alert');
    assert.equal(actions[0].message, 'no');
    const reportHtml = runtime.renderReport(loaded.model.reports[0]);
    assert.match(reportHtml, /data-page-size="300"/);
    assert.doesNotMatch(runtime.renderRoute(loaded.model, { name: 'home' }), /href="#\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function assertNoActiveHtml(html: string): void {
  const dom = new JSDOM(`<!doctype html><body><div id="root"></div></body>`);
  const document = dom.window.document as unknown as {
    getElementById(id: string): { innerHTML: string; querySelectorAll(selector: string): ArrayLike<{ attributes: ArrayLike<{ name: string; value: string }> }> };
  };
  const root = document.getElementById('root');
  root.innerHTML = html;
  const nodes = root.querySelectorAll('*');
  for (let i = 0; i < nodes.length; i++) {
    const attrs = nodes[i].attributes;
    for (let j = 0; j < attrs.length; j++) {
      const name = attrs[j].name.toLowerCase();
      const value = attrs[j].value;
      assert.equal(/^on/i.test(name), false, `${name}=${value} from ${html}`);
      assert.notEqual(name, 'srcdoc', html);
      if (name === 'href' || name === 'src') {
        const flat = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
        assert.equal(flat.startsWith('javascript:'), false, html);
        assert.equal(flat.startsWith('data:'), false, html);
        assert.equal(flat.startsWith('vbscript:'), false, html);
      }
      if (name === 'style') assert.equal(/url\s*\(|expression\s*\(|javascript:|@import/i.test(value), false, html);
    }
  }
}

test('HTML snippets drop slash, uppercase, and entity-encoded handlers', () => {
  assert.equal(sanitizeSnippet('<script>bad()</script><b onclick="x">ok</b>'), '<b>ok</b>');
  const payloads = [
    '<svg/onload=alert(1)>',
    '<details/open/ontoggle=alert(1)>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<IMG SRC=x ONERROR=alert(1)>',
    '<a href="JAVASCRIPT:alert(1)">x</a>',
    '<a href="javascript&#58;alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<svg ONLOAD=alert(1)>',
    '<a href="data:text/html,hi">x</a>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<iframe src="https://evil.test"></iframe>',
    '<meta http-equiv="refresh" content="0;url=https://evil.test">',
    '<img src=x onerror=alert(1)>'.toUpperCase(),
  ];
  for (const payload of payloads) assertNoActiveHtml(sanitizeSnippet(payload));
  const dom = new JSDOM('<!doctype html><body></body>');
  const runtimeWindow = dom.window as unknown as { document: unknown };
  const page = {
    name: 'P',
    label: 'P',
    status: 'generated' as const,
    elements: payloads.map((payload) => ({ tag: 'html', kind: 'html' as const, html: payload, children: [] })),
  };
  const built = buildUi(appOf(`\tform Item\n\t{\n${field('Name', 'text')}\n\t}`));
  const files = new Map(built.files.map((file) => [file.path, file.data]));
  const runtimePath = [...files.keys()].find((path) => /slate\/assets\/runtime\.[0-9a-f]{10}\.js$/.test(path));
  assert.ok(runtimePath);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-xss-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    for (const [path, data] of files) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
    }
    return import(pathToFileURL(join(dir, runtimePath)).href).then((runtime) => {
      for (const payload of payloads) assertNoActiveHtml(runtime.sanitizeSnippet(payload, runtimeWindow.document));
      assertNoActiveHtml(runtime.renderPage(page, runtimeWindow.document));
      assert.equal(runtime.sanitizeSnippet('<script>bad()</script><b onclick="x">ok</b>', runtimeWindow.document), '<b>ok</b>');
      // Credential URLs and non-HTTPS schemes are dropped. Canonical PDFs and
      // exact map hosts link out. Lookalike, uppercase, trailing-dot, and IDN
      // hosts stay in a locked sandbox and never become a link-out.
      const linkOuts: { url: string; label: string; name?: string }[] = [
        { url: 'https://example.com/manual.pdf?download=1', label: 'Open PDF' },
        { url: 'https://www.google.com/maps/embed?pb=abc', name: 'City Map', label: 'City Map' },
        { url: 'https://maps.google.com/maps/embed?pb=ok', label: 'Open map' },
        // Encoded '@' in the path is a genuine canonical escape, not userinfo.
        { url: 'https://example.com/manual%40.pdf', label: 'Open PDF' },
        // A lookalike host inside the query is data, not the authority.
        { url: 'https://example.com/x.pdf?next=//maps.google.com', label: 'Open PDF' },
        // The map path match is case-insensitive on the exact allowed host.
        { url: 'https://www.google.com/MAPS/embed?pb=x', label: 'Open map' },
      ];
      const locked = [
        'https://example.com/widget',
        // The parser strips tabs and newlines, so these parse onto an
        // allowlisted host — but the raw authority is not canonical.
        'https://maps.goog\tle.com/maps/embed?pb=x',
        'https://maps.google\n.com/maps/embed?pb=x',
        'https://example.com/man\tual.pdf',
        'https://exa\nmple.com/manual.pdf',
        // A literal space in the path is not the percent-encoded canonical form.
        'https://example.com/a b.pdf',
        // Leading or trailing whitespace means the raw text is not canonical.
        '  https://maps.google.com/maps/embed?pb=x',
        'https://maps.google.com/maps/embed?pb=x ',
        ' https://example.com/manual.pdf',
        'https://example.com/manual.pdf\t',
        // An uppercase scheme is not the canonical 'https:' the parser yields.
        'HTTPS://maps.google.com/maps/embed?pb=x',
        'HTTPS://EXAMPLE.COM/manual.pdf',
        'https://maps.google.com.evil.example/maps/embed?pb=x',
        'https://www.google.com.evil.example/maps/embed?pb=abc',
        'https://WWW.GOOGLE.COM/maps/embed?pb=abc',
        'https://www.google.com./maps/embed?pb=abc',
        'https://www.g\u043eogle.com/maps/embed?pb=x',
        'https://EXAMPLE.COM/manual.pdf',
        'https://example.com./manual.pdf',
        'https://ex\u0430mple.com/manual.pdf',
        // The URL parser canonicalises each of these hosts onto an allowlisted
        // name; the raw authority is not canonical, so they stay sandboxed.
        'https://maps%2egoogle.com/maps/embed?pb=x',
        'https://%6daps.google.com/maps/embed?pb=x',
        'https://maps\u3002google.com/maps/embed?pb=x',
        'https://maps\uFF0Egoogle\uFF61com/maps/embed?pb=x',
        'https://maps.google.com:443/maps/embed?pb=x',
        'https://maps.google.com:8443/maps/embed?pb=x',
        'https:\\\\maps.google.com\\maps\\embed?pb=x',
        'https://m\u00e4ps.google.com/maps/embed?pb=x',
        'https://xn--80ak6aa92e.com/x.pdf',
        'https://example%2ecom/manual.pdf',
        'https://example.com:443/manual.pdf',
      ];
      const dropped = [
        'http://example.com/insecure',
        'http://example.com/manual.pdf',
        'http://maps.google.com/maps/embed?pb=x',
        'javascript:alert(1)',
        'data:text/html,hi',
        'data:application/pdf,AAAA',
        'https://user:pass@maps.google.com/maps/embed?pb=x',
        'https://user:@maps.google.com/maps/embed?pb=x',
        'https://user:pass@example.com/manual.pdf',
        'https://user@example.com/manual.pdf',
        // Protocol-relative URLs have no scheme the parser can resolve without
        // a base, and a space inside the authority fails to parse at all.
        '//maps.google.com/maps/embed?pb=x',
        '//example.com/manual.pdf',
        'https://maps.g oogle.com/maps/embed?pb=x',
        'https://exam ple.com/manual.pdf',
      ];
      const embedded = runtime.renderPage(
        {
          name: 'E',
          label: 'E',
          status: 'generated',
          elements: [
            ...linkOuts.map((item) => ({
              tag: 'embed',
              kind: 'embed',
              ...(item.name ? { name: item.name } : {}),
              embed: { url: item.url, width: '300', height: '800' },
              children: [],
            })),
            ...locked.map((url) => ({ tag: 'embed', kind: 'embed', embed: { url }, children: [] })),
            ...dropped.map((url) => ({ tag: 'embed', kind: 'embed', embed: { url }, children: [] })),
          ],
        },
        runtimeWindow.document,
      );
      const esc = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const item of linkOuts) {
        assert.match(embedded, new RegExp(`<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${item.label}</a>`));
      }
      assert.equal((embedded.match(/<a /g) || []).length, linkOuts.length, 'only canonical PDF and map embeds link out');
      for (const url of locked) {
        assert.match(embedded, new RegExp(`<iframe class="embed" src="${esc(url)}" sandbox=""`));
        assert.doesNotMatch(embedded, new RegExp(`<a [^>]*href="${esc(url)}"`));
      }
      assert.equal((embedded.match(/<iframe/g) || []).length, locked.length, 'non-canonical https embeds stay sandboxed');
      assert.match(embedded, /<iframe[^>]*src="https:\/\/example\.com\/widget"[^>]*sandbox=""[^>]*loading="lazy"[^>]*referrerpolicy="no-referrer"/);
      for (const url of dropped) {
        assert.equal(embedded.includes(`src="${url}"`), false, url);
        assert.equal(embedded.includes(`href="${url}"`), false, url);
      }
    }).finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
});

/** 200, or a script failure after authorizeWrite (that response includes slots). A write-gate failure is 403. */
function writeGatePassed(result: { status: number; body: Record<string, unknown> }): boolean {
  if (result.status === 200) return true;
  return result.status === 500 && result.body.error === 'request failed' && Object.prototype.hasOwnProperty.call(result.body, 'slots');
}

function sourceText(value: string | Buffer | undefined, label: string): string {
  if (typeof value !== 'string') assert.fail(`${label} is ${typeof value}, expected a string`);
  return value;
}

function sourceOf(files: Map<string, string | Buffer>, path: string): string {
  return sourceText(files.get(path), path);
}

function migrationConstructs(files: Map<string, string | Buffer>): Set<string> {
  const report = JSON.parse(sourceText(files.get('migration-report.json'), 'migration-report.json')) as {
    untranslated?: { construct: string }[];
  };
  return new Set((report.untranslated ?? []).map((row) => row.construct));
}

/** TODO business steps this handler can hit: shim.todo literals only. */
function handlerTodoSteps(source: string): string[] {
  const steps = new Set<string>();
  for (const match of source.matchAll(/shim\.todo\(\s*ctx\s*,\s*"((?:\\.|[^"\\])*)"/g)) {
    steps.add(JSON.parse(`"${match[1]}"`) as string);
  }
  return [...steps].sort();
}

function transcriptOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const transcript = body.transcript;
  if (!Array.isArray(transcript)) return [];
  return transcript.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object');
}

/**
 * A 200 only means authorizeWrite passed. Script handlers must show every
 * todo() hit in the response transcript and in migration-report.json.
 * A 500 with no todo hit is a branch that failed silently.
 */
function assertScriptVisible(
  t: TestContext,
  path: string,
  source: string,
  accepted: { status: number; body: Record<string, unknown> },
  report: Set<string>,
): void {
  assert.equal(source.includes('?? []'), false, `${path} coerces a null collection with ?? []`);
  assert.equal(source.includes('date.cmp('), false, `${path} orders dates with date.cmp`);
  const steps = handlerTodoSteps(source);
  if (!source.includes('createRuntime')) {
    t.diagnostic(`${path} TODO business steps: (none)`);
    assert.deepEqual(steps, [], path);
    return;
  }
  assert.equal(Array.isArray(accepted.body.transcript), true, `${path} script response has no transcript`);
  const transcript = transcriptOf(accepted.body);
  const hits = transcript.filter((entry) => entry.op === 'todo' && typeof entry.construct === 'string');
  if (accepted.status === 500) {
    assert.equal(accepted.body.error, 'request failed', path);
    assert.equal(Object.prototype.hasOwnProperty.call(accepted.body, 'slots'), true, path);
    const ops = transcript.map((entry) => String(entry.op)).join(', ') || '(empty)';
    const runtimeError = transcript.some((entry) => entry.op === 'error' && typeof entry.message === 'string' && entry.message.length > 0);
    assert.ok(hits.length > 0 || runtimeError, `${path} 500 without a todo or runtime error hides the branch (ops: ${ops})`);
  } else {
    assert.equal(accepted.status, 200, `${path} ${accepted.status} ${String(accepted.body.error ?? '')}`);
  }
  for (const hit of hits) {
    assert.equal(report.has(String(hit.construct)), true, `${path} transcript todo ${String(hit.construct)} is not in the migration report`);
  }
  const listed = [...new Set([...steps, ...hits.map((hit) => String(hit.construct))])].sort();
  const missing = listed.filter((step) => !report.has(step));
  const text = listed.length ? listed.join(', ') : '(none)';
  t.diagnostic(`${path} TODO business steps: ${text}`);
  assert.deepEqual(missing, [], `${path} TODO business steps missing from migration report: ${text}`);
  if (source.includes('Fine_Amount') && source.includes('shim.date.rel') && accepted.status === 200) {
    const zeroed = transcript.some(
      (entry) =>
        entry.op === 'input.set' &&
        Array.isArray(entry.path) &&
        (entry.path as unknown[]).includes('Fine_Amount') &&
        (entry.value === 0 || entry.value === '0'),
    );
    assert.equal(zeroed, false, `${path} set Fine_Amount to 0; a blank date must not take that branch by JS coercion`);
  }
}

function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body: string) {
      raw = body;
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }));
}

async function loadBuilt(body: string): Promise<{ dir: string; files: Map<string, string | Buffer>; runtime: Record<string, unknown>; model: UiModel }> {
  const built = buildUi(appOf(body));
  const files = new Map(built.files.map((file) => [file.path, file.data]));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-auth-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const [path, data] of files) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  const runtimePath = [...files.keys()].find((path) => /slate\/assets\/runtime\.[0-9a-f]{10}\.js$/.test(path));
  assert.ok(runtimePath);
  const runtime = (await import(pathToFileURL(join(dir, runtimePath)).href)) as Record<string, unknown>;
  const modelPath = [...files.keys()].find((path) => /slate\/assets\/model\.[0-9a-f]{10}\.js$/.test(path));
  assert.ok(modelPath);
  const loaded = (await import(pathToFileURL(join(dir, modelPath)).href)) as { model: UiModel };
  return { dir, files, runtime, model: loaded.model };
}

test('data stubs enforce the access policy and a hidden form hash is 403', async () => {
  const visible = await loadBuilt(`\tsection Main
\t{
\t\tform Item
\t\t{
${field('Status', 'text')}
${field('Owner', 'text')}
${field('Secret', 'text')}
${field('Locked', 'number')}
\t\t}
\t\tlist Open
\t\t{
\t\t\tshow all rows from Item [Status == "Open"]
\t\t\t(
\t\t\t\tStatus
\t\t\t)
\t\t}
\t\tlist Mine
\t\t{
\t\t\tshow all rows from Item [Owner == zoho.loginuser]
\t\t\t(
\t\t\t\tOwner
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tOpen = {"View","Edit"}
\t\t\t\t\t\tMine = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tStatus
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tOwner
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tSecret
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:false,readonly:true
\t\t\t\t\t\t}
\t\t\t\t\t\tLocked
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:true
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\t"Stranger"
\t\t{
\t\t\tname = "Stranger"
\t\t\ttype = Users_Permissions
\t\t}
\t}`);
  try {
    const staff = { user: { profile: 'Staff', loginUser: 'ada@example.test' } };
    const stranger = { user: { profile: 'Stranger' } };
    const rows = [{ Status: 'Open', Owner: 'ada@example.test', Secret: 'nope', Locked: 1 }];
    const loadMod = (path: string) => import(pathToFileURL(join(visible.dir, path)).href);

    const report = await loadMod('functions/reports/open.mjs');
    assert.equal((await invoke(report.default, {})).status, 401);
    assert.equal((await invoke(report.default, stranger)).status, 403);
    const listed = await invoke(report.default, { ...staff, body: { rows } });
    assert.equal(listed.status, 200);
    const query = String(listed.body.queryShape);
    assert.match(query, / AND /);
    assert.match(query, /Status = 'Open'/);
    assert.match(query, /Owner = 'ada@example\.test'/);
    const listedRows = listed.body.rows as Record<string, unknown>[];
    assert.equal(Object.hasOwn(listedRows[0], 'Secret'), false);
    assert.equal(listedRows[0].Status, 'Open');
    assert.equal(JSON.stringify(listed.body).includes('accepted'), false);

    const lookup = await loadMod('functions/lookups/lookup.mjs');
    assert.equal((await invoke(lookup.default, { url: '/lookups/Item/Status' })).status, 401);
    assert.equal((await invoke(lookup.default, { ...stranger, url: '/lookups/Item/Status' })).status, 403);
    assert.equal((await invoke(lookup.default, { ...staff, url: '/lookups/Item/Secret', body: { rows } })).status, 403);
    const looked = await invoke(lookup.default, { ...staff, url: '/lookups/Item/Status', body: { rows } });
    assert.equal(looked.status, 200);
    assert.equal(Object.hasOwn((looked.body.rows as Record<string, unknown>[])[0], 'Secret'), false);

    const upload = await loadMod('functions/uploads/stratus-upload.mjs');
    assert.equal((await invoke(upload.default, { url: '/uploads/Item/Status' })).status, 401);
    assert.equal((await invoke(upload.default, { ...stranger, url: '/uploads/Item/Status' })).status, 403);
    assert.equal((await invoke(upload.default, { ...staff, url: '/uploads/Item/Secret' })).status, 403);
    assert.equal((await invoke(upload.default, { ...staff, url: '/uploads/Item/Locked' })).status, 403);
    const uploaded = await invoke(upload.default, { ...staff, url: '/uploads/Item/Status', body: { filename: 'photo.png' } });
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.body.wrote, false);
    assert.deepEqual(uploaded.body.reference, { key: 'dry-run/Item/Status/photo.png' });
    assert.equal(Object.hasOwn(uploaded.body, 'key'), false);
    assert.notEqual(uploaded.body.accepted, true);

    const submit = await loadMod('functions/aio/item/submit.mjs');
    assert.match(readFileSync(join(visible.dir, 'functions/aio/item/submit.mjs'), 'utf8'), /export const access/);
    assert.doesNotMatch(readFileSync(join(visible.dir, 'functions/aio/item/submit.mjs'), 'utf8'), /accepted:\s*true/);
    assert.equal((await invoke(submit.default, { body: { record: { Status: 'Open' } } })).status, 401);
    assert.equal((await invoke(submit.default, { ...stranger, body: { record: { Status: 'Open' } } })).status, 403);
    for (const [fieldName, value] of [['Secret', 'x'], ['Locked', 1]] as const) {
      const denied = await invoke(submit.default, { ...staff, body: { record: { [fieldName]: value } } });
      assert.equal(denied.status, 403);
      assert.match(String(denied.body.error), new RegExp(`write(?: hidden)? Item\\.${fieldName}`));
      assert.deepEqual(denied.body.values, undefined, 'a forbidden field is rejected, not returned as an accepted subset');
    }
    const saved = await invoke(submit.default, { ...staff, body: { record: { Status: 'Open' } } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.values, { Status: 'Open' });
    assert.notEqual(saved.body.accepted, true);
    assert.equal(saved.body.wrote, false);
    assert.equal(visible.model.forms[0].submitEndpoint, '/forms/Item/submit');
  } finally {
    rmSync(visible.dir, { recursive: true, force: true });
  }

  const hidden = await loadBuilt(`\tsection Secret
\t{
\t\thide = true
\t\tform Item
\t\t{
${field('Name', 'text')}
\t\t}
\t}`);
  try {
    const dom = new JSDOM('<!doctype html><body><header><strong id="app-title"></strong></header><nav id="nav"></nav><main id="main"></main></body></html>', {
      url: 'http://localhost/slate/index.html',
    });
    const view = dom.window as unknown as {
      location: { hash: string };
      document: {
        getElementById(id: string): { innerHTML: string; querySelector(selector: string): { getAttribute(name: string): string | null } | null } | null;
      };
      fetch: (url: string, init: { body: string; method: string }) => Promise<{ status: number; ok: boolean }>;
    };
    view.location.hash = '#/form/Item';
    const calls: string[] = [];
    const submit = await import(pathToFileURL(join(hidden.dir, 'functions/aio/item/submit.mjs')).href);
    view.fetch = async (url, init) => {
      calls.push(String(url));
      const result = await invoke(submit.default, { url, method: init.method, body: JSON.parse(init.body) });
      return { status: result.status, ok: result.status >= 200 && result.status < 300 };
    };
    await (hidden.runtime.boot as (model: UiModel, doc: unknown) => Promise<void>)(hidden.model, view.document);
    assert.deepEqual(calls, ['/forms/Item/submit']);
    const main = view.document.getElementById('main');
    assert.equal(main?.querySelector('[data-access-status]')?.getAttribute('data-access-status'), '403');
    assert.equal(main?.querySelector('input[name="Name"]'), null);
    assert.equal(main?.innerHTML.includes('Name'), false);
    const direct = await invoke(submit.default, { body: { op: 'view', record: { Name: 'Ada' } }, user: { profile: 'Staff' } });
    assert.equal(direct.status, 403);
  } finally {
    rmSync(hidden.dir, { recursive: true, force: true });
  }
});

test('report criteria that does not migrate fails closed: zero rows and a notice, never all rows', async () => {
  const built = await loadBuilt(`\tform Item
\t{
${field('Status', 'text')}
${field('Lookup', 'text')}
\t}
\tform Other
\t{
${field('Status', 'text')}
${field('Lookup', 'text')}
\t}
\tlist Gappy
\t{
\t\tshow all rows from Item [Lookup.Field]
\t\t(
\t\t\tStatus
\t\t)
\t}
\tlist Filtered
\t{
\t\tshow all rows from Other [Status == "Open"]
\t\t(
\t\t\tStatus
\t\t)
\t\tfilters
\t\t{
\t\t\t"Closed" : Status == "Closed"
\t\t\t"Broken" : Lookup.Field
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tGappy = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tOther
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tFiltered = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  try {
    const staff = { user: { profile: 'Staff' } };
    const rows = [
      { Status: 'Open', ID: '1' },
      { Status: 'Closed', ID: '2' },
    ];
    const loadMod = (path: string) => import(pathToFileURL(join(built.dir, path)).href);

    // The gap is a TODO on the model and a report-criteria item in the migration report.
    const gappyModel = built.model.reports.find((report) => report.name === 'Gappy');
    assert.equal(gappyModel?.status, 'todo');
    assert.match(gappyModel?.todo ?? '', /filter not migrated/i);
    assert.ok(built.model.todos.some((todo) => todo.area === 'report' && todo.name === 'Gappy'));
    const migration = JSON.parse(sourceOf(built.files, 'migration-report.json')) as {
      deterministic: boolean;
      untranslated?: { construct: string }[];
    };
    assert.equal(migration.deterministic, false);
    assert.ok((migration.untranslated ?? []).some((row) => row.construct === 'report-criteria'), 'migration report misses report-criteria');

    const gappy = await loadMod('functions/reports/gappy.mjs');
    assert.match(sourceText(built.files.get('functions/reports/gappy.mjs'), 'gappy.mjs'), /"op":"todo","construct":"report-criteria"/);

    // Dry run: supplied rows are not echoed under an unmigrated base criteria.
    const dry = await invoke(gappy.default, { ...staff, body: { rows } });
    assert.equal(dry.status, 200);
    assert.deepEqual(dry.body.rows, []);
    assert.equal(dry.body.notice, 'filter not migrated');

    const filtered = await loadMod('functions/reports/filtered.mjs');
    process.env.C2C_DEPLOY_MODE = 'live';
    const wheres: string[] = [];
    (globalThis as Record<string, unknown>).__c2cDatastore = {
      query: async (_form: string, where: string) => {
        wheres.push(where);
        return [{ Status: 'Open', ID: '9' }];
      },
    };
    try {
      // Live: an unmigrated base criteria must not reach the datastore.
      const live = await invoke(gappy.default, { ...staff, body: { op: 'query', rows } });
      assert.equal(live.status, 200);
      assert.deepEqual(live.body.rows, []);
      assert.equal(live.body.notice, 'filter not migrated');
      assert.equal(wheres.length, 0, 'datastore queried despite an unmigrated base criteria');

      // A named filter that did not migrate returns no rows, not the base set.
      const broken = await invoke(filtered.default, { ...staff, body: { op: 'query', filter: 'Broken' } });
      assert.equal(broken.status, 200);
      assert.deepEqual(broken.body.rows, []);
      assert.equal(broken.body.notice, 'filter not migrated');
      assert.equal(wheres.length, 0, 'datastore queried despite an unmigrated named filter');

      // A migrated named filter still applies.
      const closed = await invoke(filtered.default, { ...staff, body: { op: 'query', filter: 'Closed' } });
      assert.equal(closed.status, 200);
      assert.notEqual(closed.body.notice, 'filter not migrated');
      assert.equal(wheres.length, 1);
      assert.match(wheres[0], /Status = 'Closed'/);
    } finally {
      delete process.env.C2C_DEPLOY_MODE;
      delete (globalThis as Record<string, unknown>).__c2cDatastore;
    }
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('an index.html edit changes sw.js and activate keeps foreign caches', () => {
  const bundle = generateUi(appOf(`\tform Item\n\t{\n${field('Name', 'text')}\n\t}`));
  const first = buildSlate(bundle.files);
  const indexOnly = bundle.files.map((file) =>
    file.path === 'slate/index.html' ? { path: file.path, data: String(file.data).replace('</head>', '<!-- only-index --></head>') } : file,
  );
  const second = buildSlate(indexOnly);
  const swOf = (files: { path: string; data: string | Buffer }[]) => String(files.find((file) => file.path === 'slate/sw.js')?.data);
  const indexOf = (files: { path: string; data: string | Buffer }[]) => String(files.find((file) => file.path === 'slate/index.html')?.data);
  const sw1 = swOf(first);
  const sw2 = swOf(second);
  const index1 = indexOf(first);
  // Meta http-equiv cache tags are not honoured for document caching; the shell must not carry any.
  assert.doesNotMatch(index1, /http-equiv/i);
  assert.notEqual(sw1, sw2);
  assert.match(indexOf(second), /only-index/);
  const indexHash = createHash('sha256').update(indexOf(second)).digest('hex').slice(0, 10);
  assert.match(sw2, new RegExp(indexHash));

  const cssChanged = bundle.files.map((file) =>
    file.path === 'slate/assets/app.css' ? { path: file.path, data: `${String(file.data)}\n/* byte */\n` } : file,
  );
  const third = buildSlate(cssChanged);
  const cssName = (files: { path: string; data: string | Buffer }[]) => files.find((file) => /slate\/assets\/app\.[0-9a-f]{10}\.css$/.test(file.path))?.path;
  const oldCss = cssName(first);
  const newCss = cssName(third);
  assert.ok(oldCss && newCss);
  assert.notEqual(oldCss, newCss);
  const oldHash = oldCss.slice(oldCss.indexOf('app.') + 4, oldCss.indexOf('.css'));
  for (const file of third) {
    if (typeof file.data === 'string') assert.equal(file.data.includes(oldHash), false, file.path);
  }
  assert.match(indexOf(third), new RegExp(newCss.slice('slate/'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.notEqual(swOf(first), swOf(third));

  const cacheName = /const CACHE = "(c2c-[0-9a-f]{10})"/.exec(sw1)?.[1];
  assert.ok(cacheName);
  const deleted: string[] = [];
  const order: string[] = [];
  const listeners: Record<string, (event: { waitUntil: (p: Promise<unknown>) => void }) => void> = {};
  const sandbox = {
    self: {
      addEventListener(type: string, fn: (event: { waitUntil: (p: Promise<unknown>) => void }) => void) {
        listeners[type] = fn;
      },
      skipWaiting() {
        order.push('skip');
      },
      clients: { claim: () => Promise.resolve() },
      location: { origin: 'http://localhost', href: 'http://localhost/sw.js' },
    },
    caches: {
      keys: async () => ['c2c-previous', cacheName, 'foreign-cache'],
      delete: async (key: string) => {
        deleted.push(key);
        return true;
      },
      open: async () => ({
        addAll: async () => {
          order.push('add');
        },
      }),
    },
    Request: class {
      constructor(public url: string) {}
    },
    URL,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(sw1, sandbox);
  const installWait: Promise<unknown>[] = [];
  listeners.install({ waitUntil(p) { installWait.push(p); } });
  const activateWait: Promise<unknown>[] = [];
  listeners.activate({ waitUntil(p) { activateWait.push(p); } });
  return Promise.all([...installWait, ...activateWait]).then(() => {
    assert.deepEqual(order, ['add', 'skip']);
    assert.deepEqual(deleted, ['c2c-previous']);
  });
});

test('sw.js precaches with cache:reload and answers navigations network-first', async () => {
  const bundle = generateUi(appOf(`\tform Item\n\t{\n${field('Name', 'text')}\n\t}`));
  const built = buildSlate(bundle.files);
  const sw = String(built.find((file) => file.path === 'slate/sw.js')?.data);
  const index = String(built.find((file) => file.path === 'slate/index.html')?.data);
  // The document cannot carry a working cache directive on Slate.
  assert.doesNotMatch(index, /http-equiv/i);

  class FakeRequest {
    url: string;
    method = 'GET';
    cache?: string;
    mode?: string;
    constructor(input: string | FakeRequest, opts: { cache?: string; mode?: string } = {}) {
      this.url = typeof input === 'string' ? input : input.url;
      this.cache = opts.cache ?? (typeof input === 'string' ? undefined : input.cache);
      this.mode = opts.mode ?? (typeof input === 'string' ? undefined : input.mode);
    }
  }
  class FakeResponse {
    constructor(public ok: boolean, public body: string) {}
    get status() {
      return this.ok ? 200 : 500;
    }
    clone() {
      return this;
    }
  }
  const keyOf = (key: unknown) => (typeof key === 'string' ? key : (key as FakeRequest).url);
  const store = new Map<string, FakeResponse>();
  const added: FakeRequest[] = [];
  const fetched: FakeRequest[] = [];
  let failFetch = false;
  const listeners: Record<string, (event: never) => void> = {};
  const cacheObj = {
    addAll: async (entries: FakeRequest[]) => {
      added.push(...entries);
      for (const entry of entries) store.set(entry.url, new FakeResponse(true, `precached ${entry.url}`));
    },
    match: async (key: unknown) => store.get(keyOf(key)),
    put: async (key: unknown, res: FakeResponse) => {
      store.set(keyOf(key), res);
    },
  };
  const sandbox = {
    self: {
      addEventListener(type: string, fn: (event: never) => void) {
        listeners[type] = fn;
      },
      skipWaiting() {},
      clients: { claim: () => Promise.resolve() },
      location: { origin: 'http://localhost', href: 'http://localhost/sw.js' },
    },
    caches: {
      keys: async () => [] as string[],
      delete: async () => true,
      open: async () => cacheObj,
    },
    Request: FakeRequest,
    fetch: async (req: FakeRequest) => {
      fetched.push(req);
      if (failFetch) throw new Error('offline');
      return new FakeResponse(true, `live ${req.url}`);
    },
    URL,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(sw, sandbox);

  // Install: every precache entry is a Request with cache:'reload' so a new
  // worker cannot install a stale index.html out of the year-old HTTP cache.
  const installWaits: Promise<unknown>[] = [];
  listeners.install({ waitUntil(p: Promise<unknown>) { installWaits.push(p); } } as never);
  await Promise.all(installWaits);
  assert.ok(added.length > 0);
  assert.ok(added.some((entry) => entry.url === './index.html'));
  for (const entry of added) assert.equal(entry.cache, 'reload', entry.url);

  const respond = (req: FakeRequest) => {
    const seen: Promise<unknown>[] = [];
    listeners.fetch({ request: req, respondWith(p: Promise<unknown>) { seen.push(p); } } as never);
    assert.equal(seen.length, 1);
    return seen[0];
  };
  const nav = new FakeRequest('http://localhost/');
  nav.mode = 'navigate';

  // Online navigation: revalidating fetch of ./index.html, response wins and
  // refreshes the cached shell.
  const live = (await respond(nav)) as FakeResponse;
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, './index.html');
  assert.equal(fetched[0].cache, 'no-cache');
  assert.equal(live.body, 'live ./index.html');
  assert.equal(store.get('./index.html')?.body, 'live ./index.html');

  // Offline navigation: the cached shell is the fallback, not the source.
  failFetch = true;
  const offline = (await respond(nav)) as FakeResponse;
  assert.equal(offline.body, 'live ./index.html');
  failFetch = false;

  // Hashed assets stay cache-first: a cache hit never touches the network.
  const cssEntry = added.map((entry) => entry.url).find((url) => /^\.\/assets\/app\.[0-9a-f]{10}\.css$/.test(url));
  assert.ok(cssEntry, 'the stylesheet is precached');
  const cssUrl = `http://localhost${cssEntry.slice(1)}`;
  const css = new FakeRequest(cssUrl);
  css.mode = 'same-origin';
  store.set(cssUrl, new FakeResponse(true, 'cached css'));
  const before = fetched.length;
  const cssRes = (await respond(css)) as FakeResponse;
  assert.equal(cssRes.body, 'cached css');
  assert.equal(fetched.length, before);

  // c2c-config.js is a stable URL too: network-first with revalidation.
  const cfg = new FakeRequest('http://localhost/c2c-config.js');
  const cfgRes = (await respond(cfg)) as FakeResponse;
  assert.equal(fetched.at(-1)?.url, 'http://localhost/c2c-config.js');
  assert.equal(fetched.at(-1)?.cache, 'no-cache');
  assert.equal(cfgRes.body, 'live http://localhost/c2c-config.js');

  // The embedded sign-in frame navigates to /accounts/…/signin on this origin:
  // answering it with the app shell shows the app (not the sign-in page) inside
  // the frame. SDK, API and sign-in traffic never gets a respondWith.
  const passthrough = (req: FakeRequest) => {
    const seen: Promise<unknown>[] = [];
    listeners.fetch({
      request: req,
      respondWith(p: Promise<unknown>) {
        seen.push(p);
      },
    } as never);
    assert.equal(seen.length, 0, `the worker must not intercept ${req.url}`);
  };
  const passPaths = [
    '/accounts/p/1001/signin',
    '/__catalyst/sdk/init.js',
    '/baas/v1/project/1001/project-user/current',
    // A host can collapse slashes or decode escapes before routing: every
    // spelling of a sign-in, SDK or API prefix still bypasses the shell.
    '/accounts',
    '/accounts/',
    '/__catalyst',
    '/baas',
    '//accounts/',
    '//accounts/p',
    '/%61ccounts/',
    '/accounts%2Fp',
    '/%5F%5Fcatalyst/auth',
    '/Accounts/p/',
    '/x/../accounts/p',
    '/x/%2e%2e/accounts/p',
  ];
  for (const path of passPaths) {
    const nav = new FakeRequest(`http://localhost${path}`);
    nav.mode = 'navigate';
    passthrough(nav);
    passthrough(new FakeRequest(`http://localhost${path}`));
  }
  // A navigation to a /server/ path is never answered either — a sign-in step
  // can land on one. Non-navigation GETs there are API reads that go to the
  // network and are never stored (covered in pwa.test.ts).
  for (const path of ['/server/c2c_api/reports/R', '/server', '/Server/x']) {
    const nav = new FakeRequest(`http://localhost${path}`);
    nav.mode = 'navigate';
    passthrough(nav);
  }
  const crossOrigin = new FakeRequest('https://other.example/accounts/p/1001/signin');
  crossOrigin.mode = 'navigate';
  passthrough(crossOrigin);

  // The match is a whole first segment, not a prefix: an app path that merely
  // starts with a pass-through word stays on the shell path.
  for (const path of ['/accountsfoo/', '/x/accounts/p', '/accounts%20x']) {
    const seen: Promise<unknown>[] = [];
    listeners.fetch({
      request: new FakeRequest(`http://localhost${path}`, { mode: 'navigate' }),
      respondWith(p: Promise<unknown>) {
        seen.push(p);
      },
    } as never);
    assert.equal(seen.length, 1, `${path} is an app path — the worker answers it`);
    await seen[0];
  }

  // An app route still falls back to the shell — the router resolves it.
  const appRoute = new FakeRequest('http://localhost/report/R');
  appRoute.mode = 'navigate';
  const shell = (await respond(appRoute)) as FakeResponse;
  assert.equal(fetched.at(-1)?.url, './index.html');
  assert.equal(shell.body, 'live ./index.html');

  // The cache version mixes the worker's own bytes, so an sw.js change bumps
  // the cache name and an installed client moves to a fresh cache on activate.
  const rawSw = String(bundle.files.find((file) => file.path === 'slate/sw.js')?.data);
  const sha = (data: string) => createHash('sha256').update(data).digest('hex').slice(0, 10);
  const precache = JSON.parse(/PRECACHE = (\[[^\]]*\])/.exec(sw)?.[1] ?? '[]') as string[];
  const expectedId = sha(`${sha(rawSw)}\n${sha(index)}\n${precache.join('\n')}`);
  assert.match(sw, new RegExp(`CACHE = "c2c-${expectedId}"`), 'the cache name must derive from the worker bytes');

  // Docs must not claim meta tags prevent stale loads; the real mechanism is
  // the worker: reload precache, network-first index, updateViaCache, 24h.
  const doc = readFileSync('docs/ui.md', 'utf8');
  assert.doesNotMatch(doc, /prevent stale loads/);
  assert.match(doc, /cache: 'reload'/);
  assert.match(doc, /updateViaCache/);
  assert.match(doc, /network-first/);
  assert.match(doc, /24 hours/);
});

test('redistributable library app builds', () => {
  const text = readFileSync('fixtures/redistributable/library-application-system/library_application.ds');
  assert.ok(text.length > 0);
  const built = buildUi(deriveIr(parse(text.toString('utf8'))));
  assert.ok(built.summary.forms > 0);
  assert.equal(built.files.some((file) => file.path === 'slate/sw.js'), true);
});

function workflowForm(name: string, event: 'success' | 'edit'): string {
  const script =
    event === 'success'
      ? `\t\t\ton add
\t\t\t{
\t\t\t\tactions
\t\t\t\t{
\t\t\t\ton success
\t\t\t\t(
\t\t\t\t\ty = 1;
\t\t\t\t)
\t\t\t\t}
\t\t\t}`
      : `\t\t\ton edit
\t\t\t{
\t\t\t\tactions
\t\t\t\t{
\t\t\t\t\ty = 1;
\t\t\t\t}
\t\t\t}`;
  return `\t\tSave_${name} as "Save ${name}"
\t\t{
\t\t\ttype = form
\t\t\tform = ${name}
${script}
\t\t}`;
}

function modulePerms(name: string): string {
  const grant = (fieldName: string, visibility: boolean, readonly: boolean) => `\t\t\t\t\t${fieldName}
\t\t\t\t\t{
\t\t\t\t\t\tvisibility:${visibility},readonly:${readonly}
\t\t\t\t\t}`;
  return `\t\t\t\t${name}
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\t${name}_All = {"View","Edit"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
${grant('Name', true, false)}
${grant('Secret', false, true)}
${grant('Lines', true, false)}
${grant('Qty', true, false)}
${grant('Amount', true, true)}
\t\t\t\t\t}
\t\t\t\t}`;
}

test('a workflow that owns the submit URL enforces the same write gate', async () => {
  const gallery = ['Member_Info', 'Book_Transaction', 'New_Deal', 'New_Quotation', 'New_Invoice'];
  const grid = field(
    'Lines',
    'grid',
    '\t\t\tQty\n\t\t\t(\n\t\t\t\ttype = number\n\t\t\t)\n\t\t\tAmount\n\t\t\t(\n\t\t\t\ttype = formula\n\t\t\t)',
  );
  const forms = gallery
    .map(
      (name) => `\t\tform ${name}
\t\t{
${field('Name', 'text')}
${field('Secret', 'text')}
${field('Amount', 'formula')}
${grid}
\t\t}
\t\tlist ${name}_All
\t\t{
\t\t\tshow all rows from ${name}
\t\t\t(
\t\t\t\tName
\t\t\t)
\t\t}`,
    )
    .join('\n');
  const built = await loadBuilt(`\tsection Main
\t{
${forms}
\t}
\tsection Secret
\t{
\t\thide = true
\t\tform Item
\t\t{
${field('Name', 'text')}
\t\t}
\t}
\tworkflow
\t{
\tform
\t{
${gallery.map((name) => workflowForm(name, 'success')).join('\n')}
${workflowForm('Item', 'edit')}
\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
${gallery.map((name) => modulePerms(name)).join('\n')}
\t\t\t}
\t\t}
\t\t"Stranger"
\t\t{
\t\t\tname = "Stranger"
\t\t\ttype = Users_Permissions
\t\t}
\t}`);
  try {
    const staff = { user: { profile: 'Staff' } };
    const stranger = { user: { profile: 'Stranger' } };
    const leak = { Name: 'Ada', Secret: 'nope' };
    for (const name of gallery) {
      const endpoint = `/forms/${name}/success`;
      const form = built.model.forms.find((item) => item.name === name);
      assert.equal(form?.submitEndpoint, endpoint, name);
      assert.equal(built.files.has(`functions/aio/${name.toLowerCase().replace(/_/g, '-')}/submit.mjs`), false, name);
      const mod = await import(pathToFileURL(join(built.dir, `functions/aio/${name.toLowerCase().replace(/_/g, '-')}/on-success.mjs`)).href);
      const source = readFileSync(join(built.dir, `functions/aio/${name.toLowerCase().replace(/_/g, '-')}/on-success.mjs`), 'utf8');
      assert.match(source, /authorizeWrite/);
      assert.match(source, /readonlyFields = \[[^\]]*Amount/);
      assert.equal((await invoke(mod.default, { body: { op: 'view', record: leak } })).status, 401, name);
      assert.equal((await invoke(mod.default, { ...stranger, body: { op: 'view', record: leak } })).status, 403, name);
      const viewed = await invoke(mod.default, { ...staff, body: { op: 'view', record: leak } });
      assert.equal(viewed.status, 200, name);
      assert.equal(viewed.body.view, true, name);
      assert.equal(JSON.stringify(viewed.body).includes('Ada'), false, name);
      assert.equal(JSON.stringify(viewed.body).includes('nope'), false, name);
      assert.equal(Object.hasOwn(viewed.body, 'transcript'), false, name);
      const hiddenField = await invoke(mod.default, { ...staff, body: { record: { Secret: 'x' } } });
      assert.equal(hiddenField.status, 403, name);
      assert.equal(Object.hasOwn(hiddenField.body, 'transcript'), false, name);
      const readonly = await invoke(mod.default, { ...staff, body: { record: { Amount: 999 } } });
      assert.equal(readonly.status, 403, name);
      const nested = await invoke(mod.default, { ...staff, body: { record: { Lines: [{ Qty: 1, Amount: 999 }] } } });
      assert.equal(nested.status, 403, name);
      assert.equal(Object.hasOwn(nested.body, 'transcript'), false, name);
      assert.equal((await invoke(mod.default, { ...staff, body: { record: { Lines: [{ Qty: 1, amount: 999 }] } } })).status, 403, name);
      assert.equal((await invoke(mod.default, { ...staff, body: { record: { Lines: [{ Qty: 1, AMOUNT: 999 }] } } })).status, 403, name);
      const row = await invoke(mod.default, { ...staff, body: { record: { Lines: [{ Qty: 1 }] } } });
      assert.equal(row.status, 200, name);
      assert.equal(Array.isArray(row.body.transcript), true, name);
    }

    const hidden = built.model.forms.find((item) => item.name === 'Item');
    assert.equal(hidden?.submitEndpoint, '/forms/Item/submit');
    assert.equal(built.files.has('functions/aio/item/submit.mjs'), false);
    const onEdit = await import(pathToFileURL(join(built.dir, 'functions/aio/item/on-edit.mjs')).href);
    const hiddenSource = readFileSync(join(built.dir, 'functions/aio/item/on-edit.mjs'), 'utf8');
    assert.match(hiddenSource, /authorizeWrite/);
    assert.match(hiddenSource, /y = 1/);
    assert.equal((await invoke(onEdit.default, { body: { op: 'view', record: leak } })).status, 403);
    const strangerView = await invoke(onEdit.default, { ...stranger, body: { op: 'view', record: leak } });
    assert.equal(strangerView.status, 403);
    assert.equal(JSON.stringify(strangerView.body).includes('Ada'), false);
    assert.equal(JSON.stringify(strangerView.body).includes('nope'), false);
    assert.equal(Object.hasOwn(strangerView.body, 'transcript'), false);

    const dom = new JSDOM('<!doctype html><body><header><strong id="app-title"></strong></header><nav id="nav"></nav><main id="main"></main></body></html>', {
      url: 'http://localhost/slate/index.html',
    });
    const view = dom.window as unknown as {
      location: { hash: string };
      document: {
        getElementById(id: string): { innerHTML: string; querySelector(selector: string): { getAttribute(name: string): string | null } | null } | null;
      };
      fetch: (url: string, init: { body: string; method: string }) => Promise<{ status: number; ok: boolean }>;
    };
    view.location.hash = '#/form/Item';
    const calls: string[] = [];
    view.fetch = async (url, init) => {
      calls.push(String(url));
      const result = await invoke(onEdit.default, { url, method: init.method, body: JSON.parse(init.body) });
      return { status: result.status, ok: result.status >= 200 && result.status < 300 };
    };
    await (built.runtime.boot as (model: UiModel, doc: unknown) => Promise<void>)(built.model, view.document);
    assert.deepEqual(calls, ['/forms/Item/submit']);
    const main = view.document.getElementById('main');
    assert.equal(main?.querySelector('[data-access-status]')?.getAttribute('data-access-status'), '403');
    assert.equal(main?.querySelector('input[name="Name"]'), null);
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('gallery client payloads pass authorizeWrite for the predefined administrator', async (t) => {
  const dirs: string[] = [];
  try {
    const apps = [
      { dir: 'fixtures/redistributable/library-application-system', forms: 4, autonumber: 4, images: 0 },
      { dir: 'fixtures/redistributable/freight-forwarding', forms: 20, autonumber: 1, images: 7 },
    ];
    for (const expected of apps) {
      const ir = parseProject(expected.dir).ir;
      const built = buildUi(ir);
      const files = new Map(built.files.map((file) => [file.path, file.data]));
      const dir = mkdtempSync(join(tmpdir(), 'c2c-gallery-'));
      dirs.push(dir);
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
      for (const [path, data] of files) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, data);
      }
      const runtimePath = [...files.keys()].find((path) => /slate\/assets\/runtime\.[0-9a-f]{10}\.js$/.test(path));
      assert.ok(runtimePath);
      const runtime = (await import(pathToFileURL(join(dir, runtimePath)).href)) as {
        renderForm: (form: UiModel['forms'][number]) => string;
        submitRecord: (
          formEl: unknown,
          form: UiModel['forms'][number],
          upload: (field: UiModel['forms'][number]['fields'][number], file: { name: string; size: number; type?: string }) => Promise<unknown>,
        ) => Promise<Record<string, unknown>>;
        uploadReference: (
          view: unknown,
          field: UiModel['forms'][number]['fields'][number],
          file: { name: string; size: number; type?: string },
        ) => Promise<{ key: string }>;
      };
      const modelPath = [...files.keys()].find((path) => /slate\/assets\/model\.[0-9a-f]{10}\.js$/.test(path));
      assert.ok(modelPath);
      const model = ((await import(pathToFileURL(join(dir, modelPath)).href)) as { model: UiModel }).model;
      assert.equal(model.forms.length, expected.forms, expected.dir);
      const report = migrationConstructs(files);
      const counted = (widget: string) => model.forms.reduce((n, form) => n + form.fields.filter((field) => field.widget === widget).length, 0);
      assert.equal(counted('autonumber'), expected.autonumber, expected.dir);
      assert.equal(counted('image'), expected.images, expected.dir);
      const uploadPath = 'functions/uploads/stratus-upload.mjs';
      const upload = (await import(pathToFileURL(join(dir, uploadPath)).href)) as { default: (req: unknown, res: unknown) => unknown };
      const admin = { user: { profile: 'Administrator' } };
      const reader = { user: { profile: 'Read' } };
      const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/slate/index.html' });
      const view = dom.window as unknown as {
        document: {
          body: { innerHTML: string };
          querySelector(selector: string): { querySelector(selector: string): { files: object } | null } | null;
        };
        File: new (bits: string[], name: string, options?: { type: string }) => object;
      };
      const document = view.document;
      const WindowFile = view.File;

      function handlersFor(endpoint: string): string[] {
        const needle = `path: ${JSON.stringify(endpoint)}`;
        return [...files.keys()].filter((path) => {
          const data = files.get(path);
          return typeof data === 'string' && data.includes(needle) && data.includes('authorizeWrite');
        });
      }

      for (const form of model.forms) {
        document.body.innerHTML = runtime.renderForm(form);
        const formEl = document.querySelector('form');
        assert.ok(formEl, form.name);
        const payload = await runtime.submitRecord(formEl, form, async () => {
          throw new Error('empty file inputs are not uploaded');
        });
        for (const field of form.fields) {
          if (field.readonly || field.widget === 'autonumber' || field.widget === 'image' || field.widget === 'file') {
            assert.equal(Object.hasOwn(payload, field.name), false, `${form.name}.${field.name}`);
          }
        }
        assert.equal(JSON.stringify(payload).includes('{}'), false, form.name);
        const handlers = handlersFor(form.submitEndpoint);
        assert.ok(handlers.length > 0, form.submitEndpoint);
        for (const path of handlers) {
          const mod = (await import(pathToFileURL(join(dir, path)).href)) as { default: (req: unknown, res: unknown) => unknown };
          const accepted = await invoke(mod.default, { ...admin, body: { record: payload } });
          assert.equal(writeGatePassed(accepted), true, `${path} ${accepted.status} ${String(accepted.body.error ?? '')}`);
          assertScriptVisible(t, path, sourceOf(files, path), accepted, report);
          const denied = await invoke(mod.default, { ...reader, body: { record: payload } });
          assert.equal(denied.status, 403, path);
        }
      }

      const images = model.forms.flatMap((form) => form.fields.filter((field) => field.widget === 'image').map((field) => ({ form, field })));
      for (const { form, field } of images) {
        document.body.innerHTML = runtime.renderForm(form);
        const formEl = document.querySelector('form');
        assert.ok(formEl);
        const input = formEl.querySelector(`input[type="file"][name="${field.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
        assert.ok(input, `${form.name}.${field.name}`);
        const file = new WindowFile(['img'], 'photo.png', { type: 'image/png' });
        implForWrapper(input.files).push(implForWrapper(file));
        const view = {
          fetch: async (url: string, init: { body: string }) => {
            const hit = await invoke(upload.default, { ...admin, url, body: JSON.parse(init.body) });
            return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, json: async () => hit.body };
          },
        };
        const payload = await runtime.submitRecord(formEl, form, (item, picked) => runtime.uploadReference(view, item, picked));
        assert.deepEqual(payload[field.name], { key: `dry-run/${form.name}/${field.name}/photo.png` });
        const handlers = handlersFor(form.submitEndpoint);
        const mod = (await import(pathToFileURL(join(dir, handlers[0])).href)) as { default: (req: unknown, res: unknown) => unknown };
        const accepted = await invoke(mod.default, { ...admin, body: { record: payload } });
        assert.equal(writeGatePassed(accepted), true, `${form.name}.${field.name} ${accepted.status} ${String(accepted.body.error ?? '')}`);
        assert.ok(handlers[0], form.name);
        assertScriptVisible(t, handlers[0], sourceOf(files, handlers[0]), accepted, report);
        const empty = await invoke(mod.default, { ...admin, body: { record: { [field.name]: {} } } });
        assert.equal(empty.status, 403, field.name);
        const asString = await invoke(mod.default, { ...admin, body: { record: { [field.name]: 'dry-run/x' } } });
        assert.equal(asString.status, 403, field.name);
      }
    }
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test('browser shim binds a subform row and reads and writes it through record', async () => {
  const source = join(process.cwd(), 'packages/ui/src/client-runtime.js');
  const runtime = await import(pathToFileURL(source).href);
  const shim = runtime.browserShim();
  const record = { Parts: [{ Qty: 1 }, { Qty: 2 }] };
  const row = shim.subform.currentRow({ record, subformRow: { field: 'Parts', index: 1 } }, 'Parts');
  assert.equal(shim.record.get(row, 'Qty'), 2);
  shim.record.set(row, ['Total'], 9);
  assert.deepEqual(record.Parts[1], { Qty: 2, Total: 9 });
  assert.equal(shim.subform.currentRow({ record }, 'Parts'), null);
  assert.equal(shim.record.get(null, 'Qty'), null);
  assert.equal(shim.record.get({ __row: true, form: 'F', values: { A: 1 } }, 'A'), 1);
});

test('browser shim: for each over null, a record, and a non-collection; record collections; prefetch args', async () => {
  const source = join(process.cwd(), 'packages/ui/src/client-runtime.js');
  const runtime = await import(pathToFileURL(source).href);
  const sent: unknown[] = [];
  const shim = runtime.browserShim(async (_path: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ slots: {}, nonce: 'n1' }) };
  });
  // foreach.null is zero iterations (golden vector); a single record is a collection of one.
  assert.deepEqual(shim.each({}, null), []);
  const one = { __row: true, form: 'F', values: { A: 1 } };
  assert.deepEqual(shim.each({}, one), [one]);
  assert.throws(() => shim.each({}, 7), (err: Error & { code?: string }) => err.name === 'UncapturedDelugeError' && err.code === 'DELUGE_UNCAPTURED');
  // A record collection reads and writes its first record; an empty one reads null.
  const rows = [{ A: 1 }, { A: 2 }];
  assert.equal(shim.record.get(rows, 'A'), 1);
  shim.record.set(rows, ['A'], 9);
  assert.deepEqual(rows, [{ A: 9 }, { A: 2 }]);
  assert.equal(shim.record.get([], 'A'), null);
  await shim.client.prefetch({ record: {}, formNonce: 'n1', args: [42] }, '/functions/x/prefetch');
  await shim.client.prefetch({ record: {}, formNonce: 'n1' }, '/functions/x/prefetch');
  assert.deepEqual(sent, [{ record: {}, nonce: 'n1', args: [42] }, { record: {}, nonce: 'n1' }]);
});

test('browser shim: zoho.currentdate is the app-zone day at 00:00:00, from the zone c2c-config.js delivers', async () => {
  const source = join(process.cwd(), 'packages/ui/src/client-runtime.js');
  const runtime = await import(pathToFileURL(source).href);
  const shim = runtime.browserShim();
  const now = new Date('2020-01-01T00:30:00Z');
  const day = (appTimeZone: string) => shim.zoho.currentDate({ record: {}, now, appTimeZone });
  assert.equal(String(day('America/New_York')), '2019-12-31T00:00:00');
  assert.equal(String(day('Asia/Kolkata')), '2020-01-01T00:00:00');
  assert.equal(String(day('UTC')), '2020-01-01T00:00:00');
  assert.equal(JSON.stringify({ d: day('UTC') }), '{"d":"2020-01-01T00:00:00"}');
  // The other date helpers read it as a date, not a stub.
  assert.equal(shim.date.rel(day('Asia/Kolkata'), '2019-12-31', '>'), true);
  assert.equal(shim.date.format(day('Asia/Kolkata'), 'dd-MMM-yyyy'), '01-Jan-2020');
  assert.equal(String(shim.zoho.currentTime({ now, appTimeZone: 'Asia/Kolkata' })), '2020-01-01T06:00:00');
  // No zone on the page: refuse like a live server, never the browser's own zone.
  assert.throws(() => shim.zoho.currentDate({ record: {}, now }), (err: { code?: string }) => err.code === 'TIMEZONE_REQUIRED');
  // The config script carries the app time zone setting; the generated handler's info shows the day.
  const app = appOf('\ttime zone = "America/New_York"\n\tforms\n\t{\n\t\tform Orders\n\t\t{\n\t\t\tName\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t}\n\t}');
  const config = generateUi(app).files.find((f) => f.path === 'slate/c2c-config.js');
  assert.ok(config);
  const scope: Record<string, unknown> = {};
  vm.runInNewContext(String(config.data), { globalThis: scope });
  assert.equal(scope.C2C_APP_TIMEZONE, 'America/New_York');
  const handler = 'export async function clientActions(ctx) {\n  const shim = ctx.shim;\n  const actions = [];\n  actions.push({ op: "info", message: shim.zoho.currentDate(ctx) });\n  return actions;\n}\n';
  const actions = await runtime.runHandler(
    { module: `data:text/javascript,${encodeURIComponent(handler)}` },
    { record: {}, now, appTimeZone: scope.C2C_APP_TIMEZONE, shim },
  );
  assert.equal(String(actions[0].message), '2019-12-31T00:00:00');
});

function lookupShopBody(): string {
  return `\tsection Main
\t{
\t\tform Vendor
\t\t{
${field('Name', 'text')}
${field('Secret', 'text')}
\t\t}
\t\tform Order
\t\t{
${field('Title', 'text')}
${field('Vendor', 'picklist', '\t\t\tvalues = Vendor.Name')}
\t\t}
\t\tlist All_Vendors
\t\t{
\t\t\tshow all rows from Vendor
\t\t\t(
\t\t\t\tName
\t\t\t)
\t\t}
\t\tlist All_Orders
\t\t{
\t\t\tshow all rows from Order
\t\t\t(
\t\t\t\tTitle
\t\t\t\tVendor
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tVendor
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Vendors = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tName
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tSecret
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:false,readonly:true
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tOrder
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Orders = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tTitle
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tVendor
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;
}

test('lookups return only the display field and ROWID, caller-scoped, with paging', async () => {
  const built = await loadBuilt(lookupShopBody());
  try {
    const staff = { user: { profile: 'Staff' } };
    const loadMod = (path: string) => import(pathToFileURL(join(built.dir, path)).href);
    const lookup = await loadMod('functions/lookups/lookup.mjs');
    const supplied = [{ ROWID: '10000000000000001', Name: 'Acme', Secret: 'nope' }];
    // Dry run projects supplied rows to the display field plus ROWID.
    const dry = await invoke(lookup.default, { ...staff, url: '/lookups/Vendor/Name', body: { rows: supplied } });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.dryRun, true);
    assert.equal(dry.body.field, 'Name');
    assert.deepEqual(dry.body.rows, [{ ROWID: '10000000000000001', Name: 'Acme' }]);
    // A display field the caller cannot read stays denied.
    assert.equal((await invoke(lookup.default, { ...staff, url: '/lookups/Vendor/Secret', body: { rows: supplied } })).status, 403);
    // Live queries the datastore with pages, capped at the ZCQL row cap.
    const calls: { form: string; where: string; limit: number; offset: number }[] = [];
    process.env.C2C_DEPLOY_MODE = 'live';
    (globalThis as Record<string, unknown>).__c2cDatastore = {
      query: async (form: string, where: string, limit: number, offset: number) => {
        calls.push({ form, where, limit, offset });
        return [{ ROWID: '10000000000000001', Name: 'Acme', Secret: 'nope' }];
      },
    };
    try {
      const live = await invoke(lookup.default, { ...staff, url: '/lookups/Vendor/Name?page=2&pageSize=999', body: {} });
      assert.equal(live.status, 200);
      assert.equal(live.body.dryRun, false);
      assert.deepEqual(calls, [{ form: 'Vendor', where: '', limit: 300, offset: 600 }]);
      assert.deepEqual(live.body.rows, [{ ROWID: '10000000000000001', Name: 'Acme' }]);
      assert.equal(live.body.page, 2);
      assert.equal(live.body.pageSize, 300);
    } finally {
      delete process.env.C2C_DEPLOY_MODE;
      delete (globalThis as Record<string, unknown>).__c2cDatastore;
    }
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('the client fetches lookup options into empty selects', async () => {
  const source = join(process.cwd(), 'packages/ui/src/client-runtime.js');
  const runtime = (await import(pathToFileURL(source).href)) as {
    loadLookupOptions(view: unknown, endpoint: string): Promise<{ value: string; label: string }[]>;
    fillLookupSelect(select: HTMLSelectElement, options: { value: string; label: string }[]): void;
    fillLookups(form: unknown, formEl: unknown, view: unknown): Promise<void>;
    renderForm(form: { name: string; label: string; fields: unknown[]; submitEndpoint: string }): string;
  };
  const built = buildUi(appOf(`\tform Order\n\t{\n${field('Vendor', 'picklist', '\t\t\tvalues = Vendor.Name')}\n\t}`));
  const form = built.model.forms.find((item) => item.name === 'Order');
  assert.ok(form);
  assert.ok(form.fields.some((f) => f.lookup?.endpoint === '/lookups/Vendor/Name'));
  const dom = new JSDOM(`<!doctype html><body>${runtime.renderForm(form)}</body>`);
  const document = dom.window.document;
  const select = document.querySelector('select[name="Vendor"]') as unknown as HTMLSelectElement;
  assert.ok(select);
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0]?.text, '-Select-');
  const view = {
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify({ rows: [{ ROWID: '10000000000000001', Name: 'Acme' }], field: 'Name' }),
    }),
  };
  const options = await runtime.loadLookupOptions(view, '/lookups/Vendor/Name');
  assert.deepEqual(options, [{ value: '10000000000000001', label: 'Acme' }]);
  runtime.fillLookupSelect(select, options);
  assert.equal(select.options.length, 2);
  assert.equal(select.options[1]?.value, '10000000000000001');
  assert.equal(select.options[1]?.text, 'Acme');
});

test('live reports show the lookup display value, not the raw ROWID', async () => {
  const built = await loadBuilt(lookupShopBody());
  try {
    const staff = { user: { profile: 'Staff' } };
    const loadMod = (path: string) => import(pathToFileURL(join(built.dir, path)).href);
    const report = await loadMod('functions/reports/all-orders.mjs');
    const queried: string[] = [];
    process.env.C2C_DEPLOY_MODE = 'live';
    (globalThis as Record<string, unknown>).__c2cDatastore = {
      query: async (form: string) => {
        queried.push(form);
        if (form === 'Vendor') return [{ ROWID: '10000000000000001', Name: 'Acme' }];
        return [{ ROWID: '10000000000000002', Title: 'PO-1', Vendor: '10000000000000001' }];
      },
    };
    try {
      const live = await invoke(report.default, { ...staff, body: { op: 'query' } });
      assert.equal(live.status, 200);
      assert.equal(live.body.dryRun, false);
      assert.ok(queried.includes('Vendor'), `parent display was never fetched: ${queried.join(',')}`);
      const rows = live.body.rows as Record<string, unknown>[];
      assert.equal(rows[0]?.Vendor, 'Acme');
    } finally {
      delete process.env.C2C_DEPLOY_MODE;
      delete (globalThis as Record<string, unknown>).__c2cDatastore;
    }
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

// A Vendor parent whose Credit_Limit is currency (varchar, with a Double shadow)
// and three profiles: Staff reads Acme only, Small reads Credit_Limit < 50, and
// Stranger has no Vendor grant.
function scopedLookupShop(): string {
  const perm = (form: string, report: string, fields: string) => `\t\t\t\t${form}\n\t\t\t\t{\n\t\t\t\t\tenabled = true\n\t\t\t\t\tReportPermissions\n\t\t\t\t\t{\n\t\t\t\t\t\t${report} = {"View"}\n\t\t\t\t\t}\n\t\t\t\t\tFieldPermissions\n\t\t\t\t\t{\n${fields}\t\t\t\t\t}\n\t\t\t\t}\n`;
  const fp = (name: string, vis: boolean) => `\t\t\t\t\t\t${name}\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tvisibility:${vis},readonly:false\n\t\t\t\t\t\t}\n`;
  const vendorFields = fp('Name', true) + fp('Secret', false) + fp('Credit_Limit', true);
  const orderFields = fp('Title', true) + fp('Vendor', true);
  const profile = (name: string, vendorReport: string | null) =>
    `\t\t"${name}"\n\t\t{\n\t\t\tname = "${name}"\n\t\t\ttype = Users_Permissions\n\t\t\tModulePermissions\n\t\t\t{\n${vendorReport ? perm('Vendor', vendorReport, vendorFields) : ''}${perm('Order', 'All_Orders', orderFields)}\t\t\t}\n\t\t}\n`;
  const list = (name: string, source: string, column: string) => `\t\tlist ${name}\n\t\t{\n\t\t\tshow all rows from ${source}\n\t\t\t(\n\t\t\t\t${column}\n\t\t\t)\n\t\t}\n`;
  return `\tsection Main
\t{
\t\tform Vendor
\t\t{
${field('Name', 'text')}
${field('Secret', 'text')}
${field('Credit_Limit', 'currency')}
\t\t}
\t\tform Order
\t\t{
${field('Title', 'text')}
${field('Vendor', 'picklist', '\t\t\tvalues = Vendor.Name')}
\t\t}
${list('Acme_Vendors', 'Vendor [Name == "Acme"]', 'Name')}${list('Small_Vendors', 'Vendor [Credit_Limit < 50]', 'Name')}\t\tlist All_Orders
\t\t{
\t\t\tshow all rows from Order
\t\t\t(
\t\t\t\tTitle
\t\t\t\tVendor
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
${profile('Staff', 'Acme_Vendors')}${profile('Small', 'Small_Vendors')}${profile('Stranger', null)}\t}`;
}

// Honours the WHERE it can read, the way the Data Store does: Name equality,
// ROWID IN, and a comparison on the raw varchar Credit_Limit, which compares
// as text ('100' < '50'). A predicate on the Credit_Limit__n shadow is not
// applied, so only the exact pass can drop a row the shadow over-matches.
function varcharStore(log: { form: string; where: string; limit: number; offset: number }[]) {
  const vendors = [
    { ROWID: '1001', Name: 'Acme', Secret: 's-acme', Credit_Limit: '10' },
    { ROWID: '1002', Name: 'Beta', Secret: 's-beta', Credit_Limit: '100' },
  ];
  return {
    query: async (form: string, where: string, limit: number, offset: number) => {
      log.push({ form, where, limit, offset });
      if (form !== 'Vendor') {
        return [
          { ROWID: '2001', Title: 'PO-1', Vendor: '1001' },
          { ROWID: '2002', Title: 'PO-2', Vendor: '1002' },
          { ROWID: '2003', Title: 'PO-3', Vendor: '1002' },
        ];
      }
      let rows = vendors.map((row) => ({ ...row }));
      if (/Name = 'Acme'/.test(where)) rows = rows.filter((row) => row.Name === 'Acme');
      const ids = /ROWID IN \(([^)]*)\)/.exec(where)?.[1]?.split(',').map((id) => id.trim().replace(/'/g, ''));
      if (ids) rows = rows.filter((row) => ids.includes(row.ROWID));
      const lt = /\bCredit_Limit < '?([0-9.]+)'?/.exec(where);
      if (lt) rows = rows.filter((row) => row.Credit_Limit < lt[1]!);
      return rows.slice(offset, offset + limit);
    },
  };
}

async function withLiveStore<T>(store: unknown, run: () => Promise<T>): Promise<T> {
  process.env.C2C_DEPLOY_MODE = 'live';
  (globalThis as Record<string, unknown>).__c2cDatastore = store;
  try {
    return await run();
  } finally {
    delete process.env.C2C_DEPLOY_MODE;
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
  }
}

test('a currency record filter on the parent is exact in the lookup endpoint and the report display', async () => {
  const built = await loadBuilt(scopedLookupShop());
  try {
    const lookup = await import(pathToFileURL(join(built.dir, 'functions/lookups/lookup.mjs')).href);
    const report = await import(pathToFileURL(join(built.dir, 'functions/reports/all-orders.mjs')).href);
    const log: { form: string; where: string; limit: number; offset: number }[] = [];
    await withLiveStore(varcharStore(log), async () => {
      const small = { user: { profile: 'Small' } };
      const options = await invoke(lookup.default, { ...small, url: '/lookups/Vendor/Name', body: {} });
      assert.equal(options.status, 200);
      assert.deepEqual(options.body.rows, [{ ROWID: '1001', Name: 'Acme' }], 'Beta (Credit_Limit 100) is outside Credit_Limit < 50');
      for (const call of log) assert.doesNotMatch(call.where, /\bCredit_Limit </, `raw varchar compared: ${call.where}`);
      assert.ok(log.some((call) => /Credit_Limit__n/.test(call.where)), `no shadow column in ${JSON.stringify(log)}`);

      log.length = 0;
      const shown = await invoke(report.default, { ...small, body: { op: 'query' } });
      assert.equal(shown.status, 200);
      const rows = shown.body.rows as Record<string, unknown>[];
      assert.deepEqual(rows.map((row) => row.Vendor), ['Acme', '1002', '1002']);
      assert.ok(!JSON.stringify(shown.body).includes('Beta'), 'an out-of-filter parent display leaked');
      const parents = log.filter((call) => call.form === 'Vendor');
      for (const call of parents) assert.doesNotMatch(call.where, /\bCredit_Limit </, `raw varchar compared: ${call.where}`);
      assert.ok(parents.some((call) => /ROWID IN/.test(call.where) && /Credit_Limit__n/.test(call.where)), JSON.stringify(parents));
    });
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('lookup and report display scopes hold per profile, one parent query per column', async () => {
  const built = await loadBuilt(scopedLookupShop());
  try {
    const lookup = await import(pathToFileURL(join(built.dir, 'functions/lookups/lookup.mjs')).href);
    const report = await import(pathToFileURL(join(built.dir, 'functions/reports/all-orders.mjs')).href);
    const log: { form: string; where: string; limit: number; offset: number }[] = [];
    await withLiveStore(varcharStore(log), async () => {
      const staff = { user: { profile: 'Staff' } };
      assert.equal((await invoke(lookup.default, { url: '/lookups/Vendor/Name', body: {} })).status, 401);
      assert.equal((await invoke(lookup.default, { user: { profile: 'Stranger' }, url: '/lookups/Vendor/Name', body: {} })).status, 403);
      const options = await invoke(lookup.default, { ...staff, url: '/lookups/Vendor/Name', body: {} });
      assert.deepEqual(options.body.rows, [{ ROWID: '1001', Name: 'Acme' }]);
      log.length = 0;
      assert.equal((await invoke(lookup.default, { ...staff, url: '/lookups/Vendor/Secret', body: {} })).status, 403);
      assert.equal(log.length, 0);

      log.length = 0;
      const shown = await invoke(report.default, { ...staff, body: { op: 'query' } });
      assert.deepEqual((shown.body.rows as Record<string, unknown>[]).map((row) => row.Vendor), ['Acme', '1002', '1002']);
      assert.equal(log.filter((call) => call.form === 'Vendor').length, 1);
      log.length = 0;
      await invoke(report.default, { user: { profile: 'Stranger' }, body: { op: 'query' } });
      assert.equal(log.filter((call) => call.form === 'Vendor').length, 0);
    });
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('a prototype key as the lookup form or profile is refused before any query', async () => {
  const built = await loadBuilt(scopedLookupShop());
  try {
    const lookup = await import(pathToFileURL(join(built.dir, 'functions/lookups/lookup.mjs')).href);
    const log: { form: string; where: string; limit: number; offset: number }[] = [];
    await withLiveStore(varcharStore(log), async () => {
      for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
        log.length = 0;
        const viaUrl = await invoke(lookup.default, { user: { profile: 'Staff' }, url: `/lookups/${key}/Name`, body: {} });
        const viaParams = await invoke(lookup.default, { user: { profile: 'Staff' }, url: '/lookups/x/y', params: { form: key, field: 'Name' }, body: {} });
        const asProfile = await invoke(lookup.default, { user: { profile: key }, url: '/lookups/Vendor/Name', body: {} });
        assert.equal(log.length, 0, `${key} reached datastore.query: ${JSON.stringify(log)}`);
        for (const got of [viaUrl, viaParams, asProfile]) assert.ok(got.status === 403 || got.status === 404, `${key} -> ${got.status}`);
      }
    });
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('lookup paging comes from the query string, never the GET body', async () => {
  const built = await loadBuilt(lookupShopBody());
  try {
    const staff = { user: { profile: 'Staff' } };
    const lookup = await import(pathToFileURL(join(built.dir, 'functions/lookups/lookup.mjs')).href);
    const calls: { form: string; where: string; limit: number; offset: number }[] = [];
    await withLiveStore(
      {
        query: async (form: string, where: string, limit: number, offset: number) => {
          calls.push({ form, where, limit, offset });
          return [{ ROWID: '10000000000000006', Name: 'Acme', Secret: 'nope' }];
        },
      },
      async () => {
        // (a) the GET body page is ignored; the query string wins.
        const live = await invoke(lookup.default, {
          ...staff,
          url: '/lookups/Vendor/Name?page=2&pageSize=999',
          body: { page: 99, pageSize: 1 },
        });
        assert.equal(live.status, 200);
        assert.deepEqual(calls, [{ form: 'Vendor', where: '', limit: 300, offset: 600 }]);
        assert.deepEqual(live.body.rows, [{ ROWID: '10000000000000006', Name: 'Acme' }]);
        assert.equal(live.body.page, 2);
        assert.equal(live.body.pageSize, 300);
        // Absent params fall back to the first full page.
        calls.length = 0;
        const plain = await invoke(lookup.default, { ...staff, url: '/lookups/Vendor/Name', body: {} });
        assert.equal(plain.status, 200);
        assert.deepEqual(calls, [{ form: 'Vendor', where: '', limit: 300, offset: 0 }]);
        assert.equal(plain.body.pageSize, 300);
      },
    );
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('lookup paging rejects non-integers and over-wide offsets', async () => {
  const built = await loadBuilt(lookupShopBody());
  try {
    const staff = { user: { profile: 'Staff' } };
    const lookup = await import(pathToFileURL(join(built.dir, 'functions/lookups/lookup.mjs')).href);
    await withLiveStore(
      {
        query: async () => [{ ROWID: '10000000000000006', Name: 'Acme', Secret: 'nope' }],
      },
      async () => {
        // (b) pageSize outside [1, 300] is rejected, except above-cap values clamp.
        for (const value of ['0', '-1', '1.5', 'x']) {
          const rejected = await invoke(lookup.default, { ...staff, url: `/lookups/Vendor/Name?pageSize=${value}` });
          assert.equal(rejected.status, 400, `pageSize=${value} should be rejected`);
          assert.ok(typeof rejected.body.error === 'string' && rejected.body.error.length > 0, `pageSize=${value} needs a message`);
        }
        for (const value of ['-1', '1.5', 'x']) {
          const rejected = await invoke(lookup.default, { ...staff, url: `/lookups/Vendor/Name?page=${value}` });
          assert.equal(rejected.status, 400, `page=${value} should be rejected`);
        }
        const clamped = await invoke(lookup.default, { ...staff, url: '/lookups/Vendor/Name?pageSize=10000' });
        assert.equal(clamped.status, 200);
        assert.equal(clamped.body.pageSize, 300);
        // (c) the offset boundary: 333 * 300 = 99900 passes, 334 * 300 = 100200 is refused.
        assert.equal((await invoke(lookup.default, { ...staff, url: '/lookups/Vendor/Name?page=333&pageSize=300' })).status, 200);
        assert.equal((await invoke(lookup.default, { ...staff, url: '/lookups/Vendor/Name?page=334&pageSize=300' })).status, 400);
      },
    );
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

// Vendor lives only in a hidden section: its display value must never reach a
// visible report; the cell keeps the parent ROWID.
function hiddenParentShopBody(): string {
  return `\tsection Main
\t{
\t\tform Order
\t\t{
${field('Title', 'text')}
${field('Vendor', 'picklist', '\t\t\tvalues = Vendor.Name')}
\t\t}
\t\tlist All_Vendors
\t\t{
\t\t\tshow all rows from Vendor
\t\t\t(
\t\t\t\tName
\t\t\t)
\t\t}
\t\tlist All_Orders
\t\t{
\t\t\tshow all rows from Order
\t\t\t(
\t\t\t\tTitle
\t\t\t\tVendor
\t\t\t)
\t\t}
\t}
\tsection Archive
\t{
\t\thide = true
\t\tform Vendor
\t\t{
${field('Name', 'text')}
${field('Secret', 'text')}
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tVendor
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Vendors = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tName
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tSecret
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:false,readonly:true
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tOrder
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Orders = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tTitle
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tVendor
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;
}

test('a hidden parent display stays a ROWID in the report', async () => {
  const built = await loadBuilt(hiddenParentShopBody());
  try {
    const staff = { user: { profile: 'Staff' } };
    const report = await import(pathToFileURL(join(built.dir, 'functions/reports/all-orders.mjs')).href);
    await withLiveStore(
      {
        query: async (form: string) => {
          if (form === 'Vendor') return [{ ROWID: '1001', Name: 'Acme', Secret: 's-acme' }];
          return [{ ROWID: '2001', Title: 'PO-1', Vendor: '1001' }];
        },
      },
      async () => {
        // (d) the hidden Vendor.Name display never reaches the report: ROWID only.
        const shown = await invoke(report.default, { ...staff, body: { op: 'query' } });
        assert.equal(shown.status, 200);
        const rows = shown.body.rows as Record<string, unknown>[];
        assert.deepEqual(rows.map((row) => row.Vendor), ['1001']);
        assert.ok(!JSON.stringify(shown.body).includes('Acme'), 'hidden parent display leaked into the report');
      },
    );
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

// Order.Vendor shows Vendor.Secret. Staff hides Secret (ROWID only); Boss sees
// every field (the value resolves, even with no field allowlist on the grant).
function secretDisplayShopBody(): string {
  return `\tsection Main
\t{
\t\tform Vendor
\t\t{
${field('Name', 'text')}
${field('Secret', 'text')}
\t\t}
\t\tform Order
\t\t{
${field('Title', 'text')}
${field('Vendor', 'picklist', '\t\t\tvalues = Vendor.Secret')}
\t\t}
\t\tlist All_Vendors
\t\t{
\t\t\tshow all rows from Vendor
\t\t\t(
\t\t\t\tName
\t\t\t)
\t\t}
\t\tlist All_Orders
\t\t{
\t\t\tshow all rows from Order
\t\t\t(
\t\t\t\tTitle
\t\t\t\tVendor
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tVendor
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Vendors = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tName
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tSecret
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:false,readonly:true
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tOrder
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Orders = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tTitle
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tVendor
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\t"Boss"
\t\t{
\t\t\tname = "Boss"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tVendor
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tallfieldsvisible = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Vendors = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tOrder
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tallfieldsvisible = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Orders = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;
}

test('a profile-hidden display stays a ROWID, a visible one resolves', async () => {
  const built = await loadBuilt(secretDisplayShopBody());
  try {
    const report = await import(pathToFileURL(join(built.dir, 'functions/reports/all-orders.mjs')).href);
    await withLiveStore(
      {
        query: async (form: string) => {
          if (form === 'Vendor') return [{ ROWID: '1001', Name: 'Acme', Secret: 's-acme' }];
          return [{ ROWID: '2001', Title: 'PO-1', Vendor: '1001' }];
        },
      },
      async () => {
        const staff = await invoke(report.default, { user: { profile: 'Staff' }, body: { op: 'query' } });
        assert.equal(staff.status, 200);
        assert.deepEqual((staff.body.rows as Record<string, unknown>[]).map((row) => row.Vendor), ['1001']);
        assert.ok(!JSON.stringify(staff.body).includes('s-acme'), 'profile-hidden display leaked into the report');
        const boss = await invoke(report.default, { user: { profile: 'Boss' }, body: { op: 'query' } });
        assert.equal(boss.status, 200);
        assert.deepEqual((boss.body.rows as Record<string, unknown>[]).map((row) => row.Vendor), ['s-acme']);
      },
    );
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('a workflow hide on a subform column hides its header and cells', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  const { clientRuntimeSource } = await import('../src/generate.js');
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`);
  const model = buildUi(
    appOf(`\tform Item
\t{
${field('Name', 'text')}
${field('Lines', 'grid', '\t\t\tMaterial\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t\tQty\n\t\t\t(\n\t\t\t\ttype = number\n\t\t\t)\n\t\t\tNote\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)')}
\t}`),
  ).model;
  const form = model.forms[0];
  const dom = new JSDOM(`<!doctype html><body>${runtime.renderForm(form)}</body>`);
  const doc = dom.window.document as unknown as {
    querySelector(sel: string): { hidden: boolean; getAttribute(n: string): string | null; querySelectorAll(s: string): ArrayLike<{ hidden: boolean }> } | null;
  };
  const formEl = dom.window.document.querySelector('form');
  runtime.applyActions([{ op: 'hide', targets: ['Lines.Qty'] }], formEl);
  const box = doc.querySelector('.subform[data-field="Lines"]');
  assert.ok(box);
  const heads = box.querySelectorAll('thead th');
  // Three field columns plus the row-ops column.
  assert.equal(heads.length, 4);
  assert.equal(heads[1].hidden, true);
  assert.equal(heads[0].hidden, false);
  // The hidden flag rides the column spec so rows added later stay aligned.
  const columns = JSON.parse(box.getAttribute('data-columns') || '[]') as { hidden?: boolean }[];
  assert.equal(columns[1].hidden, true);
  runtime.applyActions([{ op: 'show', targets: ['Lines.Qty'] }], formEl);
  assert.equal(box.querySelectorAll('thead th')[1].hidden, false);
  assert.equal((JSON.parse(box.getAttribute('data-columns') || '[]') as { hidden?: boolean }[])[1].hidden, false);
});

test('an on-edit load handler does not run on the add screen, an on-add one does', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  const source = join(process.cwd(), 'packages/ui/src/client-runtime.js');
  const runtime = await import(pathToFileURL(source).href);
  const hide = 'export async function clientActions() { return [{ op: "hide", targets: ["Secret"] }]; }';
  const module = `data:text/javascript,${encodeURIComponent(hide)}`;
  const makeModel = (recordEvent: string): UiModel =>
    ({
      dryRun: true,
      framework: 'vanilla',
      pageSize: 300,
      forms: [
        {
          name: 'Item',
          label: 'Item',
          fields: [
            { name: 'Secret', label: 'Secret', widget: 'text', required: false, unique: false, readonly: false, scan: false, status: 'generated' },
          ],
          submitEndpoint: '/forms/Item/submit',
          recordEndpoint: '/forms/Item/record',
          deleteEndpoint: '/forms/Item/delete',
          handlers: [{ form: 'Item', event: 'on load', when: 'load', module, recordEvent } as unknown as UiModel['handlers'][number]],
        },
      ],
      reports: [],
      pages: [],
      nav: [],
      handlers: [],
      todos: [],
    }) as UiModel;
  for (const [recordEvent, hidden] of [
    ['on edit', false],
    ['on add', true],
  ] as const) {
    const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', {
      url: 'http://localhost/slate/index.html#/form/Item',
    });
    await (runtime.boot as (model: UiModel, doc: unknown) => Promise<void>)(makeModel(recordEvent), dom.window.document);
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const block = dom.window.document.querySelector('[data-field="Secret"]');
    assert.equal(block ? (block as unknown as { hidden: boolean }).hidden : null, hidden, recordEvent);
  }
});

// ---------- W12b: workflow events in a browser context ----------

type BrowserRuntime = {
  boot(model: UiModel, doc: unknown): Promise<void>;
  renderReportRows(report: UiModel['reports'][number], rows: Record<string, unknown>[]): string;
  renderReport(report: UiModel['reports'][number]): string;
};

async function browserRuntime(): Promise<BrowserRuntime> {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  const { clientRuntimeSource } = await import('../src/generate.js');
  return (await import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`)) as unknown as BrowserRuntime;
}

function handlerModule(tag: string, ret = '[]'): string {
  const source = `export async function clientActions(ctx){ (globalThis.__c2cOrder = globalThis.__c2cOrder || []).push(${JSON.stringify(tag)}); return ${ret}; }`;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function workflowModel(
  handlers: { when: string; field?: string; recordEvent?: string; module: string }[],
  extra: Partial<UiModel['forms'][number]> = {},
): UiModel {
  return {
    dryRun: true,
    framework: 'vanilla',
    pageSize: 300,
    forms: [
      {
        name: 'Item',
        label: 'Item',
        fields: [
          { name: 'Title', label: 'Title', widget: 'text', required: false, unique: false, readonly: false, scan: false, status: 'generated' },
        ],
        submitEndpoint: '/forms/Item/submit',
        recordEndpoint: '/forms/Item/record',
        deleteEndpoint: '/forms/Item/delete',
        handlers: handlers.map((h) => ({ form: 'Item', event: h.when, ...h })),
        ...extra,
      } as UiModel['forms'][number],
    ],
    reports: [],
    pages: [],
    nav: [],
    handlers: [],
    todos: [],
  } as UiModel;
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

type JsWin = {
  document: Document;
  Event: new (type: string, init?: EventInit) => Event;
  MouseEvent: new (type: string, init?: MouseEventInit) => Event;
};

test('browser form runs load, input, validate, then success in order on submit', async () => {
  const runtime = await browserRuntime();
  (globalThis as { __c2cOrder?: string[] }).__c2cOrder = [];
  const posts: { endpoint: string; body: string }[] = [];
  const model = workflowModel([
    { when: 'load', module: handlerModule('load') },
    { when: 'input', field: 'Title', module: handlerModule('input') },
    { when: 'validate', module: handlerModule('validate') },
    { when: 'success', module: handlerModule('success') },
  ]);
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', {
    url: 'http://localhost/slate/index.html#/form/Item',
  });
  (dom.window as unknown as { fetch: typeof fetch }).fetch = (async (endpoint: string, init: { body?: string }) => {
    posts.push({ endpoint, body: String(init && init.body) });
    return okResponse({ dryRun: true });
  }) as unknown as typeof fetch;
  await runtime.boot(model, dom.window.document);
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const win = dom.window as unknown as JsWin;
  const input = win.document.querySelector('input[name="Title"]') as unknown as { value: string; dispatchEvent(e: unknown): boolean } | null;
  assert.ok(input);
  input.value = 'Hello';
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const form = win.document.querySelector('form');
  assert.ok(form);
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual((globalThis as { __c2cOrder?: string[] }).__c2cOrder, ['load', 'input', 'validate', 'success']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].endpoint, '/forms/Item/submit');
  assert.match(posts[0].body, /"Title":"Hello"/);
});

test('browser form: a cancel-submit validate stops the write', async () => {
  const runtime = await browserRuntime();
  (globalThis as { __c2cOrder?: string[] }).__c2cOrder = [];
  const posts: string[] = [];
  const model = workflowModel([
    { when: 'validate', module: handlerModule('validate', '[{op:"cancelSubmit"}]') },
    { when: 'success', module: handlerModule('success') },
  ]);
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', {
    url: 'http://localhost/slate/index.html#/form/Item',
  });
  (dom.window as unknown as { fetch: typeof fetch }).fetch = (async (endpoint: string) => {
    posts.push(endpoint);
    return okResponse({ dryRun: true });
  }) as unknown as typeof fetch;
  await runtime.boot(model, dom.window.document);
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const cancelWin = dom.window as unknown as JsWin;
  cancelWin.document.querySelector('form')?.dispatchEvent(new cancelWin.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual((globalThis as { __c2cOrder?: string[] }).__c2cOrder, ['validate']);
  assert.equal(posts.length, 0);
});

test('browser form edit route prefills the row, runs on-edit handlers and posts ROWID', async () => {
  const runtime = await browserRuntime();
  (globalThis as { __c2cOrder?: string[] }).__c2cOrder = [];
  const posts: { endpoint: string; body: string }[] = [];
  const model = workflowModel([
    { when: 'load', recordEvent: 'on add', module: handlerModule('load-add') },
    { when: 'load', recordEvent: 'on edit', module: handlerModule('load-edit') },
    { when: 'validate', recordEvent: 'on add', module: handlerModule('validate-add') },
    { when: 'validate', recordEvent: 'on edit', module: handlerModule('validate-edit') },
    { when: 'success', recordEvent: 'on edit', module: handlerModule('success-edit') },
  ]);
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', {
    url: 'http://localhost/slate/index.html#/form/Item/edit/7',
  });
  (dom.window as unknown as { fetch: typeof fetch }).fetch = (async (endpoint: string, init: { body?: string }) => {
    posts.push({ endpoint, body: String(init && init.body) });
    if (endpoint === '/forms/Item/record') return okResponse({ dryRun: false, record: { ROWID: '7', Title: 'stored' } });
    return okResponse({ dryRun: false, wrote: true });
  }) as unknown as typeof fetch;
  await runtime.boot(model, dom.window.document);
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const editWin = dom.window as unknown as JsWin;
  const input = editWin.document.querySelector('input[name="Title"]') as unknown as { value: string } | null;
  assert.equal(input?.value, 'stored');
  assert.equal(editWin.document.querySelector('button[type="submit"]')?.textContent, 'Update');
  editWin.document.querySelector('form')?.dispatchEvent(new editWin.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual((globalThis as { __c2cOrder?: string[] }).__c2cOrder, ['load-edit', 'validate-edit', 'success-edit']);
  const submit = posts.find((post) => post.endpoint === '/forms/Item/submit');
  assert.ok(submit);
  assert.match(submit.body, /"ROWID":"7"/);
  assert.match(submit.body, /"Title":"stored"/);
});

test('browser subform row add and delete fire addrow/deleterow handlers with the row index', async () => {
  const runtime = await browserRuntime();
  (globalThis as { __c2cOrder?: string[] }).__c2cOrder = [];
  const model = workflowModel(
    [
      { when: 'addrow', module: handlerModule('addrow') },
      { when: 'deleterow', module: handlerModule('deleterow') },
    ],
    {
      fields: [
        {
          name: 'Lines',
          label: 'Lines',
          widget: 'subform',
          required: false,
          unique: false,
          readonly: false,
          scan: false,
          status: 'generated',
          subfields: [
            { name: 'Qty', label: 'Qty', widget: 'number', required: false, unique: false, readonly: false, scan: false, status: 'generated' },
          ],
        } as unknown as UiModel['forms'][number]['fields'][number],
      ],
    },
  );
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', {
    url: 'http://localhost/slate/index.html#/form/Item',
  });
  (dom.window as unknown as { fetch: typeof fetch }).fetch = (async () => okResponse({ dryRun: true })) as unknown as typeof fetch;
  await runtime.boot(model, dom.window.document);
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const win = dom.window as unknown as JsWin;
  const add = win.document.querySelector('[data-add-row]');
  assert.ok(add);
  add.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const remove = win.document.querySelector('[data-remove-row]');
  assert.ok(remove, 'a subform row renders a remove button');
  remove.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual((globalThis as { __c2cOrder?: string[] }).__c2cOrder, ['addrow', 'deleterow']);
  assert.equal(win.document.querySelectorAll('.subform tbody tr').length, 0);
});

test('browser report row paints conditional formats and notes an unmigrated rule', async () => {
  const runtime = await browserRuntime();
  const report = {
    name: 'All',
    label: 'All',
    type: 'report',
    view: 'list',
    form: 'Item',
    status: 'generated',
    columns: [
      { field: 'Title', label: 'Title' },
      { field: 'Status', label: 'Status' },
    ],
    filters: [],
    sort: [],
    groupBy: [],
    pageSize: 50,
    queryEndpoint: '/reports/All',
    conditionalFormats: [
      { name: 'hot', fields: ['Status'], criteria: { op: '==', field: 'Status', value: 'Open' }, format: 'color:red;' },
      { name: 'odd', fields: [], criteria: { op: 'todo', construct: 'x' }, format: 'color:blue;' },
    ],
    customActions: [],
    detail: false,
    rowActions: { edit: true, delete: true },
  } as UiModel['reports'][number];
  const rows = runtime.renderReportRows(report, [
    { ROWID: '1', Title: 'a', Status: 'Open' },
    { ROWID: '2', Title: 'b', Status: 'Closed' },
  ]);
  const dom = new JSDOM(`<table><tbody>${rows}</tbody></table>`);
  const tds = [...(dom.window.document as unknown as Document).querySelectorAll('td')];
  const statusCell = tds.find((td) => td.textContent === 'Open');
  assert.match(statusCell?.getAttribute('style') || '', /color:red/);
  const closedCell = tds.find((td) => td.textContent === 'Closed');
  assert.equal(closedCell?.getAttribute('style') || '', '');
  // The unmigrated rule shows a note instead of silently painting nothing.
  assert.match(runtime.renderReport(report), /conditional formatting rule was not migrated/);
  const doc2 = dom.window.document as unknown as Document;
  assert.ok(doc2.querySelector('[data-row-edit]'), 'row edit affordance rendered');
  assert.ok(doc2.querySelector('[data-row-delete]'), 'row delete affordance rendered');
});

test('submit refuses a statically hidden or disabled field; conditional rules stay client-side', async () => {
  const built = await loadBuilt(`\tsection Main
\t{
\t\tform Item
\t\t{
${field('Status', 'text')}
${field('Secret', 'text')}
${field('Locked', 'text')}
${field('Mode', 'text')}
\t\t}
\t\tlist All
\t\t{
\t\t\tshow all rows from Item
\t\t\t(
\t\t\t\tStatus
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRules as "Rules"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\trecord event = on add or edit
\t\t\t\tfield rules
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\thide Secret;
\t\t\t\t\t\tdisable Locked;
\t\t\t\t\t}
\t\t\t\t\tactions (Mode == "Sea")
\t\t\t\t\t{
\t\t\t\t\t\thide Status;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll = {"View","Edit"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tStatus
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tSecret
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tLocked
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tMode
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  try {
    const staff = { user: { profile: 'Staff', loginUser: 'ada@example.test' } };
    const source = readFileSync(join(built.dir, 'functions/aio/item/submit.mjs'), 'utf8');
    assert.match(source, /export const fieldRuleDenied = /);
    const submit = await import(pathToFileURL(join(built.dir, 'functions/aio/item/submit.mjs')).href);
    // A write to a statically hidden field is refused, naming the field.
    const hidden = await invoke(submit.default, { ...staff, body: { record: { Secret: 'x' } } });
    assert.equal(hidden.status, 403);
    assert.match(String(hidden.body.error), /Item\.Secret is hidden by a field rule/);
    // A write to a statically disabled field is refused the same way.
    const disabled = await invoke(submit.default, { ...staff, body: { record: { Locked: 'x' } } });
    assert.equal(disabled.status, 403);
    assert.match(String(disabled.body.error), /Item\.Locked is disabled by a field rule/);
    // Edit context denies too: `on add or edit` covers update (ROWID sent).
    const edited = await invoke(submit.default, { ...staff, body: { record: { Secret: 'x' }, ROWID: '7' } });
    assert.equal(edited.status, 403);
    // A conditionally hidden field is not a static denial: the server cannot
    // evaluate Mode's value, so the field stays writable.
    const conditional = await invoke(submit.default, { ...staff, body: { record: { Status: 'Open' } } });
    assert.equal(conditional.status, 200);
    assert.deepEqual(conditional.body.values, { Status: 'Open' });
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});
