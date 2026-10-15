/**
 * Form layout taken from the export: rows and columns, web label placement,
 * hidden name and address parts, and one inline-grid row on the parent submit.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, parseFile } from '../../core/src/index.js';
import { normalizeType } from '../../schema/src/mapping.js';
import { clientRuntimeSource } from '../src/generate.js';
import { buildModel, type UiField, type UiForm, type UiReport } from '../src/model.js';

const EXCERPT = `
form Add_User
{
	displayname = "Add User"
	must have Name
	(
		type = name
		prefix
		(
			type = prefix
			displayname = "Prefix"
			visibility = false
		)
		first_name
		(
			type = first_name
			displayname = "First Name"
		)
		last_name
		(
			type = last_name
			displayname = "Last Name"
		)
		suffix
		(
			type = suffix
			displayname = "Suffix"
			visibility = false
		)
		row = 1
		column = 1
		width = medium
	)
	Address
	(
		type = address
		address_line_1
		(
			type = address_line_1
			displayname = "Address Line 1"
		)
		address_line_2
		(
			type = address_line_2
			displayname = "Address Line 2"
			visibility = false
		)
		latitude
		(
			type = latitude
		)
		longitude
		(
			type = longitude
		)
		row = 2
		column = 1
		width = medium
	)
}
form Create_BOM
{
	displayname = "Create BOM"
	Section1
	(
		type = section
		displayname = "Section"
		row = 1
		column = 0
		width = medium
	)
	must have Product
	(
		type = picklist
		values = Add_Product.ID
		displayformat = [Product_Name]
		row = 1
		column = 1
		width = medium
	)
	Serial_Number
	(
		type = text
		displayname = "Serial Number"
		row = 1
		column = 2
		width = medium
	)
	Created_By
	(
		type = picklist
		displayname = "Created By"
		values = Add_User.ID
		displayformat = [Name]
		row = 1
		column = 3
		width = medium
	)
	Section
	(
		type = section
		row = 2
		column = 0
		width = medium
	)
	must have Created_Date
	(
		type = date
		displayname = "Created Date"
		row = 2
		column = 1
		width = medium
	)
	BOM_Status
	(
		type = radiobuttons
		displayname = "BOM Status"
		values = {"Active","Archive"}
		row = 2
		column = 1
		width = medium
	)
	must have Production_Batch
	(
		type = picklist
		displayname = "Production Batch"
		values = Add_Production_Batch.ID
		displayformat = [Batch_No]
		row = 2
		column = 2
		width = medium
	)
	Image
	(
		type = image
		row = 2
		column = 3
		width = medium
	)
	must have List_Of_Materials
	(
		type = grid
		displayname = "List Of Raw Materials"
		must have Material
		(
			type = picklist
			values = Add_Material.ID
			displayformat = [Material_Name]
			width = medium
		)
		Quantity
		(
			type = number
			width = medium
		)
		row = 3
		column = 1
		width = medium
	)
	Hidden_Section
	(
		type = section
		displayname = "Hidden section"
		visibility = false
		row = 9
		column = 0
		width = medium
	)
}
form Purchase_Order
{
	displayname = "Purchase Order"
	Section
	(
		type = section
		row = 1
		column = 0
		width = medium
	)
	must have PO_Title
	(
		type = text
		displayname = "PO Title"
		row = 1
		column = 1
		width = medium
	)
	must have Vendor
	(
		type = picklist
		values = Vendor.ID
		displayformat = [Vendor_Name]
		row = 1
		column = 1
		width = medium
	)
	Amount
	(
		type = decimal
		row = 1
		column = 1
		width = medium
	)
	Notes
	(
		type = textarea
		height = 100px
		row = 1
		column = 1
		width = medium
	)
}
web
{
	forms
	{
		form Add_User
		{
			label placement = left
		}
		form Create_BOM
		{
			label placement = top
		}
		form Purchase_Order
		{
			label placement = left
		}
	}
}
`;

interface Runtime {
  renderForm(form: UiForm): string;
  renderReport(report: UiReport): string;
  submitRecord(formEl: unknown, form: UiForm, upload?: unknown): Promise<Record<string, unknown>>;
  installFormLayout?(doc: Dom): void;
}

type Placed = UiField & {
  row?: number;
  column?: number;
  width?: string;
  height?: string;
  visibility?: boolean;
  labelPlacement?: string;
};

interface ElementLike {
  tagName: string;
  textContent: string | null;
  value?: string;
  selected?: boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  appendChild(node: ElementLike): void;
  dispatchEvent(event: unknown): boolean;
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
}

interface Dom {
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
  createElement(tag: string): ElementLike;
  defaultView: { Event: new (type: string, init?: { bubbles?: boolean }) => unknown } | null;
  body: { textContent: string | null };
}

function placed(field: UiField): Placed {
  return field as Placed;
}

function app() {
  return deriveIr(parse(`application "Demo"\n{\n${EXCERPT}\n}\n`));
}

function formNamed(name: string): UiForm {
  const found = buildModel(app()).forms.find((item) => item.name === name);
  assert.ok(found, name);
  return found;
}

function fieldNamed(form: UiForm, name: string): UiField {
  const found = form.fields.find((item) => item.name === name);
  assert.ok(found, name);
  return found;
}

async function loadRuntime(): Promise<Runtime> {
  const source = clientRuntimeSource();
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as Runtime;
}

function render(html: string): Dom {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document as unknown as Dom;
}

/** Element ids that appear more than once in rendered form markup. */
function repeatedElementIds(html: string): string[] {
  const doc = new JSDOM(html).window.document as unknown as Dom;
  const ids: string[] = [];
  for (const el of Array.from(doc.querySelectorAll('[id]'))) {
    const id = el.getAttribute('id');
    if (id) ids.push(id);
  }
  return ids.filter((item, index) => ids.indexOf(item) !== index);
}

function dataColumns(doc: Dom, row: string): string[] {
  const cols = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll(`[data-row="${row}"]`))) {
    if (el.tagName === 'H3') continue;
    const column = el.getAttribute('data-column');
    if (column && column !== '0') cols.add(column);
  }
  return [...cols].sort();
}

test('Create BOM uses three columns on row 1 and row 2, with top labels', async () => {
  const form = formNamed('Create_BOM');
  const product = placed(fieldNamed(form, 'Product'));
  const hidden = placed(fieldNamed(form, 'Hidden_Section'));
  assert.equal(product.row, 1);
  assert.equal(product.column, 1);
  assert.equal(product.width, 'medium');
  assert.equal(product.labelPlacement, 'top');
  assert.equal(placed(fieldNamed(form, 'Serial_Number')).column, 2);
  assert.equal(placed(fieldNamed(form, 'Created_By')).column, 3);
  assert.equal(placed(fieldNamed(form, 'Created_Date')).row, 2);
  assert.equal(placed(fieldNamed(form, 'Created_Date')).column, 1);
  assert.equal(placed(fieldNamed(form, 'Production_Batch')).column, 2);
  assert.equal(placed(fieldNamed(form, 'Image')).column, 3);
  assert.equal(hidden.visibility, false);
  assert.equal(hidden.labelPlacement, 'top');
  for (const field of form.fields) assert.equal(placed(field).labelPlacement, 'top', field.name);

  const runtime = await loadRuntime();
  const doc = render(runtime.renderForm(form));
  assert.deepEqual(dataColumns(doc, '1'), ['1', '2', '3']);
  assert.deepEqual(dataColumns(doc, '2'), ['1', '2', '3']);
  for (const el of Array.from(doc.querySelectorAll('label[data-field]'))) {
    assert.ok(el.getAttribute('data-row'), el.getAttribute('data-field') ?? '');
    assert.ok(el.getAttribute('data-column'), el.getAttribute('data-field') ?? '');
    assert.equal(el.getAttribute('data-label-placement'), 'top');
  }
  assert.equal(doc.querySelector('[data-field="Product"]')?.getAttribute('data-width'), 'medium');
  assert.equal(doc.body.textContent?.includes('Hidden section'), false);
});

test('Purchase Order stays on one data column', async () => {
  const form = formNamed('Purchase_Order');
  const notes = placed(fieldNamed(form, 'Notes'));
  assert.equal(placed(fieldNamed(form, 'PO_Title')).column, 1);
  assert.equal(placed(fieldNamed(form, 'Vendor')).column, 1);
  assert.equal(placed(fieldNamed(form, 'Amount')).column, 1);
  assert.equal(notes.column, 1);
  assert.equal(notes.height, '100px');
  assert.equal(notes.labelPlacement, 'left');
  for (const field of form.fields) {
    if (field.widget === 'section') assert.equal(placed(field).column, 0);
    else assert.equal(placed(field).column, 1, field.name);
    assert.equal(placed(field).labelPlacement, 'left', field.name);
  }

  const runtime = await loadRuntime();
  const doc = render(runtime.renderForm(form));
  assert.deepEqual(dataColumns(doc, '1'), ['1']);
  assert.equal(doc.querySelector('[data-field="Notes"]')?.getAttribute('data-height'), '100px');
  assert.equal(doc.querySelector('[data-field="PO_Title"]')?.getAttribute('data-label-placement'), 'left');
});

test('a field size carrying extra declarations is dropped before the page', async () => {
  const hostile = deriveIr(
    parse(`application "Demo"
{
	form Add_Note
	{
		displayname = "Add Note"
		Notes
		(
			type = textarea
			displayname = "Notes"
			height = "100px;background-image:url(//outside.example/p.png)"
			row = 1
			column = 1
			width = medium
		)
		Plain
		(
			type = textarea
			displayname = "Plain"
			height = 120px
			row = 2
			column = 1
			width = "10px;position:fixed"
		)
	}
}
`),
  );
  const form = buildModel(hostile).forms.find((item) => item.name === 'Add_Note');
  assert.ok(form);
  const notes = placed(form.fields.find((item) => item.name === 'Notes')!);
  assert.equal(notes.height, undefined, 'a quoted height with a second declaration is not a size');
  assert.equal(notes.width, 'medium', 'the exported size word still applies');
  const plain = placed(form.fields.find((item) => item.name === 'Plain')!);
  assert.equal(plain.height, '120px', 'a plain length still applies');
  assert.equal(plain.width, undefined, 'a width carrying a second declaration is dropped');

  const runtime = await loadRuntime();
  const doc = render(runtime.renderForm(form));
  const notesEl = doc.querySelector('[data-field="Notes"]');
  assert.equal(notesEl?.getAttribute('data-height'), null);
  assert.equal(notesEl?.hasAttribute('style'), false);
  const plainEl = doc.querySelector('[data-field="Plain"]');
  assert.equal(plainEl?.getAttribute('data-height'), '120px');
  assert.equal(plainEl?.getAttribute('style'), '--c2c-field-height:120px');
});

test('the rendered field block refuses a height that is not a safe style value', async () => {
  const runtime = await loadRuntime();
  const form = {
    name: 'Add_Note',
    label: 'Add Note',
    layout: 'one',
    fields: [
      {
        name: 'Notes',
        label: 'Notes',
        widget: 'textarea',
        status: 'generated',
        height: '100px;background-image:url(//outside.example/p.png)',
      },
    ],
  } as unknown as UiForm;
  const doc = render(runtime.renderForm(form));
  const el = doc.querySelector('[data-field="Notes"]');
  assert.ok(el);
  assert.equal(el.hasAttribute('style'), false, 'no style attribute is written for a hostile value');
  const styled = el as unknown as { style: { backgroundImage: string; getPropertyValue(name: string): string } };
  assert.equal(styled.style.backgroundImage, '', 'the browser never resolves the injected declaration');
  assert.equal(styled.style.getPropertyValue('--c2c-field-height'), '');
});

test('hidden name and address parts are omitted and the rest are inputs', async () => {
  const form = formNamed('Add_User');
  const name = fieldNamed(form, 'Name');
  const address = fieldNamed(form, 'Address');
  assert.deepEqual(
    (name.subfields ?? []).map((part) => part.name),
    ['first_name', 'last_name'],
  );
  assert.equal(name.subfields?.[0]?.widget, 'text');
  assert.equal(name.subfields?.[1]?.widget, 'text');
  assert.equal(name.subfields?.[0]?.status, 'generated');
  assert.deepEqual(
    (address.subfields ?? []).map((part) => [part.name, part.widget]),
    [
      ['address_line_1', 'text'],
      ['latitude', 'decimal'],
      ['longitude', 'decimal'],
    ],
  );
  const reasons = buildModel(app()).todos.map((todo) => todo.name);
  assert.equal(reasons.includes('Add_User.prefix'), false);
  assert.equal(reasons.includes('Add_User.suffix'), false);
  assert.equal(reasons.includes('Add_User.address_line_2'), false);
  assert.equal(reasons.includes('Add_User.first_name'), false);

  const runtime = await loadRuntime();
  const html = runtime.renderForm(form);
  assert.equal(html.includes('data-field="prefix"'), false);
  assert.equal(html.includes('data-field="suffix"'), false);
  assert.equal(html.includes('data-field="address_line_2"'), false);
  assert.match(html, /<input[^>]*name="first_name"/);
  assert.match(html, /<input[^>]*name="last_name"/);
  assert.match(html, /<input[^>]*name="address_line_1"/);
  assert.match(html, /<input[^>]*name="latitude"/);
  assert.match(html, /<input[^>]*name="longitude"/);
  assert.equal(html.includes('No schema mapping'), false);
});

test('Add row on List Of Raw Materials submits one lookup row with the parent', async () => {
  const form = formNamed('Create_BOM');
  const grid = fieldNamed(form, 'List_Of_Materials');
  assert.equal(grid.widget, 'subform');
  assert.equal(grid.subfields?.[0]?.name, 'Material');
  assert.equal(grid.subfields?.[0]?.widget, 'lookup');

  const runtime = await loadRuntime();
  assert.equal(typeof runtime.installFormLayout, 'function');
  const doc = render(runtime.renderForm(form));
  runtime.installFormLayout!(doc);
  const button = doc.querySelector('[data-add-row="List_Of_Materials"]');
  assert.ok(button);
  button.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
  const row = doc.querySelector('.subform[data-field="List_Of_Materials"] tbody tr');
  assert.ok(row);
  assert.equal(doc.querySelectorAll('.subform[data-field="List_Of_Materials"] tbody tr').length, 1);
  const material = row.querySelector('[data-subfield="Material"]');
  assert.ok(material);
  assert.equal(material.tagName, 'SELECT');
  assert.ok(material.hasAttribute('data-lookup'));
  const option = doc.createElement('option');
  option.value = '1';
  option.textContent = 'Steel';
  option.selected = true;
  material.appendChild(option);
  const serial = doc.querySelector('input[name="Serial_Number"]') as { value: string } | null;
  assert.ok(serial);
  serial.value = 'SN-1';
  const record = await runtime.submitRecord(doc.querySelector('form'), form);
  assert.equal(record.Serial_Number, 'SN-1');
  const rows = record.List_Of_Materials as { Material?: string }[];
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.Material, '1');
});

test('client scripts are appended in filename order', () => {
  const dir = join(process.cwd(), 'packages/ui/src/client');
  assert.equal(existsSync(dir), true);
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.ok(names.length >= 1);
  const source = clientRuntimeSource();
  let at = source.indexOf('export const PAGE_SIZE');
  assert.ok(at > 0);
  for (const name of names) {
    const head = readFileSync(join(dir, name), 'utf8').slice(0, 60);
    const next = source.indexOf(head);
    assert.ok(next > at, name);
    at = next;
  }
});

test('decoration modules are loaded from the directory, not an import list', () => {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/model.ts'), 'utf8');
  assert.match(source, /readdirSync\(/);
  assert.match(source, /decorations/);
  assert.doesNotMatch(source, /from '\.\/decorations\//);
  assert.doesNotMatch(source, /decorations\/layout/);
});

test('each decoration file runs in filename order', async () => {
  const mod = (await import(pathToFileURL(join(process.cwd(), 'dist/ui/src/model.js')).href)) as {
    applyDecorations?: (model: { tag?: string }, app: { forms: never[] }, dir?: string) => void;
  };
  assert.equal(typeof mod.applyDecorations, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'c2c-form-layout-'));
  try {
    writeFileSync(
      join(dir, 'b.js'),
      'module.exports.decorate = function (model) { model.tag = (model.tag || "") + "b"; };\n',
    );
    writeFileSync(
      join(dir, 'a.js'),
      'module.exports.decorate = function (model) { model.tag = (model.tag || "") + "a"; };\n',
    );
    const model: { tag?: string } = {};
    mod.applyDecorations!(model, { forms: [] }, dir);
    assert.equal(model.tag, 'ab');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A `type = grid` field whose `values` names another Creator form is
// still a subform. Its columns are the linked form's fields minus the
// bidirectional back-pointer, and required subfields carry the `*` mark.
const LINKED_APP = `
form Add_Warehouse
{
	displayname = "Add Warehouse"
	Warehouse_Code
	(
		type = text
		displayname = "Warehouse Code"
	)
}
form Form_Products
{
	displayname = "Add Products"
	must have Product_Name
	(
		type = text
		displayname = "Product Name"
	)
	must have Add_Stocks_subform
	(
		type = grid
		displayname = "Add Stocks"
		values = Add_Stock.ID
		bidirectional = Product_Name
	)
}
form Add_Stock
{
	displayname = "Add Stock"
	must have Product_Name
	(
		type = picklist
		values = Form_Products.ID
		bidirectional = Add_Stocks_subform
		displayname = "Product Name"
	)
	must have Purchased_Date
	(
		type = date
		displayname = "Purchased Date"
	)
	must have Warehouse_Code
	(
		type = picklist
		displayname = "Warehouse Code"
		values = Add_Warehouse.ID
		displayformat = [Warehouse_Code]
	)
	must have Qty_Purchased
	(
		type = number
		displayname = "Purchased Qty"
	)
	Instock
	(
		type = number
	)
}
`;

function linkedApp() {
  return deriveIr(parse(`application "Demo"\n{\n${LINKED_APP}\n}\n`));
}

test('a grid field bound to another form emits a subform with that form\'s fields', () => {
  const model = buildModel(linkedApp());
  const form = model.forms.find((item) => item.name === 'Form_Products');
  assert.ok(form);
  const field = form.fields.find((item) => item.name === 'Add_Stocks_subform');
  assert.ok(field);
  assert.equal(field.widget, 'subform');
  assert.equal(field.label, 'Add Stocks');
  assert.equal(field.required, true);
  // The linked form's fields are the columns; the bidirectional pointer back
  // to the parent (Product_Name) is not a column.
  assert.deepEqual(
    (field.subfields ?? []).map((sub) => sub.name),
    ['Purchased_Date', 'Warehouse_Code', 'Qty_Purchased', 'Instock'],
  );
  assert.equal(field.subfields?.[1]?.widget, 'lookup');
  assert.equal(field.status, 'generated');
});

test('the linked subform renders required marks, a + Add New control, and adds a row', async () => {
  const model = buildModel(linkedApp());
  const form = model.forms.find((item) => item.name === 'Form_Products');
  assert.ok(form);
  const runtime = await loadRuntime();
  const doc = render(runtime.renderForm(form));
  const subform = doc.querySelector('.subform[data-field="Add_Stocks_subform"]');
  assert.ok(subform);
  assert.deepEqual(
    Array.from(subform.querySelectorAll('thead th:not([data-row-ops])')).map((th) => th.textContent),
    ['Purchased Date *', 'Warehouse Code *', 'Purchased Qty *', 'Instock'],
  );
  const add = subform.querySelector('[data-add-row="Add_Stocks_subform"]');
  assert.ok(add);
  assert.equal(add.textContent, '+ Add New');
  runtime.installFormLayout!(doc);
  add.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
  const row = subform.querySelector('tbody tr');
  assert.ok(row);
  assert.ok(row.querySelector('[data-subfield="Qty_Purchased"]'));
  const warehouse = row.querySelector('[data-subfield="Warehouse_Code"]');
  assert.equal(warehouse?.tagName, 'SELECT');
  assert.ok(warehouse?.hasAttribute('data-lookup'));
});

test('required subform columns carry the * mark and the add control reads + Add New', async () => {
  const form = formNamed('Create_BOM');
  const runtime = await loadRuntime();
  const doc = render(runtime.renderForm(form));
  const subform = doc.querySelector('.subform[data-field="List_Of_Materials"]');
  assert.ok(subform);
  const heads = Array.from(subform.querySelectorAll('thead th:not([data-row-ops])'));
  assert.equal(heads[0]?.querySelector('.req')?.textContent, ' *');
  assert.deepEqual(
    heads.map((th) => th.textContent),
    ['Material *', 'Quantity'],
  );
  const add = subform.querySelector('[data-add-row="List_Of_Materials"]');
  assert.equal(add?.textContent, '+ Add New');
});

test('every grid field in the three reviewed apps emits a populated subform', (t) => {
  const fixtures = process.env.C2C_FIXTURES_DIR;
  if (!fixtures || !existsSync(fixtures)) {
    t.skip('no C2C_FIXTURES_DIR');
    return;
  }
  const paths = [
    join(fixtures, 'synthetic/s01-purchase-orders/L1/c2c-syn-po-l1.exported.ds'),
    join(fixtures, 'gallery/bill-of-materials/Bill_Of_Materials.ds'),
    join(fixtures, 'gallery/inventory-management/Inventory_Management.ds'),
  ];
  const misses: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const ir = parseFile(path).ir;
    const model = buildModel(ir);
    const byForm = new Map(model.forms.map((form) => [form.name, form]));
    const tag = path.split('/').pop() ?? path;
    for (const form of ir.forms) {
      for (const field of form.fields) {
        const token = normalizeType(field.type);
        if (token !== 'grid' && token !== 'subform' && token !== 'inline subform') continue;
        const ui = byForm.get(form.name)?.fields.find((item) => item.name === field.name);
        if (!ui || ui.widget !== 'subform' || !(ui.subfields ?? []).length) {
          misses.push(`${tag}:${form.name}.${field.name}:${ui?.widget ?? 'missing'}`);
        }
      }
    }
  }
  assert.deepEqual(misses, []);
});

// Two address groups share part names. Each part id includes the parent field,
// so the two groups do not reuse one element id.
const TWO_ADDRESSES = `
form New_Contact
{
	displayname = "New Contact"
	Address
	(
		type = address
		address_line_1
		(
			type = address_line_1
			displayname = "Address Line 1"
		)
		address_line_2
		(
			type = address_line_2
			displayname = "Address Line 2"
		)
		district_city
		(
			type = district_city
			displayname = "District / City"
		)
		state_province
		(
			type = state_province
			displayname = "State / Province"
		)
		postal_code
		(
			type = postal_code
			displayname = "Postal Code"
		)
		country
		(
			type = country
			displayname = "Country"
		)
		row = 1
		column = 1
		width = medium
	)
	Shipping_Address
	(
		type = address
		address_line_1
		(
			type = address_line_1
			displayname = "Address Line 1"
		)
		address_line_2
		(
			type = address_line_2
			displayname = "Address Line 2"
		)
		district_city
		(
			type = district_city
			displayname = "District / City"
		)
		state_province
		(
			type = state_province
			displayname = "State / Province"
		)
		postal_code
		(
			type = postal_code
			displayname = "Postal Code"
		)
		country
		(
			type = country
			displayname = "Country"
		)
		row = 2
		column = 1
		width = medium
	)
}
`;

test('two address fields on one form give every element a unique id', async () => {
  const ir = deriveIr(parse(`application "Demo"\n{\n${TWO_ADDRESSES}\n}\n`));
  const form = buildModel(ir).forms.find((item) => item.name === 'New_Contact');
  assert.ok(form);
  const runtime = await loadRuntime();
  const html = runtime.renderForm(form);
  const doc = render(html);
  assert.equal(Array.from(doc.querySelectorAll('[name="address_line_1"]')).length, 2);
  assert.equal(Array.from(doc.querySelectorAll('[name="country"]')).length, 2);
  assert.deepEqual(repeatedElementIds(html), []);
});

test('gallery fixtures contain no duplicate element IDs', async (t) => {
  const fixtures = process.env.C2C_FIXTURES_DIR;
  if (!fixtures || !existsSync(fixtures)) {
    t.skip('no C2C_FIXTURES_DIR');
    return;
  }
  const galleryDir = join(fixtures, 'gallery');
  if (!existsSync(galleryDir)) return;
  const dirs = readdirSync(galleryDir)
    .filter((name) => !name.startsWith('.'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const runtime = await loadRuntime();
  for (const dirName of dirs) {
    const dirPath = join(galleryDir, dirName);
    const st = statSync(dirPath, { throwIfNoEntry: false });
    if (!st?.isDirectory()) continue;
    const dsNames = readdirSync(dirPath)
      .filter((name) => name.endsWith('.ds'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const dsName of dsNames) {
      const ir = parseFile(join(dirPath, dsName)).ir;
      const model = buildModel(ir);
      for (const form of model.forms) {
        const dupes = repeatedElementIds(runtime.renderForm(form));
        assert.deepEqual(dupes, [], `${dirName}/${dsName} ${form.name}: ${dupes.join(', ')}`);
      }
    }
  }
});

function partNamed(field: UiField, name: string): UiField {
  const found = (field.subfields ?? []).find((item) => item.name === name);
  assert.ok(found, name);
  return found;
}

test('a required name or address marks its identifying parts on the controls', async () => {
  const ir = deriveIr(
    parse(`application "Demo"
{
	form Application
	{
		must have Applicant_Name
		(
			type = name
			prefix
			(
				type = prefix
				displayname = "Prefix"
			)
			first_name
			(
				type = first_name
				displayname = "First Name"
			)
			last_name
			(
				type = last_name
				displayname = "Last Name"
			)
			suffix
			(
				type = suffix
				displayname = "Suffix"
			)
		)
		must have Primary_Address
		(
			type = address
			address_line_1
			(
				type = address_line_1
				displayname = "Address Line 1"
			)
			address_line_2
			(
				type = address_line_2
				displayname = "Address Line 2"
			)
			district_city
			(
				type = district_city
				displayname = "City"
			)
			latitude
			(
				type = latitude
			)
			longitude
			(
				type = longitude
			)
		)
		Preferred_Name
		(
			type = name
			first_name
			(
				type = first_name
				displayname = "First Name"
			)
			last_name
			(
				type = last_name
				displayname = "Last Name"
			)
		)
	}
}
`),
  );
  const form = buildModel(ir).forms.find((item) => item.name === 'Application');
  assert.ok(form);
  const name = fieldNamed(form, 'Applicant_Name');
  const address = fieldNamed(form, 'Primary_Address');
  const preferred = fieldNamed(form, 'Preferred_Name');
  assert.equal(partNamed(name, 'first_name').required, true);
  assert.equal(partNamed(name, 'last_name').required, true);
  assert.equal(partNamed(name, 'prefix').required, false);
  assert.equal(partNamed(name, 'suffix').required, false);
  assert.equal(partNamed(address, 'address_line_1').required, true);
  assert.equal(partNamed(address, 'address_line_2').required, false);
  assert.equal(partNamed(address, 'district_city').required, false);
  assert.equal(partNamed(address, 'latitude').required, false);
  assert.equal(partNamed(address, 'longitude').required, false);
  assert.equal(partNamed(preferred, 'first_name').required, false);
  assert.equal(partNamed(preferred, 'last_name').required, false);

  const runtime = await loadRuntime();
  const doc = render(runtime.renderForm(form));
  const first = doc.querySelector('#f-Applicant_Name-first_name');
  const last = doc.querySelector('#f-Applicant_Name-last_name');
  const prefix = doc.querySelector('#f-Applicant_Name-prefix');
  const line1 = doc.querySelector('#f-Primary_Address-address_line_1');
  const city = doc.querySelector('#f-Primary_Address-district_city');
  const optional = doc.querySelector('#f-Preferred_Name-first_name');
  assert.ok(first);
  assert.equal(first.hasAttribute('required'), true);
  assert.equal(first.getAttribute('aria-required'), 'true');
  assert.equal(last?.hasAttribute('required'), true);
  assert.equal(last?.getAttribute('aria-required'), 'true');
  assert.equal(prefix?.hasAttribute('required'), false);
  assert.equal(prefix?.getAttribute('aria-required'), null);
  assert.equal(line1?.hasAttribute('required'), true);
  assert.equal(line1?.getAttribute('aria-required'), 'true');
  assert.equal(city?.hasAttribute('required'), false);
  assert.equal(city?.getAttribute('aria-required'), null);
  assert.equal(optional?.hasAttribute('required'), false);
});

test('a required name or address without its identifying part marks the remaining parts', () => {
  const ir = deriveIr(
    parse(`application "Demo"
{
	form Application
	{
		must have Legal_Name
		(
			type = name
			prefix
			(
				type = prefix
				displayname = "Prefix"
			)
			given
			(
				type = text
				displayname = "Given"
			)
			suffix
			(
				type = suffix
				displayname = "Suffix"
			)
		)
		must have Site
		(
			type = address
			address_line_2
			(
				type = address_line_2
				displayname = "Address Line 2"
			)
			district_city
			(
				type = district_city
				displayname = "City"
			)
			latitude
			(
				type = latitude
			)
			longitude
			(
				type = longitude
			)
		)
	}
}
`),
  );
  const form = buildModel(ir).forms.find((item) => item.name === 'Application');
  assert.ok(form);
  const name = fieldNamed(form, 'Legal_Name');
  const site = fieldNamed(form, 'Site');
  assert.equal(partNamed(name, 'given').required, true);
  assert.equal(partNamed(name, 'prefix').required, false);
  assert.equal(partNamed(name, 'suffix').required, false);
  assert.equal(partNamed(site, 'district_city').required, true);
  assert.equal(partNamed(site, 'address_line_2').required, false);
  assert.equal(partNamed(site, 'latitude').required, false);
  assert.equal(partNamed(site, 'longitude').required, false);
});

test('a required grid column and its name parts are required on the row controls', async () => {
  const ir = deriveIr(
    parse(`application "Demo"
{
	form Application
	{
		must have Task_List
		(
			type = grid
			displayname = "Task List"
			must have Description
			(
				type = text
				displayname = "Description"
			)
			must have Person
			(
				type = name
				first_name
				(
					type = first_name
					displayname = "First Name"
				)
				last_name
				(
					type = last_name
					displayname = "Last Name"
				)
			)
			Note
			(
				type = text
				displayname = "Note"
			)
		)
	}
}
`),
  );
  const form = buildModel(ir).forms.find((item) => item.name === 'Application');
  assert.ok(form);
  const grid = fieldNamed(form, 'Task_List');
  const person = partNamed(grid, 'Person');
  assert.equal(partNamed(grid, 'Description').required, true);
  assert.equal(partNamed(person, 'first_name').required, true);
  assert.equal(partNamed(person, 'last_name').required, true);
  assert.equal(partNamed(grid, 'Note').required, false);

  const runtime = await loadRuntime();
  const doc = render(runtime.renderForm(form));
  runtime.installFormLayout!(doc);
  const subform = doc.querySelector('.subform[data-field="Task_List"]');
  assert.ok(subform);
  assert.equal(subform.querySelector('input[name="Task_List"]'), null);
  const columns = JSON.parse(subform.getAttribute('data-columns') || '[]') as {
    name: string;
    required?: boolean;
    parts?: { name: string; required?: boolean }[];
  }[];
  const description = columns.find((column) => column.name === 'Description');
  const personColumn = columns.find((column) => column.name === 'Person');
  const note = columns.find((column) => column.name === 'Note');
  assert.equal(description?.required, true);
  assert.equal(note?.required, false);
  assert.equal(personColumn?.required, true);
  assert.equal(personColumn?.parts?.find((part) => part.name === 'first_name')?.required, true);
  assert.equal(personColumn?.parts?.find((part) => part.name === 'last_name')?.required, true);

  const add = subform.querySelector('[data-add-row="Task_List"]');
  assert.ok(add);
  add.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
  const row = subform.querySelector('tbody tr');
  assert.ok(row);
  const descriptionInput = row.querySelector('[data-subfield="Description"]');
  const noteInput = row.querySelector('[data-subfield="Note"]');
  const first = row.querySelector('#f-Person-1-first_name');
  const last = row.querySelector('#f-Person-1-last_name');
  assert.equal(descriptionInput?.hasAttribute('required'), true);
  assert.equal(descriptionInput?.getAttribute('aria-required'), 'true');
  assert.equal(noteInput?.hasAttribute('required'), false);
  assert.equal(noteInput?.getAttribute('aria-required'), null);
  assert.equal(first?.hasAttribute('required'), true);
  assert.equal(first?.getAttribute('aria-required'), 'true');
  assert.equal(last?.hasAttribute('required'), true);
  assert.equal(last?.getAttribute('aria-required'), 'true');
  assert.equal(subform.querySelector('input[name="Task_List"]'), null);
});

test('the report filter select has an accessible name', async () => {
  const runtime = await loadRuntime();
  const html = runtime.renderReport({
    name: 'All_Items',
    label: 'All Items',
    type: 'list',
    view: 'list',
    status: 'generated',
    columns: [{ field: 'Name', label: 'Name' }],
    filters: [{ field: 'Status', label: 'Open' }],
    sort: [],
    groupBy: [],
    pageSize: 200,
    queryEndpoint: '/reports/All_Items',
    customActions: [],
    detail: false,
  });
  const doc = render(html);
  const filter = doc.querySelector('select[data-filter]');
  assert.ok(filter);
  assert.equal(filter.getAttribute('aria-label'), 'Filter');
  assert.equal(doc.querySelector('input[type="search"]')?.getAttribute('aria-label'), 'Search');
});
