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
    ['an input that the page does not declare', REPORT_TAG('Name=<%=input.other%>')],
    ['an island in the key', REPORT_TAG('<%=row.Name%>=x')],
    ['an island in another attribute', `<div elName='zc-component' viewLinkName='All_Rows' title='<%=row.Name%>' params='Name=<%=row.Name%>'></div>`],
    ['a repeated params attribute', `<div elName='zc-component' viewLinkName='All_Rows' params='Name=<%=row.Name%>' params='Status=<%=row.Status%>'></div>`],
    ['an unknown component', `<div elName='zc-component' viewLinkName='Nope' params='Name=<%=row.Name%>'></div>`],
    ['an island joined to text outside the encoded space', REPORT_TAG('Name=<%=row.Name%>%2F<%=row.Status%>')],
    ['a lone island that is not a bare read', REPORT_TAG('Name=<%=row.Name%>&amp;<%=row.Status + "x"%>')],
    ['a lone word with no value', REPORT_TAG('Name=<%=row.Name%>&amp;Status')],
    ['an island holding a quote', REPORT_TAG(`Name=<%=row["Name"]%>`)],
  ];
  for (const [label, tag] of cases) {
    const { model } = buildUi(appWith(embed(tag)));
    assert.deepEqual(snippetTodos(model).filter((todo) => todo === SNIPPET_TODO).length, 1, label);
    assert.equal(snippetOf(model)?.components, undefined, label);
  }
});

test('a form prefill key that names no field fills nothing and leaves the embed otherwise intact', () => {
  const { model } = buildUi(appWith(embed(FORM_TAG('zc_Header=false&amp;Date1=<%=input.who%>&amp;Name=<%=row.Name%>'))));
  assert.deepEqual(snippetTodos(model), []);
  const el = snippetOf(model);
  assert.deepEqual(el?.components, [{ kind: 'form', name: 'Intake', params: ['Name'] }]);
  assert.doesNotMatch(el?.html ?? '', /Date1/);
  const alone = buildUi(appWith(embed(FORM_TAG('Date1=<%=input.who%>'))));
  assert.deepEqual(snippetTodos(alone.model), []);
  assert.deepEqual(snippetOf(alone.model)?.components, [{ kind: 'form', name: 'Intake' }]);
});

test('attack: a prefill key that names no field is still refused when its value is not a bounded literal or a bare read', () => {
  for (const value of ['<%=row.Name + "x"%>', '<%=row.Name.toUpperCase()%>', '<%=input.other%>', 'a b', 'x%26y', 'a<%=row.Name%>']) {
    const { model } = buildUi(appWith(embed(FORM_TAG(`Date1=${value}`))));
    assert.equal(snippetOf(model)?.components, undefined, value);
  }
  for (const key of ['__proto__', 'constructor', 'zc_Unknown', '<%=row.Name%>']) {
    const { model } = buildUi(appWith(embed(FORM_TAG(`${key}=x`))));
    assert.equal(snippetOf(model)?.components, undefined, key);
  }
  const repeated = buildUi(appWith(embed(FORM_TAG('Date1=x&amp;date1=y'))));
  assert.equal(snippetOf(repeated.model)?.components, undefined, 'a repeated unknown key');
  const report = buildUi(appWith(embed(REPORT_TAG('Date1=x'))));
  assert.equal(snippetOf(report.model)?.components, undefined, 'a report filter on a key that is no field would show more records');
});

test('an ampersand reference written without its semicolon reads as an ampersand before another one', () => {
  const { model } = buildUi(appWith(embed(FORM_TAG('zc_Header=false&amp&Name=<%=row.Name%>'))));
  assert.deepEqual(snippetTodos(model), []);
  assert.deepEqual(snippetOf(model)?.components, [{ kind: 'form', name: 'Intake', params: ['Name'] }]);
  // Before a letter or `=` the reference stays text: `&ampName` is the key `ampName`, not `&Name`.
  const text = buildUi(appWith(embed(FORM_TAG('Name=a&ampName=<%=row.Name%>'))));
  assert.deepEqual(snippetOf(text.model)?.components, [{ kind: 'form', name: 'Intake', params: ['Name'] }]);
  assert.match(snippetOf(text.model)?.html ?? '', /data-zml="component-form:Intake\?Name=a"/);
  const dangling = buildUi(appWith(embed(FORM_TAG('Name=a&amp'))));
  assert.equal(snippetOf(dangling.model)?.components, undefined, 'a trailing reference with nothing after it is no parameter');
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
async function painted(snippet: string, rendered: string, build: (snippet: string) => App = appWith) {
  const runtime = (await loadRuntime()) as Runtime & { boot(model: unknown, doc: unknown): Promise<void> };
  const { model } = buildUi(build(snippet));
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

test('a form embed never takes a lookup field as a key: prefilling a picklist from display text picks no provable option', () => {
  for (const tag of [FORM_TAG('Parent=<%=row.Name%>'), FORM_TAG('Parent=open')]) {
    const { model } = buildUi(appWith(embed(tag)));
    assert.equal(snippetOf(model)?.components, undefined, tag);
    assert.equal(snippetTodos(model).length, 1, tag);
  }
});

test('a report embed filters a lookup field by its display text through the lookup path', () => {
  const { model } = buildUi(appWith(embed(REPORT_TAG('zc_Header=false&amp;Parent=<%=row.Name%>&amp;Status=open'))));
  assert.deepEqual(snippetTodos(model), []);
  const el = snippetOf(model);
  assert.deepEqual(el?.components, [{ kind: 'report', name: 'All_Rows', params: ['Parent.Name', 'Status'] }]);
  assert.match(el?.html ?? '', /data-zml="component-report:All_Rows:untitled\?Parent\.Name=[^"]*Status=open"/);
  const literal = snippetOf(buildUi(appWith(embed(REPORT_TAG('Parent=open')))).model);
  assert.deepEqual(literal?.components, [{ kind: 'report', name: 'All_Rows', params: ['Parent.Name'] }]);
});

test('a lookup key written as a path, repeated, or beside its own path stays counted', () => {
  for (const tag of [REPORT_TAG('Parent.Name=<%=row.Name%>'), REPORT_TAG('Parent=<%=row.Name%>&amp;parent=<%=row.Status%>')]) {
    const { model } = buildUi(appWith(embed(tag)));
    assert.equal(snippetOf(model)?.components, undefined, tag);
    assert.equal(snippetTodos(model).length, 1, tag);
  }
});

test('a report marker filters a lookup by the display text on the lookup path', async () => {
  const snippet = embed(REPORT_TAG('zc_Header=false&amp;Parent=<%=row.Name%>'));
  const { main, bodies } = await painted(snippet, `<div data-zml="component-report:All_Rows:untitled?Parent.Name=Ann+Lee"></div>`);
  assert.ok(main.querySelector('section[data-report="All_Rows"]'), main.innerHTML);
  const query = bodies.find((body) => body.op === 'query');
  assert.ok(query, JSON.stringify(bodies));
  assert.deepEqual(query.filters, [{ field: 'Parent.Name', op: '==', value: 'Ann Lee' }]);
});

test('a marker naming a path the snippet did not declare is never filled', async () => {
  const snippet = embed(REPORT_TAG('Parent=<%=row.Name%>'));
  for (const query of ['Parent.Status=x', 'Parent.Name.Status=x', 'Parent.=x', '.Name=x', 'Parent.Name=x&Parent.Name=y', 'Parent.__proto__=x', 'Name=x']) {
    const { main } = await painted(snippet, `<div data-zml="component-report:All_Rows?${query}"></div>`);
    assert.equal(main.querySelector('section[data-report="All_Rows"]'), null, query);
  }
});

/** A report over a form whose lookup shows `format` of the Accounts form instead of its link field. */
function lookupApp(format: string, snippet: string): App {
  const zml = `<zml><layout><row><column width='100%'><dsp id='Outer1'><![CDATA[${snippet}]]></dsp></column></row></layout></zml>`;
  return deriveIr(parse(`application "Demo"
{
	section Front
	{
form Accounts
{
  Account_Name
  (
    type = text
  )
  First
  (
    type = text
  )
  Last
  (
    type = text
  )
}
form Calls
{
  Subject
  (
    type = text
  )
  Account
  (
    type = picklist
    values = Accounts.ID
    displayformat = ${format}
  )
}
report All_Calls
{
  show all rows from Calls
  (
    Subject
    Account
  )
}
		page Outer
		{
			Content=${JSON.stringify(zml)}
		}
	}
}
`));
}

const CALLS_TAG = `<div elName='zc-component' viewLinkName='All_Calls' params='Account=<%=row.Account_Name%>'>Loading...</div>`;
const callsEmbed = `htmlpage Outer1(who)\ncontent\n<%{\n\trow = Accounts[Account_Name == input.who];\n%>\n${CALLS_TAG}\n<% }%>`;

test('a lookup shown through a one-field displayformat filters on that target field', () => {
  const { model } = buildUi(lookupApp('[Account_Name]', callsEmbed));
  assert.deepEqual(snippetTodos(model), []);
  assert.deepEqual(snippetOf(model)?.components, [{ kind: 'report', name: 'All_Calls', params: ['Account.Account_Name'] }]);
});

test('a lookup shown through text built from several stored fields filters on that text', () => {
  for (const format of ['[First + " " + Last]', '["Acct " + Account_Name]']) {
    const { model } = buildUi(lookupApp(format, callsEmbed));
    assert.deepEqual(snippetTodos(model), [], format);
    assert.deepEqual(snippetOf(model)?.components, [{ kind: 'report', name: 'All_Calls', params: ['Account:display'] }], format);
    assert.match(snippetOf(model)?.html ?? '', /data-zml="component-report:All_Calls\?Account:display="/, format);
  }
});

test('a lookup whose text reads a field the target form lacks stays counted', () => {
  for (const format of ['[Missing]', '[Account_Name.first]', '[First + Missing]']) {
    const { model } = buildUi(lookupApp(format, callsEmbed));
    assert.equal(snippetOf(model)?.components, undefined, format);
    assert.equal(snippetTodos(model).length, 1, format);
  }
});

test('a form embed never takes a displayed-text lookup as a key', () => {
  const tag = `<div elName='zc-component' formLinkName='Calls' params='Account=<%=row.Account_Name%>'>Loading...</div>`;
  const { model } = buildUi(lookupApp('[First + " " + Last]', `htmlpage Outer1(who)\ncontent\n<%{\n\trow = Accounts[Account_Name == input.who];\n%>\n${tag}\n<% }%>`));
  assert.equal(snippetOf(model)?.components, undefined);
  assert.equal(snippetTodos(model).length, 1);
});

test('a displayed-text marker filters the rows query on the lookup by the decoded text', async () => {
  const build = (snippet: string) => lookupApp('[First + " " + Last]', snippet);
  const { main, bodies } = await painted(callsEmbed, `<div data-zml="component-report:All_Calls?Account:display=Ann+Lee"></div>`, build);
  assert.ok(main.querySelector('section[data-report="All_Calls"]'), main.innerHTML);
  const query = bodies.find((body) => body.op === 'query');
  assert.ok(query, JSON.stringify(bodies));
  assert.deepEqual(query.filters, [{ field: 'Account', op: 'display', value: 'Ann Lee' }]);
  for (const hostile of ['Account:display=x&Account:display=y', 'Other:display=x', 'Account:displays=x', 'Account:display.Name=x']) {
    const refused = await painted(callsEmbed, `<div data-zml="component-report:All_Calls?${hostile}"></div>`, build);
    assert.equal(refused.main.querySelector('section[data-report="All_Calls"]'), null, hostile);
  }
});
