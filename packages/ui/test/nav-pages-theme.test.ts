import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { decorateNavTheme } from '../src/decorations/nav-theme.js';
import { clientRuntimeSource } from '../src/generate.js';
import { buildModel, type UiModel, type UiPage } from '../src/model.js';
import type { UiElement } from '../src/pages.js';

function appOf(source: string): App {
  return deriveIr(parse(source));
}

async function decorate(model: UiModel, app: App): Promise<UiModel & { theme?: { theme?: string; font?: string; iconColor?: string } }> {
  void app;
  const themed = model as UiModel & { theme?: { theme?: string; font?: string; iconColor?: string } };
  assert.ok(themed.theme, 'the decoration pass records the web theme on the built model');
  return themed;
}

interface Client {
  boot(model: UiModel, doc: unknown): Promise<void>;
  applyNavPages?(model: UiModel, doc: unknown): void;
}

async function loadClient(): Promise<Client> {
  const runtime = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  const extraPath = join(process.cwd(), 'packages/ui/src/client/60-nav-pages.js');
  const extra = existsSync(extraPath) ? `\n${readFileSync(extraPath, 'utf8')}` : '';
  return (await import(`data:text/javascript;base64,${Buffer.from(runtime + extra).toString('base64')}`)) as Client;
}

async function paint(model: UiModel, hash: string) {
  const client = await loadClient();
  const dom = new JSDOM('<!doctype html><html><body><nav id="nav"></nav><main id="main"></main></body></html>', {
    url: `http://127.0.0.1/slate/index.html${hash}`,
  });
  const doc = dom.window.document as unknown as {
    documentElement: { getAttribute(name: string): string | null };
    getElementById(id: string): { innerHTML: string } | null;
    querySelector(selector: string): { textContent: string | null; innerHTML: string; getAttribute(name: string): string | null; querySelector(selector: string): unknown; querySelectorAll(selector: string): ArrayLike<ElementLike> } | null;
    querySelectorAll(selector: string): ArrayLike<ElementLike>;
  };
  await client.boot(model, doc);
  client.applyNavPages?.(model, doc);
  return doc;
}

interface ElementLike {
  textContent: string | null;
  innerHTML: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
}

function list(nodes: ArrayLike<ElementLike> | undefined): ElementLike[] {
  if (!nodes) return [];
  return Array.from(nodes);
}

type RichElement = UiElement & { width?: string; icon?: string; unresolved?: boolean };

function flat(elements: UiElement[] | undefined, out: RichElement[] = []): RichElement[] {
  for (const el of elements || []) {
    out.push(el);
    flat(el.children, out);
  }
  return out;
}

const L1 = `application "Purchase Orders"
{
	customize
	{
		icon
		{
			icon = "zc-ab-sales-and-supp10"
			background color = "blue"
			foreground color = "#FFFFFF"
		}
	}
	form Vendor
	{
		displayname = "Vendor"
		Vendor_Name
		(
			type = text
		)
	}
	web
	{
		menu
		{
			space Space
			{
				displayname = "Space"
				icon = "objects-spaceship"
				section Main
				{
					displayname = "Main"
					icon = "education-book-open"
					form Vendor
					{
						icon = "ui-2-square-add-11"
					}
				}
				section ZC_Approvals
				{
					displayname = "Approvals"
					icon = "ui-2-hourglass"
					systemcomponent
					{
						type = approval
						approval status = pending
						displayname = "Pending Tasks"
						icon = "ui-2-hourglass"
					}
					systemcomponent
					{
						type = approval
						approval status = completed
						displayname = "Completed Tasks"
						icon = "design-todo"
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

const BOM = `application "Bill Of Materials"
{
	customize
	{
		icon
		{
			icon = "zc-ab-finance11"
			background color = "amethyst"
			foreground color = "#FFFFFF"
		}
	}
	form Add_Product
	{
		displayname = "Add Product"
		Name
		(
			type = text
		)
	}
	web
	{
		menu
		{
			space Space
			{
				displayname = "Space"
				icon = "objects-spaceship"
				section Products
				{
					displayname = "Products"
					icon = "design-shape-circle"
					form Add_Product
					{
						icon = "files-add"
					}
				}
				section BOM_Calculator
				{
					displayname = "BOM Calculator"
					icon = "business-math"
				}
				section SharedAnalytics_Section
				{
					displayname = "Reports"
					icon = "business-chart-bar-33"
				}
				section ZC_Approvals
				{
					displayname = "Approvals"
					icon = "ui-2-hourglass"
					systemcomponent
					{
						type = approval
						approval status = pending
						displayname = "Pending Tasks"
						icon = "ui-2-hourglass"
					}
					systemcomponent
					{
						type = approval
						approval status = completed
						displayname = "Completed Tasks"
						icon = "design-todo"
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

const DASHBOARD_ZML = `<zml><layout><row><column width='24%'><panel><pr><pc action='OpenReport' componentLinkName='Report_A'><image type='icon' value='business-chart-bar-33'/><text type='Form Data' value='thisapp.Form_A.Field_A.sum'></text><text type='Text' value='Today Sales'></text></pc></pr></panel></column><column width='24%'><panel><pr><pc action='OpenReport' componentLinkName='Report_B'><image type='icon' value='shopping-cart-modern'/><text type='Form Data' value='thisapp.Form_B.Field_B.sum'></text><text type='Text' value='Today Purchase'></text></pc></pr></panel></column><column width='27%'><panel><pr><pc action='OpenReport' componentLinkName='Report_C'><image type='icon' value='arrows-4-reply'/><text type='Form Data' value='thisapp.Form_C.Field_C.sum'></text><text type='Text' value='Today Returns'></text></pc></pr></panel></column><column width='25%'><panel><pr><pc action='OpenReport' componentLinkName='Report_D'><image type='icon' value='design-app'/><text type='Form Data' value='thisapp.Form_D.Field_D.count'></text><text type='Text' value='Total Products'></text></pc></pr></panel></column></row><row><column width='100%'><report elementName='Report' linkName='Report_Stock'/></column></row><row><column width='50%'><report elementName='Report 1' linkName='Report_Weekly'/></column><column width='50%'><report elementName='Report 2' linkName='Report_Monthly'/></column></row><row><column width='100%'><dsp id='html_snippet'><![CDATA[<p>Open the firm record.</p><script>alert(1)</script><style>p{color:red}</style>]]></dsp></column></row></layout></zml>`;

const INVENTORY = `application "Inventory"
{
	customize
	{
		icon
		{
			icon = "zc-ab-operation-4"
			background color = "blue"
			foreground color = "#FFFFFF"
		}
	}
	pages
	{
		page Dashboard
		{
			displayname = "Dashboard"
			Content="${DASHBOARD_ZML.replace(/"/g, '\\"')}"
		}
	}
	web
	{
		menu
		{
			space Space
			{
				displayname = "Space"
				icon = "objects-spaceship"
				section Hidden
				{
					displayname = "Hidden"
					icon = "ui-2-menu-bold"
				}
				section Charts
				{
					displayname = "Charts"
					icon = "ui-2-menu-bold"
				}
				section page
				{
					displayname = "Return to Stock"
					icon = "tech-desktop"
				}
				section Dashboard
				{
					displayname = "Dashboard"
					icon = "ui-1-dashboard-half"
					page Dashboard
					{
						icon = "design-window-paragraph"
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

function headings(doc: Awaited<ReturnType<typeof paint>>): string[] {
  return list(doc.querySelectorAll('#nav [data-section]')).map((el) => el.getAttribute('data-section') || '');
}

test('purchase orders menu text and icon colour', async () => {
  const app = appOf(L1);
  const model = await decorate(buildModel(app), app);
  const doc = await paint(model, '#/');
  assert.equal(doc.documentElement.getAttribute('data-icon-color'), 'blue');
  assert.equal(doc.documentElement.getAttribute('data-font'), 'lato');
  assert.equal(doc.querySelector('#nav a[href="#/report/approval"]'), null);
  assert.equal(doc.querySelector('#nav a[href="#/report/localization"]'), null);
  const pending = list(doc.querySelectorAll('#nav span')).filter((el) => el.textContent === 'Pending Tasks');
  const done = list(doc.querySelectorAll('#nav span')).filter((el) => el.textContent === 'Completed Tasks');
  assert.equal(pending.length, 0, 'system entries stay off the menu');
  assert.equal(done.length, 0);
  assert.equal(headings(doc).includes('Approvals'), false, 'a system section does not draw a heading');
  assert.equal(headings(doc).includes('App Preferences'), false);
  const main = list(doc.querySelectorAll('#nav [data-section]')).find((el) => el.getAttribute('data-section') === 'Main');
  assert.equal(main?.querySelector('summary') ? (main.querySelector('summary') as ElementLike).getAttribute('data-icon') : null, 'education-book-open');
  const vendor = list(doc.querySelectorAll('#nav a')).find((el) => el.getAttribute('href') === '#/form/Vendor');
  assert.equal(vendor?.getAttribute('data-icon'), 'ui-2-square-add-11');
});

test('bill of materials omits empty sections and records the theme', async () => {
  const app = appOf(BOM);
  const model = await decorate(buildModel(app), app);
  const doc = await paint(model, '#/');
  assert.equal(doc.documentElement.getAttribute('data-theme'), '9');
  assert.equal(doc.documentElement.getAttribute('data-font'), 'lato');
  const names = headings(doc);
  assert.equal(names.includes('BOM Calculator'), false);
  assert.equal(names.includes('BOM_Calculator'), false);
  assert.equal(names.includes('Hidden'), false);
  assert.equal(names.includes('Reports'), false);
  assert.equal(names.includes('Products'), true);
  const products = list(doc.querySelectorAll('#nav [data-section]')).find((el) => el.getAttribute('data-section') === 'Products');
  assert.equal((products?.querySelector('summary') as ElementLike | null)?.getAttribute('data-icon'), 'design-shape-circle');
  const add = list(doc.querySelectorAll('#nav a')).find((el) => el.textContent === 'Add Product');
  assert.equal(add?.getAttribute('data-icon'), 'files-add');
  assert.equal(doc.querySelector('#nav a[href="#/report/approval"]'), null);
});

test('dashboard page uses link names, widths, captions, icons, and snippet text', async () => {
  const app = appOf(INVENTORY);
  const model = await decorate(buildModel(app), app);
  const page = model.pages.find((item) => item.name === 'Dashboard') as UiPage;
  const elements = flat(page.elements);
  const hrefs = elements.map((el) => el.href).filter(Boolean);
  assert.ok(hrefs.includes('#/report/Report_Stock'));
  assert.ok(hrefs.includes('#/report/Report_Weekly'));
  assert.ok(hrefs.includes('#/report/Report_Monthly'));
  assert.equal(hrefs.includes('#/report/Report'), false);
  assert.equal(hrefs.includes('#/report/Report%201'), false);
  const widths = elements.filter((el) => el.tag.toLowerCase() === 'column').map((el) => el.width);
  assert.deepEqual(widths.slice(0, 4), ['24%', '24%', '27%', '25%']);
  assert.equal(elements.some((el) => el.icon === 'business-chart-bar-33'), true);
  assert.equal(elements.some((el) => (el.todo || '').includes('no generated component') && el.tag.toLowerCase() === 'image'), false);
  assert.equal(elements.some((el) => el.text === 'Today Sales'), true);
  assert.equal(elements.some((el) => el.text === 'Today Purchase'), true);
  assert.equal(elements.some((el) => el.text === 'Today Returns'), true);
  assert.equal(elements.some((el) => el.text === 'Total Products'), true);
  assert.equal(elements.some((el) => (el.text || '').includes('thisapp.Form_A.Field_A.sum')), false);
  assert.equal(elements.some((el) => (el.kind as string) === 'kpi'), true, 'a Form Data cell becomes a KPI element');
  assert.equal(elements.some((el) => el.unresolved), false, 'no Unresolved label survives');
  const snippet = elements.find((el) => el.kind === 'html');
  assert.match(snippet?.html || '', /Open the firm record/);
  assert.doesNotMatch(snippet?.html || '', /<script/i);
  assert.doesNotMatch(snippet?.html || '', /<style/i);

  const doc = await paint(model, '#/page/Dashboard');
  assert.equal(headings(doc).includes('Hidden'), false);
  assert.equal(headings(doc).includes('Charts'), false);
  assert.equal(headings(doc).includes('Return to Stock'), false);
  const row = doc.querySelector('article[data-page="Dashboard"] [data-zml="row"]');
  const cols = list(row?.querySelectorAll(':scope > [data-zml="column"]')).map((el) => el.getAttribute('data-width'));
  assert.deepEqual(cols, ['24%', '24%', '27%', '25%']);
  for (const href of ['#/report/Report_Stock', '#/report/Report_Weekly', '#/report/Report_Monthly']) {
    assert.ok(doc.querySelector(`article a[href="${href}"]`), href);
  }
  for (const caption of ['Today Sales', 'Today Purchase', 'Today Returns', 'Total Products']) {
    assert.match(doc.querySelector('article')?.textContent || '', new RegExp(caption));
  }
  assert.doesNotMatch(doc.querySelector('article')?.textContent || '', /thisapp\.Form_A\.Field_A\.sum/);
  assert.equal(doc.querySelector('article [data-icon="business-chart-bar-33"]')?.getAttribute('aria-hidden'), 'true');
  const snippetEl = doc.querySelector('article .snippet');
  assert.match(snippetEl?.textContent || '', /Open the firm record/);
  assert.equal(snippetEl?.innerHTML.includes('<script'), false);
  assert.equal(doc.querySelector('article .snippet script'), null);
});

test('boot paints the recorded theme without a second call', async () => {
  (globalThis as { CSS?: { escape(value: string): string } }).CSS ??= {
    escape: (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`),
  };
  const app = appOf(L1);
  const model = decorateNavTheme(buildModel(app), app);
  const source = clientRuntimeSource();
  const client = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as {
    boot(model: UiModel, doc: unknown): Promise<void>;
  };
  const dom = new JSDOM('<!doctype html><html><body><nav id="nav"></nav><main id="main"></main></body></html>', {
    url: 'http://127.0.0.1/slate/index.html#/',
  });
  const doc = dom.window.document as unknown as {
    documentElement: { getAttribute(name: string): string | null };
    querySelector(selector: string): ElementLike | null;
    querySelectorAll(selector: string): ArrayLike<ElementLike>;
  };
  await client.boot(model, doc);
  assert.equal(doc.documentElement.getAttribute('data-icon-color'), 'blue');
  assert.equal(doc.documentElement.getAttribute('data-font'), 'lato');
  assert.equal(doc.querySelector('#nav a[href="#/report/approval"]'), null);
  const vendor = list(doc.querySelectorAll('#nav a')).find((el) => el.getAttribute('href') === '#/form/Vendor');
  assert.equal(vendor?.getAttribute('data-icon'), 'ui-2-square-add-11');
});
