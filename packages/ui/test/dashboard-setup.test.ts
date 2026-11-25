/**
 * A dashboard page whose render provisions the owner through a setup function
 * (`thisapp.Setup.addEmployee();`), opens a popup only for a manager who has no
 * project, and lists the jobs and logs of the signed-in user through the
 * fields of linked records (`Assignees.Email`, `Submitted_By.Email`,
 * `row.Project.Title`). Every check runs the generated page module against the
 * fake datastore: what the endpoint writes, reads and prints, not its text.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, generateUi } from '../src/index.js';
import { ADMIN, invoke, liveDatastore, loadTree } from './page-endpoint.js';

const SNIPPET_TODO = 'Server-side Deluge snippet requires manual translation';
const span = { start: 0, end: 0 };

const ADD_EMPLOYEE = `employeeCount = Employees[ID != 0].count();
if(employeeCount == 0)
{
	insert into Employees
	[
		Designation="Manager"
		Email=zoho.loginuserid
		Name.first_name=zoho.loginuser
		Added_User=zoho.loginuser
	]
}`;

const PAGE = `htmlpage Dash1()
content
<%{
	thisapp.Setup.addEmployee();
	managerCount = Employees[Email == zoho.loginuserid && Designation == "Manager"].count();
	if(managerCount > 0 && Projects[Added_User == zoho.loginuser].count() == 0)
	{
		openUrl("#Form:Projects","popup window");
	}
	%>
<div class="jobs">
<%
	jobs = Jobs[Added_User == zoho.loginuser || Assignees.Email == zoho.loginuserid && Status == "Active"] sort by Added_Time desc range from 1 to 8;
	for each  job in jobs
	{
		%>
<p class="job"><%=job.Job_Title%> | <%=job.Project.Title%></p>
<%
	}
	%>
</div>
<div class="logs">
<%
	logs = Logs[Submitted_By.Email == zoho.loginuserid && Status != "Tracking Time"] sort by Added_Time desc range from 1 to 5;
	for each  log in logs
	{
		%>
<p class="log"><%=log.Hours%> for <%=log.Job_Name.Job_Title%></p>
<%
	}
	%>
</div>
<div class="people">
<%
	for each  person in Employees[Reporting_To == zoho.loginuserid]
	{
		%>
<p class="person"><%=person.Name%></p>
<%
	}
	%>
</div>
<%
}%>`;

function appWith(snippet = PAGE, fns = [{ name: 'Setup.addEmployee', signature: 'void Setup.addEmployee()', deluge: ADD_EMPLOYEE }]): App {
  const zml = `<zml><layout><row><column width='100%'><dsp id='Dash1'><![CDATA[${snippet}]]></dsp></column></row></layout></zml>`;
  const app = deriveIr(parse(`application "Demo"
{
	section Front
	{
form Employees
{
  must have Name
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
  Email
  (
    type = email
  )
  Designation
  (
    type = picklist
    values = {"Member","Manager"}
  )
  Reporting_To
  (
    type = text
  )
}
form Projects
{
  Title
  (
    type = text
  )
}
form Jobs
{
  Job_Title
  (
    type = text
  )
  Project
  (
    type = picklist
    values = Projects.ID
    displayformat = [Title]
  )
  Assignees
  (
    type = list
    values = Employees.ID
    displayformat = [Email]
  )
  Status
  (
    type = picklist
    values = {"Active","Completed"}
  )
}
form Logs
{
  Hours
  (
    type = text
  )
  Status
  (
    type = text
  )
  Submitted_By
  (
    type = picklist
    values = Employees.ID
    displayformat = [Email]
  )
  Job_Name
  (
    type = picklist
    values = Jobs.ID
    displayformat = [Job_Title]
  )
}
		page Dash
		{
			Content=${JSON.stringify(zml)}
		}
	}
}
`));
  app.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span });
  for (const fn of fns) app.functions.push({ name: fn.name, kind: 'deluge', signature: fn.signature, deluge: [{ text: fn.deluge, span }], properties: [], span });
  return app;
}

const OWNER = { profile: 'Administrator', loginUser: 'ada-login', userId: 'u1' };
const MEMBER = { profile: 'Administrator', loginUser: 'mem-login', userId: 'mem-mail' };
const PAGE_MODULE = 'functions/htmlpages/dash-s0.mjs';

const todos = (app: App) => buildUi(app).model.todos.filter((todo) => todo.reason === SNIPPET_TODO);
const lines = (html: unknown, cls: string) => [...String(html).matchAll(new RegExp(`<p class="${cls}">([^<]*)</p>`, 'g'))].map((m) => m[1]!.trim());

/** The generated tree with a manager seeded, a member reporting to the manager, and jobs and logs for both. */
async function seeded(mutate?: (policy: { profiles: Record<string, unknown> }) => void) {
  const { files, model } = generateUi(appWith());
  assert.deepEqual(model.todos.filter((todo) => todo.reason === SNIPPET_TODO), []);
  if (mutate) {
    const file = files.find((item) => item.path === 'functions/access-policy.json')!;
    const policy = JSON.parse(String(file.data)) as { profiles: Record<string, unknown> };
    mutate(policy);
    file.data = JSON.stringify(policy);
  }
  const dir = loadTree(files);
  const live = liveDatastore();
  const { datastore } = live;
  await datastore.insert('Employees', [
    { Name_first_name: 'Ada', Name_last_name: 'Lovelace', Email: 'u1', Designation: 'Manager' },
    { Name_first_name: 'Mem', Name_last_name: 'Ber', Email: 'mem-mail', Designation: 'Member', Reporting_To: 'u1' },
  ]);
  const [manager, member] = (await datastore.query('Employees', 'true', 10)).map((row) => String(row.ROWID));
  await datastore.insert('Projects', [{ Title: 'Apollo', Added_User: 'zed' }]);
  const project = String((await datastore.query('Projects', 'true', 1))[0]!.ROWID);
  await datastore.insert('Jobs', [
    { Job_Title: 'own', Added_User: 'ada-login', Status: 'Active', Project: project },
    { Job_Title: 'assigned', Added_User: 'zed', Status: 'Active' },
    { Job_Title: 'assigned-done', Added_User: 'zed', Status: 'Completed' },
    { Job_Title: 'theirs', Added_User: 'zed', Status: 'Active' },
  ]);
  const jobs = Object.fromEntries((await datastore.query('Jobs', 'true', 10)).map((row) => [String(row.Job_Title), String(row.ROWID)]));
  await datastore.insert('Jobs__Assignees', [
    { parent_id: jobs.assigned, Assignees: manager, row_order: '0' },
    { parent_id: jobs['assigned-done'], Assignees: manager, row_order: '0' },
    { parent_id: jobs.theirs, Assignees: member, row_order: '0' },
  ]);
  await datastore.insert('Logs', [
    { Hours: '02:30', Status: 'Tracked', Submitted_By: manager, Job_Name: jobs.own },
    { Hours: '00:01', Status: 'Tracking Time', Submitted_By: manager, Job_Name: jobs.own },
    { Hours: '01:05', Status: 'Tracked', Submitted_By: member, Job_Name: jobs.theirs },
  ]);
  return { dir, datastore, restore: live.restore, ids: { manager: manager!, member: member! } };
}

test('a void setup function called by name compiles as its body in place', () => {
  assert.deepEqual(todos(appWith()), []);
});

test('the setup insert runs once, into the name part\'s own column, and never for a caller who may not write', async () => {
  const { files } = generateUi(appWith());
  const file = files.find((item) => item.path === 'functions/access-policy.json')!;
  const policy = JSON.parse(String(file.data)) as { profiles: Record<string, unknown> };
  policy.profiles.Clerk = { Employees: { read: true }, Projects: { read: true }, Jobs: { read: true }, Logs: { read: true } };
  file.data = JSON.stringify(policy);
  const dir = loadTree(files);
  const live = liveDatastore();
  try {
    const clerk = await invoke(dir, PAGE_MODULE, { profile: 'Clerk', loginUser: 'cy-login', userId: 'u2' }, { input: {} });
    assert.equal(clerk.status, 200, JSON.stringify(clerk.body));
    assert.deepEqual(clerk.body.notes, ['a setup write was skipped because the caller may not run it']);
    assert.deepEqual(await live.datastore.query('Employees', 'true', 10), [], 'a caller who may not write provisions nothing');
    const first = await invoke(dir, PAGE_MODULE, OWNER, { input: {} });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const rows = await live.datastore.query('Employees', 'true', 10);
    assert.equal(rows.length, 1);
    assert.deepEqual({ designation: rows[0]!.Designation, email: rows[0]!.Email, first: rows[0]!.Name_first_name, user: rows[0]!.Added_User }, { designation: 'Manager', email: 'u1', first: 'ada-login', user: 'ada-login' });
    assert.equal(Object.keys(rows[0]!).some((key) => key.includes('.')), false, 'no dotted column reaches the store');
    await invoke(dir, PAGE_MODULE, OWNER, { input: {} });
    assert.equal((await live.datastore.query('Employees', 'true', 10)).length, 1, 'the form is no longer empty');
  } finally {
    live.restore();
  }
});

test('a setup function the page cannot run in place keeps the page counted', () => {
  const body = (text: string) => [{ name: 'Setup.addEmployee', signature: 'void Setup.addEmployee()', deluge: text }];
  const cases: [string, App][] = [
    ['the body reads the page input', appWith(PAGE, body(`${ADD_EMPLOYEE.replace('Designation="Manager"', 'Designation=input.kind')}`))],
    ['the body calls another function', appWith(PAGE, body(`thisapp.Setup.other();\n${ADD_EMPLOYEE}`))],
    ['the body returns', appWith(PAGE, body(`${ADD_EMPLOYEE}\nreturn;`))],
    ['the function has a parameter', appWith(PAGE, [{ name: 'Setup.addEmployee', signature: 'void Setup.addEmployee(int n)', deluge: ADD_EMPLOYEE }])],
    ['the function returns a value', appWith(PAGE, [{ name: 'Setup.addEmployee', signature: 'int Setup.addEmployee()', deluge: ADD_EMPLOYEE }])],
    ['the page already uses a name the body binds', appWith(PAGE.replace('managerCount', 'employeeCount'))],
    ['the function does not exist', appWith(PAGE, [])],
  ];
  for (const [label, app] of cases) assert.equal(todos(app).length, 1, label);
});

const marks = (html: unknown) => String(html).match(/data-zml="popup-[^"]*"/g);

test('a popup the render opens is a marker only for a manager who has no project', async () => {
  const run = await seeded();
  try {
    const noProject = await invoke(run.dir, PAGE_MODULE, OWNER, { input: {} });
    assert.deepEqual(marks(noProject.body.html), ['data-zml="popup-form:Projects"']);
    await run.datastore.insert('Projects', [{ Title: 'Mine', Added_User: 'ada-login' }]);
    const withProject = await invoke(run.dir, PAGE_MODULE, OWNER, { input: {} });
    assert.equal(marks(withProject.body.html), null);
    const member = await invoke(run.dir, PAGE_MODULE, MEMBER, { input: {} });
    assert.equal(marks(member.body.html), null, 'a member is no manager');
  } finally {
    run.restore();
  }
});

test('the snippet declares the popup it may open and the lifter no longer claims it', () => {
  const walk = (elements: { popups?: unknown[]; popupMarks?: unknown[]; children?: unknown[] }[]): { popups?: unknown[]; popupMarks?: unknown[] }[] =>
    elements.flatMap((el) => [el, ...walk((el.children ?? []) as never)]);
  const { model } = buildUi(appWith());
  const snippet = walk(model.pages[0]!.elements as never).find((el) => el.popupMarks);
  assert.deepEqual(snippet?.popupMarks, [{ target: 'form', name: 'Projects' }]);
  assert.equal(snippet?.popups, undefined, 'a popup that depends on the render is not lifted as an always popup');
});

test('a popup nothing encloses, and one alone under an empty-form guard, stay lifted', () => {
  const walk = (elements: { popups?: unknown[]; popupMarks?: unknown[]; children?: unknown[] }[]): { popups?: unknown[]; popupMarks?: unknown[] }[] =>
    elements.flatMap((el) => [el, ...walk((el.children ?? []) as never)]);
  const plain = `htmlpage Dash1()\ncontent\n<%{\n\topenUrl("#Form:Projects","popup window");\n%>\n<p>x</p>\n<% }%>`;
  const guarded = `htmlpage Dash1()\ncontent\n<%{\n\trows = Projects[ID != 0];\n\tif(rows.count() == 0)\n\t{\n\t\topenUrl("#Form:Projects","popup window");\n\t}\n%>\n<p>x</p>\n<% }%>`;
  for (const [label, snippet, when] of [['plain', plain, 'always'], ['guarded', guarded, 'empty']] as const) {
    const element = walk(buildUi(appWith(snippet, [])).model.pages[0]!.elements as never).find((el) => el.popups);
    assert.equal((element?.popups as { when: string }[] | undefined)?.[0]?.when, when, label);
    assert.equal(element?.popupMarks, undefined, label);
  }
});

test('jobs come from the signed-in user, their assignments and the linked project title', async () => {
  const run = await seeded();
  try {
    const owner = await invoke(run.dir, PAGE_MODULE, OWNER, { input: {} });
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    assert.deepEqual(lines(owner.body.html, 'job').sort(), ['assigned |', 'own | Apollo']);
    const member = await invoke(run.dir, PAGE_MODULE, MEMBER, { input: {} });
    assert.deepEqual(lines(member.body.html, 'job'), ['theirs |']);
  } finally {
    run.restore();
  }
});

test('logs come from the linked person and print the linked job title, and the unfinished one is left out', async () => {
  const run = await seeded();
  try {
    const owner = await invoke(run.dir, PAGE_MODULE, OWNER, { input: {} });
    assert.deepEqual(lines(owner.body.html, 'log'), ['02:30 for own']);
    const member = await invoke(run.dir, PAGE_MODULE, MEMBER, { input: {} });
    assert.deepEqual(lines(member.body.html, 'log'), ['01:05 for theirs']);
  } finally {
    run.restore();
  }
});

test('a name composite prints its parts and the people list follows the reporting line', async () => {
  const run = await seeded();
  try {
    const owner = await invoke(run.dir, PAGE_MODULE, OWNER, { input: {} });
    assert.deepEqual(lines(owner.body.html, 'person'), ['Mem Ber']);
    assert.deepEqual(lines((await invoke(run.dir, PAGE_MODULE, MEMBER, { input: {} })).body.html, 'person'), []);
  } finally {
    run.restore();
  }
});

test('a caller who may not read the form a lookup path goes through is refused, never answered from it', async () => {
  const run = await seeded((policy) => {
    policy.profiles.Clerk = { Jobs: { read: true }, Logs: { read: true }, Projects: { read: true } };
  });
  try {
    const clerk = await invoke(run.dir, PAGE_MODULE, { profile: 'Clerk', loginUser: 'ada-login', userId: 'u1' }, { input: {} });
    assert.equal(clerk.status, 403, JSON.stringify(clerk.body));
    assert.equal(clerk.body.html, undefined);
  } finally {
    run.restore();
  }
});

test('the client opens a rendered popup only when its snippet declared it, once, inside an arrived render', async () => {
  const client = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    setPopupOpener(fn: (target: { target: string; name: string }) => void): void;
    hydrateRenderedPopups(root: unknown, appModel: unknown): void;
  };
  const opened: string[] = [];
  client.setPopupOpener((target) => opened.push(`${target.target}:${target.name}`));
  const shell = (declared: string, rendered: string, marker: string) =>
    `<div class="snippet" data-page-popups="${declared}"><div data-snippet-src="/x" data-snippet-rendered="${rendered}">${marker}</div></div>`;
  const run = (html: string) => {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: 'http://localhost/app/index.html#/page/Dash' });
    client.hydrateRenderedPopups(dom.window.document, {});
    client.hydrateRenderedPopups(dom.window.document, {});
  };
  run(shell('form:Projects', 'true', '<div data-zml="popup-form:Projects"></div>'));
  assert.deepEqual(opened.splice(0), ['form:Projects'], 'declared and rendered: once');
  run(shell('form:Other', 'true', '<div data-zml="popup-form:Projects"></div>'));
  assert.deepEqual(opened.splice(0), [], 'another popup was declared');
  run(shell('form:Projects', 'false', '<div data-zml="popup-form:Projects"></div>'));
  assert.deepEqual(opened.splice(0), [], 'the static shell draws no popup');
  run('<div data-snippet-src="/x" data-snippet-rendered="true"><div data-zml="popup-form:Projects"></div></div>');
  assert.deepEqual(opened.splice(0), [], 'no declaring snippet');
  run(shell('form:Projects', 'true', '<div data-zml="popup-form:Pro jects"></div>'));
  assert.deepEqual(opened.splice(0), [], 'a name outside the identifier grammar');
});
