/**
 * A linked subform takes its columns from the other form. Name and address
 * columns expand into the same part controls as a top-level composite, each
 * with an element id that includes the parent field.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse } from '../../core/src/index.js';
import { clientRuntimeSource } from '../src/generate.js';
import { buildModel, type UiField, type UiForm } from '../src/model.js';

const APP = `
form Add_Company
{
	displayname = "Add Company"
	Company_Name
	(
		type = text
		displayname = "Company Name"
	)
	Branches
	(
		type = grid
		displayname = "Branches"
		values = Add_Site.ID
		bidirectional = Company
	)
}
form Add_Site
{
	displayname = "Add Site"
	Company
	(
		type = picklist
		values = Add_Company.ID
		bidirectional = Branches
		displayname = "Company"
	)
	Site_Name
	(
		type = text
		displayname = "Site Name"
	)
	Site_Contact
	(
		type = name
		displayname = "Site Contact"
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
	)
	Site_Address
	(
		type = address
		displayname = "Site Address"
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
		state_province
		(
			type = state_province
			displayname = "State"
		)
		postal_Code
		(
			type = postal_Code
			displayname = "Postal Code"
		)
		country
		(
			type = country
			displayname = "Country"
		)
		latitude
		(
			type = latitude
			displayname = "Latitude"
			visibility = false
		)
		longitude
		(
			type = longitude
			displayname = "Longitude"
			visibility = false
		)
	)
}
`;

const NAME_PARTS = ['first_name', 'last_name'];
const ADDRESS_PARTS = ['address_line_1', 'address_line_2', 'district_city', 'state_province', 'postal_Code', 'country'];

interface Control {
  id: string;
  value: string;
  getAttribute(name: string): string | null;
}

interface Row {
  querySelector(selector: string): Control | null;
  querySelectorAll(selector: string): ArrayLike<Control>;
}

interface Dom {
  querySelector(selector: string): { dispatchEvent(event: unknown): boolean; getAttribute(name: string): string | null } | null;
  querySelectorAll(selector: string): ArrayLike<{ id: string }>;
  defaultView: { Event: new (type: string, init?: { bubbles?: boolean }) => unknown } | null;
}

interface Runtime {
  renderForm(form: UiForm): string;
  submitRecord(formEl: unknown, form: UiForm): Promise<Record<string, unknown>>;
  installFormLayout?(doc: Dom): void;
}

function model() {
  return buildModel(deriveIr(parse(`application "Demo"\n{\n${APP}\n}\n`)));
}

function branchesOf(form: UiForm): UiField {
  const field = form.fields.find((item) => item.name === 'Branches');
  assert.ok(field);
  assert.equal(field.widget, 'subform');
  return field;
}

function composite(field: UiField, name: string): UiField {
  const found = (field.subfields ?? []).find((item) => item.name === name);
  assert.ok(found, name);
  return found;
}

function assertParts(field: UiField, names: string[], widget: 'text' | 'decimal'): void {
  assert.deepEqual((field.subfields ?? []).map((part) => part.name), names);
  for (const part of field.subfields ?? []) {
    assert.equal(part.widget, widget, part.name);
    assert.equal(part.status, 'generated', part.name);
    assert.equal(part.todo, undefined, part.name);
    assert.equal(names.filter((item) => item === part.name).length, 1, part.name);
  }
}

async function loadRuntime(): Promise<Runtime> {
  const source = clientRuntimeSource();
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as Runtime;
}

test('a linked subform expands name and address parts into controls with unique parent-prefixed ids', async () => {
  const built = model();
  const form = built.forms.find((item) => item.name === 'Add_Company');
  assert.ok(form);
  const branches = branchesOf(form);
  assert.deepEqual(
    (branches.subfields ?? []).map((column) => column.name),
    ['Site_Name', 'Site_Contact', 'Site_Address'],
  );
  const contact = composite(branches, 'Site_Contact');
  const address = composite(branches, 'Site_Address');
  assert.equal(contact.widget, 'name');
  assert.equal(address.widget, 'address');
  assertParts(contact, NAME_PARTS, 'text');
  assertParts(address, ADDRESS_PARTS, 'text');
  assert.equal(JSON.stringify(built).includes('No schema mapping'), false);

  const runtime = await loadRuntime();
  const doc = new JSDOM(`<!doctype html><body>${runtime.renderForm(form)}</body>`).window.document as unknown as Dom;
  runtime.installFormLayout!(doc);
  const add = doc.querySelector('[data-add-row="Branches"]');
  assert.ok(add);
  add.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
  const row = doc.querySelector('.subform[data-field="Branches"] tbody tr') as unknown as Row | null;
  assert.ok(row);

  for (const name of [...NAME_PARTS, ...ADDRESS_PARTS]) {
    const inputs = row.querySelectorAll(`input[name="${name}"]`);
    assert.equal(inputs.length, 1, name);
  }
  for (const name of ['prefix', 'suffix', 'latitude', 'longitude']) {
    assert.equal(row.querySelectorAll(`input[name="${name}"]`).length, 0, name);
  }

  const ids = Array.from(doc.querySelectorAll('[id]')).map((el) => el.id);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
  for (const name of NAME_PARTS) {
    const input = row.querySelector(`input[name="${name}"]`);
    assert.ok(input);
    assert.match(input.id, /Site_Contact/);
  }
  for (const name of ADDRESS_PARTS) {
    const input = row.querySelector(`input[name="${name}"]`);
    assert.ok(input);
    assert.match(input.id, /Site_Address/);
  }

  const first = row.querySelector('input[name="first_name"]');
  const line = row.querySelector('input[name="address_line_1"]');
  assert.ok(first);
  assert.ok(line);
  first.value = 'Ada';
  line.value = '1 High Street';
  const record = await runtime.submitRecord(doc.querySelector('form'), form);
  const rows = record.Branches as { Site_Contact?: { first_name?: string }; Site_Address?: { address_line_1?: string } }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.Site_Contact?.first_name, 'Ada');
  assert.equal(rows[0]?.Site_Address?.address_line_1, '1 High Street');
});
