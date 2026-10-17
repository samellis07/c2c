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
  'Foreign Host': ['Foreign_Host', `openUrl("https://elsewhere.example" + zoho.appuri + "#Form:Request","popup window");`],
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
  assert.deepEqual(byName.get('Go Home')?.navigate, { kind: 'page', target: 'Home', href: '#/page/Home', params: [] });
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
  ]);
  // Row 8's Name is not on the row (the caller cannot read it): no Note prefill.
  assert.deepEqual(links(second!), [
    'Request It #/form/Request?Item_Ref=8',
    'Note It #/form/Request?Kind=Loan',
    'New Request #/form/Request',
    'Go Home #/page/Home',
    'Open Secret #/form/Secret?Item_Ref=8',
    'By Holder #/form/Request',
  ]);
  // Counted actions draw no link.
  assert.doesNotMatch(rows, /External|Mixed|Computed|Filtered Report/);
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
