/**
 * Screen fidelity: generated screens match the app's own look.
 *
 *  - Developer notes (storage and read internals) never reach the page.
 *  - An unnamed section draws no heading.
 *  - The exported theme drives the shell palette and menu style.
 *  - Menu entries draw icons, not icon names; system sections hide.
 *  - Home lands on the first menu target instead of restating the menu.
 *  - Controls carry Creator wording: -Select-, date placeholders, currency
 *    add-ons, Select Image, centred Add New, subform asterisks.
 *  - Install stays hidden unless the app runs installed.
 *  - A report with no data endpoint shows the empty state, not an error.
 *  - Dashboard KPI cells resolve to values and snippets stay markup.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { parseZml } from '../../core/src/zml.js';
import { clientRuntimeSource } from '../src/generate.js';
import { buildModel, type UiModel } from '../src/model.js';
import { buildUi, elementsFromZml } from '../src/index.js';

function appOf(source: string): App {
  return deriveIr(parse(source));
}

interface Client {
  boot(model: UiModel, doc: unknown): Promise<void>;
  renderForm(form: UiModel['forms'][number]): string;
  renderReport(report: UiModel['reports'][number]): string;
  renderNav(model: UiModel): string;
  renderRoute(model: UiModel, route: { name: string; id?: string }): string;
}

async function loadClient(): Promise<Client> {
  const source = clientRuntimeSource();
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as Client;
}

function dom(html: string, url = 'http://127.0.0.1/slate/index.html#/') {
  return new JSDOM(html, { url });
}

interface Doc {
  querySelector(selector: string): {
    textContent: string | null;
    className: string;
    getAttribute(name: string): string | null;
    querySelector(selector: string): DocEl | null;
  } | null;
  querySelectorAll(selector: string): ArrayLike<DocEl>;
  getElementById(id: string): DocEl | null;
}

interface DocEl {
  textContent: string | null;
  className: string;
  hidden?: boolean;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DocEl | null;
  querySelectorAll(selector: string): ArrayLike<DocEl>;
}

function shell(_hash: string): string {
  return `<!doctype html><html><body>
<header class="topbar"><button id="menu-toggle" type="button">Menu</button><strong id="app-title"></strong><button id="install" hidden type="button">Install app</button></header>
<div class="shell"><nav id="nav"></nav><main id="main"></main></div>
<div id="toasts"></div>
</body></html>`;
}

const PO_APP = `application "Purchase Orders"
{
	date format = "dd-MMM-yyyy"
	time zone = "Asia/Kolkata"
	section Main
	{
		form Vendor
		{
			displayname = "Vendor"
			must have Vendor_Name
			(
				type = text
			)
		}
		form Purchase_Order
		{
			displayname = "Purchase Order"
			Section
			(
				type = section
			)
			must have PO_Title
			(
				type = text
			)
			must have Purchase_Date
			(
				type = date
			)
			must have Vendor
			(
				type = picklist
				values = Vendor.ID
				displayformat = [Vendor_Name]
			)
			Unit_Price
			(
				type = USD
			)
			Status
			(
				type = picklist
				values = {"Open","Closed"}
				initial value = "Open"
			)
			Logo
			(
				type = image
			)
			Product_Description
			(
				type = textarea
			)
			Other_Details
			(
				type = section
				displayname = "Other details"
			)
			Notes
			(
				type = textarea
			)
			must have Line_Items
			(
				type = grid
				must have Qty
				(
					type = number
				)
				Item
				(
					type = text
				)
			)
		}
		list All_Purchase_Orders
		{
			displayname = "All Purchase Orders"
			show all rows from Purchase_Order
			(
				PO_Title
			)
		}
	}
	web
	{
		menu
		{
			space Space
			{
				displayname = "Space"
				section Main
				{
					displayname = "Main"
					icon = "education-book-open"
					form Purchase_Order
					{
						icon = "ui-2-square-add-11"
					}
					report All_Purchase_Orders
					{
						icon = "files-single-copy-04"
					}
				}
				section ZC_App_Preferences
				{
					displayname = "App Preferences"
					systemcomponent
					{
						type = localization
						displayname = "Language Selection"
					}
				}
				section ZC_Approvals
				{
					displayname = "Approvals"
					systemcomponent
					{
						type = approval
						approval status = pending
						displayname = "Pending Tasks"
					}
				}
			}
		}
		customize
		{
			new theme = 3
			font = "lato"
		}
	}
}
`;

const BOM_APP = `application "Bill Of Materials"
{
	section Products
	{
		form Add_Product
		{
			displayname = "Add Product"
			Name
			(
				type = text
			)
		}
	}
	web
	{
		menu
		{
			space Space
			{
				displayname = "Space"
				section Products
				{
					displayname = "Products"
					icon = "design-shape-circle"
					form Add_Product
					{
						icon = "files-add"
					}
				}
			}
		}
		customize
		{
			new theme = 9
			font = "lato"
		}
	}
}
`;

const INV_APP = `application "Inventory"
{
	date format = "dd-MMM-yyyy"
	time zone = "Asia/Kolkata"
	section Products
	{
		form Add_Stock
		{
			displayname = "Add Stock"
			Product_Name
			(
				type = picklist
				values = Form_Products.ID
			)
			Purchased_Date
			(
				type = date
			)
			Warehouse_Code
			(
				type = text
			)
			Qty_Purchased
			(
				type = number
			)
		}
		form Form_Products
		{
			displayname = "Add Products"
			must have Product_Name
			(
				type = text
			)
			must have Add_Stocks
			(
				type = grid
				values = Add_Stock.ID
				bidirectional = Product_Name
			)
		}
		list Report_Stock
		{
			displayname = "Stock Report"
			show all rows from Add_Stock
			(
				Qty_Purchased
			)
		}
		list Report_Sales
		{
			displayname = "Sales Details"
			show all rows from Add_Stock
			(
				Qty_Purchased
			)
		}
		form Add_Firm
		{
			displayname = "Add Firm"
			Firm_Name
			(
				type = text
			)
		}
		summary Firm_Details
		{
			displayname = "Firm Details"
			show all rows from Add_Firm
			(
				Firm_Name
			)
		}
	}
	pages
	{
		page Dashboard
		{
			displayname = "Dashboard"
			Content="<zml><layout><row><column width='50%'><panel><pr width='fill' height='fill'><pc width='50%' action='OpenReport' componentLinkName='Report_Sales' bgColor='#FFFFFF' hAlign='left' vAlign='center' padding='20px' cornerRadius='5px'><pr width='fill' height='fill'><pc width='40%'><pr width='fill' height='fill'><pc width='auto' height='auto'><image type='icon' value='business-chart-bar-33' color='#ffffff' bgColor='#A07E2F' width='52px' height='52px' cornerRadius='26px' size='24px'/></pc></pr></pc><pc width='60%'><pr width='auto' height='auto'><pc width='fill' height='auto'><text type='Form Data' value='thisapp.Add_Stock.Qty_Purchased.sum' criteria='Purchased_Date is today' color='#A07E2F' size='36px'/></pc></pr><pr width='auto' height='auto'><pc width='fill' height='auto'><text type='Text' value='Today Sales' color='#888888' size='14px'/></pc></pr></pc></pr></pc><pc width='50%'><report elementName='Report' linkName='Report_Stock'/></pc></pr></panel></column><column width='50%'><report elementName='Report' linkName='Report_Stock'/></column></row><row><column width='100%'><dsp id='html_snippet'><![CDATA[htmlpage html_snippet()\ncontent\n<%{\n\tgetadmindetails = Add_Firm[ID != 0];\n\tif(getadmindetails.count() == 0)\n\t{\n\t\topenUrl(&quot;#Form:Add_Firm&quot;,&quot;popup window&quot;);\n\t}\n%}>]]></dsp></column></row></layout></zml>"
		}
	}
	web
	{
		menu
		{
			space Space
			{
				displayname = "Space"
				section Dashboard
				{
					displayname = "Dashboard"
					page Dashboard
					{
					}
				}
				section Products
				{
					displayname = "Products"
					form Form_Products
					{
						icon = "business-factory"
					}
				}
			}
		}
		customize
		{
			new theme = 11
			font = "lato"
		}
	}
}
`;

const PO_MODEL = () => buildModel(appOf(PO_APP));
const INV_MODEL = () => buildModel(appOf(INV_APP));

// --- G1: developer notes never reach the screen -----------------------------

test('G1: storage and read internals stay out of rendered form and report copy', async () => {
  const client = await loadClient();
  const model = PO_MODEL();
  const form = model.forms.find((item) => item.name === 'Purchase_Order');
  assert.ok(form);
  const html = client.renderForm(form);
  for (const leak of [/Stratus/, /cross-table transaction/, /enforced on the server/, /multi lookup/, /dry-run/i]) {
    assert.doesNotMatch(html, leak, `${leak} leaked into the form`);
  }
  const report = model.reports.find((item) => item.name === 'All_Purchase_Orders');
  assert.ok(report);
  const rep = client.renderReport(report);
  assert.doesNotMatch(rep, /ZCQL/, 'read internals leaked into the report');
  assert.doesNotMatch(rep, />Page size /, 'paging internals leaked into the report');
});

// --- G2: an unnamed section draws no heading --------------------------------

test('G2: unnamed section draws no heading; a named one draws its name', async () => {
  const client = await loadClient();
  const form = PO_MODEL().forms.find((item) => item.name === 'Purchase_Order');
  assert.ok(form);
  const html = client.renderForm(form);
  assert.doesNotMatch(html, />\s*Section\s*</, 'unnamed section must not render a "Section" heading');
  assert.match(html, /Other details/, 'named section keeps its display name');
});

// --- G3: exported theme maps to palette and menu style -----------------------

test('G3: the exported theme drives the shell palette and menu style', async () => {
  const l1 = PO_MODEL();
  const bom = buildModel(appOf(BOM_APP));
  const inv = INV_MODEL();
  const menuOf = (model: UiModel) => (model.theme as { menu?: string } | undefined)?.menu;
  assert.equal(menuOf(l1), 'list', 'theme 3 is a dark list menu');
  assert.equal(menuOf(bom), 'rail', 'theme 9 is a left icon rail');
  assert.equal(menuOf(inv), 'list', 'theme 11 is a dark list menu');

  const files = new Map(buildUi(appOf(BOM_APP)).files.map((file) => [file.path, String(file.data)]));
  const index = files.get('slate/index.html');
  assert.ok(index);
  assert.match(index, /data-theme="9"/, 'theme id baked into index.html');
  assert.match(index, /data-menu="rail"/, 'menu style baked into index.html');
  const css = [...files.entries()].find(([path]) => /^slate\/assets\/app(\..*)?\.css$/.test(path))?.[1];
  assert.ok(css);
  assert.match(css, /data-theme="9"/, 'theme 9 palette block missing');
  assert.match(css, /data-menu="rail"/, 'rail menu rules missing');
  const l1Files = new Map(buildUi(appOf(PO_APP)).files.map((file) => [file.path, String(file.data)]));
  assert.match(l1Files.get('slate/index.html') ?? '', /data-menu="list"/, 'list menu baked for theme 3');
  const l1Css = [...l1Files.entries()].find(([path]) => /^slate\/assets\/app(\..*)?\.css$/.test(path))?.[1];
  assert.match(l1Css ?? '', /data-theme="3"/, 'theme 3 palette block missing');
  const invFiles = new Map(buildUi(appOf(INV_APP)).files.map((file) => [file.path, String(file.data)]));
  assert.match(invFiles.get('slate/index.html') ?? '', /data-menu="list"/, 'list menu baked for theme 11');
  const invCss = [...invFiles.entries()].find(([path]) => /^slate\/assets\/app(\..*)?\.css$/.test(path))?.[1];
  assert.match(invCss ?? '', /data-theme="11"/, 'theme 11 palette block missing');
  assert.match(invCss ?? '', /--c2c-menu-active-bg:#e71e3a/, 'theme 11 active row carries the accent');
});

// --- G4: menu icons are glyphs, not icon names --------------------------------

test('G4: menu entries render icon glyphs, never raw icon names', async () => {
  const client = await loadClient();
  const view = dom(shell('#/'), 'http://127.0.0.1/slate/index.html#/');
  const doc = view.window.document as unknown as Document;
  await client.boot(buildModel(appOf(BOM_APP)), doc);
  const nav = doc.getElementById('nav');
  assert.ok(nav);
  assert.ok(nav.querySelector('svg'), 'menu icons render as svg glyphs');
  assert.doesNotMatch(nav.textContent ?? '', /design-shape-circle|files-add/, 'icon names stay out of the menu text');
});

// --- G5: system sections hide; home lands on the first menu target ------------

test('G5: system sections stay off the menu but keep their routes', async () => {
  const client = await loadClient();
  const model = PO_MODEL();
  const prefs = (model.nav as { name: string; system?: boolean }[]).find((item) => item.name === 'App Preferences');
  const approvals = (model.nav as { name: string; system?: boolean }[]).find((item) => item.name === 'Approvals');
  assert.equal(prefs?.system, true, 'App Preferences is a system section');
  assert.equal(approvals?.system, true, 'Approvals is a system section');

  const view = dom(shell('#/form/Purchase_Order'), 'http://127.0.0.1/slate/index.html#/form/Purchase_Order');
  const doc = view.window.document as unknown as Document;
  await client.boot(model, doc);
  const text = doc.getElementById('nav')?.textContent ?? '';
  assert.doesNotMatch(text, /App Preferences|Pending Tasks|Approvals/, 'system sections hide from the menu');
  assert.match(text, /Purchase Order|All Purchase Orders/, 'application sections stay');

  const home = client.renderRoute(model, { name: 'home' });
  assert.doesNotMatch(home, /href="#\//, 'home never restates the menu as links');
});

test('G5: opening the app lands on the first menu target', async () => {
  const client = await loadClient();
  const view = dom(shell('#/'), 'http://127.0.0.1/slate/index.html#/');
  const win = view.window as unknown as { location: { hash: string }; document: Document };
  await client.boot(PO_MODEL(), win.document);
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(win.location.hash, '#/form/Purchase_Order', 'home redirects to the first menu item');
});

// --- G6: controls match Creator ----------------------------------------------

test('G6: selects say -Select-, dates carry the app format, money and files show Creator controls', async () => {
  const client = await loadClient();
  const model = PO_MODEL();
  assert.equal((model as { dateFormat?: string }).dateFormat, 'dd-MMM-yyyy', 'the app date format reaches the model');
  const form = model.forms.find((item) => item.name === 'Purchase_Order');
  assert.ok(form);
  const html = client.renderForm(form);
  const page = dom(`<!doctype html><body>${html}</body>`);
  const doc = page.window.document as unknown as Doc;

  const selects = Array.from(doc.querySelectorAll('.field select'));
  assert.ok(selects.length >= 2, 'expected lookup and choice selects');
  for (const select of selects) {
    assert.equal(select.querySelector('option')?.textContent, '-Select-', 'first option is -Select-');
  }
  const date = doc.querySelector('[data-field="Purchase_Date"] input');
  assert.ok(date);
  assert.equal(date.getAttribute('type'), 'text', 'date renders a text control with the app format');
  assert.equal(date.getAttribute('placeholder'), 'dd-MMM-yyyy', 'placeholder is the app date format');
  const money = doc.querySelector('[data-field="Unit_Price"] .money-sym');
  assert.equal(money?.textContent, '$', 'USD field carries a currency add-on');
  const pick = doc.querySelector('[data-field="Logo"] .filepick-btn');
  assert.equal(pick?.textContent, 'Select Image', 'image field shows the picker button');
  assert.equal(doc.querySelector('[data-field="Logo"] input[type="file"]')?.className, 'visually-hidden');
  const status = doc.querySelector('[data-field="Status"] select');
  const selected = status?.querySelector('option[selected]');
  assert.equal(selected?.getAttribute('value'), 'Open', 'the export initial value is the selected option');
});

// --- G7: subform grid matches Creator ------------------------------------------

test('G7: required subform columns carry the star and Add New centres', async () => {
  const client = await loadClient();
  const form = PO_MODEL().forms.find((item) => item.name === 'Purchase_Order');
  assert.ok(form);
  const html = client.renderForm(form);
  assert.match(html, /Qty<span class="req"[^>]*>\s*\*<\/span>/, 'a required column carries the star like a field label');
  assert.match(html, /data-add-row=/, 'Add New control sits below the grid');
  assert.match(html, /\+ Add New/, 'Add New link text');
});

test('G7: a related-form grid renders as a subform grid of the related fields', () => {
  const model = INV_MODEL();
  const form = model.forms.find((item) => item.name === 'Form_Products');
  assert.ok(form);
  const grid = form.fields.find((item) => item.name === 'Add_Stocks');
  assert.ok(grid);
  assert.equal(grid.widget, 'subform', 'a grid over another form is a subform grid');
  const names = (grid.subfields || []).map((sub) => sub.name);
  assert.ok(names.includes('Purchased_Date'), 'related fields become columns');
  assert.ok(names.includes('Qty_Purchased'));
  assert.equal(names.includes('Product_Name'), false, 'the bidirectional back-reference is not a column');
  assert.equal(names.includes('Section'), false, 'section markers are not columns');
});

// --- G8: install stays hidden outside an installed app -------------------------

test('G8: install is hidden in a browser tab even after beforeinstallprompt', async () => {
  const client = await loadClient();
  const view = dom(shell('#/form/Purchase_Order'), 'http://127.0.0.1/slate/index.html#/form/Purchase_Order');
  const doc = view.window.document as unknown as Document;
  await client.boot(PO_MODEL(), doc);
  const install = doc.getElementById('install') as unknown as { hidden: boolean };
  assert.ok(install);
  const win = view.window as unknown as { Event: new (type: string) => Event; dispatchEvent(event: Event): boolean };
  const event = new win.Event('beforeinstallprompt');
  win.dispatchEvent(event);
  assert.equal(install.hidden, true, 'a browser tab never shows the install button');
});

// --- G9: an unavailable report endpoint shows the Creator empty state -----------

test('G9: a report without a data endpoint shows the empty state, live errors retry', async () => {
  const client = await loadClient();
  const model = PO_MODEL();
  const url = 'http://127.0.0.1/slate/index.html#/report/All_Purchase_Orders';
  const build = (fetchImpl: unknown) => {
    const view = dom(shell('#/report/All_Purchase_Orders'), url);
    const win = view.window as unknown as { document: Doc; fetch: unknown };
    win.fetch = fetchImpl;
    return win;
  };
  const preview = build(async () => ({ ok: false, status: 404, text: async () => 'not found' }));
  await client.boot(model, preview.document);
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const state = preview.document.querySelector('[data-state]');
  assert.match(state?.textContent ?? '', /no records/i, 'an unavailable endpoint shows the empty state');
  assert.equal(state?.querySelector('[data-retry]'), null, 'no retry under a static host');

  const live = build(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
  await client.boot(model, live.document);
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const liveState = live.document.querySelector('[data-state]');
  assert.ok(liveState?.querySelector('[data-retry]'), 'a real failure keeps Retry');
});

// --- G10: dashboard KPIs, report embeds, snippets ------------------------------

test('G10: a Form Data cell is a KPI element, not an Unresolved label', () => {
  const model = INV_MODEL();
  const page = model.pages.find((item) => item.name === 'Dashboard');
  assert.ok(page);
  const flat = (els: { children?: unknown[] }[] | undefined, out: { kind: string; text?: string }[] = []) => {
    for (const el of (els || []) as { kind: string; text?: string; children?: unknown[] }[]) {
      out.push(el);
      flat(el.children as { children?: unknown[] }[] | undefined, out);
    }
    return out;
  };
  const elements = flat(page.elements);
  const kpi = elements.find((el) => el.kind === 'kpi') as { kpi?: { form: string; field: string; fn: string }; criteria?: string } | undefined;
  assert.ok(kpi, 'a Form Data text becomes a KPI element');
  assert.deepEqual(kpi?.kpi, { form: 'Add_Stock', field: 'Qty_Purchased', fn: 'sum' });
  assert.equal(kpi?.criteria, 'Purchased_Date is today');
  assert.equal(elements.some((el) => el.text === 'Unresolved'), false, 'no Unresolved label survives');
  const snippet = elements.find((el) => el.kind === 'html') as { html?: string } | undefined;
  assert.equal((snippet?.html ?? '').includes('htmlpage'), false, 'a server-side snippet body never renders');
});

test('G10: the dashboard draws KPI outputs and resolves report embeds', async () => {
  const client = await loadClient();
  const model = INV_MODEL();
  const view = dom(shell('#/page/Dashboard'), 'http://127.0.0.1/slate/index.html#/page/Dashboard');
  const win = view.window as unknown as { document: Doc; fetch: unknown; C2C_APP_TIMEZONE: string };
  win.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  const today = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date())
    .replace(/ /g, '-');
  win.fetch = async (target: string) => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        rows: target.includes('Report_Sales')
          ? [
              { ROWID: '1', Qty_Purchased: '7', Purchased_Date: today },
              { ROWID: '3', Qty_Purchased: '100', Purchased_Date: '01-Jan-2020' },
            ]
          : [{ ROWID: '2', Qty_Purchased: '5' }],
      }),
  });
  await client.boot(model, win.document);
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const article = win.document.querySelector('article[data-page="Dashboard"]');
  assert.ok(article);
  const text = article.textContent ?? '';
  assert.doesNotMatch(text, /Unresolved|htmlpage|thisapp\./, 'no unresolved or raw snippet text');
  const output = article.querySelector('output[data-kpi-fn]');
  assert.ok(output, 'KPI cells render as outputs');
  assert.equal(output?.textContent, '7', 'the KPI reads its report rows');
  const embed = article.querySelector('a[href="#/report/Report_Stock"]');
  assert.match(embed?.textContent ?? '', /Stock Report/, 'report embeds show the report label, not the link name');
});

// --- G11: dashboard tile presentation attributes -------------------------------

test('G11: ZML presentation attributes land as inline styles on tiles', () => {
  const model = INV_MODEL();
  const page = model.pages.find((item) => item.name === 'Dashboard');
  const flat = (els: { children?: unknown[] }[] | undefined, out: { kind: string; style?: Record<string, string> }[] = []) => {
    for (const el of (els || []) as { kind: string; style?: Record<string, string>; children?: unknown[] }[]) {
      out.push(el);
      flat(el.children as { children?: unknown[] }[] | undefined, out);
    }
    return out;
  };
  const elements = flat(page?.elements);
  const number = elements.find((el) => el.kind === 'kpi');
  assert.equal(number?.style?.['font-size'], '36px', 'the KPI number keeps the export size');
  assert.equal(number?.style?.['color'], '#A07E2F', 'the KPI number keeps the export accent');
  const label = elements.find((el) => el.kind === 'text' && el.style?.['color'] === '#888888');
  assert.equal(label?.style?.['font-size'], '14px', 'the label keeps the export size');
  const icon = elements.find((el) => el.kind === 'text' && el.style?.['border-radius'] === '26px');
  assert.equal(icon?.style?.['background-color'], '#A07E2F', 'the icon chip keeps the export fill');
});

test('G11: rendered dashboard tiles carry the export colors and sizes', async () => {
  const client = await loadClient();
  const model = INV_MODEL();
  const view = dom(shell('#/page/Dashboard'), 'http://127.0.0.1/slate/index.html#/page/Dashboard');
  const win = view.window as unknown as { document: Doc; fetch: unknown; C2C_APP_TIMEZONE: string };
  win.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  win.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ rows: [{ ROWID: '1', Qty_Purchased: '7' }] }) });
  await client.boot(model, win.document);
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const article = win.document.querySelector('article[data-page="Dashboard"]');
  assert.ok(article);
  const output = article.querySelector('output[data-kpi-fn]');
  assert.match(output?.getAttribute('style') ?? '', /color:#A07E2F/, 'the KPI number keeps the export accent');
  assert.match(output?.getAttribute('style') ?? '', /font-size:36px/, 'the KPI number is the large export size');
  const label = article.querySelector('p');
  assert.match(label?.getAttribute('style') ?? '', /color:#888888/, 'the KPI label keeps the muted export color');
  const icon = article.querySelector('.zicon');
  const iconStyle = icon?.getAttribute('style') ?? '';
  assert.match(iconStyle, /background-color:#A07E2F/, 'the icon chip keeps the export fill');
  assert.match(iconStyle, /border-radius:26px/, 'the icon chip keeps the round export corners');
  assert.match(iconStyle, /font-size:24px/, 'the icon glyph keeps the export size');
  const cell = article.querySelector('a.zcard [data-zml="pc"]');
  const cellStyle = cell?.getAttribute('style') ?? '';
  assert.match(cellStyle, /width:50%/, 'the tile keeps the page-defined column share');
  assert.match(cellStyle, /background-color:#FFFFFF/, 'the tile keeps the export surface');
  assert.match(cellStyle, /border-radius:5px/, 'the tile keeps the export corners');
});

test('G11: ZML style values drop CSS injection vectors and keep real values', () => {
  const [row] = elementsFromZml(
    parseZml(
      `<row>` +
        `<pc color="url(evil.png)"/>` +
        `<pc size="expression(alert(1))"/>` +
        `<pc bgcolor="image-set(url(a.png) 1x)"/>` +
        `<pc color="var(--x)"/>` +
        `<pc bgcolor=";color:red"/>` +
        `<pc color="\\75rl("/>` +
        `<pc padding="4px/*"/>` +
        `<pc halign="@page"/>` +
        `<pc color='"red"'/>` +
        `<pc color="#A07E2F" size="36px" padding="4px 8px" cornerradius="26px" halign="left" height="50%" bgcolor="rgb(255, 0, 0)"/>` +
        `<pc bgcolor="hsla(200, 50%, 50%, 0.5)"/>` +
        `</row>`,
    ),
  );
  const cells = (row?.children || []) as { style?: Record<string, string> }[];
  assert.equal(cells.length, 11);
  for (let i = 0; i < 9; i++) assert.equal(cells[i].style, undefined, `injection vector ${i} dropped`);
  assert.deepEqual(cells[9].style, {
    color: '#A07E2F',
    'font-size': '36px',
    padding: '4px 8px',
    'border-radius': '26px',
    'text-align': 'left',
    height: '50%',
    'background-color': 'rgb(255, 0, 0)',
  });
  assert.deepEqual(cells[10].style, { 'background-color': 'hsla(200, 50%, 50%, 0.5)' });
});

test('G11: the rendered style attribute refuses the same values', async () => {
  const client = await loadClient();
  const model = {
    nav: [],
    forms: [],
    reports: [],
    pages: [
      {
        name: 'P',
        label: 'P',
        status: 'generated',
        elements: [
          { tag: 'text', kind: 'text', text: 'a', style: { color: 'url(evil.png)', 'font-size': '12px' }, children: [] },
          { tag: 'text', kind: 'text', text: 'b', style: { color: 'expression(alert(1))' }, children: [] },
          {
            tag: 'text',
            kind: 'text',
            text: 'c',
            style: { 'background-color': 'hsla(200, 50%, 50%, 0.5)', padding: '4px' },
            children: [],
          },
        ],
      },
    ],
  } as unknown as UiModel;
  const html = client.renderRoute(model, { name: 'page', id: 'P' });
  assert.doesNotMatch(html, /url\(|expression\(|evil\.png/, 'a dangerous value never reaches the style attribute');
  assert.match(html, /font-size:12px/, 'a clean value still renders');
  assert.match(html, /background-color:hsla\(200, 50%, 50%, 0\.5\)/, 'a colour function still renders');
});

// --- G12: snippet popup actions -------------------------------------------------

test('G12: a dsp openUrl popup becomes a page popup trigger, not dropped markup', () => {
  const model = INV_MODEL();
  const page = model.pages.find((item) => item.name === 'Dashboard');
  const flat = (els: { children?: unknown[] }[] | undefined, out: { kind: string; popups?: unknown[] }[] = []) => {
    for (const el of (els || []) as { kind: string; popups?: unknown[]; children?: unknown[] }[]) {
      out.push(el);
      flat(el.children as { children?: unknown[] }[] | undefined, out);
    }
    return out;
  };
  const elements = flat(page?.elements);
  const snippet = elements.find((el) => el.popups && el.popups.length) as
    | { popups?: { target: string; name: string; when: string; whenForm?: string }[] }
    | undefined;
  assert.ok(snippet, 'the snippet keeps its popup action');
  assert.deepEqual(snippet?.popups, [{ target: 'form', name: 'Add_Firm', when: 'empty', whenForm: 'Add_Firm' }]);
});

test('G12: an empty guarded form opens the popup form as a modal', async () => {
  const client = await loadClient();
  const model = INV_MODEL();
  const view = dom(shell('#/page/Dashboard'), 'http://127.0.0.1/slate/index.html#/page/Dashboard');
  const win = view.window as unknown as { document: Doc; fetch: unknown; C2C_APP_TIMEZONE: string };
  win.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  win.fetch = async (target: string) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ rows: target.includes('Firm_Details') ? [] : [{ ROWID: '1', Qty_Purchased: '7' }] }),
  });
  await client.boot(model, win.document);
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const modal = win.document.querySelector('[data-modal-form="Add_Firm"]');
  assert.ok(modal, 'an empty Add_Firm opens the modal form');
  assert.ok(modal?.querySelector('form[data-form="Add_Firm"]'), 'the modal renders the form');
  assert.match(modal?.textContent ?? '', /Add Firm/, 'the modal shows the form label');
});

test('G12: a popup to a hidden-section target asks the server before opening', async () => {
  const client = await loadClient();
  const model = INV_MODEL();
  // Creator keeps popup-only forms in a section with hide = true.
  for (const section of model.nav) section.items = section.items.filter((item) => item.name !== 'Add_Firm');
  model.nav.push({
    name: 'Setup',
    hidden: true,
    items: [{ kind: 'form', name: 'Add_Firm', label: 'Add Firm', href: '#/form/Add_Firm' }],
  });

  const boot = async (allow: boolean) => {
    const calls: { url: string; op?: string }[] = [];
    const view = dom(shell('#/page/Dashboard'), 'http://127.0.0.1/slate/index.html#/page/Dashboard');
    const win = view.window as unknown as { document: Doc; fetch: unknown; C2C_APP_TIMEZONE: string };
    win.C2C_APP_TIMEZONE = 'Asia/Kolkata';
    win.fetch = async (target: string, init?: { body?: string }) => {
      let op: string | undefined;
      try {
        op = JSON.parse(String(init?.body ?? '{}')).op;
      } catch {
        op = undefined;
      }
      calls.push({ url: String(target), op });
      if (String(target).includes('Add_Firm')) {
        return allow
          ? { ok: true, status: 200, text: async () => '{}' }
          : { ok: false, status: 403, text: async () => 'denied' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ rows: [] }) };
    };
    await client.boot(model, win.document);
    // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
    // fetch resolution: a few timer turns, not a wall-clock wait.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    return { win, calls };
  };

  const denied = await boot(false);
  assert.equal(denied.win.document.querySelector('[data-modal-form]'), null, 'a refused view check opens no modal');
  const gates = denied.calls.filter((call) => call.url.includes('Add_Firm'));
  assert.ok(gates.length > 0, 'the hidden target asked the server first');
  assert.ok(
    gates.every((call) => call.op === 'view'),
    'the gate is a view check, never a record write',
  );
  const guardQueries = denied.calls.filter((call) => call.url.includes('Firm_Details'));
  assert.equal(guardQueries.length, 1, 'the empty guard queries once per page paint');

  const allowed = await boot(true);
  const modals = allowed.win.document.querySelectorAll('[data-modal-form]');
  assert.equal(modals.length, 1, 'an allowed target opens exactly one modal');
  assert.ok(
    allowed.win.document.querySelector('[data-modal-form="Add_Firm"] form[data-form="Add_Firm"]'),
    'the modal renders the form',
  );
});

test('G12: a hidden-section report popup gates before it reads rows', async () => {
  const client = await loadClient();
  const model = buildModel(appOf(INV_APP.replace('#Form:Add_Firm', '#Report:Firm_Details')));
  for (const section of model.nav) section.items = section.items.filter((item) => item.name !== 'Firm_Details');
  model.nav.push({
    name: 'Setup',
    hidden: true,
    items: [{ kind: 'report', name: 'Firm_Details', label: 'Firm Details', href: '#/report/Firm_Details' }],
  });

  const boot = async (allow: boolean) => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const view = dom(shell('#/page/Dashboard'), 'http://127.0.0.1/slate/index.html#/page/Dashboard');
    const win = view.window as unknown as { document: Doc; fetch: unknown; C2C_APP_TIMEZONE: string };
    win.C2C_APP_TIMEZONE = 'Asia/Kolkata';
    win.fetch = async (target: string, init?: { body?: string }) => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      } catch {
        body = {};
      }
      calls.push({ url: String(target), body });
      if (String(target).includes('Firm_Details') && body.op === 'view') {
        return allow
          ? { ok: true, status: 200, text: async () => '{}' }
          : { ok: false, status: 403, text: async () => 'denied' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ rows: [] }) };
    };
    await client.boot(model, win.document);
    // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
    // fetch resolution: a few timer turns, not a wall-clock wait.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    return { win, calls };
  };

  const denied = await boot(false);
  assert.equal(denied.win.document.querySelector('[data-modal-form]'), null, 'a refused view check opens no modal');
  const hits = denied.calls.filter((call) => call.url.includes('Firm_Details'));
  assert.ok(
    hits.some((call) => call.body.op === 'view'),
    'the hidden report asked the server first',
  );
  assert.equal(
    hits.filter((call) => 'q' in call.body || 'filter' in call.body).length,
    0,
    'a refused popup never issues the row query',
  );

  const allowed = await boot(true);
  assert.ok(allowed.win.document.querySelector('[data-modal-form="Firm_Details"]'), 'an allowed report opens its modal');
  const reads = allowed.calls.filter((call) => call.url.includes('Firm_Details') && 'q' in call.body);
  assert.ok(reads.length > 0, 'an allowed report loads its rows');
});

test('G12: a populated guarded form does not open the modal', async () => {
  const client = await loadClient();
  const model = INV_MODEL();
  const view = dom(shell('#/page/Dashboard'), 'http://127.0.0.1/slate/index.html#/page/Dashboard');
  const win = view.window as unknown as { document: Doc; fetch: unknown; C2C_APP_TIMEZONE: string };
  win.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  win.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ rows: [{ ROWID: '1', Firm_Name: 'Acme' }] }) });
  await client.boot(model, win.document);
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(win.document.querySelector('[data-modal-form]'), null, 'a non-empty guard form opens no modal');
});

// --- G13: single-entry sections flatten like Creator's menu ---------------------

test('G13: a section whose only item shares its name renders one flat entry', async () => {
  const client = await loadClient();
  const nav = client.renderNav(INV_MODEL());
  const view = dom(`<!doctype html><nav>${nav}</nav>`);
  const doc = view.window.document as unknown as Doc;
  const links = Array.from(doc.querySelectorAll('a'));
  const dashboards = links.filter((link) => /Dashboard/.test(link.textContent ?? ''));
  assert.equal(dashboards.length, 1, 'the Dashboard section collapses to its lone child link');
  const sectionHeads = Array.from(doc.querySelectorAll('summary')).map((el) => el.textContent);
  assert.equal(sectionHeads.includes('Dashboard'), false, 'no collapsed group head repeats the item label');
});

// --- G14: a missing data endpoint counts as an empty guard -----------------------

test('G14: a static-host 404 on the guard report still opens the popup', async () => {
  const client = await loadClient();
  const model = INV_MODEL();
  const view = dom(shell('#/page/Dashboard'), 'http://127.0.0.1/slate/index.html#/page/Dashboard');
  const win = view.window as unknown as { document: Doc; fetch: unknown; C2C_APP_TIMEZONE: string };
  win.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  win.fetch = async (target: string) =>
    target.includes('Firm_Details')
      ? { ok: false, status: 404, text: async () => '' }
      : { ok: true, status: 200, text: async () => JSON.stringify({ rows: [{ ROWID: '1', Qty_Purchased: '7' }] }) };
  await client.boot(model, win.document);
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(win.document.querySelector('[data-modal-form="Add_Firm"]'), 'a host without the data function means no rows yet');
});

// --- G15: only the active section stays open in the list menu --------------------

test('G15: sections closed unless they hold the active entry', async () => {
  const client = await loadClient();
  const model = INV_MODEL();
  const view = dom(shell('#/page/Dashboard'), 'http://127.0.0.1/slate/index.html#/page/Dashboard');
  const win = view.window as unknown as { document: Doc; fetch: unknown; C2C_APP_TIMEZONE: string };
  win.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  win.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
  await client.boot(model, win.document);
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const open = win.document.querySelectorAll('#nav details[open]');
  assert.equal(open.length, 0, 'the flat Dashboard link leaves every section closed, like Creator');
});

// --- G16: a page's popup modal closes when the route leaves the page -------------

test('G16: navigating away closes the popup modal the page opened', async () => {
  const client = await loadClient();
  const model = INV_MODEL();
  const view = dom(shell('#/page/Dashboard'), 'http://127.0.0.1/slate/index.html#/page/Dashboard');
  const win = view.window as unknown as {
    document: Doc;
    fetch: unknown;
    C2C_APP_TIMEZONE: string;
    location: { hash: string };
    dispatchEvent(event: unknown): boolean;
    Event: new (type: string) => unknown;
  };
  win.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  win.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
  await client.boot(model, win.document);
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(win.document.querySelector('[data-modal-form]'), 'the empty guard opened the modal');
  win.location.hash = '#/report/Firm_Details';
  win.dispatchEvent(new win.Event('hashchange'));
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(win.document.querySelector('[data-modal-form]'), null, 'the modal closes when its page is no longer shown');
});

// --- G17: a popup answer that lands after navigation stays closed --------------

test('G17: a view answer that lands after the route moved on opens no modal', async () => {
  const client = await loadClient();
  const model = INV_MODEL();
  for (const section of model.nav) section.items = section.items.filter((item) => item.name !== 'Add_Firm');
  model.nav.push({
    name: 'Setup',
    hidden: true,
    items: [{ kind: 'form', name: 'Add_Firm', label: 'Add Firm', href: '#/form/Add_Firm' }],
  });
  let answer: (res: unknown) => void = () => {};
  const gate = new Promise((resolve) => {
    answer = resolve;
  });
  const view = dom(shell('#/page/Dashboard'), 'http://127.0.0.1/slate/index.html#/page/Dashboard');
  const win = view.window as unknown as {
    document: Doc;
    fetch: unknown;
    C2C_APP_TIMEZONE: string;
    location: { hash: string };
    dispatchEvent(event: unknown): boolean;
    Event: new (type: string) => unknown;
  };
  win.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  win.fetch = (target: string, init?: { body?: string }) => {
    let op = '';
    try {
      op = String(JSON.parse(String(init?.body ?? '{}')).op ?? '');
    } catch {
      op = '';
    }
    if (String(target).includes('Add_Firm') && op === 'view') return gate;
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ rows: [] }) });
  };
  await client.boot(model, win.document);
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(win.document.querySelector('[data-modal-form]'), null, 'the view check is still in flight');
  win.location.hash = '#/form/Form_Products';
  win.dispatchEvent(new win.Event('hashchange'));
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  answer({ ok: true, status: 200, text: async () => '{}' });
  // Deferred runtime work is scheduled on 0ms timers, possibly chained behind a
  // fetch resolution: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(win.document.querySelector('[data-modal-form]'), null, 'a popup belongs to the page that asked for it');
  assert.equal(win.document.querySelector('form[data-form="Form_Products"]') !== null, true, 'the new route painted');
});
