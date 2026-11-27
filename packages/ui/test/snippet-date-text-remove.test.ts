/**
 * `str.remove(dt)` over a date-time's text and the text of its own date, as a
 * tracking page writes it to split a stamp into day and time of day. Both
 * operands are rendered by the date shims in one format, so the result is the
 * time of day. The render runs under the caller's grants like any snippet read.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';
import { uiSnippetFiles } from '../src/model.js';
import { ADMIN, invoke, liveDatastore, loadTree } from './page-endpoint.js';

const STAFF = { profile: 'Staff', loginUser: 'sam-login', userId: 'u3' };
const NOBODY = { profile: 'Visitor', loginUser: 'vi-login', userId: 'u4' };
const PAGE = 'functions/htmlpages/outer-s0.mjs';

function appWith(island: string) {
  const zml = `<zml><layout><row><column width='100%'><dsp id='Outer1'><![CDATA[htmlpage Outer1()
content
<%{
${island}
%>
<table><tr><td class="d"><%=dte%></td><td class="t"><%=tym%></td></tr></table>
<% }%>]]></dsp></column></row></layout></zml>`;
  const app = deriveIr(parse(`application "Demo"
{
	section Front
	{
form Shipments
{
  Code
  (
    type = text
  )
}
report All_Shipments
{
  show all rows from Shipments
  (
    Code
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

const SPLIT = `re = Shipments[Code == "A1"];
str = re.Added_Time.toString();
dte = re.Added_Time.toDate();
dt = dte.toString();
tym = str.remove(dt);`;

test('a date-time stamp split into day and time of day compiles to a generated render', () => {
  const { files, model } = generateUi(appWith(SPLIT));
  assert.deepEqual(model.todos, []);
  assert.equal(uiSnippetFiles(model).length, 1);
  assert.ok(files.some((file) => file.path === PAGE));
});

async function renderAs(user: Record<string, string>, shipments: Record<string, unknown> = { read: true }) {
  const { files } = generateUi(appWith(SPLIT));
  const policy = files.find((item) => item.path === 'functions/access-policy.json')!;
  const parsed = JSON.parse(String(policy.data)) as { profiles: Record<string, unknown> };
  Object.assign(parsed.profiles, { Staff: { Shipments: shipments } });
  policy.data = JSON.stringify(parsed);
  const dir = loadTree(files);
  const { datastore, restore } = liveDatastore();
  try {
    await datastore.insert('Shipments', [{ Code: 'A1', Added_Time: '2026-11-25 09:05:07' }]);
    return await invoke(dir, PAGE, user, { input: {} });
  } finally {
    restore();
  }
}

async function render(user: Record<string, string>): Promise<string> {
  const page = await renderAs(user);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  return String(page.body.html);
}

for (const [label, user] of [['Administrator', ADMIN], ['Staff with a read grant', STAFF]] as const) {
  test(`${label}: the day and the time of day are printed apart`, async () => {
    const html = await render(user);
    assert.match(html, /<td class="d">25-Nov-2026<\/td>/);
    assert.match(html, /<td class="t">\s*09:05:07<\/td>/);
  });
}

test('a caller with no grant on the form is refused and the reply holds no stamp', async () => {
  const page = await renderAs(NOBODY);
  assert.equal(page.status, 403);
  assert.doesNotMatch(JSON.stringify(page.body), /2026|09:05:07/);
});

test('a caller whose grant leaves the stamp column out gets no stamp in the reply', async () => {
  const page = await renderAs(STAFF, { fields: ['Code'] });
  assert.equal(page.status, 403);
  assert.doesNotMatch(JSON.stringify(page.body), /2026|09:05:07/);
});

test('guard: removing a text that is not the stamp own date stays counted', () => {
  const { model } = generateUi(appWith(`re = Shipments[Code == "A1"];
str = re.Added_Time.toString();
dte = re.Added_Time.toDate();
tym = str.remove(re.Code);`));
  assert.equal(model.todos.length, 1);
});

test('guard: removing text from a field value stays counted', () => {
  const { model } = generateUi(appWith(`re = Shipments[Code == "A1"];
str = re.Code;
dte = re.Added_Time.toDate();
dt = dte.toString();
tym = str.remove(dt);`));
  assert.equal(model.todos.length, 1);
});
