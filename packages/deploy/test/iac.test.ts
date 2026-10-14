import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateSchema, type SchemaPlan } from '../../schema/src/index.js';
import { authPlan } from '../../auth/src/plan.js';
import { loadApp } from '../src/cli.js';
import { diffTemplate, formatDrift, IAC_COMPONENT_ORDER, importTemplate, importTemplateJson, normalizeTemplate, projectTemplate, projectTemplateJson, type TemplateItem } from '../src/iac.js';
import { iacImportBundle, zipStore } from '../src/iac-import.js';

function planOf(body: string): SchemaPlan {
  return generateSchema(deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`)));
}

function field(name: string, type: string, extra = '', modifiers = ''): string {
  const head = modifiers ? `${modifiers} ${name}` : name;
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${head}\n\t\t(\n${lines}\n\t\t)`;
}

function form(name: string, fields: string): string {
  return `\tform ${name}\n\t{\n${fields}\n\t}`;
}

const SALES = planOf(
  [
    form('Customer', field('Name', 'text', '', 'must have')),
    form('Orders', [field('Amount', 'number'), field('Price', 'decimal'), field('Customer', 'picklist', '\t\t\tvalues = Customer.Name')].join('\n')),
  ].join('\n'),
);

function item(items: readonly TemplateItem[], type: string, name: string): TemplateItem {
  const found = items.find((i) => i.type === type && i.name === name);
  assert.ok(found, `${type} ${name} not in template: ${items.map((i) => i.name).join(', ')}`);
  return found;
}

test('template is the real Catalyst project-template-1.0.0 envelope', () => {
  const template = projectTemplate(SALES);
  assert.deepEqual(Object.keys(template), ['name', 'version', 'parameters', 'components']);
  assert.equal(template.name, 'project-template');
  assert.equal(template.version, '1.0.0');
  assert.deepEqual(template.parameters, {});
  assert.deepEqual(Object.keys(template.components), ['Datastore', 'Functions']);
  for (const items of Object.values(template.components)) {
    for (const i of items) assert.deepEqual(Object.keys(i), ['type', 'name', 'properties', 'dependsOn']);
  }
});

test('Datastore items: tables first, then columns with lowercase data_type and names as references', () => {
  const ds = projectTemplate(SALES).components.Datastore;
  const types = ds.map((i) => i.type);
  assert.deepEqual(types.slice(0, 2), ['table', 'table']);
  assert.ok(types.slice(2).every((t) => t === 'column'));
  assert.deepEqual(item(ds, 'table', 'Customer'), { type: 'table', name: 'Customer', properties: { table_name: 'Customer' }, dependsOn: [] });

  const name = item(ds, 'column', 'Customer-Name');
  assert.equal(name.properties.data_type, 'varchar');
  assert.equal(name.properties.max_length, 255);
  assert.equal(name.properties.is_mandatory, true);
  assert.equal(name.properties.table_id, 'Customer');
  assert.equal(name.properties.table_name, 'Customer');
  assert.deepEqual(name.dependsOn, ['Datastore.table.Customer']);

  const source = item(ds, 'column', 'Customer-c2c_source_id');
  // Nullable and not store-unique; the loader keeps it unique per table.
  assert.equal(source.properties.is_unique, false);
  assert.equal(source.properties.is_mandatory, false);

  const amount = item(ds, 'column', 'Orders-Amount');
  assert.equal(amount.properties.data_type, 'bigint');
  assert.equal(amount.properties.max_length, undefined);

  const fk = item(ds, 'column', 'Orders-Customer');
  assert.deepEqual(fk.properties, {
    column_name: 'Customer',
    data_type: 'foreign key',
    is_unique: false,
    is_mandatory: false,
    search_index_enabled: false,
    audit_consent: false,
    parent_table: 'Customer',
    parent_column: 'ROWID',
    constraint_type: 'ON-DELETE-SET-NULL',
    table_id: 'Orders',
    table_name: 'Orders',
  });
  assert.deepEqual(fk.dependsOn, ['Datastore.column.ROWID', 'Datastore.table.Customer', 'Datastore.table.Orders']);
});

test('columns keep schema order, so an FK is not moved behind the system columns', () => {
  const ds = projectTemplate(SALES).components.Datastore;
  const orders = ds.filter((i) => i.type === 'column' && i.properties.table_name === 'Orders').map((i) => i.properties.column_name);
  const schema = SALES.tables.find((t) => t.name === 'Orders')!.columns.map((c) => c.name);
  assert.deepEqual(orders, schema);
});

test('a double column carries max_length 15 and its decimal digits as numbers', () => {
  const plan = planOf(form('Item', field('Weight', 'decimal')));
  const table = plan.tables[0];
  table.columns.push({ name: 'Ratio', creatorType: 'decimal', matrixId: 't', status: 'supported', dataType: 'Double', precision: 4, mandatory: false, unique: false });
  const ratio = item(projectTemplate(plan).components.Datastore, 'column', `${table.name}-Ratio`);
  assert.equal(ratio.properties.data_type, 'double');
  assert.equal(ratio.properties.max_length, 15);
  assert.equal(ratio.properties.decimal_digits, 4);
});

test('NoSQL tables and Signals rules are not in the template', () => {
  const plan = structuredClone(SALES);
  const orders = plan.tables.find((t) => t.name === 'Orders')!;
  orders.nosql = true;
  plan.signals.push({ table: 'Customer', event: 'row_inserted', target: 'event-function', note: 'n' });
  const template = projectTemplate(plan);
  const text = JSON.stringify(template);
  assert.ok(!template.components.Datastore.some((i) => i.properties.table_name === 'Orders'));
  assert.doesNotMatch(text, /Signals|row_inserted|Circuits|EventListeners|"Cron"/);
});

test('function env vars are names only; values are blank in the template', () => {
  const fn = item(projectTemplate(SALES).components.Functions, 'function', 'c2c_api');
  assert.deepEqual(fn.properties, {
    name: 'c2c_api',
    type: 'applogic',
    stack: 'node20',
    code: { path: 'functions/c2c_api.zip' },
    configuration: { memory: 256, environment: { variables: { C2C_DEPLOY_MODE: '' } } },
  });
  const custom = projectTemplate(SALES, [{ name: 'job1', type: 'job', stack: 'node20', memory: 512, env: ['Z_KEY', 'A_KEY', 'Z_KEY'] }]);
  const vars = (item(custom.components.Functions, 'function', 'job1').properties.configuration as { environment: { variables: Record<string, string> } }).environment.variables;
  assert.deepEqual(Object.keys(vars), ['A_KEY', 'Z_KEY']);
  assert.ok(Object.values(vars).every((v) => v === ''));
  assert.deepEqual(Object.keys(projectTemplate(SALES, []).components), ['Datastore']);
});

test('template JSON is byte-stable: same bytes twice, 2-space, LF, trailing newline', () => {
  const a = projectTemplateJson(SALES);
  const b = projectTemplateJson(structuredClone(SALES));
  assert.equal(a, b);
  assert.ok(a.endsWith('}\n'));
  assert.ok(!a.includes('\r'));
  assert.match(a, /^\{\n {2}"name": "project-template",\n/);
  assert.deepEqual(JSON.parse(a), projectTemplate(SALES));
});

// --- drift --------------------------------------------------------------------

/**
 * A Catalyst project template example, trimmed to the tested Datastore and
 * Functions shapes. This is the expected template.
 */
const DOC_TEMPLATE = {
  name: 'project-template',
  version: '1.0.0',
  parameters: {},
  components: {
    Datastore: [
      { type: 'table', name: 'Customer', properties: { table_name: 'Customer' }, dependsOn: [] },
      { type: 'table', name: 'Orders', properties: { table_name: 'Orders' }, dependsOn: [] },
      {
        type: 'column',
        name: 'Customer-name',
        properties: { column_name: 'name', data_type: 'varchar', max_length: 100, is_unique: false, is_mandatory: true, search_index_enabled: false, audit_consent: false, table_id: 'Customer', table_name: 'Customer' },
        dependsOn: ['Datastore.table.Customer'],
      },
      {
        type: 'column',
        name: 'Orders-amount',
        properties: { column_name: 'amount', data_type: 'double', max_length: 15, decimal_digits: 2, is_unique: false, is_mandatory: false, search_index_enabled: false, audit_consent: false, table_id: 'Orders', table_name: 'Orders' },
        dependsOn: ['Datastore.table.Orders'],
      },
      {
        type: 'column',
        name: 'Orders-customer',
        properties: {
          column_name: 'customer',
          data_type: 'foreign key',
          parent_table: 'Customer',
          parent_column: 'ROWID',
          constraint_type: 'ON-DELETE-SET-NULL',
          is_unique: false,
          is_mandatory: false,
          search_index_enabled: false,
          table_id: 'Orders',
          table_name: 'Orders',
        },
        dependsOn: ['Datastore.column.ROWID', 'Datastore.table.Customer', 'Datastore.table.Orders'],
      },
    ],
    Functions: [
      {
        type: 'function',
        name: 'dailysummary',
        properties: { name: 'dailysummary', type: 'job', stack: 'node20', code: { path: 'functions/dailysummary.zip' }, configuration: { memory: 256, environment: { variables: { API_KEY: '' } } } },
        dependsOn: [],
      },
    ],
  },
};

/**
 * A hand-recorded `iac:export` of a project built from DOC_TEMPLATE, written from
 * the doc's description of an export (not a live export): server ids and
 * timestamps, an env var value in clear text, Catalyst-filled column defaults,
 * string numbers, the default role scopes/permissions, the Default cache segment,
 * reordered items and dependsOn, and the empty component keys every export has.
 */
function recordedExport(): Record<string, unknown> {
  return {
    name: 'project-template',
    version: '1.0.0',
    parameters: {},
    components: {
      Pipelines: [],
      Stratus: [],
      Functions: [
        {
          type: 'function',
          name: 'dailysummary',
          properties: {
            id: '10000000000099001',
            name: 'dailysummary',
            type: 'job',
            stack: 'node20',
            code: { path: 'functions/dailysummary.zip' },
            configuration: { memory: 256, environment: { variables: { API_KEY: 'sk-live-not-a-real-secret' } } },
            last_updated_time: '2026-10-05 19:22:01',
          },
          dependsOn: [],
        },
      ],
      Cron: [],
      Datastore: [
        { type: 'table', name: 'Orders', properties: { table_name: 'Orders', id: '10000000000013100' }, dependsOn: [] },
        { type: 'table', name: 'Customer', properties: { table_name: 'Customer', id: '10000000000013101' }, dependsOn: [] },
        {
          type: 'column',
          name: 'Customer-name',
          properties: { audit_consent: false, decimal_digits: 2, column_name: 'name', data_type: 'varchar', is_unique: false, is_mandatory: true, search_index_enabled: false, table_id: 'Customer', table_name: 'Customer', max_length: '100' },
          dependsOn: ['Datastore.table.Customer'],
        },
        {
          type: 'column',
          name: 'Orders-amount',
          properties: { audit_consent: false, decimal_digits: '2', column_name: 'amount', data_type: 'double', is_unique: false, is_mandatory: false, search_index_enabled: false, table_id: 'Orders', table_name: 'Orders', max_length: 15 },
          dependsOn: ['Datastore.table.Orders'],
        },
        {
          type: 'column',
          name: 'Orders-customer',
          properties: {
            audit_consent: false,
            decimal_digits: 2,
            max_length: 50,
            column_name: 'customer',
            data_type: 'foreign key',
            parent_table: 'Customer',
            parent_column: 'ROWID',
            constraint_type: 'ON-DELETE-SET-NULL',
            is_unique: false,
            is_mandatory: false,
            search_index_enabled: false,
            table_id: 'Orders',
            table_name: 'Orders',
          },
          dependsOn: ['Datastore.table.Orders', 'Datastore.table.Customer', 'Datastore.column.ROWID'],
        },
        {
          type: 'tableScope',
          name: 'Orders-App User',
          properties: { role_name: 'App User', table_scope: 'GLOBAL', type: 'App User', table_name: 'Orders' },
          dependsOn: ['Datastore.table.Orders'],
        },
        {
          type: 'tablePermission',
          name: 'Orders-App Administrator',
          properties: { role_name: 'App Administrator', type: 'App Administrator', table_permissions: ['SELECT', 'UPDATE', 'INSERT', 'DELETE'], table_name: 'Orders' },
          dependsOn: ['Datastore.table.Orders'],
        },
      ],
      Cache: [{ type: 'segment', name: 'Default', properties: { segment_name: 'Default', id: '10000000000013200' }, dependsOn: [] }],
      Authentication: [{ type: 'roles', name: 'App User', properties: { role_name: 'App User' }, dependsOn: [] }],
    },
  };
}

function datastore(doc: Record<string, unknown>): Record<string, unknown>[] {
  return (doc.components as Record<string, Record<string, unknown>[]>).Datastore;
}

test('normalizer drops ids and timestamps and blanks env values', () => {
  const normalized = normalizeTemplate(recordedExport());
  const fn = normalized.get('Functions.function.dailysummary')!;
  assert.equal(fn.properties.id, undefined);
  assert.equal(fn.properties.last_updated_time, undefined);
  assert.deepEqual(fn.properties.configuration, { environment: { variables: { API_KEY: '' } }, memory: 256 });
  assert.doesNotMatch(JSON.stringify([...normalized.values()]), /sk-live|10000000000/);
  assert.deepEqual(normalized.get('Datastore.column.Orders-customer')!.dependsOn, ['Datastore.column.ROWID', 'Datastore.table.Customer', 'Datastore.table.Orders']);
});

test('normalizer reads top-level component arrays when there is no components envelope', () => {
  const flat = { name: 'project-template', version: '1.0.0', component_keys: ['Datastore'], Datastore: datastore(recordedExport()) };
  assert.ok(normalizeTemplate(flat).has('Datastore.table.Orders'));
  assert.throws(() => normalizeTemplate([]), /not a JSON object/);
});

test('drift: the recorded export of the doc template is exact (exit 0)', () => {
  const report = diffTemplate(DOC_TEMPLATE, recordedExport());
  assert.deepEqual(report, { exitCode: 0, missing: [], changed: [], extra: [] });
  assert.equal(formatDrift(report), 'drift: none\nmissing:\n- none\nchanged:\n- none\nextra:\n- none\n');
});

test('drift: a missing column and a changed length are exit 1', () => {
  const exported = recordedExport();
  const items = datastore(exported);
  items.splice(items.findIndex((i) => i.name === 'Orders-amount'), 1);
  (items.find((i) => i.name === 'Customer-name')!.properties as Record<string, unknown>).max_length = 50;
  const report = diffTemplate(DOC_TEMPLATE, exported);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.missing, ['Datastore.column.Orders-amount']);
  assert.deepEqual(report.changed, [{ key: 'Datastore.column.Customer-name', field: 'max_length', expected: 100, actual: 50 }]);
  assert.match(formatDrift(report), /^drift: missing or changed\nmissing:\n- Datastore\.column\.Orders-amount\nchanged:\n- Datastore\.column\.Customer-name max_length: expected 100 actual 50\n/);
});

test('drift: changed dependsOn and a property the export lacks are reported', () => {
  const exported = recordedExport();
  const fk = datastore(exported).find((i) => i.name === 'Orders-customer')!;
  fk.dependsOn = ['Datastore.table.Orders'];
  delete (fk.properties as Record<string, unknown>).constraint_type;
  const report = diffTemplate(DOC_TEMPLATE, exported);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(
    report.changed.map((c) => [c.field, c.actual]),
    [
      ['constraint_type', null],
      ['dependsOn', ['Datastore.table.Orders']],
    ],
  );
});

test('drift: an undeclared table or custom role permission is extra (exit 2); defaults and unused components are not', () => {
  const exported = recordedExport();
  datastore(exported).push(
    { type: 'table', name: 'Scratch', properties: { table_name: 'Scratch' }, dependsOn: [] },
    { type: 'tablePermission', name: 'Orders-c2c_manager', properties: { role_name: 'c2c_manager', table_permissions: ['SELECT'], table_name: 'Orders' }, dependsOn: [] },
  );
  const report = diffTemplate(DOC_TEMPLATE, exported);
  assert.equal(report.exitCode, 2);
  assert.deepEqual(report.extra, ['Datastore.table.Scratch', 'Datastore.tablePermission.Orders-c2c_manager']);
  assert.deepEqual(report.missing, []);
});

test('drift: a generated template round-trips through an export-shaped copy with no drift', () => {
  const template = JSON.parse(projectTemplateJson(SALES)) as { components: Record<string, Record<string, unknown>[]> };
  let n = 0;
  const exported = structuredClone(template);
  for (const items of Object.values(exported.components)) {
    items.reverse();
    for (const i of items) Object.assign(i.properties as object, { id: `1000000000000${1000 + n++}`, last_updated_time: '2026-10-05 19:22:01' });
  }
  for (const fn of exported.components.Functions) {
    ((fn.properties as { configuration: { environment: { variables: Record<string, string> } } }).configuration.environment.variables).C2C_DEPLOY_MODE = 'live';
  }
  assert.equal(diffTemplate(template, exported).exitCode, 0);
  exported.components.Datastore.pop();
  assert.equal(diffTemplate(template, exported).exitCode, 1);
});

test('an app-unique column is created store-level non-unique, with no non-Catalyst property', () => {
  const plan = planOf(
    form(
      'Add_User',
      [
        field('Mail_ID', 'email', '', 'must have unique'),
        field('Phone', 'phonenumber', '', 'unique'),
        field('Code', 'text', '', 'unique'),
      ].join('\n'),
    ),
  );
  const datastore = projectTemplate(plan).components.Datastore;
  const unique = (name: string) => item(datastore, 'column', `Add_User-${name}`).properties.is_unique;
  assert.deepEqual(['Mail_ID', 'Phone', 'Code'].map(unique), [true, true, false]);
  // The template only carries Catalyst keys, so an exact export still reports no drift.
  const code = item(datastore, 'column', 'Add_User-Code');
  assert.ok(!Object.keys(code.properties).some((key) => /unique/i.test(key) && key !== 'is_unique'));
  const copy = JSON.parse(projectTemplateJson(plan));
  assert.equal(diffTemplate(projectTemplate(plan), copy).exitCode, 0);
});

// --- import template (the whole project in one IaC import) ---------------------

const DS_ROLES = `application "Widget"
{
\ttime zone = "Asia/Kolkata"
\tsection S
\t{
\t\tform Item
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tlist L
\t\t{
\t\t\tshow all rows from Item
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tL = {"View","Edit","Add","Delete"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tL = {"Viewall"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\troles
\t{
\t\tCEO
\t\t{
\t\t\tdescription = "Top"
\t\t}
\t}
}
`;

function importDoc(): ReturnType<typeof importTemplate> {
  const app = deriveIr(parse(DS_ROLES));
  const auth = authPlan(app);
  return importTemplate({ plan: generateSchema(app), roles: auth.roles, tablePermissions: auth.tablePermissions });
}

test('import template: every export component key in the export order, empties included', () => {
  const template = importDoc();
  assert.deepEqual(Object.keys(template.components), [...IAC_COMPONENT_ORDER]);
  for (const key of ['Pipelines', 'ApplicationAlerts', 'Stratus', 'Add-onServices', 'WebClient', 'Cron', 'SchedulingJobpool', 'Filestore', 'Mail', 'Zia', 'AppSail', 'EventListeners', 'SchedulingCron']) {
    assert.deepEqual(template.components[key], [], `${key} should be an empty array`);
  }
  for (const items of Object.values(template.components)) {
    for (const i of items) assert.deepEqual(Object.keys(i), ['type', 'name', 'properties', 'dependsOn']);
  }
});

test('Authentication: built-in roles, custom roles cloned from their base, SignupConfiguration, HostedLogin', () => {
  const auth = importDoc().components.Authentication;
  const kinds = auth.map((i) => `${i.type}:${i.name}`);
  // Export order: the two email templates, roles, signup, hosted login.
  assert.deepEqual(kinds.slice(0, 2), ['emailTemplates:1', 'emailTemplates:2']);
  const roles = auth.filter((i) => i.type === 'roles');
  assert.deepEqual(roles.map((i) => i.name), ['App Administrator', 'App User', 'Staff', 'Administrator', 'CEO']);
  const appUser = item(roles, 'roles', 'App User');
  assert.equal(appUser.properties.is_default, true);
  assert.deepEqual(appUser.dependsOn, []);
  const appAdmin = item(roles, 'roles', 'App Administrator');
  assert.equal(appAdmin.properties.type, 'App Administrator');
  assert.deepEqual(appAdmin.dependsOn, ['Authentication.roles.App User']);
  for (const name of ['Staff', 'Administrator', 'CEO']) {
    const role = item(roles, 'roles', name);
    assert.equal(role.properties.role_name, name);
    assert.equal(role.properties.type, 'Custom');
    assert.equal(role.properties.is_default, false);
    // Each custom role depends on the base it clones: Administrator clones the admin base.
    const base = name === 'Administrator' ? 'App Administrator' : 'App User';
    assert.deepEqual(role.dependsOn, [`Authentication.roles.${base}`], `${name} clones ${base}`);
  }
  const signup = item(auth, 'SignupConfiguration', 'signup-configuration');
  assert.deepEqual(signup.properties, {
    app_account_meta: { limit: 1000, type: 0 },
    custom_validation: false,
    public_signup: false,
    url_preference: 0,
    status: { embedded_auth: true, third_party_auth: false, hosted_auth: true },
  });
  const hosted = item(auth, 'HostedLogin', 'hosted-login');
  assert.deepEqual((hosted.properties.config as { is_logo_present: boolean }).is_logo_present, false);
});

test('Datastore groups each table as table, columns, tableScope then tablePermission per role', () => {
  const ds = importDoc().components.Datastore;
  const seq: string[] = [];
  for (const i of ds) {
    const key = `${i.properties.table_name}:${i.type}`;
    if (seq[seq.length - 1] !== key) seq.push(key);
  }
  assert.deepEqual(seq, ['Item:table', 'Item:column', 'Item:tableScope', 'Item:tablePermission']);
  // Scope/permission rows follow the roles order: built-ins first, then customs.
  const scopes = ds.filter((i) => i.type === 'tableScope').map((i) => i.properties.role_name);
  const perms = ds.filter((i) => i.type === 'tablePermission').map((i) => i.properties.role_name);
  assert.deepEqual(scopes, perms);
  assert.deepEqual([...new Set(scopes)], ['App Administrator', 'App User', 'Staff', 'Administrator', 'CEO']);
});

test('a grant row carries the role type, the Catalyst verb order and the table dependency', () => {
  const ds = importDoc().components.Datastore;
  const staffPerm = item(ds, 'tablePermission', 'Item-Staff');
  assert.equal(staffPerm.properties.role_name, 'Staff');
  assert.equal(staffPerm.properties.type, 'Custom');
  assert.equal(staffPerm.properties.table_name, 'Item');
  assert.deepEqual(staffPerm.properties.table_permissions, ['SELECT', 'UPDATE', 'INSERT', 'DELETE']);
  assert.deepEqual(staffPerm.dependsOn, ['Datastore.table.Item']);
  const staffScope = item(ds, 'tableScope', 'Item-Staff');
  assert.deepEqual(staffScope.properties, { role_name: 'Staff', table_scope: 'ORG', type: 'Custom', table_name: 'Item' });
  assert.deepEqual(staffScope.dependsOn, ['Datastore.table.Item']);
  // A Viewall grant is GLOBAL; an admin profile's grants keep the admin role type.
  const adminScope = item(ds, 'tableScope', 'Item-Administrator');
  assert.equal(adminScope.properties.table_scope, 'GLOBAL');
  assert.equal(adminScope.properties.type, 'Custom');
});

test('a column with a static initial value carries default_value into the template', () => {
  // columnBody() sets default_value from a static "initial value"; the template
  // must carry it — the re-exported project keeps it.
  const plan = planOf(form('Item', field('Status', 'text', '\t\t\tinitial value = "Draft"')));
  const template = importTemplate({ plan, roles: [], tablePermissions: [] });
  assert.equal(item(template.components.Datastore, 'column', 'Item-Status').properties.default_value, 'Draft');
});

test('every role the template defines gets a scope and a permission row per table', () => {
  // An ungranted role is not absent — the import writes the Catalyst default of
  // its clone base, so a dropped grant is a verify mismatch, not a gap.
  const ds = importDoc().components.Datastore;
  const scopes = ds.filter((i) => i.type === 'tableScope');
  const perms = ds.filter((i) => i.type === 'tablePermission');
  const roles = ['App Administrator', 'App User', 'Staff', 'Administrator', 'CEO'];
  assert.deepEqual(scopes.map((i) => i.name), roles.map((role) => `Item-${role}`));
  assert.deepEqual(perms.map((i) => i.name), roles.map((role) => `Item-${role}`));
  const scopeOf = (role: string) => item(scopes, 'tableScope', `Item-${role}`).properties.table_scope;
  const permOf = (role: string) => item(perms, 'tablePermission', `Item-${role}`).properties.table_permissions;
  // The built-ins carry their Catalyst defaults (admin CRUD, user read).
  assert.deepEqual(permOf('App Administrator'), ['SELECT', 'UPDATE', 'INSERT', 'DELETE']);
  assert.equal(scopeOf('App Administrator'), 'GLOBAL');
  assert.deepEqual(permOf('App User'), ['SELECT']);
  assert.equal(scopeOf('App User'), 'GLOBAL');
  // A role the auth plan grants keeps that grant (Staff: CRUD on ORG rows).
  assert.deepEqual(permOf('Staff'), ['SELECT', 'UPDATE', 'INSERT', 'DELETE']);
  assert.equal(scopeOf('Staff'), 'ORG');
  // A role the auth plan leaves out gets its clone base's default: CEO clones
  // App User, so it reads every row (GLOBAL) but cannot write.
  assert.deepEqual(permOf('CEO'), ['SELECT']);
  assert.equal(scopeOf('CEO'), 'GLOBAL');
});

test('an ungranted role cloned from App Administrator defaults to the admin grant', () => {
  const plan = planOf(form('Item', field('Name', 'text')));
  const template = importTemplate({
    plan,
    roles: [{ role_name: 'Boss', clone_role: 'App Administrator' }],
    tablePermissions: [],
  });
  const ds = template.components.Datastore;
  assert.deepEqual(item(ds, 'tablePermission', 'Item-Boss').properties.table_permissions, ['SELECT', 'UPDATE', 'INSERT', 'DELETE']);
  assert.equal(item(ds, 'tableScope', 'Item-Boss').properties.table_scope, 'GLOBAL');
});

// --- the generated L1 template against the real project's re-export ------------

/**
 * The local fixture directory: C2C_FIXTURES_DIR, or undefined. The fixture
 * carries the L1 app plus the project template its Catalyst project re-exports.
 */
function fixturesDir(): string | undefined {
  return process.env.C2C_FIXTURES_DIR || undefined;
}
const FIXTURES = fixturesDir();
const L1_APP_DS = FIXTURES ? join(FIXTURES, 'synthetic', 's01-purchase-orders', 'L1', 'c2c-syn-po-l1.exported.ds') : '';
const REAL_L1_TEMPLATE = FIXTURES ? join(FIXTURES, 'iac-template', 'full-l1', 'project-template-1.0.0.json') : '';
const realFixtureSkip =
  !FIXTURES || !statSync(REAL_L1_TEMPLATE, { throwIfNoEntry: false })?.isFile() || !statSync(L1_APP_DS, { throwIfNoEntry: false })?.isFile()
    ? 'C2C_FIXTURES_DIR L1 app + re-exported template not available'
    : false;

interface RealItem {
  type: string;
  name: string;
  properties: Record<string, unknown>;
}

function generatedL1(): ReturnType<typeof importTemplate> {
  const app = loadApp(L1_APP_DS);
  const auth = authPlan(app);
  return importTemplate({ plan: generateSchema(app), roles: auth.roles, tablePermissions: auth.tablePermissions });
}

test('the generated L1 columns carry every attribute the real re-export sets', { skip: realFixtureSkip }, () => {
  const real = JSON.parse(readFileSync(REAL_L1_TEMPLATE, 'utf8')) as { components: { Datastore: RealItem[] } };
  const realCols = real.components.Datastore.filter((i) => i.type === 'column');
  const genCols = new Map(generatedL1().components.Datastore.filter((i) => i.type === 'column').map((i) => [i.name, i]));
  assert.equal(genCols.size, realCols.length, 'column count differs from the real export');
  // decimal_digits and max_length on types that do not declare them are
  // Catalyst-filled export noise — the template emits them only where the
  // schema defines them.
  const noise = new Set(['decimal_digits', 'max_length']);
  for (const realItem of realCols) {
    const got = genCols.get(realItem.name);
    assert.ok(got, `generated template misses column ${realItem.name}`);
    for (const [key, value] of Object.entries(got.properties)) {
      assert.deepEqual(realItem.properties[key], value, `${realItem.name}.${key} differs from the real export`);
    }
    for (const [key, value] of Object.entries(realItem.properties)) {
      if (noise.has(key) && got.properties[key] === undefined) continue;
      assert.deepEqual(got.properties[key], value, `${realItem.name}.${key} missing from the generated template`);
    }
  }
  // The L1 static initial values the import must not drop.
  assert.equal(genCols.get('Purchase_Order-Status')!.properties.default_value, 'Draft');
  assert.equal(genCols.get('Product-UOM')!.properties.default_value, 'Each');
  assert.equal(genCols.get('Vendor-Active')!.properties.default_value, 'false');
});

test('the generated L1 template writes a scope and a permission row for every role the real export has', { skip: realFixtureSkip }, () => {
  const real = JSON.parse(readFileSync(REAL_L1_TEMPLATE, 'utf8')) as { components: { Datastore: RealItem[] } };
  const generated = generatedL1();
  for (const type of ['tableScope', 'tablePermission']) {
    const genNames = new Set(generated.components.Datastore.filter((i) => i.type === type).map((i) => i.name));
    const realNames = real.components.Datastore.filter((i) => i.type === type).map((i) => i.name);
    assert.equal(genNames.size, realNames.length, `${type} row count differs from the real export`);
    for (const name of realNames) assert.ok(genNames.has(name), `generated template misses ${type} ${name}`);
  }
  const permOf = (name: string) => item(generated.components.Datastore, 'tablePermission', name).properties.table_permissions;
  assert.deepEqual(permOf('Product-App Administrator'), ['SELECT', 'UPDATE', 'INSERT', 'DELETE']);
  assert.deepEqual(permOf('Product-App User'), ['SELECT']);
  assert.deepEqual(permOf('Product-Member'), ['SELECT']);
  assert.deepEqual(permOf('Product-Administrator'), ['SELECT', 'UPDATE', 'INSERT', 'DELETE']);
  // The auth plan grants CEO nothing: it gets its App User clone's default
  // (read all rows). The real project's CEO CRUD is a manual grant beyond
  // what the .ds export expresses — grant it through the auth plan when wanted.
  assert.deepEqual(permOf('Product-CEO'), ['SELECT']);
});

test('SecurityRules requires authentication for c2c_api on every path and verb', () => {
  const rules = importDoc().components.SecurityRules;
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0], {
    type: 'rules',
    name: 'security-rules',
    properties: {
      advancedio: {
        c2c_api: [{ '.*': { methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'], authentication: 'required' } }],
      },
    },
    dependsOn: [],
  });
});

test('Cache keeps the Default segment; Functions keeps the c2c_api zip reference', () => {
  const template = importDoc();
  assert.deepEqual(template.components.Cache, [{ type: 'segment', name: 'Default', properties: { segment_name: 'Default' }, dependsOn: [] }]);
  const fn = item(template.components.Functions, 'function', 'c2c_api');
  assert.equal(fn.properties.type, 'applogic');
  assert.equal(fn.properties.stack, 'node20');
  assert.deepEqual(fn.properties.code, { path: 'functions/c2c_api.zip' });
});

test('an app with no profiles emits an empty Authentication component', () => {
  const template = importTemplate({ plan: SALES, roles: [], tablePermissions: [] });
  assert.deepEqual(template.components.Authentication, []);
  assert.deepEqual(template.components.SecurityRules.length, 1);
});

test('import template JSON is byte-stable: same bytes twice, LF, trailing newline', () => {
  const app = deriveIr(parse(DS_ROLES));
  const auth = authPlan(app);
  const a = importTemplateJson({ plan: generateSchema(app), roles: auth.roles, tablePermissions: auth.tablePermissions });
  const b = importTemplateJson({ plan: generateSchema(app), roles: auth.roles, tablePermissions: auth.tablePermissions });
  assert.equal(a, b);
  assert.ok(a.endsWith('}\n'));
  assert.ok(!a.includes('\r'));
  assert.deepEqual(JSON.parse(a).components, importDoc().components);
});

// --- import bundle zip -----------------------------------------------------------

/** Central-directory names, in order, from a STORE zip (the outer archive only). */
function zipNames(zip: Buffer): string[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'no end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    names.push(zip.subarray(at + 46, at + 46 + nameLen).toString('utf8'));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

test('zipStore writes a deterministic STORE archive: same bytes twice, names in order', () => {
  const a = zipStore([{ name: 'b.txt', data: 'two' }, { name: 'a.txt', data: 'one' }]);
  const b = zipStore([{ name: 'a.txt', data: 'one' }, { name: 'b.txt', data: 'two' }]);
  assert.deepEqual(zipNames(a), ['a.txt', 'b.txt']);
  assert.deepEqual(zipNames(b), ['a.txt', 'b.txt']);
  assert.equal(a.toString('hex'), b.toString('hex'));
});

test('iacImportBundle packs the template and functions/c2c_api.zip inside one archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-iac-'));
  mkdirSync(join(dir, 'functions'), { recursive: true });
  writeFileSync(join(dir, 'project-template-1.0.0.json'), '{"name":"project-template"}\n');
  const inner = zipStore([
    { name: 'index.js', data: 'module.exports = () => {};\n' },
    { name: 'package.json', data: '{}\n' },
  ]);
  writeFileSync(join(dir, 'functions', 'c2c_api.zip'), inner);
  const a = iacImportBundle(dir);
  const b = iacImportBundle(dir);
  assert.equal(a.toString('hex'), b.toString('hex'));
  assert.deepEqual(zipNames(a), ['functions/c2c_api.zip', 'project-template-1.0.0.json']);
  // The inner member is the function zip byte for byte.
  const at = a.indexOf(inner.subarray(0, 30));
  assert.ok(at >= 0 && a.subarray(at, at + inner.length).equals(inner), 'the inner zip travels verbatim');
  rmSync(dir, { recursive: true, force: true });
});

/** A generated iac tree plus a sibling directory outside it. */
function iacTree(): { root: string; dir: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'c2c-iac-links-'));
  const dir = join(root, 'iac');
  const outside = join(root, 'outside');
  mkdirSync(join(dir, 'functions'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(dir, 'project-template-1.0.0.json'), '{"name":"project-template"}\n');
  writeFileSync(join(dir, 'functions', 'c2c_api.zip'), zipStore([{ name: 'index.js', data: 'module.exports = () => {};\n' }]));
  writeFileSync(join(outside, 'secret.txt'), 'outside-bytes\n');
  return { root, dir, outside };
}

test('iacImportBundle refuses a member that is a file link to outside the directory', () => {
  for (const member of ['project-template-1.0.0.json', 'functions/c2c_api.zip']) {
    const t = iacTree();
    rmSync(join(t.dir, member));
    symlinkSync(join(t.outside, 'secret.txt'), join(t.dir, member));
    assert.throws(() => iacImportBundle(t.dir), new RegExp(`provision/iac/${member.replace('.', '\\.')} is a link`), member);
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('iacImportBundle refuses a link even when it points inside the directory', () => {
  const t = iacTree();
  writeFileSync(join(t.dir, 'copy.json'), '{"name":"project-template"}\n');
  rmSync(join(t.dir, 'project-template-1.0.0.json'));
  symlinkSync('copy.json', join(t.dir, 'project-template-1.0.0.json'));
  assert.throws(() => iacImportBundle(t.dir), /project-template-1\.0\.0\.json is a link/);
  rmSync(t.root, { recursive: true, force: true });
});

test('iacImportBundle refuses a linked functions directory, inside or outside', () => {
  for (const target of ['inside', 'outside'] as const) {
    const t = iacTree();
    const real = target === 'inside' ? join(t.dir, 'fn-real') : join(t.outside, 'fn-real');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'c2c_api.zip'), readFileSync(join(t.dir, 'functions', 'c2c_api.zip')));
    rmSync(join(t.dir, 'functions'), { recursive: true });
    symlinkSync(real, join(t.dir, 'functions'), 'dir');
    assert.throws(() => iacImportBundle(t.dir), /provision\/iac\/functions is a link/, target);
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('iacImportBundle refuses a hard-linked member — its bytes are shared with a file elsewhere', () => {
  const t = iacTree();
  rmSync(join(t.dir, 'functions', 'c2c_api.zip'));
  linkSync(join(t.outside, 'secret.txt'), join(t.dir, 'functions', 'c2c_api.zip'));
  assert.throws(() => iacImportBundle(t.dir), /functions\/c2c_api\.zip has 2 hard links/);
  rmSync(t.root, { recursive: true, force: true });
});

test('iacImportBundle refuses a member that is a directory, naming it', () => {
  const t = iacTree();
  rmSync(join(t.dir, 'project-template-1.0.0.json'));
  mkdirSync(join(t.dir, 'project-template-1.0.0.json'));
  assert.throws(() => iacImportBundle(t.dir), /project-template-1\.0\.0\.json is not a regular file/);
  rmSync(t.root, { recursive: true, force: true });
});
