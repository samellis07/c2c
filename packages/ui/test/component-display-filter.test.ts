/**
 * A report embed filtered by a lookup field's displayed text, where the page
 * builds that text from a record's name (`Contact_Name=<%=contact.Name1%>`, or
 * the first and last name joined by an encoded space). The page endpoint
 * renders the marker value from the stored name parts; the report endpoint
 * composes the lookup text from the parent rows the caller may read and keeps
 * the rows whose lookup column holds one of those ids. Every check here runs
 * the generated modules against the fake datastore, not the generated text.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';
import { ADMIN, CLERK, invoke, liveDatastore, loadTree, type Reply } from './page-endpoint.js';

const { reportRouteFilters } = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
  reportRouteFilters(query: string): { field: string; op: string; value: unknown }[];
};

/** The People, Calls and page definition; `embed` is the params of the Calls report embed. */
function appWith(params: string, format = '[Name1.first_name + " " + Name1.last_name]') {
  const zml = `<zml><layout><row><column width='100%'><dsp id='Outer1'><![CDATA[htmlpage Outer1(who)
content
<%{
	person = People[ID == input.who.toLong()];
%>
<span class='who'><%=person.Name1%></span>
<div elName='zc-component' viewLinkName='All_Calls' params='${params}'>Loading...</div>
<% }%>]]></dsp></column></row></layout></zml>`;
  const app = deriveIr(parse(`application "Demo"
{
	section Front
	{
form People
{
  Name1
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
}
form Calls
{
  Subject
  (
    type = text
  )
  Person
  (
    type = picklist
    values = People.ID
    displayformat = ${format}
  )
}
report All_Calls
{
  show all rows from Calls
  (
    Subject
    Person
  )
}
		page Outer(who)
		{
			Content=${JSON.stringify(zml)}
		}
	}
}
`));
  app.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } });
  return app;
}

const PAGE = 'functions/htmlpages/outer-s0.mjs';
const REPORT = 'functions/reports/all-calls.mjs';

interface Setup {
  dir: string;
  files: { path: string; data: string | Buffer }[];
  ids: { john: string; jane: string };
  restore(): void;
}

/** The generated tree on disk, live against a fake datastore holding two people and a call for each. */
async function setup(params: string, format?: string, policy?: Record<string, unknown>): Promise<Setup> {
  const { files, model } = generateUi(appWith(params, format));
  assert.deepEqual(model.todos.filter((todo) => todo.area === 'zml'), []);
  if (policy) {
    const file = files.find((item) => item.path === 'functions/access-policy.json')!;
    const parsed = JSON.parse(String(file.data)) as { profiles: Record<string, unknown> };
    Object.assign(parsed.profiles, policy);
    file.data = JSON.stringify(parsed);
  }
  const dir = loadTree(files);
  const { datastore, restore } = liveDatastore();
  await datastore.insert('People', [
    { Name1_first_name: 'John', Name1_last_name: 'Doe', Email: 'john-mail' },
    { Name1_first_name: 'Jane', Name1_last_name: 'Roe', Email: 'jane-mail' },
  ]);
  const people = await datastore.query('People', 'true', 10);
  const john = String(people[0]!.ROWID);
  const jane = String(people[1]!.ROWID);
  await datastore.insert('Calls', [
    { Subject_field: 'call John', Person: john },
    { Subject_field: 'call Jane', Person: jane },
  ]);
  return {
    dir,
    files,
    ids: { john, jane },
    restore,
  };
}

/** The `?query` of the Calls embed marker the page endpoint rendered. */
function markerQuery(html: unknown): string {
  const found = /data-zml="component-report:All_Calls[^"]*\?([^"]*)"/.exec(String(html));
  assert.ok(found, String(html));
  return found[1]!;
}

/** The filters the client builds from a marker query: values form-decoded, then re-encoded for the report filter reader. */
const filtersOf = (query: string) =>
  reportRouteFilters([...new URLSearchParams(query)].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&'));

const subjects = (reply: Reply) => ((reply.body.rows as { Subject_field?: string }[] | undefined) ?? []).map((row) => row.Subject_field);

test('a name read renders as its parts and the marker carries them as the lookup text', async () => {
  const run = await setup('Person=<%=person.Name1%>&amp;zc_Header=false');
  try {
    const page = await invoke(run.dir, PAGE, ADMIN, { input: { who: run.ids.john } });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.match(String(page.body.html), /<span class='who'>John Doe<\/span>|<span class="who">John Doe<\/span>/);
    assert.equal(markerQuery(page.body.html), 'Person:display=John+Doe');
  } finally {
    run.restore();
  }
});

test('the report filters the lookup column to the rows whose shown text is the marker text', async () => {
  const run = await setup('Person=<%=person.Name1%>&amp;zc_Header=false');
  try {
    const page = await invoke(run.dir, PAGE, ADMIN, { input: { who: run.ids.jane } });
    const filters = filtersOf(markerQuery(page.body.html));
    assert.deepEqual(filters, [{ field: 'Person', op: 'display', value: 'Jane Roe' }]);
    const jane = await invoke(run.dir, REPORT, ADMIN, { op: 'query', filters });
    assert.deepEqual(subjects(jane), ['call Jane']);
    assert.match(String(jane.body.queryShape), new RegExp(`Person IN \\('${run.ids.jane}'\\)`));
    const nobody = await invoke(run.dir, REPORT, ADMIN, { op: 'query', filters: [{ field: 'Person', op: 'display', value: 'Nobody Here' }] });
    assert.deepEqual(subjects(nobody), []);
    const everyone = await invoke(run.dir, REPORT, ADMIN, { op: 'query', filters: [] });
    assert.deepEqual(subjects(everyone).sort(), ['call Jane', 'call John']);
  } finally {
    run.restore();
  }
});

test('the first and last name joined by an encoded space make one text, and a lone trailing island applies nothing', async () => {
  const run = await setup('Person=<%=person.Name1.first_name%>%20<%=person.Name1.last_name%>&amp;<%=person.Email%>&amp;zc_Header=false');
  try {
    const page = await invoke(run.dir, PAGE, ADMIN, { input: { who: run.ids.john } });
    assert.equal(markerQuery(page.body.html), 'Person:display=John%20Doe');
    const filters = filtersOf(markerQuery(page.body.html));
    assert.deepEqual(filters, [{ field: 'Person', op: 'display', value: 'John Doe' }]);
    assert.deepEqual(subjects(await invoke(run.dir, REPORT, ADMIN, { op: 'query', filters })), ['call John']);
  } finally {
    run.restore();
  }
});

test('a first name followed by an encoded space compares with that exact text, so it keeps no row of a full name', async () => {
  const run = await setup('Person=<%=person.Name1.first_name%>%20&amp;<%=person.Name1.last_name%>&amp;zc_Header=false');
  try {
    const page = await invoke(run.dir, PAGE, ADMIN, { input: { who: run.ids.john } });
    assert.equal(markerQuery(page.body.html), 'Person:display=John%20');
    const filters = filtersOf(markerQuery(page.body.html));
    assert.deepEqual(filters, [{ field: 'Person', op: 'display', value: 'John ' }]);
    assert.deepEqual(subjects(await invoke(run.dir, REPORT, ADMIN, { op: 'query', filters })), []);
  } finally {
    run.restore();
  }
});

test('a caller who cannot read the lookup parent field never learns which rows match its text', async () => {
  const run = await setup('Person=<%=person.Name1%>&amp;zc_Header=false', undefined, {
    Clerk: { Calls: { read: true }, People: { fields: ['Email'] } },
  });
  try {
    const filters = [{ field: 'Person', op: 'display', value: 'John Doe' }];
    const admin = await invoke(run.dir, REPORT, ADMIN, { op: 'query', filters });
    assert.deepEqual(subjects(admin), ['call John']);
    const clerk = await invoke(run.dir, REPORT, CLERK, { op: 'query', filters });
    assert.equal(clerk.status, 200, JSON.stringify(clerk.body));
    assert.deepEqual(subjects(clerk), []);
    const granted = await setup('Person=<%=person.Name1%>&amp;zc_Header=false', undefined, { Clerk: { Calls: { read: true }, People: { fields: ['Name1'] } } });
    try {
      assert.deepEqual(subjects(await invoke(granted.dir, REPORT, CLERK, { op: 'query', filters })), ['call John']);
    } finally {
      granted.restore();
    }
  } finally {
    run.restore();
  }
});

test('a display leaf on a lookup the page never embedded, or with a non-text value, is dropped', async () => {
  const run = await setup('Person=<%=person.Name1%>&amp;zc_Header=false');
  try {
    for (const filters of [
      [{ field: 'Subject', op: 'display', value: 'call John' }],
      [{ field: 'Person', op: 'display', value: { __rows: {} } }],
      [{ field: 'Person', op: 'display', value: 7 }],
      [{ field: '__proto__', op: 'display', value: 'John Doe' }],
    ]) {
      const reply = await invoke(run.dir, REPORT, ADMIN, { op: 'query', filters });
      assert.deepEqual(subjects(reply).sort(), ['call Jane', 'call John'], JSON.stringify(filters));
    }
  } finally {
    run.restore();
  }
});

test('a report no page filters by displayed text carries none of the display filter code', () => {
  const { files } = generateUi(appWith('zc_Header=false'));
  const source = String(files.find((item) => item.path === REPORT)?.data);
  assert.doesNotMatch(source, /lookupDisplays|resolveDisplayLeaves/);
  const filtered = String(generateUi(appWith('Person=<%=person.Name1%>')).files.find((item) => item.path === REPORT)?.data);
  assert.match(filtered, /const lookupDisplays = /);
});

test('a lookup text made of two fields and a literal compares the composed text', async () => {
  const run = await setup('Person=<%=person.Email%>%20<%=person.Name1.last_name%>', '[Email + " " + Name1.last_name]');
  try {
    const page = await invoke(run.dir, PAGE, ADMIN, { input: { who: run.ids.john } });
    const filters = filtersOf(markerQuery(page.body.html));
    assert.deepEqual(filters, [{ field: 'Person', op: 'display', value: 'john-mail Doe' }]);
    assert.deepEqual(subjects(await invoke(run.dir, REPORT, ADMIN, { op: 'query', filters })), ['call John']);
  } finally {
    run.restore();
  }
});
