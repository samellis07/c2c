/**
 * A hand-written link to a form or report of this app
 * (`href="<%=zoho.appuri%>#Form:Orgs"`) is the route Creator opens, not the
 * text `##Form:Orgs` the address island and the pseudo-URL make when printed.
 * Every check runs the generated module against the fake datastore.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';
import { ADMIN, invoke, liveDatastore, loadTree } from './page-endpoint.js';

const { reportRouteFilters } = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
  reportRouteFilters(query: string): { field: string; op: string; value: unknown }[];
};

const STAFF = { profile: 'Staff', loginUser: 'sam-login', userId: 'u3' };
const PAGE = 'functions/htmlpages/outer-s0.mjs';

function appWith(links: string) {
  const zml = `<zml><layout><row><column width='100%'><dsp id='Outer1'><![CDATA[htmlpage Outer1()
content
<%{
	n = Orgs[ID != 0].count();
	org = Orgs[ID != 0];
%>
${links}
<p><%=n%></p>
<% }%>]]></dsp></column></row></layout></zml>`;
  const app = deriveIr(parse(`application "Demo"
{
	section Front
	{
form Orgs
{
  Title
  (
    type = text
  )
}
report All_Orgs
{
  show all rows from Orgs
  (
    Title
  )
}
		page Outer
		{
			Content=${JSON.stringify(zml)}
		}
	}
}
`));
  app.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } });
  return app;
}

async function render(links: string, user: Record<string, string>, onRows?: (dir: string, rowId: string) => Promise<void>): Promise<string> {
  const { files } = generateUi(appWith(links));
  const policy = files.find((item) => item.path === 'functions/access-policy.json')!;
  const parsed = JSON.parse(String(policy.data)) as { profiles: Record<string, unknown> };
  Object.assign(parsed.profiles, { Staff: { Orgs: { read: true } } });
  policy.data = JSON.stringify(parsed);
  const dir = loadTree(files);
  const { datastore, restore } = liveDatastore();
  try {
    await datastore.insert('Orgs', [{ Title: 'one' }]);
    const page = await invoke(dir, PAGE, user, { input: {} });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    if (onRows) await onRows(dir, String((await datastore.query('Orgs', 'true', 5))[0]!.ROWID));
    return String(page.body.html);
  } finally {
    restore();
  }
}

for (const [label, user] of [['Administrator', ADMIN], ['Staff', STAFF]] as const) {
  test(`${label}: form and report links, with or without the address island and display flags, print the app's routes`, async () => {
    const html = await render(
      [
        `<a href="<%=zoho.appuri%>#Form:Orgs"><div>new</div></a>`,
        `<a href="<%=zoho.appuri%>#Report:All_Orgs?zc_LoadIn=dialog&amp;zc_Header=false">all</a>`,
        `<a href="#Form:Orgs?zc_LoadIn=dialog">bare</a>`,
      ].join('\n'),
      user,
    );
    assert.match(html, /href="#\/form\/Orgs"[^>]*><div>new<\/div>/);
    assert.match(html, /href="#\/report\/All_Orgs"[^>]*>all</);
    assert.match(html, /href="#\/form\/Orgs"[^>]*>bare</);
    assert.doesNotMatch(html, /##/);
    assert.match(html, /<p>1<\/p>/);
  });
}

test('a link whose name is not a form or report of the app, or that carries a filter, is left as written', async () => {
  const { files, model } = generateUi(appWith(`<a href="<%=zoho.appuri%>#Form:Missing">x</a>`));
  const refused = model.todos.some((todo) => todo.area === 'zml') || !files.some((file) => file.path === PAGE);
  const html = refused ? '' : await render(`<a href="<%=zoho.appuri%>#Form:Missing">x</a>`, ADMIN);
  assert.doesNotMatch(html, /#\/form\/Missing/);
  const filtered = await render(`<a href="<%=zoho.appuri%>#Report:All_Orgs?Title=one">x</a>`, ADMIN);
  assert.doesNotMatch(filtered, /#\/report\/All_Orgs"/);
});

for (const [label, user] of [['Administrator', ADMIN], ['Staff', STAFF]] as const) {
  test(`${label}: a report link to one record is the report route filtered to its id, and the report answers that row`, async () => {
    let rowId = '';
    const html = await render(`<a href="<%=zoho.appuri%>#Report:All_Orgs?ID=<%=org.ID%>" target="_blank">open</a>`, user, async (dir, id) => {
      rowId = id;
      const filters = reportRouteFilters(`ID=${encodeURIComponent(id)}`);
      const reply = await invoke(dir, 'functions/reports/all-orgs.mjs', user, { op: 'query', filters });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.deepEqual((reply.body.rows as { Title?: string }[]).map((row) => row.Title), ['one']);
    });
    assert.ok(rowId);
    assert.ok(html.includes(`href="#/report/All_Orgs?ID=${rowId}"`), html);
  });
}
