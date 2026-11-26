/** R5-A probe: an owner-scoped setup write (zoho.adminuserid guard) runs only for the owner, never for a look-alike or a hostile page input. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';
import { ADMIN, invoke, liveDatastore, loadTree } from './page-endpoint.js';

const span = { start: 0, end: 0 };
const PAGE = `htmlpage Dash1(kind)
content
<%{
	if(zoho.loginuserid == zoho.adminuserid && Projects[ID != 0].count() == 0)
	{
		insert into Projects
		[
			Title="seeded"
			Added_User=zoho.loginuser
		]
	}
	%>
<p class="n"><%=Projects[ID != 0].count()%></p>
<%
}%>`;

function app(): App {
  const zml = `<zml><layout><row><column width='100%'><dsp id='Dash1'><![CDATA[${PAGE}]]></dsp></column></row></layout></zml>`;
  const a = deriveIr(parse(`application "Demo"
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
		page Dash
		{
			Content=${JSON.stringify(zml)}
		}
	}
}
`));
  a.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span });
  return a;
}
const PAGE_MODULE = 'functions/htmlpages/dash-s0.mjs';

test('R5A-F4: an owner-scoped setup write (zoho.loginuserid == zoho.adminuserid) runs only for the owner', async () => {
  const { files, model } = generateUi(app());
  assert.equal(model.todos.filter((t) => t.area === 'zml').length, 0);
  const policy = files.find((f) => f.path === 'functions/access-policy.json')!;
  const parsed = JSON.parse(String(policy.data)) as { profiles: Record<string, unknown> };
  parsed.profiles.Clerk = { Projects: { read: true } };
  parsed.profiles.administrator = { Projects: { read: true } };
  policy.data = JSON.stringify(parsed);
  const dir = loadTree(files);
  const hostile = { input: { adminuserid: 'u9', userId: 'u1', kind: 'u1' }, user: { userId: 'u1' }, principal: { userId: 'u1', profile: 'Administrator' } };
  const callers: [string, Record<string, string>, object, number][] = [
    ['clerk', { profile: 'Clerk', loginUser: 'cy', userId: 'u2' }, {}, 0],
    ['Administrator profile, not the owner', { profile: 'Administrator', loginUser: 'mem', userId: 'u9' }, {}, 0],
    ['Administrator profile, not the owner, hostile body', { profile: 'Administrator', loginUser: 'mem', userId: 'u9' }, hostile, 0],
    ['look-alike profile with the owner id', { profile: 'administrator', loginUser: 'x', userId: 'u1' }, {}, 0],
    ['owner', { ...ADMIN }, {}, 1],
  ];
  for (const [label, user, body, want] of callers) {
    const { restore, datastore } = liveDatastore();
    try {
      const r = await invoke(dir, PAGE_MODULE, user, { input: {}, ...body });
      assert.equal(r.status, 200, label);
      assert.equal((await datastore.query('Projects', 'true', 10)).length, want, label);
    } finally {
      restore();
    }
  }
  const { restore, datastore } = liveDatastore();
  delete process.env.C2C_ADMIN_USER_ID;
  try {
    await invoke(dir, PAGE_MODULE, { profile: 'Administrator', loginUser: 'a', userId: '' }, { input: {} });
    assert.equal((await datastore.query('Projects', 'true', 10)).length, 0, 'no owner id configured: nobody is the owner');
  } finally {
    restore();
  }
});
