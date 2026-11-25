/**
 * A statement island at the top of a `<style>` body that sends the visitor to a
 * form when no row exists yet (`if(Orgs[ID != 0].count() == 0){ openUrl("#Form:Orgs","same window"); }`).
 * The element is removed from the page, but the statements still run: the
 * generated page endpoint answers the link a statement island's openUrl prints
 * anywhere else, for every profile that may read the form. Every check runs
 * the generated module against the fake datastore.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';
import { ADMIN, invoke, liveDatastore, loadTree } from './page-endpoint.js';

const STAFF = { profile: 'Staff', loginUser: 'sam-login', userId: 'u3' };
const PAGE = 'functions/htmlpages/outer-s0.mjs';

function appWith() {
  const zml = `<zml><layout><row><column width='100%'><dsp id='Outer1'><![CDATA[htmlpage Outer1()
content
<%{
	%>
<style>
<%
	if(Orgs[ID != 0].count() == 0)
	{
		openUrl("#Form:Orgs","same window");
	}
	%>
.card { color: red; }
</style>
<div class='card'><span class='cur'>RUPEE_ESC</span> Home</div>
<%
}%>]]></dsp></column></row></layout></zml>`;
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
		page Outer
		{
			Content=${JSON.stringify(zml).replace('RUPEE_ESC', '\\u20B9')}
		}
	}
}
`));
  app.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } });
  return app;
}

async function run(user: Record<string, string>, rows: number): Promise<string> {
  const { files, model } = generateUi(appWith());
  assert.deepEqual(model.todos.filter((todo) => todo.area === 'zml'), []);
  const policy = files.find((item) => item.path === 'functions/access-policy.json')!;
  const parsed = JSON.parse(String(policy.data)) as { profiles: Record<string, unknown> };
  Object.assign(parsed.profiles, { Staff: { Orgs: { read: true } } });
  policy.data = JSON.stringify(parsed);
  const dir = loadTree(files);
  const { datastore, restore } = liveDatastore();
  try {
    if (rows) await datastore.insert('Orgs', Array.from({ length: rows }, (_, n) => ({ Title: `org ${n}` })));
    const page = await invoke(dir, PAGE, user, { input: {} });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    return String(page.body.html);
  } finally {
    restore();
  }
}

for (const [label, user] of [['Administrator', ADMIN], ['Staff', STAFF]] as const) {
  test(`${label}: no organisation yet shows the link to the form, once one exists the page shows none`, async () => {
    const empty = await run(user, 0);
    assert.match(empty, /<span class="cur">\u20B9<\/span>/);
    assert.match(empty, /Home/);
    assert.match(empty, /href="#\/form\/Orgs"/);
    const filled = await run(user, 1);
    assert.match(filled, /Home/);
    assert.doesNotMatch(filled, /#\/form\/Orgs/);
  });
}
