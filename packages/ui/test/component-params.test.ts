/**
 * A `zc-component` form or report embed whose `params` carry a record value or
 * a page input at render time. The compiler emits the parameter as an
 * encoded query value on the embed marker; the runtime applies it as the form
 * prefill or the report filter through the same route machinery a link uses.
 * Anything that is not a bare read of a declared field stays a counted snippet.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';
import type { UiElement, UiModel } from '../src/index.js';

const SNIPPET_TODO = 'Server-side Deluge snippet requires manual translation';

interface Runtime {
  renderPage(page: unknown, doc: unknown, appModel?: unknown): string;
  hydrateSnippets(root: unknown, appModel: unknown, viewRef?: unknown): void;
  hydrateComponentEmbeds(root: unknown, appModel: unknown, viewRef?: unknown): void;
}

async function loadRuntime(): Promise<Runtime> {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as Runtime;
}

const FORM = `form Intake
{
  Name
  (
    type = text
  )
  Status
  (
    type = text
  )
  Parent
  (
    type = picklist
    values = Intake.Name
  )
}`;
const REPORT = `report All_Rows
{
  show all rows from Intake
  (
    Name
    Status
  )
}`;

function appWith(snippet: string, pageHead = 'page Outer'): App {
  const zml = `<zml><layout><row><column width='100%'><dsp id='Outer1'><![CDATA[${snippet}]]></dsp></column></row></layout></zml>`;
  return deriveIr(parse(`application "Demo"
{
	section Front
	{
${FORM}
${REPORT}
		${pageHead}
		{
			Content=${JSON.stringify(zml)}
		}
	}
}
`));
}

function snippetOf(model: UiModel): UiElement | undefined {
  const walk = (els: UiElement[]): UiElement | undefined => {
    for (const el of els) {
      if (el.kind === 'html') return el;
      const hit = walk(el.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(model.pages.find((item) => item.name === 'Outer')?.elements ?? []);
}

const snippetTodos = (model: UiModel) => model.todos.filter((todo) => todo.area === 'zml').map((todo) => todo.reason);

const embed = (tag: string, head = 'htmlpage Outer1(who)') => `${head}
content
<%{
	row = Intake[Name == input.who];
%>
${tag}
<% }%>`;

const FORM_TAG = (params: string) => `<div elName='zc-component' formLinkName='Intake' params='${params}'>Loading Form...</div>`;
const REPORT_TAG = (params: string) => `<div elName='zc-component' viewLinkName='All_Rows' params='${params}'>Loading...</div>`;

test('a form embed prefilled from a record value compiles to a parameterised marker', () => {
  const { model } = buildUi(appWith(embed(FORM_TAG('zc_Header=false&amp;Name=<%=row.Name%>'))));
  assert.deepEqual(snippetTodos(model), []);
  const el = snippetOf(model);
  assert.deepEqual(el?.components, [{ kind: 'form', name: 'Intake', params: ['Name'] }]);
  assert.match(el?.html ?? '', /data-zml="component-form:Intake:untitled\?Name="/);
  assert.ok(el?.src, 'the render rides the generated endpoint');
});

test('a report embed filtered by a record value and a page input compiles', () => {
  const { model } = buildUi(appWith(embed(REPORT_TAG('zc_Header=false&amp;Name=<%=row.Name%>&amp;Status=<%=input.who%>'))));
  assert.deepEqual(snippetTodos(model), []);
  assert.deepEqual(snippetOf(model)?.components, [{ kind: 'report', name: 'All_Rows', params: ['Name', 'Status'] }]);
});

test('a bounded literal value filters the embed without an island', () => {
  const { model } = buildUi(appWith(`htmlpage Outer1()\ncontent\n<%{ %>${REPORT_TAG('zc_Header=false&amp;Status=open')}<% }%>`));
  assert.deepEqual(snippetTodos(model), []);
  const el = snippetOf(model);
  assert.deepEqual(el?.components, [{ kind: 'report', name: 'All_Rows', params: ['Status'] }]);
  assert.match(el?.html ?? '', /data-zml="component-report:All_Rows:untitled\?Status=open"/);
});

test('a literal value outside the bounded grammar stays counted', () => {
  for (const value of ['a b', 'x%26y', 'a/b', '"q"', 'x;y']) {
    const { model } = buildUi(appWith(`htmlpage Outer1()\ncontent\n<%{ %>${REPORT_TAG(`Status=${value}`)}<% }%>`));
    assert.equal(snippetOf(model)?.components, undefined, value);
  }
});

test('a declared field name keeps its declared spelling', () => {
  const { model } = buildUi(appWith(embed(REPORT_TAG('name=<%=row.Name%>'))));
  assert.deepEqual(snippetTodos(model), []);
  assert.deepEqual(snippetOf(model)?.components, [{ kind: 'report', name: 'All_Rows', params: ['Name'] }]);
});

test('embed parameters that cannot be proven keep the snippet counted', () => {
  const cases: [string, string][] = [
    ['an undeclared key', REPORT_TAG('Missing=<%=row.Name%>')],
    ['a repeated key', REPORT_TAG('Name=<%=row.Name%>&amp;Name=<%=row.Status%>')],
    ['a repeated key in another case', REPORT_TAG('Name=<%=row.Name%>&amp;name=<%=row.Status%>')],
    ['a __proto__ key', REPORT_TAG('__proto__=<%=row.Name%>')],
    ['a constructor key', FORM_TAG('constructor=<%=row.Name%>')],
    ['a non-bare expression', REPORT_TAG('Name=<%=row.Name + "x"%>')],
    ['a call', REPORT_TAG('Name=<%=row.Name.toUpperCase()%>')],
    ['an index', REPORT_TAG('Name=<%=row.Name[0]%>')],
    ['an island with text around it', REPORT_TAG('Name=a<%=row.Name%>')],
    ['two islands in one value', REPORT_TAG('Name=<%=row.Name%><%=row.Status%>')],
    ['an input that the page does not declare', REPORT_TAG('Name=<%=input.other%>')],
    ['an island in the key', REPORT_TAG('<%=row.Name%>=x')],
    ['an island in another attribute', `<div elName='zc-component' viewLinkName='All_Rows' title='<%=row.Name%>' params='Name=<%=row.Name%>'></div>`],
    ['a repeated params attribute', `<div elName='zc-component' viewLinkName='All_Rows' params='Name=<%=row.Name%>' params='Status=<%=row.Status%>'></div>`],
    ['an unknown component', `<div elName='zc-component' viewLinkName='Nope' params='Name=<%=row.Name%>'></div>`],
    ['a value that is not a bare read', REPORT_TAG('Name=<%=row.Name%>%20&amp;<%=row.Status%>')],
    ['an island holding a quote', REPORT_TAG(`Name=<%=row["Name"]%>`)],
  ];
  for (const [label, tag] of cases) {
    const { model } = buildUi(appWith(embed(tag)));
    assert.deepEqual(snippetTodos(model).filter((todo) => todo === SNIPPET_TODO).length, 1, label);
    assert.equal(snippetOf(model)?.components, undefined, label);
  }
});

test('a hand-written parameterised marker is never trusted', () => {
  const { model } = buildUi(appWith(embed(`<div data-zml="component-form:Intake?Name=x"></div>`)));
  assert.equal(snippetOf(model)?.components, undefined);
});

interface Main {
  innerHTML: string;
  querySelector(selector: string): { value?: string } | null;
}

interface Main {
  innerHTML: string;
  querySelector(selector: string): { value?: string } | null;
}

/** The booted app on the snippet's page, with the server render answering `rendered`. */
async function painted(snippet: string, rendered: string) {
  const runtime = (await loadRuntime()) as Runtime & { boot(model: unknown, doc: unknown): Promise<void> };
  const { model } = buildUi(appWith(snippet));
  assert.deepEqual(snippetTodos(model), []);
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', { url: 'http://localhost/app/index.html#/page/Outer' });
  const bodies: Record<string, unknown>[] = [];
  (dom.window as unknown as { fetch: unknown }).fetch = async (url: string, init?: { body?: string }) => {
    if (url.includes('htmlpages')) return { status: 200, ok: true, json: async () => ({ html: rendered }), text: async () => JSON.stringify({ html: rendered }) };
    if (init?.body) bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return { status: 200, ok: true, json: async () => ({ rows: [] }), text: async () => '{"rows":[]}' };
  };
  await runtime.boot(model, dom.window.document);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const main = (dom.window.document as unknown as { getElementById(id: string): Main }).getElementById('main');
  return { main, model, bodies };
}

test('a form marker prefills the declared field with the decoded value', async () => {
  const snippet = embed(FORM_TAG('zc_Header=false&amp;Name=<%=row.Name%>'));
  const { main } = await painted(snippet, `<div data-zml="component-form:Intake:untitled?Name=Ann+%26+Co%3D%22%3Cb%3E"></div>`);
  const input = main.querySelector('form[data-form="Intake"] [name="Name"]');
  assert.ok(input, main.innerHTML);
  assert.equal(input.value, 'Ann & Co="<b>');
});

test('a report marker filters the rows query by the decoded value', async () => {
  const snippet = embed(REPORT_TAG('zc_Header=false&amp;Name=<%=row.Name%>'));
  const { main, bodies } = await painted(snippet, `<div data-zml="component-report:All_Rows:untitled?Name=Ann+Lee"></div>`);
  assert.ok(main.querySelector('section[data-report="All_Rows"]'), main.innerHTML);
  const query = bodies.find((body) => body.op === 'query');
  assert.ok(query, JSON.stringify(bodies));
  assert.deepEqual(query.filters, [{ field: 'Name', op: '==', value: 'Ann Lee' }]);
});

test('a marker whose keys the snippet did not declare is never filled', async () => {
  const snippet = embed(FORM_TAG('Name=<%=row.Name%>'));
  const hostile = [
    `<div data-zml="component-form:Intake?Status=x"></div>`,
    `<div data-zml="component-form:Intake?Name=x&Status=y"></div>`,
    `<div data-zml="component-form:Intake?Name=x&Name=y"></div>`,
    `<div data-zml="component-form:Intake?__proto__=x"></div>`,
    `<div data-zml="component-form:Intake"></div>`,
    `<div data-zml="component-form:Intake?Name=%E0%A4%A"></div>`,
  ];
  for (const html of hostile) {
    const { main } = await painted(snippet, html);
    assert.equal(main.querySelector('form[data-form="Intake"]'), null, html);
  }
});

test('a hostile value stays one literal filter value', async () => {
  const snippet = embed(REPORT_TAG('Name=<%=row.Name%>'));
  const value = encodeURIComponent('x&Status=closed&Name_op=1#').replace(/%20/g, '+');
  const { bodies } = await painted(snippet, `<div data-zml="component-report:All_Rows?Name=${value}"></div>`);
  const query = bodies.find((body) => body.op === 'query');
  assert.deepEqual(query?.filters, [{ field: 'Name', op: '==', value: 'x&Status=closed&Name_op=1#' }]);
});

test('a page parameter of the embedding page may fill an embed field', () => {
  const tag = FORM_TAG('Name=<%=input.searchKey%>');
  const body = `htmlpage Outer1()\ncontent\n<%{ %>${tag}<% }%>`;
  const { model } = buildUi(appWith(body, 'page Outer(searchKey)'));
  assert.deepEqual(snippetTodos(model), []);
  assert.deepEqual(snippetOf(model)?.components, [{ kind: 'form', name: 'Intake', params: ['Name'] }]);
  // The same read of a name no declaration holds stays counted.
  const other = buildUi(appWith(`htmlpage Outer1()\ncontent\n<%{ %>${FORM_TAG('Name=<%=input.missing%>')}<% }%>`, 'page Outer(searchKey)'));
  assert.equal(snippetOf(other.model)?.components, undefined);
});

test('an iframe whose src follows a quoted attribute without a space is read like the browser reads it', () => {
  const app = (src: string) => deriveIr(parse(`application "Demo"
{
	section Front
	{
		page Inner(who)
		{
			Content=${JSON.stringify("<zml><layout><panel><text value='x'/></panel></layout></zml>")}
		}
		page Outer(who)
		{
			Content=${JSON.stringify(`<zml><layout><row><column width='100%'><dsp id='Outer1'><![CDATA[htmlpage Outer1()\ncontent\n<%{ %><iframe name='f' style="border:none;"src='<%=zoho.appuri%>view-embed/Inner?who=<%=input.who%>' ></iframe><% }%>${src}]]></dsp></column></row></layout></zml>`)}
		}
	}
}
`));
  const { model } = buildUi(app(''));
  assert.deepEqual(snippetTodos(model), []);
  assert.deepEqual(snippetOf(model)?.includes, ['Inner?who=@who']);
});

const REPORT_FLAGS = 'zc_Header=false&amp;zc_Footer=false&amp;zc_SecHeader=false&amp;zc_AddRec=false&amp;zc_EditRec=false&amp;zc_DelRec=true&amp;zc_DuplRec=false&amp;zc_EditBulkRec=false&amp;zc_Filter=false&amp;zc_Search=false&amp;zc_SumRow=false&amp;zc_ColMenu=false&amp;zc_Summary=false&amp;zc_RecSelect=false&amp;zc_SaveRec=false';

test('report display flags that hide controls ride on the marker, beside a filter', () => {
  const { model } = buildUi(appWith(embed(REPORT_TAG(`Name=<%=row.Name%>&amp;${REPORT_FLAGS}`))));
  assert.deepEqual(snippetTodos(model), []);
  const el = snippetOf(model);
  assert.deepEqual(el?.components, [{ kind: 'report', name: 'All_Rows', params: ['Name'] }]);
  assert.match(el?.html ?? '', /data-zml="component-report:All_Rows:untitled:hide-add-bulk-edit-filter-pages-search-select\?Name="/);
});

test('display flags the generated view cannot honor stay counted', () => {
  const cases = [
    REPORT_TAG('zc_AddRec=maybe'),
    REPORT_TAG('zc_AddRec'),
    REPORT_TAG('zc_Unknown=false'),
    REPORT_TAG('zc_AddRec=false&amp;zc_AddRec=true'),
    FORM_TAG('zc_AddRec=false'),
    FORM_TAG('zc_Search=false'),
  ];
  for (const tag of cases) {
    const { model } = buildUi(appWith(embed(tag)));
    assert.equal(snippetOf(model)?.components, undefined, tag);
  }
});

test('a marker hides only the controls it names, and an unknown name hides nothing', async () => {
  const snippet = embed(REPORT_TAG(`Name=<%=row.Name%>&amp;zc_AddRec=false&amp;zc_Search=false`));
  const { main } = await painted(snippet, `<div data-zml="component-report:All_Rows:hide-add-search?Name=Ann"></div>`);
  const slot = main.querySelector('[data-zml^="component-report:"]') as unknown as { getAttribute(name: string): string | null } | null;
  assert.equal(slot?.getAttribute('data-embed-hide'), 'add search');
  const odd = await painted(snippet, `<div data-zml="component-report:All_Rows:hide-add-script?Name=Ann"></div>`);
  const slot2 = odd.main.querySelector('[data-zml^="component-report:"]') as unknown as { getAttribute(name: string): string | null } | null;
  assert.equal(slot2?.getAttribute('data-embed-hide'), 'add');
  const proto = await painted(snippet, `<div data-zml="component-report:All_Rows:hide-__proto__?Name=Ann"></div>`);
  assert.equal(proto.main.querySelector('section[data-report]'), null, 'a marker that does not parse is not drawn');
});

test('a lookup field is refused as an embed key: the value is display text, the column holds a row id', () => {
  for (const tag of [FORM_TAG('Parent=<%=row.Name%>'), REPORT_TAG('Parent=<%=row.Name%>'), REPORT_TAG('Parent=open')]) {
    const { model } = buildUi(appWith(embed(tag)));
    assert.equal(snippetOf(model)?.components, undefined, tag);
    assert.equal(snippetTodos(model).length, 1, tag);
  }
});
