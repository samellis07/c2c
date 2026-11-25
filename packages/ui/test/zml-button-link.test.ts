/**
 * A ZML `<button>` that opens this app's own form or report, inside a compiled
 * server snippet, is written as a link to that generated route with its
 * parameters as encoded query values. The button used to leave the compiler as
 * an empty `<button>` (or kept the whole snippet counted when a parameter
 * held a record read). Each case runs the generated page for both profiles.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { Readable } from 'node:stream';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { mockDatastore } from '../../shims/test/zcql-mock.js';
import { compileHtmlpage, rewriteZmlButtonLinks } from '../src/htmlpage.js';
import { generateUi } from '../src/index.js';
import { uiSnippetFiles } from '../src/model.js';

const SNIPPET_TODO = 'Server-side Deluge snippet requires manual translation';
const FUNCTION_HOST = 'c2c-app-1001.development.catalystserverless.in';
const SLATE_ORIGIN = 'https://c2c-app-4f3a.onslate.in';

const profile = (name: string) => ({ name, type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } });

const BODY = `\tform Orders
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tStatus
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Lines
\t{
\t\tItem
\t\t(
\t\t\ttype = text
\t\t)
\t\tOrder
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Orders.Name
\t\t)
\t}
\treport All_Orders
\t{
\t\tshow all rows from Orders
\t\t(
\t\t\tName
\t\t\tStatus
\t\t)
\t}`;

function appOf(snippet: string): App {
  const zml = `<zml><layout><row><column width='100%'><dspZml id='zml1'><![CDATA[${snippet}]]></dspZml></column></row></layout></zml>`;
  const app = deriveIr(parse(`application "Demo"\n{\n${BODY}\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tContent=${JSON.stringify(zml)}\n\t\t}\n\t}\n}\n`));
  app.profiles.push(profile('Administrator'), profile('Staff'));
  return app;
}

const page = (button: string) => `htmlpage zml1()\ncontent\n<%{ r = Orders[Name == input.who]; %>\n<panel><pr><pc>${button}</pc></pr></panel>\n<%}%>`;
const FORM_BUTTON = `<button text='Add Line' size='3' bgColor='#286bdc' action='OpenForm' parameters='Order=<%=r.ID%>&amp;Item=New' componentLinkName='Lines' target='popup' />`;

const loadedDirs: string[] = [];
after(() => {
  for (const dir of loadedDirs) rmSync(dir, { recursive: true, force: true });
});

async function loadTree(files: { path: string; data: string | Buffer }[], entry: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-zb-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of files.filter((f) => f.path.startsWith('functions/'))) {
    const dest = join(dir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.data);
  }
  loadedDirs.push(dir);
  return (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>;
}

async function invoke(handler: (req: unknown, res: unknown) => unknown, req: Record<string, unknown>) {
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
  const stream = Readable.from([Buffer.from(JSON.stringify(req.body), 'utf8')]) as Readable & { method: string; headers: Record<string, string>; rawBody?: string; body?: unknown };
  stream.method = 'POST';
  stream.headers = { 'content-type': 'application/json' };
  const readBody = (await import(pathToFileURL(join(process.cwd(), 'packages/deploy/fn/read-body.cjs')).href)) as { default?: { readBody: (s: unknown) => Promise<unknown> }; readBody?: (s: unknown) => Promise<unknown> };
  const read = readBody.readBody ?? readBody.default!.readBody;
  const body = await read(stream);
  await handler({ method: 'POST', headers: { host: FUNCTION_HOST, origin: SLATE_ORIGIN }, ...req, body, rawBody: stream.rawBody }, res);
  return { status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
}

const USERS = {
  Administrator: { user: { profile: 'Administrator', loginUser: 'ada@example.com', userId: 'u1' } },
  Staff: { user: { profile: 'Staff', loginUser: 'sam@example.com', userId: 'u2' } },
};

async function render(snippet: string, who: string, as: keyof typeof USERS, staffGrant: Record<string, unknown> | undefined = { Orders: { read: true } }) {
  const { files, model } = generateUi(appOf(snippet));
  assert.equal(model.todos.filter((todo) => todo.reason === SNIPPET_TODO).length, 0, JSON.stringify(model.todos));
  const compiled = uiSnippetFiles(model);
  assert.equal(compiled.length, 1);
  const policy = files.find((item) => item.path === 'functions/access-policy.json');
  assert.ok(policy);
  const parsed = JSON.parse(String(policy.data)) as { profiles: Record<string, unknown> };
  parsed.profiles.Staff = staffGrant ?? {};
  policy.data = JSON.stringify(parsed);
  const mod = await loadTree(files, compiled[0]!.path);
  const { datastore } = mockDatastore({});
  const keep = { mode: process.env.C2C_DEPLOY_MODE, zone: process.env.C2C_APP_TIMEZONE, admin: process.env.C2C_ADMIN_USER_ID, store: (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore };
  process.env.C2C_DEPLOY_MODE = 'live';
  process.env.C2C_APP_TIMEZONE = 'UTC';
  process.env.C2C_ADMIN_USER_ID = 'u1';
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = datastore;
  try {
    await datastore.insert('Orders', [{ Name: who, Status: 'open' }]);
    return await invoke(mod.default as never, { ...USERS[as], body: { input: { who } } });
  } finally {
    for (const [key, value] of [['C2C_DEPLOY_MODE', keep.mode], ['C2C_APP_TIMEZONE', keep.zone], ['C2C_ADMIN_USER_ID', keep.admin]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (keep.store === undefined) delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    else (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = keep.store;
  }
}

test('an OpenForm button with a record-read parameter prints a form link carrying the encoded id, for Administrator and Staff', async () => {
  for (const as of ['Administrator', 'Staff'] as const) {
    const out = await render(page(FORM_BUTTON), 'Ann', as);
    assert.equal(out.status, 200, `${as}: ${JSON.stringify(out.body)}`);
    const html = String(out.body.html);
    assert.match(html, /<a class="button" href="#\/form\/Lines\?Order=\d+&amp;Item=New"[^>]*>Add Line<\/a>/, `${as}: ${html}`);
    assert.doesNotMatch(html, /<button/);
    assert.doesNotMatch(html, /popup/);
  }
});

test('a Staff profile without a read grant on the forms the snippet reads gets no page and no link', async () => {
  const out = await render(page(FORM_BUTTON), 'Ann', 'Staff', {});
  assert.equal(out.status, 403, JSON.stringify(out.body));
  assert.equal(out.body.html, undefined);
});

test('a hostile record value is encoded in the link and cannot add a query key, a tag or an attribute', async () => {
  const hostile = `x"><script>alert(1)</script>&Status=hacked #`;
  const snippet = page(`<button text='Go' action='OpenForm' parameters='Item=<%=r.Name%>' componentLinkName='Lines' />`);
  for (const as of ['Administrator', 'Staff'] as const) {
    const out = await render(snippet, hostile, as);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const html = String(out.body.html);
    assert.doesNotMatch(html, /<script/i);
    const href = /href="([^"]*)"/.exec(html)?.[1] ?? '';
    assert.match(href, /^#\/form\/Lines\?Item=[A-Za-z0-9%._~*()'!+-]*$/, html);
    assert.equal(new URLSearchParams(href.split('?')[1]).get('Item'), hostile);
    assert.equal([...new URLSearchParams(href.split('?')[1]).keys()].join(), 'Item');
  }
});

test('a report button with one equality parameter prints a report link; a literal parameter is encoded', async () => {
  const snippet = page(`<button text='Open' action='OpenReport' parameters='Status=<%=r.Status%>' componentLinkName='All_Orders' /><button text='Done' action='Report' parameters='Status=closed' componentLinkName='All_Orders' /><button text='Plain' action='OpenForm' componentLinkName='Lines' />`);
  for (const as of ['Administrator', 'Staff'] as const) {
    const out = await render(snippet, 'Ann', as);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const html = String(out.body.html);
    assert.match(html, /href="#\/report\/All_Orders\?Status=open"[^>]*>Open</);
    assert.match(html, /href="#\/report\/All_Orders\?Status=closed"[^>]*>Done</);
    assert.match(html, /href="#\/form\/Lines"[^>]*>Plain</);
  }
});

test('buttons outside the proven grammar keep the snippet counted', () => {
  const app = appOf('x');
  const cases: Record<string, string> = {
    'a key that names no field of the form': `<button text='Go' action='OpenForm' parameters='Nope=<%=r.ID%>' componentLinkName='Lines' />`,
    'a report filter on a lookup': `<button text='Go' action='OpenReport' parameters='Order=<%=r.ID%>' componentLinkName='All_Orders' />`,
    'two report filters': `<button text='Go' action='OpenReport' parameters='Name=a&amp;Status=b' componentLinkName='All_Orders' />`,
    'a call inside the value': `<button text='Go' action='OpenForm' parameters='Item=<%=r.Name.toUpperCase()%>' componentLinkName='Lines' />`,
    'an operator inside the value': `<button text='Go' action='OpenForm' parameters='Item=<%=r.Name + "x"%>' componentLinkName='Lines' />`,
    'a value joined with text': `<button text='Go' action='OpenForm' parameters='Item=a<%=r.Name%>' componentLinkName='Lines' />`,
    'an undeclared page input': `<button text='Go' action='OpenForm' parameters='Item=<%=input.other%>' componentLinkName='Lines' />`,
    'an island in the label': `<button text='<%=r.Name%>' action='OpenForm' componentLinkName='Lines' />`,
    'an island in a style attribute': `<button text='Go' bgColor='<%=r.Name%>' action='OpenForm' componentLinkName='Lines' />`,
    'a target form this app lacks': `<button text='Go' action='OpenForm' componentLinkName='Elsewhere' />`,
    'a reserved key': `<button text='Go' action='OpenForm' parameters='constructor=<%=r.ID%>' componentLinkName='Lines' />`,
    'a hostile literal': `<button text='Go' action='OpenForm' parameters='Item=javascript:alert(1)' componentLinkName='Lines' />`,
  };
  for (const [name, button] of Object.entries(cases)) {
    // Nothing is converted: the button stays a button, and an island in it keeps the snippet counted.
    const out = rewriteZmlButtonLinks(`<panel>${button}</panel>`, app, new Set());
    assert.ok(out.includes('<button'), name);
    assert.ok(!out.includes('<a class="button"'), name);
    if (button.includes('<%')) assert.equal(compileHtmlpage(app, 'Home', 'zml1', page(button)).ok, false, name);
  }
});

test('a button read of a declared page input compiles', () => {
  const snippet = `htmlpage zml1(who)\ncontent\n<%{ r = Orders[Name == input.who]; %>\n<panel><pr><pc><button text='Go' action='OpenForm' parameters='Item=<%=input.who%>' componentLinkName='Lines' /></pc></pr></panel>\n<%}%>`;
  const compiled = compileHtmlpage(appOf('x'), 'Home', 'zml1', snippet);
  assert.equal(compiled.ok, true, compiled.reason ?? '');
});

test('the button reader is linear on adversarial parameter text', () => {
  const app = appOf('x');
  const hostile = [
    `Item=<%=${'a.'.repeat(1000)}%>`,
    `Item=<%=${' '.repeat(1000)}a${' '.repeat(1000)}`,
    `Item=<%=${'a'.repeat(1000)}`,
    `${'Item=<%=a%>&'.repeat(1000)}`,
    `Item=<%=a.toLong(${'('.repeat(1000)}%>`,
    `${'&amp;'.repeat(1000)}`,
  ];
  for (const parameters of hostile) {
    const template = `<panel><button text='Go' action='OpenForm' parameters='${parameters}' componentLinkName='Lines' /></panel>`;
    const start = process.hrtime.bigint();
    const out = rewriteZmlButtonLinks(template, app, new Set());
    assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 250, 'linear time');
    assert.match(out, /<button|<a /);
  }
});

test('the button pass is linear over many tags, unterminated tags and islands', () => {
  const app = appOf('x');
  const hostile = [
    "<button text='a' action='OpenForm' componentLinkName='Lines' />".repeat(1000),
    `<button${' '.repeat(1000)}`.repeat(1000),
    `<button a='${'b'.repeat(1000)}`.repeat(1000),
    `<%=x%>`.repeat(1000) + "<button text='a' action='OpenForm' componentLinkName='Lines' />".repeat(1000),
    `<button ${"x='<%=a%>' ".repeat(1000)}`,
  ];
  for (const template of hostile) {
    const start = process.hrtime.bigint();
    rewriteZmlButtonLinks(template, app, new Set());
    assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 500, 'linear time');
  }
});
