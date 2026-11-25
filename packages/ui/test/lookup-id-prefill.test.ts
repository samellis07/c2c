/**
 * A `zc-component` form embed whose `params` prefill a picklist (lookup) field
 * with a name the render code set once to `input.<own param>.toLong()`: the
 * row id the page was opened with. Also the tag shapes Creator authors write
 * around such an embed: an `elName` with no link, an unknown text-level tag.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, generateUi } from '../src/index.js';
import type { UiModel } from '../src/index.js';
import { ADMIN, invoke, liveDatastore, loadTree } from './page-endpoint.js';

const SNIPPET_TODO = 'Server-side Deluge snippet requires manual translation';
const COMPONENT_TODO = /^Embedded zc-component .* has no generated view$/;

function appWith(snippet: string): App {
  const zml = `<zml><layout><row><column width='100%'><dsp id='Outer1'><![CDATA[${snippet}]]></dsp></column></row></layout></zml>`;
  const app = deriveIr(parse(`application "Demo"
{
	section Front
	{
form Projects
{
  Title
  (
    type = text
  )
}
form Actions
{
  Project
  (
    type = picklist
    values = Projects.ID
    displayformat = [Title]
  )
  Note
  (
    type = text
  )
}
		page Outer(pid)
		{
			Content=${JSON.stringify(zml)}
		}
	}
}
`));
  app.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } });
  return app;
}

const page = (statements: string, tag: string, head = 'htmlpage Outer1(pid)') => `${head}
content
<%{
${statements}
%>
${tag}
<% }%>`;
const ACTIONS = (params: string, extra = '') => `<div ${extra}elName='zc-component' formLinkName='Actions' params='${params}'>Loading...</div>`;
const TO_LONG = '\tprojID = input.pid.toLong();\n\tproject = Projects[ID == projID];';

const refused = (model: UiModel) => model.todos.filter((todo) => todo.area === 'zml' && (todo.reason === SNIPPET_TODO || COMPONENT_TODO.test(todo.reason)));

test('a lookup prefill takes a name set once to the page input as a long', () => {
  const { model } = buildUi(appWith(page(TO_LONG, ACTIONS('zc_Header=false&amp;Project=<%=projID%>'))));
  assert.deepEqual(refused(model), []);
});

test('the same name stays counted when it could hold anything but the page input id', () => {
  const cases = [
    `\tprojID = input.pid.toLong();\n\tprojID = projID + 1;`,
    `\tprojID = input.pid.toLong();\n\tif (input.pid == "1")\n\t{\n\t\tprojID = 7;\n\t}`,
    `\tprojID = Projects[Title == "x"].ID;`,
    `\tprojID = input.other.toLong();`,
    `\tprojID = input.pid.toLong() + 1;`,
    `\tprojID = input.pid;`,
    `\tprojID = input.pid.toLong();\n\tfor each projID in Projects\n\t{\n\t}`,
    `\twhile (input.pid == "1")\n\t{\n\t\tprojID = input.pid.toLong();\n\t}`,
    `\tfor each r in Projects\n\t{\n\t\tprojID = input.pid.toLong();\n\t}`,
    `\tif (input.pid == "1")\n\t{\n\t\twhile (true)\n\t\t{\n\t\t\tprojID = input.pid.toLong();\n\t\t}\n\t}`,
  ];
  for (const statements of cases) {
    const { model } = buildUi(appWith(page(`${statements}\n\tproject = Projects[ID == projID];`, ACTIONS('Project=<%=projID%>'))));
    assert.ok(refused(model).length > 0, statements);
  }
});

test('a name set once to the page input inside a guarding if still carries; inside any loop it does not', () => {
  const guarded = `\tif (input.pid != null)\n\t{\n\t\tprojID = input.pid.toLong();\n\t\tproject = Projects[ID == projID];\n\t\t%>\n${ACTIONS('Project=<%=projID%>')}\n<%\n\t}`;
  assert.deepEqual(refused(buildUi(appWith(page(guarded, ''))).model), []);
});

test('an elName with no link and a stray quote embeds nothing and no longer counts, one that names a link still counts', () => {
  assert.deepEqual(refused(buildUi(appWith(page(TO_LONG, `<div class="box" elName='zc-component' '>x</div>`))).model), []);
  assert.ok(refused(buildUi(appWith(page(TO_LONG, `<div class="box" elName='zc-component' formLinkName='Actions' '>x</div>`))).model).length > 0);
});

test('an unknown text-level tag holds an expression island and keeps its text', () => {
  const { model } = buildUi(appWith(page(TO_LONG, `<div><p1><%=ifnull(project.Title,"")%></p1></div>`)));
  assert.deepEqual(refused(model), []);
});

const PAGE = 'functions/htmlpages/outer-s0.mjs';

test('the generated page answers every profile with the id as the embed prefill and the title text', async () => {
  const { files, model } = generateUi(appWith(page(TO_LONG, `<div><p1><%=ifnull(project.Title,"")%></p1></div>\n${ACTIONS('zc_Header=false&amp;Project=<%=projID%>')}`)));
  assert.deepEqual(refused(model), []);
  const policy = files.find((item) => item.path === 'functions/access-policy.json')!;
  const parsed = JSON.parse(String(policy.data)) as { profiles: Record<string, unknown> };
  parsed.profiles.Staff = { Projects: { read: true } };
  policy.data = JSON.stringify(parsed);
  const dir = loadTree(files);
  const { datastore, restore } = liveDatastore();
  try {
    await datastore.insert('Projects', [{ Title: 'Alpha <b>' }]);
    const id = String((await datastore.query('Projects', 'true', 10))[0]!.ROWID);
    for (const user of [ADMIN, { profile: 'Staff', loginUser: 'sam-login', userId: 'u3' }]) {
      const reply = await invoke(dir, PAGE, user, { input: { pid: id } });
      assert.equal(reply.status, 200, `${user.profile}: ${JSON.stringify(reply.body)}`);
      const html = String(reply.body.html);
      assert.match(html, new RegExp(`data-zml="component-form:Actions:untitled\\?Project=${id}"`), user.profile);
      assert.match(html, /Alpha &lt;b&gt;/, `${user.profile} escapes the title`);
      assert.doesNotMatch(html, /Alpha <b>/, user.profile);
    }
    const none = await invoke(dir, PAGE, ADMIN, { input: { pid: '999999' } });
    assert.equal(none.status, 200, JSON.stringify(none.body));
  } finally {
    restore();
  }
});
