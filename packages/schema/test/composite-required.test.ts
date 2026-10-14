/**
 * A required name or address requires the same parts on a server write as on
 * the form. A write that leaves one of those parts empty is refused. A write
 * that leaves only prefix or address line 2 empty is accepted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { writeRulesOf } from '../../deluge/src/generate.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { WriteRuleError } from '../../shims/src/write-rules.js';
import { buildModel, type UiField, type UiModel } from '../../ui/src/model.js';
import { generateSchema, type SchemaPlan } from '../src/generator.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function columnRequired(rules: ReturnType<typeof writeRulesOf>, table: string, column: string): boolean {
  return rules[table]?.some((item) => item.name === column && item.required === true) ?? false;
}

function agree(model: UiModel, rules: ReturnType<typeof writeRulesOf>, schema: SchemaPlan, formName: string): void {
  const form = model.forms.find((item) => item.name === formName);
  assert.ok(form, formName);
  const children = new Map<string, string>();
  for (const table of schema.tables) {
    if (table.role === 'child' && table.subform?.form === formName && table.subform.field) children.set(table.subform.field, table.name);
  }
  const walk = (fields: readonly UiField[], table: string, label: string): void => {
    for (const field of fields) {
      if (field.widget === 'name' || field.widget === 'address') {
        for (const part of field.subfields ?? []) {
          const column = `${field.name}_${part.name}`;
          assert.equal(columnRequired(rules, table, column), part.required === true, `${label} ${column}`);
        }
      } else if (field.widget === 'subform' && children.has(field.name)) {
        walk(field.subfields ?? [], children.get(field.name)!, `${label}.${field.name}`);
      }
    }
  };
  walk(form.fields, formName, formName);
}

function partRequired(model: UiModel, formName: string, path: readonly string[], part: string): boolean {
  let fields = model.forms.find((item) => item.name === formName)?.fields ?? [];
  let field: UiField | undefined;
  for (const name of path) {
    field = fields.find((item) => item.name === name);
    assert.ok(field, name);
    fields = field.subfields ?? [];
  }
  const found = field?.subfields?.find((item) => item.name === part);
  assert.ok(found, `${path.join('.')}.${part}`);
  return found.required === true;
}

const IDENTIFYING = `
form Application
{
	must have Applicant_Name
	(
		type = name
		prefix
		(
			type = prefix
		)
		first_name
		(
			type = first_name
		)
		last_name
		(
			type = last_name
		)
		suffix
		(
			type = suffix
		)
	)
	must have Primary_Address
	(
		type = address
		address_line_1
		(
			type = address_line_1
		)
		address_line_2
		(
			type = address_line_2
		)
		district_city
		(
			type = district_city
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
		)
		last_name
		(
			type = last_name
		)
	)
}
`;

const FALLBACK = `
form Application
{
	must have Legal_Name
	(
		type = name
		prefix
		(
			type = prefix
		)
		given
		(
			type = text
		)
		suffix
		(
			type = suffix
		)
	)
	must have Site
	(
		type = address
		address_line_2
		(
			type = address_line_2
		)
		district_city
		(
			type = district_city
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
`;

const GRID = `
form Application
{
	must have Task_List
	(
		type = grid
		must have Description
		(
			type = text
		)
		must have Person
		(
			type = name
			first_name
			(
				type = first_name
			)
			last_name
			(
				type = last_name
			)
		)
		Note
		(
			type = text
		)
	)
}
`;

const HIDDEN = `
form Add_User
{
	must have Name
	(
		type = name
		prefix
		(
			type = prefix
			visibility = false
		)
		first_name
		(
			type = first_name
		)
		last_name
		(
			type = last_name
		)
		suffix
		(
			type = suffix
			visibility = false
		)
	)
	Address
	(
		type = address
		address_line_1
		(
			type = address_line_1
		)
		address_line_2
		(
			type = address_line_2
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
	)
}
`;

const LINKED = `
form Add_Company
{
	Branches
	(
		type = grid
		values = Add_Site.ID
		bidirectional = Company
	)
}
form Add_Site
{
	Company
	(
		type = picklist
		values = Add_Company.ID
		bidirectional = Branches
	)
	Site_Contact
	(
		type = name
		prefix
		(
			type = prefix
			visibility = false
		)
		first_name
		(
			type = first_name
		)
		last_name
		(
			type = last_name
		)
		suffix
		(
			type = suffix
			visibility = false
		)
	)
	Site_Address
	(
		type = address
		address_line_1
		(
			type = address_line_1
		)
		address_line_2
		(
			type = address_line_2
		)
		district_city
		(
			type = district_city
		)
		state_province
		(
			type = state_province
		)
		postal_Code
		(
			type = postal_Code
		)
		country
		(
			type = country
		)
		latitude
		(
			type = latitude
			visibility = false
		)
		longitude
		(
			type = longitude
			visibility = false
		)
	)
}
`;

const DEFAULTS = `
form Application
{
	must have Bare_Name
	(
		type = name
	)
	must have Bare_Address
	(
		type = address
	)
}
`;

function opened(body: string): { app: App; model: UiModel; schema: SchemaPlan; rules: ReturnType<typeof writeRulesOf> } {
  const app = appOf(body);
  const schema = generateSchema(app);
  return { app, model: buildModel(app), schema, rules: writeRulesOf(app, schema) };
}

test('the form and the server require the same name and address parts', () => {
  const identifying = opened(IDENTIFYING);
  agree(identifying.model, identifying.rules, identifying.schema, 'Application');
  assert.equal(partRequired(identifying.model, 'Application', ['Applicant_Name'], 'first_name'), true);
  assert.equal(partRequired(identifying.model, 'Application', ['Applicant_Name'], 'last_name'), true);
  assert.equal(partRequired(identifying.model, 'Application', ['Applicant_Name'], 'prefix'), false);
  assert.equal(partRequired(identifying.model, 'Application', ['Applicant_Name'], 'suffix'), false);
  assert.equal(partRequired(identifying.model, 'Application', ['Primary_Address'], 'address_line_1'), true);
  assert.equal(partRequired(identifying.model, 'Application', ['Primary_Address'], 'address_line_2'), false);
  assert.equal(partRequired(identifying.model, 'Application', ['Primary_Address'], 'district_city'), false);
  assert.equal(partRequired(identifying.model, 'Application', ['Primary_Address'], 'latitude'), false);
  assert.equal(partRequired(identifying.model, 'Application', ['Primary_Address'], 'longitude'), false);
  assert.equal(partRequired(identifying.model, 'Application', ['Preferred_Name'], 'first_name'), false);
  assert.equal(partRequired(identifying.model, 'Application', ['Preferred_Name'], 'last_name'), false);
  assert.equal(columnRequired(identifying.rules, 'Application', 'Applicant_Name_first_name'), true);
  assert.equal(columnRequired(identifying.rules, 'Application', 'Applicant_Name_last_name'), true);
  assert.equal(columnRequired(identifying.rules, 'Application', 'Applicant_Name_prefix'), false);
  assert.equal(columnRequired(identifying.rules, 'Application', 'Applicant_Name_suffix'), false);
  assert.equal(columnRequired(identifying.rules, 'Application', 'Primary_Address_address_line_1'), true);
  assert.equal(columnRequired(identifying.rules, 'Application', 'Primary_Address_address_line_2'), false);
  assert.equal(columnRequired(identifying.rules, 'Application', 'Primary_Address_district_city'), false);
  assert.equal(columnRequired(identifying.rules, 'Application', 'Preferred_Name_first_name'), false);
  assert.equal(columnRequired(identifying.rules, 'Application', 'Preferred_Name_last_name'), false);

  const fallback = opened(FALLBACK);
  agree(fallback.model, fallback.rules, fallback.schema, 'Application');
  assert.equal(partRequired(fallback.model, 'Application', ['Legal_Name'], 'given'), true);
  assert.equal(partRequired(fallback.model, 'Application', ['Legal_Name'], 'prefix'), false);
  assert.equal(partRequired(fallback.model, 'Application', ['Legal_Name'], 'suffix'), false);
  assert.equal(partRequired(fallback.model, 'Application', ['Site'], 'district_city'), true);
  assert.equal(partRequired(fallback.model, 'Application', ['Site'], 'address_line_2'), false);
  assert.equal(partRequired(fallback.model, 'Application', ['Site'], 'latitude'), false);
  assert.equal(partRequired(fallback.model, 'Application', ['Site'], 'longitude'), false);
  assert.equal(columnRequired(fallback.rules, 'Application', 'Legal_Name_given'), true);
  assert.equal(columnRequired(fallback.rules, 'Application', 'Legal_Name_prefix'), false);
  assert.equal(columnRequired(fallback.rules, 'Application', 'Site_district_city'), true);
  assert.equal(columnRequired(fallback.rules, 'Application', 'Site_address_line_2'), false);
  assert.equal(columnRequired(fallback.rules, 'Application', 'Site_latitude'), false);
  assert.equal(columnRequired(fallback.rules, 'Application', 'Site_longitude'), false);

  const grid = opened(GRID);
  agree(grid.model, grid.rules, grid.schema, 'Application');
  const child = grid.schema.tables.find((table) => table.role === 'child' && table.subform?.field === 'Task_List');
  assert.ok(child);
  assert.equal(partRequired(grid.model, 'Application', ['Task_List', 'Person'], 'first_name'), true);
  assert.equal(partRequired(grid.model, 'Application', ['Task_List', 'Person'], 'last_name'), true);
  assert.equal(columnRequired(grid.rules, child.name, 'Person_first_name'), true);
  assert.equal(columnRequired(grid.rules, child.name, 'Person_last_name'), true);
  assert.equal(columnRequired(grid.rules, child.name, 'Note'), false);

  const hidden = opened(HIDDEN);
  agree(hidden.model, hidden.rules, hidden.schema, 'Add_User');
  assert.equal(partRequired(hidden.model, 'Add_User', ['Name'], 'first_name'), true);
  assert.equal(partRequired(hidden.model, 'Add_User', ['Name'], 'last_name'), true);
  assert.equal(hidden.model.forms.find((item) => item.name === 'Add_User')?.fields.find((item) => item.name === 'Name')?.subfields?.some((part) => part.name === 'prefix'), false);
  assert.equal(columnRequired(hidden.rules, 'Add_User', 'Name_first_name'), true);
  assert.equal(columnRequired(hidden.rules, 'Add_User', 'Name_last_name'), true);
  assert.equal(columnRequired(hidden.rules, 'Add_User', 'Name_prefix'), false);
  assert.equal(columnRequired(hidden.rules, 'Add_User', 'Name_suffix'), false);
  assert.equal(columnRequired(hidden.rules, 'Add_User', 'Address_address_line_1'), false);
  assert.equal(columnRequired(hidden.rules, 'Add_User', 'Address_address_line_2'), false);

  const linked = opened(LINKED);
  agree(linked.model, linked.rules, linked.schema, 'Add_Company');
  agree(linked.model, linked.rules, linked.schema, 'Add_Site');
  assert.equal(partRequired(linked.model, 'Add_Site', ['Site_Contact'], 'first_name'), false);
  assert.equal(partRequired(linked.model, 'Add_Site', ['Site_Contact'], 'last_name'), false);
  assert.equal(partRequired(linked.model, 'Add_Site', ['Site_Address'], 'address_line_1'), false);
  assert.equal(partRequired(linked.model, 'Add_Site', ['Site_Address'], 'postal_Code'), false);
  assert.equal(columnRequired(linked.rules, 'Add_Site', 'Site_Contact_first_name'), false);
  assert.equal(columnRequired(linked.rules, 'Add_Site', 'Site_Contact_last_name'), false);
  assert.equal(columnRequired(linked.rules, 'Add_Site', 'Site_Address_address_line_1'), false);
  assert.equal(columnRequired(linked.rules, 'Add_Site', 'Site_Address_postal_Code'), false);

  const defaults = opened(DEFAULTS);
  agree(defaults.model, defaults.rules, defaults.schema, 'Application');
  assert.equal(partRequired(defaults.model, 'Application', ['Bare_Name'], 'first_name'), true);
  assert.equal(partRequired(defaults.model, 'Application', ['Bare_Name'], 'last_name'), true);
  assert.equal(partRequired(defaults.model, 'Application', ['Bare_Name'], 'prefix'), false);
  assert.equal(partRequired(defaults.model, 'Application', ['Bare_Name'], 'suffix'), false);
  assert.equal(partRequired(defaults.model, 'Application', ['Bare_Address'], 'address_line_1'), true);
  assert.equal(partRequired(defaults.model, 'Application', ['Bare_Address'], 'address_line_2'), false);
  assert.equal(partRequired(defaults.model, 'Application', ['Bare_Address'], 'district_city'), false);
  assert.equal(partRequired(defaults.model, 'Application', ['Bare_Address'], 'latitude'), false);
  assert.equal(columnRequired(defaults.rules, 'Application', 'Bare_Name_first_name'), true);
  assert.equal(columnRequired(defaults.rules, 'Application', 'Bare_Name_last_name'), true);
  assert.equal(columnRequired(defaults.rules, 'Application', 'Bare_Name_prefix'), false);
  assert.equal(columnRequired(defaults.rules, 'Application', 'Bare_Address_address_line_1'), true);
  assert.equal(columnRequired(defaults.rules, 'Application', 'Bare_Address_address_line_2'), false);
  assert.equal(columnRequired(defaults.rules, 'Application', 'Bare_Address_district_city'), false);
});

test('a write missing a required name or address part is refused, and a missing optional part is accepted', async () => {
  const identifying = opened(IDENTIFYING);
  const full: Record<string, string> = {
    Applicant_Name_prefix: 'Ms',
    Applicant_Name_first_name: 'Ada',
    Applicant_Name_last_name: 'Lovelace',
    Applicant_Name_suffix: '',
    Primary_Address_address_line_1: '1 Road',
    Primary_Address_address_line_2: 'Unit 2',
    Primary_Address_district_city: 'London',
    Primary_Address_latitude: '1.25',
    Primary_Address_longitude: '2.5',
    Preferred_Name_first_name: '',
    Preferred_Name_last_name: '',
  };
  const calls: string[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    writeRules: identifying.rules,
    datastore: {
      async insert(form: string, rows: unknown) {
        calls.push(form);
        return rows;
      },
      async update() {
        return { updated: 0 };
      },
      async query() {
        return [];
      },
    },
  });
  const ctx = runtime.context({});
  const attempt = async (row: Record<string, string>) =>
    runtime.shim.datastore.insert(ctx, 'Application', row).then(
      () => null,
      (err: unknown) => err,
    );

  for (const column of ['Applicant_Name_first_name', 'Applicant_Name_last_name', 'Primary_Address_address_line_1']) {
    const blank = { ...full, [column]: '' };
    const err = await attempt(blank);
    assert.ok(err instanceof WriteRuleError, column);
    assert.equal(err.code, 'MANDATORY_MISSING', column);
    assert.equal(err.field, column, column);
    const absent = { ...full };
    delete absent[column];
    const missing = await attempt(absent);
    assert.ok(missing instanceof WriteRuleError, column);
    assert.equal(missing.field, column, column);
  }

  const noPrefix = { ...full };
  delete noPrefix.Applicant_Name_prefix;
  assert.equal(await attempt(noPrefix), null);
  const noLine2 = { ...full };
  delete noLine2.Primary_Address_address_line_2;
  assert.equal(await attempt(noLine2), null);
  assert.equal(await attempt({ ...full, Applicant_Name_prefix: '', Primary_Address_address_line_2: '' }), null);

  const fallback = opened(FALLBACK);
  const fallbackRuntime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    writeRules: fallback.rules,
    datastore: {
      async insert(_form: string, rows: unknown) {
        return rows;
      },
      async update() {
        return { updated: 0 };
      },
      async query() {
        return [];
      },
    },
  });
  const fallbackCtx = fallbackRuntime.context({});
  const fallbackAttempt = async (row: Record<string, string>) =>
    fallbackRuntime.shim.datastore.insert(fallbackCtx, 'Application', row).then(
      () => null,
      (err: unknown) => err,
    );
  const fallbackRow: Record<string, string> = {
    Legal_Name_prefix: 'Dr',
    Legal_Name_given: 'Ada',
    Legal_Name_suffix: '',
    Site_address_line_2: 'Unit 2',
    Site_district_city: 'London',
    Site_latitude: '1.25',
    Site_longitude: '2.5',
  };
  for (const column of ['Legal_Name_given', 'Site_district_city']) {
    const err = await fallbackAttempt({ ...fallbackRow, [column]: '' });
    assert.ok(err instanceof WriteRuleError, column);
    assert.equal(err.code, 'MANDATORY_MISSING', column);
    assert.equal(err.field, column, column);
  }
  const optionalPrefix = { ...fallbackRow };
  delete optionalPrefix.Legal_Name_prefix;
  assert.equal(await fallbackAttempt(optionalPrefix), null);
  const optionalLine2 = { ...fallbackRow };
  delete optionalLine2.Site_address_line_2;
  assert.equal(await fallbackAttempt(optionalLine2), null);
  const optionalLatitude = { ...fallbackRow };
  delete optionalLatitude.Site_latitude;
  assert.equal(await fallbackAttempt(optionalLatitude), null);

  const grid = opened(GRID);
  const child = grid.schema.tables.find((table) => table.role === 'child' && table.subform?.field === 'Task_List');
  assert.ok(child);
  const gridRuntime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    writeRules: grid.rules,
    datastore: {
      async insert(_form: string, rows: unknown) {
        return rows;
      },
      async update() {
        return { updated: 0 };
      },
      async query() {
        return [];
      },
    },
  });
  const gridCtx = gridRuntime.context({});
  const gridAttempt = async (row: Record<string, string>) =>
    gridRuntime.shim.datastore.insert(gridCtx, child.name, row).then(
      () => null,
      (err: unknown) => err,
    );
  const gridRow: Record<string, string> = {
    parent_id: '1',
    Description: 'Lift',
    Person_first_name: 'Ada',
    Person_last_name: 'Lovelace',
    Note: 'later',
  };
  for (const column of ['Person_first_name', 'Person_last_name']) {
    const err = await gridAttempt({ ...gridRow, [column]: '' });
    assert.ok(err instanceof WriteRuleError, column);
    assert.equal(err.code, 'MANDATORY_MISSING', column);
    assert.equal(err.field, column, column);
  }
  const noNote = { ...gridRow };
  delete noNote.Note;
  assert.equal(await gridAttempt(noNote), null);
  assert.deepEqual(calls, ['Application', 'Application', 'Application']);
});
