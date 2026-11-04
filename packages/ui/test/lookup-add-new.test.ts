import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, type UiModel } from '../src/index.js';

/**
 * `allow new entries` on a lookup: the model carries the flag and the
 * `displayname` dialog title, the select renders a hidden "add" action, the
 * lookups endpoint reports the caller's insert grant as `canAdd`, and the
 * saved row is selected in the picker. A caller without the grant never sees
 * the action and a direct POST to the target form is refused.
 */

interface ClientModule {
  loadLookupPage(view: unknown, endpoint: string): Promise<{ options: { value: string; label: string }[]; canAdd: boolean }>;
  fillLookups(form: unknown, formEl: unknown, view: unknown): Promise<void>;
  selectLookupNew(select: HTMLSelectElement, displayField: string, answer: unknown): void;
  renderForm(form: { name: string; label: string; fields: unknown[]; submitEndpoint: string }): string;
}

async function loadClient(): Promise<ClientModule> {
  const mod = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as ClientModule;
  assert.equal(typeof mod.selectLookupNew, 'function', 'client-runtime.js does not export selectLookupNew');
  return mod;
}

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = '', modifiers = ''): string {
  const head = modifiers ? `${modifiers} ${name}` : name;
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${head}\n\t\t(\n${lines}\n\t\t)`;
}

/** Department parent, a Course lookup with `allow new entries`, and Staff (add) vs Viewer (read-only) profiles. */
function addNewBody(): string {
  const perm = (form: string, report: string, verbs: string, fields: string) =>
    `\t\t\t\t${form}\n\t\t\t\t{\n\t\t\t\t\tenabled = true\n\t\t\t\t\tReportPermissions\n\t\t\t\t\t{\n\t\t\t\t\t\t${report} = {${verbs}}\n\t\t\t\t\t}\n\t\t\t\t\tFieldPermissions\n\t\t\t\t\t{\n${fields}\t\t\t\t\t}\n\t\t\t\t}\n`;
  const fp = (name: string) => `\t\t\t\t\t\t${name}\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tvisibility:true,readonly:false\n\t\t\t\t\t\t}\n`;
  const list = (name: string, source: string, column: string) =>
    `\t\tlist ${name}\n\t\t{\n\t\t\tshow all rows from ${source}\n\t\t\t(\n\t\t\t\t${column}\n\t\t\t)\n\t\t}\n`;
  const profile = (name: string, departmentVerbs: string) =>
    `\t\t"${name}"\n\t\t{\n\t\t\tname = "${name}"\n\t\t\ttype = Users_Permissions\n\t\t\tModulePermissions\n\t\t\t{\n${perm('Department', 'All_Departments', departmentVerbs, fp('Department_Name'))}${perm('Course', 'All_Courses', '"View","Add"', fp('Title') + fp('Department'))}\t\t\t}\n\t\t}\n`;
  return `\tsection Main
\t{
\t\tform Department
\t\t{
${field('Department_Name', 'text')}
\t\t}
\t\tform Course
\t\t{
${field('Title', 'text')}
${field('Department', 'picklist', '\t\t\tvalues = Department.ID\n\t\t\tdisplayformat = [Department_Name]\n\t\t\tallow new entries\n\t\t\t[\n\t\t\t\tdisplayname = "Add New Department"\n\t\t\t]')}
\t\t}
${list('All_Departments', 'Department', 'Department_Name')}${list('All_Courses', 'Course', 'Title\n\t\t\t\tDepartment')}\t}
\tshare_settings
\t{
${profile('Staff', '"View","Add"')}${profile('Viewer', '"View"')}\t}`;
}

function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body: string) {
      raw = body;
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }));
}

async function loadBuilt(body: string): Promise<{ dir: string; files: Map<string, string | Buffer>; model: UiModel }> {
  const built = buildUi(appOf(body));
  const files = new Map(built.files.map((file) => [file.path, file.data]));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-addnew-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const [path, data] of files) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  const modelPath = [...files.keys()].find((path) => /slate\/assets\/model\.[0-9a-f]{10}\.js$/.test(path));
  assert.ok(modelPath);
  const loaded = (await import(pathToFileURL(join(dir, modelPath)).href)) as { model: UiModel };
  return { dir, files, model: loaded.model };
}

test('the model carries allow new entries and its displayname dialog title', () => {
  const built = buildUi(appOf(`\tsection Main\n\t{\n\t\tform Department\n\t\t{\n${field('Department_Name', 'text')}\n\t\t}\n\t\tform Course\n\t\t{\n${field('Department', 'picklist', '\t\t\tvalues = Department.ID\n\t\t\tdisplayformat = [Department_Name]\n\t\t\tallow new entries\n\t\t\t[\n\t\t\t\tdisplayname = "Add New Department"\n\t\t\t]')}\n\t\t}\n\t}`));
  const course = built.model.forms.find((item) => item.name === 'Course');
  const department = course?.fields.find((item) => item.name === 'Department');
  assert.equal(department?.widget, 'lookup');
  assert.deepEqual(department?.lookup?.addNew, { label: 'Add New Department' });

  // No annotation: the flag alone still carries the affordance.
  const bare = buildUi(appOf(`\tsection Main\n\t{\n\t\tform Department\n\t\t{\n${field('Department_Name', 'text')}\n\t\t}\n\t\tform Course\n\t\t{\n${field('Department', 'picklist', '\t\t\tvalues = Department.ID\n\t\t\tallow new entries')}\n\t\t}\n\t}`));
  const plain = bare.model.forms.find((item) => item.name === 'Course')?.fields.find((item) => item.name === 'Department');
  assert.deepEqual(plain?.lookup?.addNew, {});
});

test('the select renders a hidden add action with the dialog title', async () => {
  const runtime = await loadClient();
  const built = buildUi(appOf(`\tsection Main\n\t{\n\t\tform Department\n\t\t{\n${field('Department_Name', 'text')}\n\t\t}\n\t\tform Course\n\t\t{\n${field('Department', 'picklist', '\t\t\tvalues = Department.ID\n\t\t\tdisplayformat = [Department_Name]\n\t\t\tallow new entries\n\t\t\t[\n\t\t\t\tdisplayname = "Add New Department"\n\t\t\t]')}\n\t\t}\n\t}`));
  const form = built.model.forms.find((item) => item.name === 'Course')!;
  const html = runtime.renderForm(form);
  assert.match(html, /data-lookup-add="Department"/);
  assert.match(html, /data-add-form="Department"/);
  assert.match(html, />Add New Department</);
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const button = dom.window.document.querySelector('button[data-lookup-add]') as HTMLButtonElement;
  assert.ok(button);
  assert.equal(button.hidden, true);
  assert.equal(button.getAttribute('data-add-display'), 'Department_Name');
});

test('fillLookups unhides the add action only when the endpoint grants insert', async () => {
  const runtime = await loadClient();
  const built = buildUi(appOf(`\tsection Main\n\t{\n\t\tform Department\n\t\t{\n${field('Department_Name', 'text')}\n\t\t}\n\t\tform Course\n\t\t{\n${field('Department', 'picklist', '\t\t\tvalues = Department.ID\n\t\t\tallow new entries')}\n\t\t}\n\t}`));
  const form = built.model.forms.find((item) => item.name === 'Course')!;
  const dom = new JSDOM(`<!doctype html><body>${runtime.renderForm(form)}</body>`);
  const document = dom.window.document;
  const formEl = document.querySelector('form')!;
  const button = document.querySelector('button[data-lookup-add]') as HTMLButtonElement;
  assert.ok(button);
  const viewFor = (canAdd: boolean) => ({
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ rows: [], field: 'Name', canAdd }) }),
  });
  await runtime.fillLookups(form, formEl, viewFor(true));
  assert.equal(button.hidden, false);
  button.hidden = true;
  await runtime.fillLookups(form, formEl, viewFor(false));
  assert.equal(button.hidden, true);
});

test('a saved target row becomes the selected lookup option', async () => {
  const runtime = await loadClient();
  const dom = new JSDOM('<!doctype html><body><select name="Department"><option value="">-Select-</option><option value="1">Acme</option></select></body>');
  const select = dom.window.document.querySelector('select') as unknown as HTMLSelectElement;
  runtime.selectLookupNew(select, 'Department_Name', { wrote: true, values: { ROWID: '2002', Department_Name: 'Science' } });
  assert.equal(select.value, '2002');
  assert.equal(select.options[select.options.length - 1]?.text, 'Science');

  // An existing option is reused; a reply with no ROWID selects nothing.
  runtime.selectLookupNew(select, 'Department_Name', { wrote: true, values: { ROWID: '1' } });
  assert.equal(select.value, '1');
  runtime.selectLookupNew(select, 'Department_Name', { wrote: true, values: {} });
  assert.equal(select.value, '1');
  runtime.selectLookupNew(select, 'Department_Name', { dryRun: true, wrote: false });
  assert.equal(select.value, '1');
});

test('the lookups endpoint reports canAdd per profile and a direct POST is refused', async () => {
  const built = await loadBuilt(addNewBody());
  try {
    const lookup = await import(pathToFileURL(join(built.dir, 'functions/lookups/lookup.mjs')).href);
    const submit = await import(pathToFileURL(join(built.dir, 'functions/aio/department/submit.mjs')).href);

    const staff = await invoke(lookup.default, { user: { profile: 'Staff' }, url: '/lookups/Department/Department_Name', body: { rows: [] } });
    assert.equal(staff.status, 200);
    assert.equal(staff.body.canAdd, true, 'Staff holds View + Add on Department');

    const viewer = await invoke(lookup.default, { user: { profile: 'Viewer' }, url: '/lookups/Department/Department_Name', body: { rows: [] } });
    assert.equal(viewer.status, 200);
    assert.equal(viewer.body.canAdd, false, 'Viewer holds View only');

    const refused = await invoke(submit.default, { user: { profile: 'Viewer' }, url: '/forms/Department', body: { record: { Department_Name: 'X' } } });
    assert.equal(refused.status, 403, `direct POST by Viewer answered ${refused.status}`);
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});
