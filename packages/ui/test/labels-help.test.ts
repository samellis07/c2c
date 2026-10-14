import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { applyLabels } from '../src/decorations/labels.js';
import { buildModel } from '../src/model.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

interface TestEl {
  textContent: string | null;
  innerHTML: string;
  outerHTML: string;
  value: string;
  reset(): void;
  click(): void;
  getAttribute(name: string): string | null;
  querySelector(sel: string): TestEl | null;
  querySelectorAll(sel: string): ArrayLike<TestEl> & Iterable<TestEl>;
}

interface TestDoc {
  body: TestEl;
  querySelector(sel: string): TestEl | null;
}

function tdoc(dom: InstanceType<typeof JSDOM>): TestDoc {
  return dom.window.document as unknown as TestDoc;
}

interface Labelled {
  help?: string;
  placeholder?: string;
  notesHtml?: string;
  submitLabel?: string;
  resetLabel?: string;
  updateLabel?: string;
  cancelLabel?: string;
}

const ORDER_BODY = `\tform Purchase_Order
\t{
\t\tdisplayname = "Purchase Order"
\t\tmust have PO_Title
\t\t(
\t\t\ttype = text
\t\t\tdisplayname = "PO Title"
\t\t)
\t\tmust have Vendor
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Vendor.Vendor_Name
\t\t)
\t\tOrder_Date
\t\t(
\t\t\ttype = date
\t\t\tdisplayname = "Order Date"
\t\t)
\t\tStatus
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = {"Draft","Sent"}
\t\t)
\t\tAmount
\t\t(
\t\t\ttype = decimal
\t\t)
\t}
\tlist All_Purchase_Orders
\t{
\t\tdisplayName = "All Purchase Orders"
\t\tshow all rows from Purchase_Order
\t\t(
\t\t\tPO_Title
\t\t\tVendor
\t\t\tOrder_Date
\t\t\tStatus
\t\t\tAmount
\t\t\tAmount as "Total"
\t\t)
\t}`;

const BOM_BODY = `\tform Create_BOM
\t{
\t\tdisplayname = "Create BOM"
\t\tProduction_Batch
\t\t(
\t\t\ttype = text
\t\t\tdisplayname = "Production Batch"
\t\t\tdescription
\t\t\t[
\t\t\t\ttype = help_text
\t\t\t\tmessage = "Batch Number"
\t\t\t]
\t\t)
\t\tSerial_Number
\t\t(
\t\t\ttype = text
\t\t\tdisplayname = "Serial Number"
\t\t\tplaceholder = "PO-0001"
\t\t)
\t\tNotes
\t\t(
\t\t\ttype = multi-line
\t\t\tdisplayname = "Notes"
\t\t)
\t}`;

const PRODUCT_BODY = `\tform Add_Product
\t{
\t\tdisplayname = "Add Product"
\t\tplain
\t\t(
\t\t\ttype = plaintext
\t\t\tvalue = "<div><b>This form is to track finished goods.</b></div>"
\t\t)
\t\tProduct_Name
\t\t(
\t\t\ttype = text
\t\t\tdisplayname = "Product Name"
\t\t)
\t}`;

const MATERIAL_BODY = `\tform Add_Material
\t{
\t\tdisplayname = "Add Material"
\t\tMaterial_Name
\t\t(
\t\t\ttype = text
\t\t\tdisplayname = "Material Name"
\t\t)
\t\tactions
\t\t{
\t\t\ton add
\t\t\t{
\t\t\t\tsubmit
\t\t\t\t(
\t\t\t\t\ttype = submit
\t\t\t\t\tdisplayname = "Add"
\t\t\t\t)
\t\t\t\treset
\t\t\t\t(
\t\t\t\t\ttype = reset
\t\t\t\t\tdisplayname = "Reset"
\t\t\t\t)
\t\t\t}
\t\t\ton edit
\t\t\t{
\t\t\t\tupdate
\t\t\t\t(
\t\t\t\t\ttype = submit
\t\t\t\t\tdisplayname = "Update"
\t\t\t\t)
\t\t\t\tcancel
\t\t\t\t(
\t\t\t\t\ttype = cancel
\t\t\t\t\tdisplayname = "Cancel"
\t\t\t\t)
\t\t\t}
\t\t}
\t}`;

async function client(): Promise<{ runtime: any; labels: any }> {
  const runtime = await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href);
  const labels = await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client/30-labels.js')).href);
  return { runtime, labels };
}

function enhancedForm(runtime: any, labels: any, form: object, options?: object): { doc: TestDoc; formEl: TestEl } {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = tdoc(dom);
  doc.body.innerHTML = runtime.renderForm(form);
  const formEl = doc.querySelector('form');
  assert.ok(formEl);
  labels.applyFormLabels(formEl, form, {
    doc: dom.window.document,
    sanitize: (html: string) => runtime.sanitizeSnippet(html, dom.window.document),
    ...(options ?? {}),
  });
  return { doc, formEl };
}

test('report headers use the form display name when the column has no label', async () => {
  const app = appOf(ORDER_BODY);
  const model = buildModel(app);
  applyLabels(app, model);
  const report = model.reports.find((item) => item.name === 'All_Purchase_Orders');
  assert.ok(report);
  assert.deepEqual(
    report.columns.map((column) => column.label),
    ['PO Title', 'Vendor', 'Order Date', 'Status', 'Amount', 'Total'],
  );
});

test('help text and placeholder reach the rendered field', async () => {
  const { runtime, labels } = await client();
  const app = appOf(BOM_BODY);
  const model = buildModel(app);
  applyLabels(app, model);
  const form = model.forms.find((item) => item.name === 'Create_BOM');
  assert.ok(form);
  const byName = Object.fromEntries(form.fields.map((item) => [item.name, item as Labelled]));
  assert.equal(byName.Production_Batch.help, 'Batch Number');
  assert.equal(byName.Serial_Number.placeholder, 'PO-0001');
  assert.equal(byName.Notes.placeholder, undefined);

  const { formEl } = enhancedForm(runtime, labels, form);
  const help = formEl.querySelector('[data-field="Production_Batch"] [data-help]');
  assert.ok(help);
  assert.equal(help.textContent, 'Batch Number');
  const serial = formEl.querySelector('[data-field="Serial_Number"] input');
  assert.ok(serial);
  assert.equal(serial.getAttribute('placeholder'), 'PO-0001');
  const notes = formEl.querySelector('[data-field="Notes"] textarea');
  assert.ok(notes);
  assert.equal(notes.getAttribute('placeholder'), null);
});

test('instruction notes show the stored HTML, not the field name', async () => {
  const { runtime, labels } = await client();
  const app = appOf(PRODUCT_BODY);
  const model = buildModel(app);
  applyLabels(app, model);
  const form = model.forms.find((item) => item.name === 'Add_Product');
  assert.ok(form);
  const note = form.fields.find((item) => item.widget === 'notes');
  assert.ok(note);
  assert.match((note as unknown as Labelled).notesHtml ?? '', /finished goods/);

  const { formEl } = enhancedForm(runtime, labels, form);
  const block = formEl.querySelector('.notes');
  assert.ok(block);
  assert.match(block.innerHTML, /finished goods/);
  assert.doesNotMatch(block.textContent ?? '', /^plain$/);
});

test('stored markup in notes is cleaned before it is shown', async () => {
  const { runtime, labels } = await client();
  const app = appOf(
    `\tform Add_Product
\t{
\t\tdisplayname = "Add Product"
\t\tplain
\t\t(
\t\t\ttype = plaintext
\t\t\tvalue = "<div>Fine<script>alert(1)</script></div>"
\t\t)
\t}`,
  );
  const model = buildModel(app);
  applyLabels(app, model);
  const { formEl } = enhancedForm(runtime, labels, model.forms[0]);
  const block = formEl.querySelector('.notes');
  assert.ok(block);
  assert.doesNotMatch(block.innerHTML, /<script/);
  assert.match(block.textContent ?? '', /Fine/);
});

test('add and edit screens use the configured button labels', async () => {
  const { runtime, labels } = await client();
  const app = appOf(MATERIAL_BODY);
  const model = buildModel(app);
  applyLabels(app, model);
  const form = model.forms.find((item) => item.name === 'Add_Material');
  assert.ok(form);
  const labelled = form as unknown as Labelled;
  assert.equal(labelled.submitLabel, 'Add');
  assert.equal(labelled.resetLabel, 'Reset');
  assert.equal(labelled.updateLabel, 'Update');
  assert.equal(labelled.cancelLabel, 'Cancel');

  const add = enhancedForm(runtime, labels, form, { mode: 'add' });
  assert.equal(add.formEl.querySelector('button[type="submit"]')?.textContent, 'Add');
  const reset = add.formEl.querySelector('button[type="reset"]');
  assert.ok(reset);
  assert.equal(reset.textContent, 'Reset');

  const edit = enhancedForm(runtime, labels, form, { mode: 'edit' });
  assert.equal(edit.formEl.querySelector('button[type="submit"]')?.textContent, 'Update');
  const others = [...edit.formEl.querySelectorAll('button')].filter(
    (item) => item.getAttribute('type') !== 'submit' && item.getAttribute('type') !== 'reset',
  );
  assert.equal(others.length, 1);
  assert.equal(others[0].textContent, 'Cancel');
});

test('reset clears typed values back to the start', async () => {
  const { runtime, labels } = await client();
  const app = appOf(MATERIAL_BODY);
  const model = buildModel(app);
  applyLabels(app, model);
  const form = model.forms.find((item) => item.name === 'Add_Material');
  assert.ok(form);
  const { formEl } = enhancedForm(runtime, labels, form, { mode: 'add' });
  const input = formEl.querySelector('[data-field="Material_Name"] input');
  assert.ok(input);
  input.value = 'typed value';
  formEl.reset();
  assert.equal(input.value, '');
});
