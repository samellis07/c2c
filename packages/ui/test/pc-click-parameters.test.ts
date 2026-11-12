/**
 * Page `<pc action="OpenReport">` parameters compile only when every field
 * exists on the target form and the URL (or `Field is ${zoho.currentdate}`)
 * shape is one the report endpoint can apply.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { criteriaHasRelative } from '../../shims/src/criteria.js';
import { generateUi, type UiElement, type UiModel } from '../src/index.js';
import { pcClickHref, pcClickParameters, type PcClick } from '../src/click-parameters.js';

function names(...fields: string[]): Set<string> {
  return new Set(fields);
}

function field(name: string, type: string, extra = ''): string {
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${name}\n\t\t(\n${lines}\n\t\t)`;
}

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function findPc(elements: readonly UiElement[]): UiElement | undefined {
  for (const el of elements) {
    if (el.tag.toLowerCase() === 'pc') return el;
    const nested = findPc(el.children);
    if (nested) return nested;
  }
  return undefined;
}

function pcs(model: UiModel): UiElement[] {
  const out: UiElement[] = [];
  const walk = (el: UiElement) => {
    if (el.tag.toLowerCase() === 'pc') out.push(el);
    el.children.forEach(walk);
  };
  for (const page of model.pages) page.elements.forEach(walk);
  return out;
}

test('corpus pc parameter strings compile only when the field exists', () => {
  const status = pcClickParameters('Status=Estimation', names('Status'));
  assert.equal(status?.mode, 'equality');
  assert.deepEqual(status?.equality, { field: 'Status', value: 'Estimation' });
  assert.equal(status?.label, 'c2c-click:Status == "Estimation"');
  assert.equal(pcClickHref('Sales_Report', 'Status=Estimation', status as PcClick), '#/report/Sales_Report?Status=Estimation');

  const event = pcClickParameters('Event_Status=Active', names('Event_Status'));
  assert.equal(event?.mode, 'equality');
  assert.deepEqual(event?.equality, { field: 'Event_Status', value: 'Active' });

  const month = pcClickParameters('Date_field_op=45', names('Date_field'));
  assert.equal(month?.mode, 'named');
  assert.equal(month?.equality, undefined);
  assert.equal(month?.label, 'c2c-click:Date_field in this month');
  assert.equal(criteriaHasRelative(month!.criteria), true);
  assert.deepEqual(month?.criteria, { op: 'in', field: 'Date_field', value: { __rel: 'this month' } });
  assert.equal(
    pcClickHref('All_Incomes', 'Date_field_op=45', month as PcClick).includes('Date_field_op=45'),
    true,
  );
  assert.match(pcClickHref('All_Incomes', 'Date_field_op=45', month as PcClick), /filter=c2c-click%3A/);

  const expiry = pcClickParameters('Expiry_Date=${zoho.currentdate}', names('Expiry_Date'));
  assert.equal(expiry?.mode, 'named');
  assert.equal(expiry?.label, 'c2c-click:Expiry_Date == zoho.currentdate');
  assert.deepEqual(expiry?.criteria, { op: '==', field: 'Expiry_Date', value: { __rel: 'today', day: true } });

  assert.equal(pcClickParameters('From is ${zoho.currentdate}', names('From_Time_With_Date')), null);
  const today = pcClickParameters('From is ${zoho.currentdate}', names('From'));
  assert.equal(today?.mode, 'named');
  assert.equal(today?.label, 'c2c-click:From is zoho.currentdate');

  assert.equal(pcClickParameters('Delivery=Door%20Delivery', names('Delivery_Type')), null);
  const door = pcClickParameters('Delivery=Door%20Delivery', names('Delivery'));
  assert.equal(door?.mode, 'equality');
  assert.deepEqual(door?.equality, { field: 'Delivery', value: 'Door Delivery' });

  assert.equal(pcClickParameters('Status == "Open"', names('Status')), null);
  assert.equal(pcClickParameters('Owner=${invoice_ID}', names('Owner')), null);
  assert.equal(pcClickParameters('Status_op=99', names('Status')), null);
  assert.equal(pcClickParameters('Note=say"hi', names('Note')), null);
});

const PAGE = `<zml><layout>
<pc action='OpenReport' componentLinkName='Sales_Report' parameters='Status=Estimation'></pc>
<pc action='OpenReport' componentLinkName='All_Incomes' parameters='Date_field_op=45'></pc>
<pc action='OpenReport' componentLinkName='All_Incomes' parameters='Date_field_op=45'></pc>
<pc action='OpenReport' componentLinkName='All_Subscriptions' parameters='Expiry_Date=\${zoho.currentdate}'></pc>
<pc action='OpenReport' componentLinkName='All_Events_List' parameters='Event_Status=Active'></pc>
<pc action='OpenReport' componentLinkName='Upcoming_Bookings' parameters='From is \${zoho.currentdate}'></pc>
<pc action='OpenReport' componentLinkName='In_Process' parameters='Delivery=Door%20Delivery'></pc>
</layout></zml>`;

const BODY = `\tsection Main
\t{
\t\tform Add_Sales
\t\t{
${field('Status', 'radiobuttons', '\t\t\tvalues = {"Estimation","Invoice"}')}
${field('Date_field', 'date')}
${field('Expiry_Date', 'date')}
${field('Event_Status', 'radiobuttons', '\t\t\tvalues = {"Active","Ended"}')}
\t\t}
\t\tlist Sales_Report
\t\t{
\t\t\tshow all rows from Add_Sales
\t\t}
\t\tlist All_Incomes
\t\t{
\t\t\tshow all rows from Add_Sales
\t\t}
\t\tlist All_Subscriptions
\t\t{
\t\t\tshow all rows from Add_Sales
\t\t}
\t\tlist All_Events_List
\t\t{
\t\t\tshow all rows from Add_Sales
\t\t}
\t\tlist Upcoming_Bookings
\t\t{
\t\t\tshow all rows from Add_Sales
\t\t}
\t\tlist In_Process
\t\t{
\t\t\tshow all rows from Add_Sales
\t\t}
\t}
\tpages
\t{
\t\tpage Sales_Details
\t\t{
\t\t\tContent=${JSON.stringify(PAGE)}
\t\t}
\t}`;

test('a page wires field-backed pc clicks and leaves unknown fields as manual steps', () => {
  const { model, files } = generateUi(appOf(BODY));
  const linked = pcs(model);
  assert.equal(linked.length, 7);
  const byName = new Map(linked.map((el) => [el.name, el]));
  assert.equal(byName.get('Sales_Report')?.href, '#/report/Sales_Report?Status=Estimation');
  assert.equal(byName.get('All_Events_List')?.href, '#/report/All_Events_List?Event_Status=Active');
  assert.match(byName.get('All_Incomes')?.href ?? '', /^#\/report\/All_Incomes\?Date_field_op=45&filter=c2c-click%3A/);
  assert.match(byName.get('All_Subscriptions')?.href ?? '', /^#\/report\/All_Subscriptions\?Expiry_Date=\$\{zoho\.currentdate\}&filter=/);
  assert.equal(byName.get('Upcoming_Bookings')?.href, '#/report/Upcoming_Bookings');
  assert.equal(byName.get('In_Process')?.href, '#/report/In_Process');
  const reasons = model.todos.filter((todo) => /click parameters/.test(todo.reason)).map((todo) => todo.name).sort();
  assert.deepEqual(reasons, ['Sales_Details.In_Process', 'Sales_Details.Upcoming_Bookings']);
  for (const todo of model.todos.filter((item) => /click parameters/.test(item.reason))) {
    assert.match(todo.manualStep ?? '', new RegExp(`Sales_Details.*${todo.name.split('.')[1]}`));
  }

  const sourceOf = (report: string) => {
    const file = files.find((item) => item.path === `functions/reports/${report}.mjs`);
    assert.ok(file, report);
    return String(file.data);
  };
  const incomes = sourceOf('all-incomes');
  assert.equal(incomes.split('c2c-click:Date_field in this month').length - 1, 1);
  assert.match(incomes, /bindRelativeCriteria/);
  const expiry = sourceOf('all-subscriptions');
  assert.match(expiry, /c2c-click:Expiry_Date == zoho\.currentdate/);
  assert.match(expiry, /bindRelativeCriteria/);
  assert.equal(sourceOf('sales-report').includes('c2c-click:'), false);
  assert.equal(sourceOf('sales-report').includes('bindRelativeCriteria'), false);
  assert.equal(sourceOf('all-events-list').includes('c2c-click:'), false);
  assert.equal(findPc([]), undefined);
});

interface Runtime {
  boot(model: UiModel, doc: Document): Promise<void>;
  reportClickFilter(hash: string): '' | string | { field: string; value: string };
}

async function loadRuntime(): Promise<Runtime> {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as Runtime;
}

const reportModel = {
  name: 'Demo',
  nav: [{ name: 'Menu', hidden: false, items: [{ kind: 'report', name: 'R', label: 'R', href: '#/report/R' }] }],
  pages: [],
  forms: [],
  reports: [
    {
      name: 'R',
      label: 'R',
      status: 'generated',
      view: 'list',
      queryEndpoint: '/reports/R',
      pageSize: 1,
      columns: [{ field: 'Status', label: 'Status' }],
      filters: [{ label: 'Open' }],
      sort: [],
      groupBy: [],
      customActions: [],
      detail: false,
    },
  ],
} as unknown as UiModel;

function setup(hash: string) {
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>', {
    url: `http://localhost/slate/index.html${hash}`,
  }).window as unknown as { document: Document; fetch: typeof fetch; Event: typeof Event };
  const calls: { body: Record<string, unknown> }[] = [];
  win.fetch = (async (_url: string, init: { body: string }) => {
    calls.push({ body: JSON.parse(init.body) as Record<string, unknown> });
    return { ok: true, status: 200, json: async () => ({ rows: [{ ROWID: '1', Status: 'Estimation' }] }) };
  }) as unknown as typeof fetch;
  return { win, doc: win.document, calls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('a report click filter is posted on the first load and on the next page', async () => {
  (globalThis as { CSS?: { escape(value: string): string } }).CSS ??= { escape: (value: string) => value };
  const runtime = await loadRuntime();
  assert.deepEqual(runtime.reportClickFilter('#/report/R?Status=Estimation'), { field: 'Status', value: 'Estimation' });
  assert.equal(
    runtime.reportClickFilter('#/report/R?Date_field_op=45&filter=c2c-click%3ADate_field%20in%20this%20month'),
    'c2c-click:Date_field in this month',
  );
  const { win, doc, calls } = setup('#/report/R?Status=Estimation');
  await runtime.boot(reportModel, doc);
  await settle();
  const queries = () => calls.filter((call) => call.body.op === 'query');
  assert.equal(queries().length >= 1, true);
  assert.deepEqual(queries()[0]?.body.filter, { field: 'Status', value: 'Estimation' });
  const next = doc.querySelector('[data-next]') as HTMLButtonElement | null;
  assert.ok(next);
  next.dispatchEvent(new win.Event('click', { bubbles: true }));
  await settle();
  assert.equal(queries().length >= 2, true);
  assert.equal(queries()[1]?.body.page, 1);
  assert.deepEqual(queries()[1]?.body.filter, { field: 'Status', value: 'Estimation' });
});

test('a named click filter is posted, and a dropdown label replaces it', async () => {
  (globalThis as { CSS?: { escape(value: string): string } }).CSS ??= { escape: (value: string) => value };
  const runtime = await loadRuntime();
  const hash = '#/report/R?Date_field_op=45&filter=c2c-click%3ADate_field%20in%20this%20month';
  const { win, doc, calls } = setup(hash);
  await runtime.boot(reportModel, doc);
  await settle();
  const queries = () => calls.filter((call) => call.body.op === 'query');
  assert.equal(queries()[0]?.body.filter, 'c2c-click:Date_field in this month');
  const select = doc.querySelector('select[data-filter]') as HTMLSelectElement;
  assert.ok(select);
  select.value = 'Open';
  select.dispatchEvent(new win.Event('change', { bubbles: true }));
  await settle();
  assert.equal(queries().at(-1)?.body.filter, 'Open');
  select.value = '';
  select.dispatchEvent(new win.Event('change', { bubbles: true }));
  await settle();
  assert.equal(queries().at(-1)?.body.filter, 'c2c-click:Date_field in this month');
});
