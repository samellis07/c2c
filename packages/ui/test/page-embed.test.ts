/**
 * A literal `page-embed` iframe of another page of the same app becomes an
 * inline include of that page's generated view: no iframe, the included page
 * passes the same gate as its own route, and its snippets keep their own
 * endpoints. Anything else (an unknown page, the page itself, a query
 * parameter that is not a `zc_` display flag, an island in the tag) stays the
 * counted snippet. A `zc-component` embed in compiled markup stays a TODO.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';
import { compileHtmlpage } from '../src/htmlpage.js';
import type { UiElement, UiModel } from '../src/index.js';
import { pageSpecs } from '../../ui-react/src/charts.js';

const SNIPPET_TODO = 'Server-side Deluge snippet requires manual translation';

interface Runtime {
  renderPage(page: unknown, doc: unknown, appModel?: unknown): string;
  hydratePageIncludes(root: unknown, appModel: unknown, viewRef?: unknown): void;
  hydrateSnippets(root: unknown, appModel: unknown, viewRef?: unknown): void;
  hydrateComponentEmbeds(root: unknown, appModel: unknown, viewRef?: unknown): void;
}

async function loadRuntime(): Promise<Runtime> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as Runtime;
}

function literal(zml: string): string {
  return JSON.stringify(zml);
}

function snippetPage(name: string, snippet: string): string {
  const zml = `<zml><layout><row><column width='100%'><dsp id='${name}1'><![CDATA[${snippet}]]></dsp></column></row></layout></zml>`;
  return `\t\tpage ${name}\n\t\t{\n\t\t\tContent=${literal(zml)}\n\t\t}`;
}

function textPage(name: string, text: string): string {
  return `\t\tpage ${name}\n\t\t{\n\t\t\tContent=${literal(`<zml><layout><panel><text value='${text}'/></panel></layout></zml>`)}\n\t\t}`;
}

function appOf(pages: string[], hidden: string[] = []): App {
  const hiddenSection = hidden.length ? `\n\tsection Back\n\t{\n\t\thide = true\n${hidden.join('\n')}\n\t}` : '';
  return deriveIr(parse(`application "Demo"\n{\n\tsection Front\n\t{\n${pages.join('\n')}\n\t}${hiddenSection}\n}\n`));
}

interface Node {
  innerHTML: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): Node | null;
  querySelectorAll(selector: string): { length: number };
}

function mainOf(dom: JSDOM): Node {
  return (dom.window.document as unknown as { getElementById(id: string): Node }).getElementById('main');
}

const embed = (src: string, attrs = '') => `htmlpage Outer1()
content
<%{
%>
<div class="box"><p>Before</p><iframe id = "frame"${attrs} src="${src}"></iframe></div>
<%
}%>`;

function snippetOf(model: UiModel, page: string): UiElement | undefined {
  const walk = (els: UiElement[]): UiElement | undefined => {
    for (const el of els) {
      if (el.kind === 'html') return el;
      const hit = walk(el.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(model.pages.find((item) => item.name === page)?.elements ?? []);
}

function snippetTodos(model: UiModel): string[] {
  return model.todos.filter((todo) => todo.area === 'zml').map((todo) => todo.reason);
}

test('a literal page-embed of another page compiles to an include marker, not an iframe', () => {
  const { model } = buildUi(appOf([snippetPage('Outer', embed('<%=zoho.appuri%>page-embed/Inner')), textPage('Inner', 'Inner body')]));
  assert.deepEqual(snippetTodos(model), []);
  const el = snippetOf(model, 'Outer');
  assert.deepEqual(el?.includes, ['Inner']);
  assert.match(el?.html ?? '', /<div data-zml="page-include:Inner"><\/div>/);
  assert.doesNotMatch(el?.html ?? '', /iframe/i);
});

test('zc_ display flags may stay on the embed URL', () => {
  const { model } = buildUi(appOf([snippetPage('Outer', embed('<%= zoho.appuri %>page-embed/Inner?zc_Header=false&zc_Footer=false')), textPage('Inner', 'x')]));
  assert.deepEqual(snippetTodos(model), []);
  assert.deepEqual(snippetOf(model, 'Outer')?.includes, ['Inner']);
});

test('an embed the compiler cannot prove keeps the snippet counted', () => {
  const cases: [string, string, string][] = [
    ['unknown page', embed('<%=zoho.appuri%>page-embed/Missing'), ''],
    ['the page embedding itself', embed('<%=zoho.appuri%>page-embed/Outer'), ''],
    ['a query parameter that is not a zc_ flag', embed('<%=zoho.appuri%>page-embed/Inner?recID=1'), ''],
    ['a zc_ flag beside another parameter', embed('<%=zoho.appuri%>page-embed/Inner?zc_Header=false&q=1'), ''],
    ['an island in the URL', embed('<%=zoho.appuri%>page-embed/Inner?zc_Header=<%=input.h%>'), ''],
    ['an island on another attribute', embed('<%=zoho.appuri%>page-embed/Inner', ' name="<%=input.n%>"'), ''],
    ['frame content', embed('<%=zoho.appuri%>page-embed/Inner').replace('></iframe>', '>fallback</iframe>'), ''],
    ['an embed inside a dropped element', embed('<%=zoho.appuri%>page-embed/Inner').replace('<iframe', '<noscript><iframe').replace('</iframe>', '</iframe></noscript>'), ''],
    ['a hand-written include marker', embed('<%=zoho.appuri%>page-embed/Inner').replace('<p>Before</p>', '<div data-zml="page-include:Inner"></div>'), ''],
  ];
  for (const [label, snippet] of cases) {
    const { model } = buildUi(appOf([snippetPage('Outer', snippet), textPage('Inner', 'x')]));
    assert.deepEqual(snippetTodos(model), [SNIPPET_TODO], label);
    assert.equal(snippetOf(model, 'Outer')?.includes, undefined, label);
  }
});

test('a commented-out embed is never turned into an include', () => {
  const app = appOf([textPage('Inner', 'x')]);
  const out = compileHtmlpage(app, 'Outer', 'dsp', `htmlpage Outer1()
content
<p><%=input.a%></p><!-- <iframe src="<%=zoho.appuri%>page-embed/Inner"></iframe> -->`);
  assert.equal(out.includes, undefined);
  assert.doesNotMatch(out.html ?? '', /page-include/);
});

test('an embed beside other islands rides the server render and keeps its marker', () => {
  const app = appOf([textPage('Inner', 'x')]);
  const out = compileHtmlpage(app, 'Outer', 'dsp', `htmlpage Outer1()
content
<p><%=input.a%></p><iframe src="<%=zoho.appuri%>page-embed/Inner"></iframe>`);
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(out.includes, ['Inner']);
  assert.ok(out.src);
  assert.match(out.file?.source ?? '', /page-include:Inner/);
});

async function painted(app: App, outer: string, fetchHtml?: string) {
  const runtime = await loadRuntime();
  const { model } = buildUi(app);
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', { url: 'http://localhost/' });
  const main = mainOf(dom);
  const page = model.pages.find((item) => item.name === outer);
  const infos: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => infos.push(args.map(String).join(' '));
  const view = {
    // No server response keeps the static shell (a static host answers 404).
    fetch: async () =>
      fetchHtml === undefined
        ? { status: 404, ok: false }
        : { status: 200, ok: true, json: async () => ({ html: fetchHtml }), text: async () => JSON.stringify({ html: fetchHtml }) },
  };
  try {
    main.innerHTML = runtime.renderPage(page, dom.window.document, model);
    runtime.hydrateSnippets(main, model, view);
    runtime.hydratePageIncludes(main, model, view);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    console.info = original;
  }
  return { main, infos, model };
}

test('the runtime draws the included page inline where the iframe stood', async () => {
  const { main } = await painted(appOf([snippetPage('Outer', embed('<%=zoho.appuri%>page-embed/Inner')), textPage('Inner', 'Inner body')]), 'Outer');
  assert.equal(main.querySelector('iframe'), null);
  const include = main.querySelector('[data-zml="page-include:Inner"] > .page-include[data-page="Inner"]');
  assert.ok(include, main.innerHTML);
  assert.match(include.textContent ?? '', /Inner body/);
  // The include sits where the iframe stood: after the text before it, in the same parent.
  assert.match(main.querySelector('[data-snippet-src] > div')?.textContent ?? '', /^Before[\s\S]*Inner body/);
});

test('an included page only a hidden section lists is refused, like its route', async () => {
  const { main } = await painted(
    appOf([snippetPage('Outer', embed('<%=zoho.appuri%>page-embed/Inner'))], [textPage('Inner', 'Secret body')]),
    'Outer',
  );
  assert.doesNotMatch(main.textContent ?? '', /Secret body/);
  assert.equal(main.querySelector('[data-zml="page-include:Inner"] [data-access-status]')?.getAttribute('data-access-status'), '403');
});

test('a marker the element did not declare is never filled', async () => {
  const runtime = await loadRuntime();
  const { model } = buildUi(appOf([textPage('Inner', 'Inner body')]));
  const dom = new JSDOM('<!doctype html><body><main id="main"><div class="snippet"><div data-zml="page-include:Inner"></div></div></main></body>');
  const main = mainOf(dom);
  runtime.hydratePageIncludes(main, model, {});
  assert.doesNotMatch(main.textContent ?? '', /Inner body/);
});

test('an include cycle draws each page once', async () => {
  const back = `htmlpage Inner1()
content
<%{
%>
<p>Inner body</p><iframe src="<%=zoho.appuri%>page-embed/Outer"></iframe>
<%
}%>`;
  const { main, infos } = await painted(appOf([snippetPage('Outer', embed('<%=zoho.appuri%>page-embed/Inner')), snippetPage('Inner', back)]), 'Outer');
  assert.equal(main.querySelectorAll('.page-include[data-page="Inner"]').length, 1);
  assert.equal(main.querySelectorAll('[data-page="Outer"]').length, 1, main.innerHTML);
  assert.ok(infos.some((line) => /already open above/.test(line)), infos.join('\n'));
});

test('a server-rendered snippet fills its include markers after the fetch', async () => {
  const snippet = `htmlpage Outer1()
content
<p><%=input.a%></p><iframe src="<%=zoho.appuri%>page-embed/Inner"></iframe>`;
  const { main } = await painted(appOf([snippetPage('Outer', snippet), textPage('Inner', 'Inner body')]), 'Outer', '<p>A</p><div data-zml="page-include:Inner"></div>');
  const host = main.querySelector('[data-snippet-src]');
  assert.match(host?.textContent ?? '', /^A[\s\S]*Inner body/);
  assert.equal(main.querySelectorAll('.page-include[data-page="Inner"]').length, 1);
});

const COMPONENT_FORM = `form Intake
{
  Name
  (
    type = text
  )
}`;
const COMPONENT_REPORT = `report All_Rows
{
  show all rows from Intake
  (
    Name
  )
}`;

function componentApp(snippet: string): App {
  return deriveIr(parse(`application "Demo"
{
	section Front
	{
${COMPONENT_FORM}
${COMPONENT_REPORT}
${snippetPage('Outer', snippet)}
	}
}
`));
}

test('generated zc-component forms and reports draw at their markers inline', async () => {
  const snippet = `htmlpage Outer1()
content
<%{
%>
<p>Before</p><div elName='zc-component' formLinkName='Intake'>Loading Form...</div><div elname="zc-component" viewLinkName="All_Rows">Loading...</div>
<%
}%>`;
  const app = componentApp(snippet);
  const { model } = buildUi(app);
  assert.deepEqual(snippetTodos(model), []);
  const el = snippetOf(model, 'Outer');
  assert.deepEqual(el?.components, [{ kind: 'form', name: 'Intake' }, { kind: 'report', name: 'All_Rows' }]);
  assert.match(el?.html ?? '', /data-zml="component-form:Intake"/);
  assert.match(el?.html ?? '', /data-zml="component-report:All_Rows"/);

  const runtime = await loadRuntime();
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>');
  const main = mainOf(dom);
  main.innerHTML = runtime.renderPage(model.pages.find((page) => page.name === 'Outer'), dom.window.document, model);
  runtime.hydrateComponentEmbeds(main, model, { fetch: async () => ({ status: 200, ok: true }) });
  assert.ok(main.querySelector('form[data-form="Intake"]'), main.innerHTML);
  assert.ok(main.querySelector('section[data-report="All_Rows"]'), main.innerHTML);
  assert.match(main.textContent ?? '', /^OuterBefore/);
});

test('zc-component embeds with params or unknown targets remain counted TODOs', () => {
  const snippet = `htmlpage Outer1()
content
<%{
%>
<div elName='zc-component' formLinkName='Intake' params='zc_Header=false'>Loading Form...</div>
<div elname="zc-component" viewLinkName="Missing">Loading...</div>
<%
}%>`;
  const { model } = buildUi(componentApp(snippet));
  assert.deepEqual(snippetTodos(model), [
    'Embedded zc-component form "Intake" has no generated view',
    'Embedded zc-component report "Missing" has no generated view',
  ]);
  assert.equal(snippetOf(model, 'Outer')?.components, undefined);
});

test('hidden zc-component targets show the same 403 notice as their route', async () => {
  const snippet = `htmlpage Outer1()
content
<%{ %><div elName='zc-component' formLinkName='Intake'></div><% }%>`;
  const { model } = buildUi(componentApp(snippet));
  model.nav = [{ name: 'Back', hidden: true, items: [{ kind: 'form', name: 'Intake', label: 'Intake', href: '#/form/Intake' }] }];
  const runtime = await loadRuntime();
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>');
  const main = mainOf(dom);
  main.innerHTML = runtime.renderPage(model.pages.find((page) => page.name === 'Outer'), dom.window.document, model);
  runtime.hydrateComponentEmbeds(main, model, { fetch: async () => ({ status: 403, ok: false }) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(main.querySelector('[data-access-status]')?.getAttribute('data-access-status'), '403');
  assert.equal(main.querySelector('form[data-form="Intake"]'), null);
});

test('the React view keeps the snippet that embeds a page as a TODO', () => {
  const app = appOf([snippetPage('Outer', embed('<%=zoho.appuri%>page-embed/Inner')), textPage('Inner', 'x')]);
  const { model } = buildUi(app);
  const spec = pageSpecs(app, model).Outer;
  assert.ok(spec.todos.some((todo) => /built by a server-side script/.test(todo)), spec.todos.join('\n'));
});
