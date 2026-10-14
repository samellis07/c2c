import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse } from '../../core/src/index.js';
import { TEMPLATE_DIR, reactAppSpec } from '../src/index.js';
import { LOOKUP_PAGE_SIZE, LookupSource, filterLookupOptions, lookupIds, lookupKnownLabels, lookupOptions, lookupPageUrl, lookupSource } from '../template/lib/c2c-ui/lookup/source.js';
import { isEmptyRow, subformRows, validateRows, validateSubforms } from '../template/lib/c2c-ui/subform/rows.js';
import { createApi, type ApiReply, type AppWindow } from '../template/lib/c2c-ui/runtime/api.js';
import type { FieldSpec, FormSpec } from '../template/lib/c2c-ui/types.js';
import { firstErrorControl, readRecord } from '../template/lib/c2c-ui/form/record.js';
import { activeDescendant, enterAction, optionId } from '../template/lib/c2c-ui/arc/components/combobox/keys.js';
import { saveSubforms, splitSubforms, type SubformStore, type SubformTables } from '../../shims/src/subforms.js';

const APP = `application "Orders"
{
\tform Customer
\t{
\t\tdisplayname = "Customer"
\t\tmust have Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tEmail
\t\t(
\t\t\ttype = email
\t\t)
\t}
\tform Product
\t{
\t\tTitle
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Order
\t{
\t\tdisplayname = "Order"
\t\tmust have Buyer
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Customer.ID
\t\t\tdisplayformat = [Name]
\t\t\tdisplayname = "Buyer"
\t\t)
\t\tWatchers
\t\t(
\t\t\ttype = list
\t\t\tvalues = Customer.Email
\t\t)
\t\tSupplier
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Vendor.Name
\t\t)
\t\tOwner
\t\t(
\t\t\ttype = users
\t\t)
\t\tLines
\t\t(
\t\t\ttype = grid
\t\t\tdisplayname = "Order Lines"
\t\t\tmust have Item
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tvalues = Product.ID
\t\t\t\tdisplayformat = [Title]
\t\t\t)
\t\t\tmust have Quantity
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t\tNote
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t)
\t}
}
`;

function orderForm(): FormSpec {
  return reactAppSpec(deriveIr(parse(APP))).forms.Order!;
}

function fieldOf(form: FormSpec, name: string): FieldSpec {
  const found = form.fields.find((f) => f.name === name);
  assert.ok(found, name);
  return found;
}

test('lookup and multi lookup fields are generated with their parent, display field and paged endpoint', () => {
  const form = orderForm();
  const buyer = fieldOf(form, 'Buyer');
  assert.equal(buyer.widget, 'lookup');
  assert.equal(buyer.generated, true);
  assert.equal(buyer.todo, undefined);
  assert.deepEqual(buyer.lookup, { form: 'Customer', display: 'Name', endpoint: '/lookups/Customer/Name' });
  const watchers = fieldOf(form, 'Watchers');
  assert.equal(watchers.widget, 'lookup-multi');
  assert.equal(watchers.generated, true);
  assert.deepEqual(watchers.lookup, { form: 'Customer', display: 'Email', endpoint: '/lookups/Customer/Email' });
  // A users field is an email control, not a placeholder.
  const owner = fieldOf(form, 'Owner');
  assert.equal(owner.widget, 'users');
  assert.equal(owner.generated, true);
});

test('subform columns keep the Creator order and a lookup column carries its lookup', () => {
  const lines = fieldOf(orderForm(), 'Lines');
  assert.equal(lines.widget, 'subform');
  assert.equal(lines.generated, true);
  assert.deepEqual(lines.subfields!.map((c) => [c.name, c.widget, c.required]), [['Item', 'lookup', true], ['Quantity', 'number', true], ['Note', 'text', false]]);
  assert.deepEqual(lines.subfields![0]!.lookup, { form: 'Product', display: 'Title', endpoint: '/lookups/Product/Title' });
});

test('the widget table routes lookups, multi lookups and subforms to their controls', () => {
  const fields = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/form/fields.tsx'), 'utf8');
  assert.match(fields, /case 'lookup': return LookupField;/);
  assert.match(fields, /case 'lookup-multi': return LookupMultiField;/);
  assert.match(fields, /case 'subform': return SubformGrid;/);
  assert.match(fields, /users: 'email'/);
});

type Calls = string[];
function fakeGet(pages: number, total: number, calls: Calls, fail = new Set<number>()) {
  return async (url: string): Promise<ApiReply<unknown>> => {
    calls.push(url);
    const page = Number(/[?&]page=(\d+)/.exec(url)![1]);
    const size = Number(/[?&]pageSize=(\d+)/.exec(url)![1]);
    if (fail.has(calls.length)) return { ok: false, status: 500, body: { error: 'boom' } };
    const rows = [];
    for (let i = page * size; i < Math.min(total, (page + 1) * size) && page < pages; i++) rows.push({ ROWID: String(1000 + i), Name: `Customer ${i}` });
    return { ok: true, status: 200, body: { rows, field: 'Name', page, pageSize: size } };
  };
}

test('lookup options are read one 300-row page at a time, never the whole table on open', async () => {
  assert.equal(LOOKUP_PAGE_SIZE, 300);
  assert.equal(lookupPageUrl('/lookups/Customer/Name', 2), '/lookups/Customer/Name?page=2&pageSize=300');
  const calls: Calls = [];
  const source = new LookupSource(fakeGet(10, 700, calls), '/lookups/Customer/Name');
  await Promise.all([source.open(), source.open()]);
  assert.deepEqual(calls, ['/lookups/Customer/Name?page=0&pageSize=300'], 'one request for the first page, shared');
  assert.equal(source.snapshot().options.length, 300);
  assert.equal(source.snapshot().done, false);
  await source.open();
  assert.equal(calls.length, 1, 'reopening does not read again');
  await source.more();
  await source.more();
  assert.deepEqual(calls.slice(1), ['/lookups/Customer/Name?page=1&pageSize=300', '/lookups/Customer/Name?page=2&pageSize=300']);
  assert.equal(source.snapshot().options.length, 700);
  assert.equal(source.snapshot().done, true, 'a short page ends the paging');
  await source.more();
  assert.equal(calls.length, 3, 'nothing is read after the last page');
});

test('search filters the pages read; a failed page is an error state that retries', async () => {
  const calls: Calls = [];
  const source = new LookupSource(fakeGet(10, 1000, calls, new Set([2])), '/lookups/Customer/Name');
  await source.open();
  const options = source.snapshot().options;
  assert.deepEqual(filterLookupOptions(options, 'customer 29').map((o) => o.label), ['Customer 29', ...Array.from({ length: 10 }, (_, i) => `Customer ${290 + i}`)]);
  assert.equal(calls.length, 1, 'search reads nothing');
  await source.more();
  assert.equal(source.snapshot().state, 'error');
  assert.equal(source.snapshot().pages, 1);
  await source.retry();
  assert.equal(source.snapshot().state, 'ready');
  assert.equal(source.snapshot().pages, 2);
  assert.equal(calls.at(-1), '/lookups/Customer/Name?page=1&pageSize=300');
});

test('lookup replies map ROWID to the display value; a static host with no function is an empty list', async () => {
  assert.deepEqual(lookupOptions({ rows: [{ ROWID: '1', Name: 'Ann' }, { Name: 'no id' }, { ROWID: 2 }], field: 'Name' }), [
    { value: '1', label: 'Ann' },
    { value: '2', label: '2' },
  ]);
  const source = new LookupSource(async () => ({ ok: false, status: 404, body: undefined }), '/lookups/X/Y');
  await source.open();
  assert.deepEqual([source.snapshot().state, source.snapshot().done, source.snapshot().options.length, source.snapshot().status], ['ready', true, 0, null]);
  assert.deepEqual(lookupIds('5'), ['5']);
  assert.deepEqual(lookupIds([{ ROWID: '7', label: 'Seven' }, 8]), ['7', '8']);
  assert.deepEqual(lookupIds(''), []);
  assert.deepEqual([...lookupKnownLabels({ ROWID: '7', display_value: 'Seven' })], [['7', 'Seven']]);
});

test('a refused lookup keeps its status so the control can deny or name it', async () => {
  const denied = new LookupSource(async () => ({ ok: false, status: 403, body: undefined }), '/lookups/Customer/Name');
  await denied.open();
  assert.deepEqual([denied.snapshot().state, denied.snapshot().status], ['error', 403]);
  const ended = new LookupSource(async () => ({ ok: false, status: 401, body: undefined }), '/lookups/Customer/Name');
  await ended.open();
  assert.deepEqual([ended.snapshot().state, ended.snapshot().status], ['error', 401]);
  const dropped = new LookupSource(async () => {
    throw new TypeError('fetch failed');
  }, '/lookups/Customer/Name');
  await dropped.open();
  assert.deepEqual([dropped.snapshot().state, dropped.snapshot().status], ['error', 0]);
});

test('the API client reads lookups with a GET that carries no body; lookups on one endpoint share a source', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const view = {
    fetch: async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ rows: [], field: 'Name' }), { status: 200 });
    },
    C2C_API_BASE: 'https://fn.example.test/server/c2c_api/',
  } as unknown as AppWindow;
  const api = createApi(view);
  const reply = await api.get('/lookups/Customer/Name?page=0&pageSize=300');
  assert.equal(reply.ok, true);
  assert.equal(seen[0]!.url, 'https://fn.example.test/server/c2c_api/lookups/Customer/Name?page=0&pageSize=300');
  assert.equal(seen[0]!.init.method, 'GET');
  assert.equal(seen[0]!.init.body, undefined);
  assert.equal(seen[0]!.init.credentials, 'include');
  await api.post('/forms/Order/submit', { record: {} });
  assert.equal(seen[1]!.init.method, 'POST');
  assert.equal(seen[1]!.init.body, '{"record":{}}');
  assert.equal(lookupSource(api, '/lookups/A/B'), lookupSource(api, '/lookups/A/B'));
  assert.notEqual(lookupSource(api, '/lookups/A/B'), lookupSource(api, '/lookups/A/C'));
});

function gridDom(html: string): HTMLFormElement {
  const dom = new JSDOM(`<form>${html}</form>`);
  return dom.window.document.querySelector('form') as unknown as HTMLFormElement;
}

test('subform rows are read in grid order with their cells, ROWID and multi lookup lists; empty rows are skipped', () => {
  const lines = fieldOf(orderForm(), 'Lines');
  const formEl = gridDom(`
    <input name="Lines[0].ROWID" type="hidden" value="55">
    <input name="Lines[0].Item" type="hidden" value="9">
    <input name="Lines[0].Quantity" value="2">
    <input name="Lines[0].Note" value="">
    <input name="Lines[1].Item" type="hidden" value="">
    <input name="Lines[1].Quantity" value="">
    <input name="Lines[1].Note" value="">
    <input name="Lines[2].Item" type="hidden" value="">
    <input name="Lines[2].Quantity" value="x">
    <input name="Lines[2].Note" value="late">
    <select name="Other" multiple><option value="1" selected>1</option></select>`);
  const rows = subformRows(formEl, lines);
  assert.deepEqual(rows.map((r) => r.index), [0, 1, 2]);
  assert.deepEqual(rows[0]!.values, { ROWID: '55', Item: '9', Quantity: '2', Note: '' });
  assert.deepEqual(rows.map(isEmptyRow), [false, true, false]);
  // Row 3 misses its mandatory lookup and has a non-number quantity; row 2 is empty and not checked.
  const errors = validateRows(lines, rows);
  assert.deepEqual(Object.keys(errors), ['Lines', 'Lines[2].Item', 'Lines[2].Quantity']);
  assert.equal(errors.Lines, 'Check row 3 of Order Lines.');
  assert.equal(errors['Lines[2].Item'], 'Enter Item in row 3.');
  assert.equal(errors['Lines[2].Quantity'], 'Enter a number for Quantity in row 3.');
  assert.deepEqual(validateSubforms(formEl, orderForm()), errors);
});

test('a multi lookup cell is read as a list of ROWIDs', () => {
  const field: FieldSpec = { name: 'Tags', label: 'Tags', widget: 'subform', required: false, readonly: false, generated: true, subfields: [
    { name: 'Who', label: 'Who', widget: 'lookup-multi', required: true, readonly: false, generated: true, lookup: { form: 'Customer', display: 'Name', endpoint: '/lookups/Customer/Name' } },
    { name: 'Why', label: 'Why', widget: 'text', required: false, readonly: false, generated: true },
  ] };
  const formEl = gridDom(`
    <select name="Tags[0].Who" multiple hidden><option value="1" selected>1</option><option value="2" selected>2</option></select>
    <input name="Tags[0].Why" value="">
    <select name="Tags[1].Who" multiple hidden></select>
    <input name="Tags[1].Why" value="needs one">`);
  const rows = subformRows(formEl, field);
  assert.deepEqual(rows[0]!.values.Who, ['1', '2']);
  assert.deepEqual(rows[1]!.values.Who, []);
  assert.deepEqual(validateRows(field, rows), { Tags: 'Check row 2 of Tags.', 'Tags[1].Who': 'Enter Who in row 2.' });
});

test('a composite column is read as its filled parts, nested; an unfilled one is left out', () => {
  const field: FieldSpec = { name: 'People', label: 'People', widget: 'subform', required: false, readonly: false, generated: true, subfields: [
    { name: 'Name', label: 'Name', widget: 'name', required: true, readonly: false, generated: true, subfields: [
      { name: 'first_name', label: 'First Name', widget: 'text', required: false, readonly: false, generated: true },
      { name: 'last_name', label: 'Last Name', widget: 'text', required: false, readonly: false, generated: true },
    ] },
    { name: 'Age', label: 'Age', widget: 'number', required: false, readonly: false, generated: true },
  ] };
  const formEl = gridDom(`
    <input name="People[0].Name.first_name" value="Ann"><input name="People[0].Name.last_name" value=""><input name="People[0].Age" value="4">
    <input name="People[1].Name.first_name" value=""><input name="People[1].Name.last_name" value=""><input name="People[1].Age" value="9">`);
  const rows = subformRows(formEl, field);
  assert.deepEqual(rows.map((r) => r.values), [{ Name: { first_name: 'Ann' }, Age: '4' }, { Age: '9' }]);
  assert.deepEqual(validateRows(field, rows), { People: 'Check row 2 of People.', 'People[1].Name': 'Enter Name in row 2.' });
});

test('Arc combobox and multi-select are vendored, recorded, and keep a reduced-motion path', () => {
  const upstream = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/ARC-UPSTREAM.md'), 'utf8');
  for (const name of ['combobox', 'multi-select']) {
    const dir = join(TEMPLATE_DIR, `lib/c2c-ui/arc/components/${name}`);
    assert.ok(existsSync(join(dir, `${name}.tsx`)), name);
    assert.match(upstream, new RegExp(`\`${name}\``), `${name} listed in ARC-UPSTREAM.md`);
    const source = readFileSync(join(dir, `${name}.tsx`), 'utf8');
    assert.match(source, /useReducedMotion/);
    assert.doesNotMatch(source, /@\/lib\//, 'no path alias');
    assert.doesNotMatch(source, /\bdocument\.addEventListener/, 'listeners go on the control own document');
    assert.match(readFileSync(join(dir, `${name}.module.css`), 'utf8'), /prefers-reduced-motion: reduce/);
  }
  for (const css of ['lookup/lookup.css', 'subform/subform.css']) {
    assert.match(readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui', css), 'utf8'), /prefers-reduced-motion/, css);
  }
});

/** An in-memory child table: rows by ROWID, new ROWIDs on insert. */
function childStore(rows: Record<string, unknown>[]) {
  let next = 900;
  const table = new Map<string, Record<string, unknown>>(rows.map((row) => [String(row.ROWID), row]));
  const store: SubformStore = {
    async insert(_name, list) {
      for (const row of list) {
        const id = String(next++);
        table.set(id, { ...row, ROWID: id });
      }
    },
    async query(_name, where, limit, offset = 0) {
      const m = /^(\w+) = '(\d+)'$/.exec(where);
      assert.ok(m, where);
      return [...table.values()].filter((row) => String(row[m[1]!]) === m[2]).slice(offset, offset + limit);
    },
    async delete(_name, ids) {
      for (const id of ids) table.delete(String(id));
    },
  };
  return { store, rows: () => [...table.values()] };
}

const ORDER_TABLES: SubformTables = { Order: [{ field: 'Lines', table: 'Order_Lines', parentColumn: 'Order_id', orderColumn: 'Row_order' }] };

/** Saves an edit the way the generated update handler does: split the record, replace the carried subforms. */
async function saveEdit(record: Record<string, unknown>, stored: Record<string, unknown>[]) {
  const child = childStore(stored);
  const split = splitSubforms(record, ORDER_TABLES, 'Order');
  if (split.children.length) await saveSubforms(child.store, '100', split.children, { replace: true });
  return child.rows();
}

const TWO_LINES = [
  { ROWID: '55', Order_id: '100', Row_order: 0, Item: '9', Quantity: '2' },
  { ROWID: '56', Order_id: '100', Row_order: 1, Item: '8', Quantity: '1' },
];

test('removing every row of a generated grid on edit deletes every stored child row', async () => {
  // The edit screen opened with two stored rows; the user removed both, so the grid holds no row controls.
  const formEl = gridDom(`<div data-field="Lines"><fieldset data-subform="Lines"></fieldset></div>`);
  const record = readRecord(formEl, orderForm());
  assert.deepEqual(record.Lines, [], 'the grid sends an empty list, not nothing');
  assert.deepEqual(await saveEdit(record, TWO_LINES), []);
});

test('removing one of two rows leaves exactly the kept row, stored under a new ROWID', async () => {
  const formEl = gridDom(`<div data-field="Lines"><fieldset data-subform="Lines">
    <input type="hidden" name="Lines[0].ROWID" value="56">
    <input type="hidden" name="Lines[0].Item" value="8">
    <input name="Lines[0].Quantity" value="1">
    <input name="Lines[0].Note" value="">
  </fieldset></div>`);
  const record = readRecord(formEl, orderForm());
  const after = await saveEdit(record, TWO_LINES);
  assert.equal(after.length, 1);
  assert.deepEqual({ ...after[0], ROWID: undefined }, { Item: '8', Note: '', Order_id: '100', Quantity: '1', Row_order: 0, ROWID: undefined });
  // Replace semantics: the kept row is re-inserted, so its ROWID is not the one it was loaded with.
  assert.notEqual(after[0]!.ROWID, '56');
});

test('a subform drawn by a custom widget without the grid sends nothing and leaves the stored rows alone', async () => {
  const formEl = gridDom(`<div data-field="Lines"></div>`);
  const record = readRecord(formEl, orderForm());
  assert.equal(Object.hasOwn(record, 'Lines'), false);
  assert.equal((await saveEdit(record, TWO_LINES)).length, 2);
});

test('the docs describe the subform replace: child ROWIDs are not kept across an edit', () => {
  const docs = readFileSync(join(TEMPLATE_DIR, '../../../docs/react-target.md'), 'utf8');
  assert.doesNotMatch(docs, /so an edit updates it/);
  assert.match(docs, /Removing every row deletes\s+them all/);
  assert.match(docs, /Child ROWIDs are not kept/);
  for (const file of ['subform/SubformGrid.tsx', 'subform/rows.ts']) {
    assert.doesNotMatch(readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui', file), 'utf8'), /an edit\s+(\*\s+)?updates/, file);
  }
});

test('Enter in an open lookup menu is always consumed: it chooses an option or does nothing, never submits', () => {
  const options = [{ disabled: true }, {}, {}];
  assert.equal(enterAction(false, -1, '', options), 'pass', 'a closed menu lets Enter through');
  assert.equal(enterAction(true, -1, '', options), 'consume', 'open, nothing highlighted, no query');
  assert.equal(enterAction(true, -1, 'acme', options), 1, 'a typed query takes its first enabled match');
  assert.equal(enterAction(true, -1, 'acme', []), 'consume', 'no match is still consumed');
  assert.equal(enterAction(true, 2, '', options), 2);
  assert.equal(enterAction(true, 0, '', options), 'consume', 'a disabled highlight chooses nothing');
  for (const name of ['combobox', 'multi-select']) {
    const source = readFileSync(join(TEMPLATE_DIR, `lib/c2c-ui/arc/components/${name}/${name}.tsx`), 'utf8');
    assert.match(source, /enterAction\(open, activeIndex,/, name);
    assert.doesNotMatch(source, /event\.key === "Enter" && open && activeIndex >= 0/, name);
  }
});

test('the multi-select exposes its keyboard highlight through aria-activedescendant', () => {
  assert.equal(activeDescendant(true, 1, 3, 'ms-listbox'), optionId('ms-listbox', 1));
  assert.equal(activeDescendant(false, 1, 3, 'ms-listbox'), undefined);
  assert.equal(activeDescendant(true, -1, 3, 'ms-listbox'), undefined);
  assert.equal(activeDescendant(true, 3, 3, 'ms-listbox'), undefined);
  const source = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/arc/components/multi-select/multi-select.tsx'), 'utf8');
  assert.match(source, /role="option" id=\{optionId\(`\$\{id\}-listbox`, index\)\}/);
  assert.match(source, /aria-label=\{`Search \$\{label\}`\}[^>]*aria-activedescendant=\{active\}/);
  assert.match(source, /aria-haspopup="listbox"[^>]*aria-activedescendant=\{searchable \? undefined : active\}/);
});

test('multi lookup and grid cell errors are linked to their control with aria-describedby', () => {
  const multi = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/arc/components/multi-select/multi-select.tsx'), 'utf8');
  assert.match(multi, /aria-haspopup="listbox"[^>]*aria-describedby=\{describedBy\}/);
  const lookup = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/lookup/LookupField.tsx'), 'utf8');
  assert.match(lookup, /<LookupMultiControl [^>]*describedBy=\{error \? errorId : undefined\}/);
  assert.match(lookup, /invalid=\{!!error\}\s+describedBy=\{describedBy\}/);
  const grid = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/subform/SubformGrid.tsx'), 'utf8');
  assert.match(grid, /<LookupControl [^>]*describedBy=\{described\}/);
  assert.match(grid, /<LookupMultiControl [^>]*describedBy=\{described\}/);
  assert.match(grid, /<FieldError name=\{name\} error=\{cellError\} id=\{errorId\} \/>/);
});

test('first-error focus lands on the invalid subform cell, a multi lookup trigger, or a field control', () => {
  const formEl = gridDom(`
    <div data-field="Buyer"><input role="combobox" id="buyer"><input type="hidden" name="Buyer"></div>
    <div data-field="Watchers"><button type="button" id="watchers">Select</button><select name="Watchers" multiple hidden></select></div>
    <div data-field="Lines"><fieldset data-subform="Lines"><table><tr>
      <td data-cell="Lines[0].Quantity"><input name="Lines[0].Quantity" id="q0"></td>
      <td data-cell="Lines[1].Item"><input id="item1" role="combobox"><input type="hidden" name="Lines[1].Item"></td>
      <td data-cell="Lines[1].Quantity"><input name="Lines[1].Quantity" id="q1"></td>
    </tr></table><button type="button" id="add">Add</button></fieldset></div>`);
  const id = (errors: Record<string, string>) => firstErrorControl(formEl, errors)?.id;
  assert.equal(id({ Lines: 'Check row 2 of Order Lines.', 'Lines[1].Quantity': 'Enter a number.' }), 'q1');
  assert.equal(id({ Lines: 'Check row 2.', 'Lines[1].Item': 'Enter Item in row 2.', 'Lines[1].Quantity': 'x' }), 'item1');
  assert.equal(id({ Watchers: 'Enter Watchers.' }), 'watchers');
  assert.equal(id({ Buyer: 'Enter Buyer.', Lines: 'Check row 1.', 'Lines[0].Quantity': 'x' }), 'buyer');
  assert.equal(id({ Lines: 'Enter Order Lines.' }), 'q0');
  assert.equal(id({ Missing: 'x' }), undefined);
  const view = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/form/FormView.tsx'), 'utf8');
  assert.match(view, /firstErrorControl\(formEl, found\)\?\.focus\(\)/);
});

test('lookup ids follow one rule, bare or wrapped: digit strings, bigints and safe integers only', () => {
  assert.deepEqual(lookupIds(['12', 13, 14n, { ROWID: '15' }, { value: 16 }]), ['12', '13', '14', '15', '16']);
  assert.deepEqual(lookupIds(12345678901234567890), [], 'a number past 2^53 has lost digits');
  assert.deepEqual(lookupIds({ ROWID: 12345678901234567890 }), []);
  assert.deepEqual(lookupIds('Acme Ltd'), []);
  assert.deepEqual(lookupIds({ ROWID: 'Acme Ltd' }), []);
  assert.deepEqual(lookupIds([-1, 1.5, true, null]), []);
  assert.deepEqual(lookupOptions({ rows: [{ ROWID: 'x', Name: 'bad' }, { ROWID: 2 ** 60, Name: 'lost' }, { ROWID: '3', Name: 'ok' }], field: 'Name' }), [{ value: '3', label: 'ok' }]);
});
