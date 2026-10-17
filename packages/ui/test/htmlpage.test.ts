/**
 * `htmlpage` snippets compile to read-only server-rendered endpoints: the
 * value-slots and aggregate classes, against the fake datastore. Anything the
 * compiler cannot prove stays the same counted TODO as before.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, parseFile, type App } from '../../core/src/index.js';
import { mockDatastore } from '../../shims/test/zcql-mock.js';
import { buildUi, generateUi } from '../src/index.js';
import { compileHtmlpage, convertZmlSnippetToHtml, islandReadOnly, renderAuditSource, rewriteRecordSummaryFrames } from '../src/htmlpage.js';
import { renderedDocumentViolation, renderedHtmlElements } from '../../shims/src/rendered-guard.js';
import { c2cUrlFunctionSource } from '../src/url-policy.js';
import { uiSnippetFiles } from '../src/model.js';
import { leaves, sanitizeSnippet } from '../src/pages.js';

const ADMIN = { name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } };

function appOf(body: string): App {
  const app = deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
  app.profiles.push(ADMIN);
  return app;
}

function pageWithSnippet(snippet: string): string {
  const zml = `<zml><layout><row><column width='100%'><dsp id='hp1'><![CDATA[${snippet}]]></dsp></column></row></layout></zml>`;
  // A Deluge string keeps \n, \t, \r, and any raw character. The \f escape is
  // the letter f, and a \u escape is u plus the hex digits, so the page string
  // keeps the original character instead of those escapes.
  const literal = JSON.stringify(zml)
    .replace(/(?<!\\)\\f/g, '\f')
    .replace(/(?<!\\)\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return `\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tContent=${literal}\n\t\t}\n\t}`;
}

function pageWithZmlSnippet(snippet: string): string {
  const zml = `<zml><layout><row><column width='100%'><dspZml id='zml1'><![CDATA[${snippet}]]></dspZml></column></row></layout></zml>`;
  const literal = JSON.stringify(zml)
    .replace(/(?<!\\)\\f/g, '\f')
    .replace(/(?<!\\)\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return `\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tContent=${literal}\n\t\t}\n\t}`;
}

const ORDERS = `\tform Orders
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tStatus
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = open,closed
\t\t)
\t\tAmount
\t\t(
\t\t\ttype = decimal
\t\t)
\t}`;

/** Write all generated `functions/*` so sibling imports resolve, like deluge/test's loadTree. */
const loadedDirs: string[] = [];
after(() => {
  for (const dir of loadedDirs) rmSync(dir, { recursive: true, force: true });
});
async function loadTree(files: { path: string; data: string | Buffer }[], entry: string, origins: readonly string[] = PAGE_ORIGINS): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-hp-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of files.filter((f) => f.path.startsWith('functions/'))) {
    const dest = join(dir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.data);
  }
  // The deploy stamps allowedOrigins into the shipped c2c-deploy.json. The
  // module reads it lazily at request time, so the tree must outlive loadTree.
  try {
    const target = join(dir, 'functions/c2c-deploy.json');
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    parsed.allowedOrigins = [...origins];
    writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch {
    /* the generated tree ships no c2c-deploy.json */
  }
  loadedDirs.push(dir);
  return (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>;
}

/** The documented deployment: the page rides a Slate host, the function the project domain — different origins. */
const SLATE_ORIGIN = 'https://c2c-app-4f3a.onslate.in';
const FUNCTION_HOST = 'c2c-app-1001.development.catalystserverless.in';
const FUNCTION_ORIGIN = `https://${FUNCTION_HOST}`;
const PAGE_ORIGINS = [SLATE_ORIGIN, FUNCTION_ORIGIN];

async function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown) {
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
  await handler({ method: 'POST', headers: { host: FUNCTION_HOST, origin: SLATE_ORIGIN }, ...(req && typeof req === 'object' ? req as object : {}) }, res);
  return { status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
}

/** Live mode + injected fake datastore preloaded with rows; restore() in finally. */
async function liveStore(rows: Record<string, Record<string, unknown>[]>) {
  const { datastore, tables } = mockDatastore({});
  const realMode = process.env.C2C_DEPLOY_MODE;
  const realZone = process.env.C2C_APP_TIMEZONE;
  const realAdmin = process.env.C2C_ADMIN_USER_ID;
  const realStore = (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
  process.env.C2C_DEPLOY_MODE = 'live';
  process.env.C2C_APP_TIMEZONE = 'UTC';
  process.env.C2C_ADMIN_USER_ID = 'u1';
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = datastore;
  for (const [form, list] of Object.entries(rows)) if (list.length) await datastore.insert(form, list);
  return {
    datastore,
    tables,
    restore() {
      if (realMode === undefined) delete process.env.C2C_DEPLOY_MODE;
      else process.env.C2C_DEPLOY_MODE = realMode;
      if (realZone === undefined) delete process.env.C2C_APP_TIMEZONE;
      else process.env.C2C_APP_TIMEZONE = realZone;
      if (realAdmin === undefined) delete process.env.C2C_ADMIN_USER_ID;
      else process.env.C2C_ADMIN_USER_ID = realAdmin;
      if (realStore === undefined) delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
      else (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = realStore;
    },
  };
}

const USER = { user: { profile: 'Administrator', loginUser: 'ada@example.com', userId: 'u1' } };
const CLERK = { user: { profile: 'Clerk', loginUser: 'ada@example.com', userId: 'u2' } };
/** First row the fake datastore inserts. Creator `ID` matches that ROWID. */
const FIRST_ID = '1000';

function htmlElements(model: ReturnType<typeof buildUi>['model']) {
  return leaves(model.pages[0].elements).filter((el) => el.kind === 'html');
}

test('value-slots: input, zoho.currentdate, literals and if compile and render', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<p>Hello <%= input.name %>, <%= zoho.currentdate %>, <%= zoho.loginuser %>, <%= zoho.appuri %></p>
<%
if (input.show == "yes") {
%><b>shown</b><%
} else {
%><i>hidden</i><%
}
%>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const element = htmlElements(model)[0];
  assert.equal(element.src, '/htmlpages/Home/s0');
  const entry = uiSnippetFiles(model)[0];
  assert.equal(entry.path, 'functions/htmlpages/home-s0.mjs');
  const mod = await loadTree(files, entry.path);
  const handler = mod.default as (req: unknown, res: unknown) => Promise<void>;

  const live = await liveStore({});
  try {
    const shown = await invoke(handler, { ...USER, body: { input: { name: 'Ada', show: 'yes' } } });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.match(String(shown.body.html), /<p>Hello Ada, \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}, ada@example\.com, #<\/p>/);
    assert.match(String(shown.body.html), /<b>shown<\/b>/);
    assert.doesNotMatch(String(shown.body.html), /hidden/);

    const hidden = await invoke(handler, { ...USER, body: { input: { name: 'Ada', show: 'no' } } });
    assert.match(String(hidden.body.html), /<i>hidden<\/i>/);
  } finally {
    live.restore();
  }
});

test('scalar Shape E: getSuffix, concatenation, member checks and app URI compile and render', async () => {
  const { files, model } = generateUi(
    appOf(`${pageWithSnippet(`htmlpage hp1()
content
<p><%= "archive.tar.gz".getSuffix(".") %></p>
<% value = "catalyst" + "-app";
if (input.mode == "full") {
%><a href="<%= zoho.appuri %>"><%= value %></a><%
} else {
%><i>compact</i><%
}
%>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const element = htmlElements(model)[0];
  assert.ok(element.src, 'scalar snippets use the generated htmlpage renderer');
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const live = await liveStore({});
  try {
    const full = await invoke(mod.default as never, { ...USER, body: { input: { mode: 'full' } } });
    assert.equal(full.status, 200);
    assert.match(String(full.body.html), /<p>tar\.gz<\/p>/);
    assert.match(String(full.body.html), /<a href="#"[^>]*>catalyst-app<\/a>/);

    const compact = await invoke(mod.default as never, { ...USER, body: { input: { mode: 'compact' } } });
    assert.equal(compact.status, 200);
    assert.match(String(compact.body.html), /<i>compact<\/i>/);
  } finally {
    live.restore();
  }
});

test('empty server wrappers keep sanitized static markup without an endpoint', () => {
  const emptyBodies = [
    '',
    ' \n\t ',
    '// comment only\n',
    '// <img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>secret_api_key\n',
  ];
  for (const body of emptyBodies) {
    const snippet = `htmlpage hp1()\ncontent\n<%{${body}%}>\n<p>static</p><script>unsafe()</script>`;
    const source = `${ORDERS}\n${pageWithSnippet(snippet)}`;
    const first = generateUi(appOf(source));
    const second = generateUi(appOf(source));
    assert.deepEqual(first.files, second.files, 'generation is byte-identical');
    assert.deepEqual(first.model.todos.map((todo) => todo.reason), ['The <script> element is removed from this page snippet by the sanitizer'], `empty body ${JSON.stringify(body)}`);
    assert.deepEqual(uiSnippetFiles(first.model), [], 'static markup needs no endpoint');
    const html = htmlElements(first.model)[0].html ?? '';
    assert.match(html, /<p>static<\/p>/);
    assert.doesNotMatch(html, /%|&lt;%|<script|unsafe|htmlpage|comment only|secret_api_key|<img|javascript:/i);
  }
});

test('successful htmlpage compilation reports sanitizer-dropped tags from its static markup', () => {
  const snippet = `htmlpage hp1()
content
<script>bad()</script><svg><path/></svg><template><b>hidden</b></template><p>Hello <%= input.name %></p>`;
  const { model } = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(snippet)}`));
  assert.deepEqual(model.todos.map((todo) => todo.reason), [
    'The <script> element is removed from this page snippet by the sanitizer',
    'The <svg> element is removed from this page snippet by the sanitizer',
    'The <template> element is removed from this page snippet by the sanitizer',
  ]);
  assert.equal(uiSnippetFiles(model).length, 1, 'the page still compiles');
});

test('empty server wrappers keep dropped styles as a counted TODO', () => {
  const unsafeSnippet = `htmlpage hp1()\ncontent\n<%{%}>\n<div style="background-image:url(javascript:alert(1))">x</div>`;
  const unsafe = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(unsafeSnippet)}`));
  assert.equal(unsafe.model.todos.filter((todo) => todo.reason === SNIPPET_TODO).length, 1);
  assert.deepEqual(uiSnippetFiles(unsafe.model), []);
  assert.deepEqual(htmlElements(unsafe.model)[0].children.map((child) => child.kind), ['todo']);

  const safeSnippet = `htmlpage hp1()\ncontent\n<%{%}>\n<div style="color:red;background-color:#fff">x</div>`;
  const safe = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(safeSnippet)}`));
  assert.deepEqual(safe.model.todos, []);
  assert.deepEqual(uiSnippetFiles(safe.model), []);
  assert.equal(htmlElements(safe.model)[0].kind, 'html');
});

test('server wrappers with an expression or assignment do not use the empty-wrapper path', () => {
  for (const body of ['<%= input.name %>', '<%{ value = input.name; %}>']) {
    const compiled = compileHtmlpage(appOf(ORDERS), 'Home', 'hp1', `htmlpage hp1()\ncontent\n${body}\n<p>static</p>`);
    assert.notEqual(compiled.staticOnly, true, body);
  }
});

test('value-slots: interpolated input is escaped in text and attribute positions', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<p title="<%= input.tip %>"><%= input.name %></p><a href="<%= input.href %>">go</a>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const live = await liveStore({});
  try {
    const out = await invoke(mod.default as never, {
      ...USER,
      body: { input: { name: '<script>alert(1)</script>" onclick="x', tip: 'a "b" <c>', href: 'javascript:alert(1)' } },
    });
    assert.equal(out.status, 200);
    const html = String(out.body.html);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /" onclick="/);
    assert.doesNotMatch(html, /javascript:/i);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /title="a &quot;b&quot; &lt;c&gt;"/);
    assert.match(html, /<a href=""[^>]*>go<\/a>/);
  } finally {
    live.restore();
  }
});

test('aggregate: count/sum/avg/min/max with criteria, if and openUrl', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<%
n = Orders[Status == "open"].count();
s = Orders[Status == "open"].sum(Amount);
a = Orders[Status == "open"].avg(Amount);
lo = Orders[Status == "open"].min(Amount);
hi = Orders[Status == "open"].max(Amount);
if (n > 0) {
%><p><%= n %>|<%= s %>|<%= a %>|<%= lo %>|<%= hi %></p><%
} else {
%><p>empty</p><%
}
openUrl("#Form:Orders","new window");
openUrl("#Form:Orders","popup window");
%>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const live = await liveStore({
    Orders: [
      { Status: 'open', Amount: 10 },
      { Status: 'open', Amount: null },
      { Status: 'open', Amount: 30 },
      { Status: 'closed', Amount: 5 },
    ],
  });
  try {
    const out = await invoke(mod.default as never, { ...USER, body: { input: {} } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const html = String(out.body.html);
    // NULL rows count, but do not skew sum/avg/min/max over the live values.
    assert.match(html, /3\|40\|20\|10\|30/);
    assert.match(html, /<a href="#\/form\/Orders">Orders<\/a>/);
    // The popup-window openUrl is lifted to a popup marker, not a link.
    assert.equal(html.match(/<a href/g)?.length, 1);
    const element = htmlElements(model)[0];
    assert.deepEqual(
      (element.popups ?? []).map((p) => [p.target, p.name, p.when]),
      [['form', 'Orders', 'always']],
    );
  } finally {
    live.restore();
  }
});

test('aggregate: an empty form renders the else branch', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<%
n = Orders[Status == "open"].count();
if (n > 0) {
%><p><%= n %></p><%
} else {
%><p>empty</p><%
}
%>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const live = await liveStore({ Orders: [] });
  try {
    const out = await invoke(mod.default as never, { ...USER, body: { input: {} } });
    assert.equal(out.status, 200);
    assert.match(String(out.body.html), /<p>empty<\/p>/);
  } finally {
    live.restore();
  }
});

test('htmlpage endpoints: unauthenticated and unauthorized callers are refused, hidden forms too', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<p><%= Orders[Status == "open"].count() %></p>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const handler = mod.default as (req: unknown, res: unknown) => Promise<void>;
  const live = await liveStore({ Orders: [{ Status: 'open', Amount: 1 }] });
  try {
    const anon = await invoke(handler, { body: { input: {} } });
    assert.equal(anon.status, 401);
    const denied = await invoke(handler, { user: { profile: 'Nobody' }, body: { input: {} } });
    assert.equal(denied.status, 403);
    const ok = await invoke(handler, { ...USER, body: { input: {} } });
    assert.equal(ok.status, 200);
    assert.match(String(ok.body.html), /<p>1<\/p>/);
  } finally {
    live.restore();
  }
});

test('a record value with malicious markup is escaped in the rendered page', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<%
v = Orders[ID != 0].distinct(Status);
%><p><%= v %></p>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const live = await liveStore({ Orders: [{ Status: 'open"><script>alert(1)</script>', Amount: 1 }] });
  try {
    const out = await invoke(mod.default as never, { ...USER, body: { input: {} } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const html = String(out.body.html);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /" onclick="/);
    assert.match(html, /&lt;script&gt;/);
  } finally {
    live.restore();
  }
});

const SNIPPET_TODO = 'Server-side Deluge snippet requires manual translation';

test('htmlpage slot positions retain their current context class and compile reason', () => {
  const cases: Array<{ name: string; template: string; className?: 'T' | 'A' | 'C' | 'D'; reason?: string }> = [
    { name: 'text', template: '<p><%= input.value %></p>', className: 'T' },
    { name: 'double-quoted attribute', template: '<p title="<%= input.value %>">x</p>', className: 'A' },
    { name: 'single-quoted attribute', template: "<p title='<%= input.value %>'>x</p>", className: 'A' },
    { name: 'unquoted attribute', template: '<p title=<%= input.value %>>x</p>', className: 'A' },
    { name: 'style attribute', template: '<p style="color:<%= input.value %>">x</p>', className: 'C' },
    { name: 'tag name', template: '<p<%= input.value %>>x</p>', reason: 'island in an unsafe position' },
    { name: 'HTML comment', template: '<!-- <%= input.value %> -->', className: 'D' },
    { name: 'script body', template: '<script>const x = <%= input.value %>;</script>', reason: 'island in an unsafe position' },
    { name: 'style body', template: '<style>.x { color: <%= input.value %>; }</style>', reason: 'island in an unsafe position' },
  ];
  for (const c of cases) {
    const compiled = compileHtmlpage(appOf(ORDERS), 'Home', 'hp1', `htmlpage hp1()\ncontent\n${c.template}`);
    if (c.reason) {
      assert.equal(compiled.ok, false, c.name);
      assert.equal(compiled.reason, c.reason, c.name);
    } else {
      assert.equal(compiled.ok, true, c.name);
      assert.match(compiled.file?.source ?? '', new RegExp(`\\[\\"k\\"\\]: \\\"${c.className}\\\"`), c.name);
    }
  }
});

const SEEDED = {
  Orders: [
    { Status: 'open', Amount: 1 },
    { Status: 'open', Amount: 2 },
    { Status: 'closed', Amount: 3 },
  ],
};

/**
 * A page render may not write. The island stays the counted snippet, no
 * endpoint is emitted, and a live-mode render (when one was emitted) leaves
 * every seeded row as it was.
 */
async function assertStaysSnippet(body: string, input: Record<string, unknown>) {
  const { files, model } = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n${body}`)}`));
  const compiled = uiSnippetFiles(model);
  const live = await liveStore(SEEDED);
  let statuses: string[] = [];
  try {
    if (compiled.length) {
      const mod = await loadTree(files, compiled[0].path);
      await invoke(mod.default as never, { ...USER, body: { input } });
    }
    const rows = await live.datastore.query('Orders', 'true', 300);
    statuses = rows.map((row) => String(row.Status));
  } finally {
    live.restore();
  }
  assert.equal(compiled.length, 0, `compiled endpoint; statuses=${statuses.join(',')}`);
  assert.equal(model.todos.filter((todo) => todo.reason === SNIPPET_TODO).length, 1);
  assert.deepEqual(statuses, ['open', 'open', 'closed']);
}

test('a query-root field assignment stays a snippet and does not update rows', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      `<%
q = Orders[Status == "open"];
q.Status = input.payload;
%>
<p>x</p>`,
      { payload: 'pwned' },
    ],
    [
      `<%
q = Orders[Status == "open"];
q.Status = "pwned";
%>
<p>x</p>`,
      {},
    ],
    [
      `<%
if (input.go == "yes") {
  q = Orders[Status == "open"];
  q.Status = "pwned";
}
%>
<p>x</p>`,
      { go: 'yes' },
    ],
    [
      `<%
r = Orders[Status == "open"];
r.Status = "pwned";
%>
<p>x</p>`,
      {},
    ],
    [
      `<%
r = Orders[ID == 1];
r.Status = "Done";
%>
<b><%= r.Status %></b>`,
      {},
    ],
    [
      `<%
r = Orders[Status == "open"];
r.Detail.Status = "pwned";
%>
<p>x</p>`,
      {},
    ],
    [
      `<%
rows = Orders[Status == "open"];
rows[0].Status = "pwned";
%>
<p>x</p>`,
      {},
    ],
    [
      `<%
rows = Orders[Status == "open"];
if (input.go == "yes") {
  rows[0].Status = "pwned";
}
%>
<p>x</p>`,
      { go: 'yes' },
    ],
    [
      `<%
rows = Orders[Status == "open"];
for each rec in rows {
  rec.Status = "pwned";
}
%>
<p>x</p>`,
      {},
    ],
    [
      `<%
r = Orders[Status == "open"];
s = r;
s.Status = "pwned";
%>
<p>x</p>`,
      {},
    ],
  ];
  for (const [body, input] of cases) await assertStaysSnippet(body, input);
});

test('a write into a bound collection is refused at the read-only gate', () => {
  // The downstream translator emits this write as an ordinary local mutation,
  // so only the effect gate keeps it a counted snippet. Reverting the gate
  // compiles the endpoint and fails this assertion.
  const cases = [
    `<%\nrows = Orders[Status == "open"];\nrows[0].Status = "Done";\n%><p>x</p>`,
    `<%\nrows = Orders[Status == "open"];\nif (input.go == "yes") { rows[0].Status = "Done"; }\n%><p>x</p>`,
    `<%\nrows = Orders[Status == "open"];\nfor each rec in rows { rec.Status = "Done"; }\n%><p>x</p>`,
  ];
  for (const body of cases) {
    const compiled = compileHtmlpage(appOf(ORDERS), 'Home', 'hp1', `htmlpage hp1()\ncontent\n${body}`);
    assert.equal(compiled.ok, false, body);
    assert.equal(compiled.reason, 'island is not a read-only render', body);
  }
});

test('a local map or record read that does not write a bound record still compiles', () => {
  const cases = [
    `<%\nm = {"a": 1};\nm.a = 2;\n%><p><%= m.a %></p>`,
    `<%\nx = Orders[ID == 1];\n%><p><%= x.Status %></p>`,
    `<%\nrows = Orders[Status == "open"];\nn = rows.count();\n%><p><%= n %></p>`,
  ];
  for (const body of cases) {
    const compiled = compileHtmlpage(appOf(ORDERS), 'Home', 'hp1', `htmlpage hp1()\ncontent\n${body}`);
    assert.equal(compiled.ok, true, `${body}: ${compiled.reason}`);
  }
});

test('getUrl stays a snippet and is not a compiled endpoint', async () => {
  await assertStaysSnippet(`<p><%= getUrl("https://example.test/fetch") %></p>`, {});
  await assertStaysSnippet(
    `<%
x = getUrl(input.u);
%>
<p><%= x %></p>`,
    { u: 'https://example.test/fetch' },
  );
});

test('a page href drops control characters and whitespace before the scheme check', async () => {
  const payloads = ['java\nscript:alert(1)', 'java\tscript:alert(1)', 'data\n:text/html,x', '\u0000javascript:alert(1)'];
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<a href="<%= input.a %>">a</a><a href="<%= input.b %>">b</a><a href="<%= input.c %>">c</a><a href="<%= input.d %>">d</a>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const entry = uiSnippetFiles(model)[0];
  const source = String(files.find((file) => file.path === entry.path)?.data ?? '');
  assert.match(source, /replace\(\/\[\\u0000-\\u0020\]\+\/g, ""\)/);
  assert.match(source, /flat\.startsWith\("http:"\)/);
  assert.match(source, /flat\.startsWith\("https:"\)/);
  assert.match(source, /flat\.startsWith\("mailto:"\)/);
  const mod = await loadTree(files, entry.path);
  const live = await liveStore({});
  try {
    const out = await invoke(mod.default as never, {
      ...USER,
      body: { input: { a: payloads[0], b: payloads[1], c: payloads[2], d: payloads[3] } },
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const html = String(out.body.html);
    assert.equal(html.match(/<a href=""[^>]*>/g)?.length, 4, html);
    assert.doesNotMatch(html, /javascript:|data:/i);
    for (const payload of payloads) assert.equal(html.includes(payload), false, JSON.stringify(payload));
  } finally {
    live.restore();
  }

  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    sanitizeSnippet(raw: string, doc: unknown): string;
  };
  const doc = new JSDOM('<!doctype html><body></body>').window.document;
  for (const payload of payloads.slice(0, 3)) {
    const client = runtime.sanitizeSnippet(`<a href="${payload}">go</a>`, doc);
    assert.equal(client.includes('href'), false, JSON.stringify(payload));
  }
});

test('a page href checks the whole assembled attribute value, not each island', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<a href="<%= input.a %><%= input.b %>">two</a><a href="javascript<%= input.c %>">pre</a><a href="java<%= input.d %>">mid</a><a href="<%= input.e %><%= input.f %>">ctl</a><a href="https://safe.example/<%= input.g %>">ok</a>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const live = await liveStore({});
  try {
    const out = await invoke(mod.default as never, {
      ...USER,
      body: {
        input: {
          a: 'javascript',
          b: ':alert(1)',
          c: ':alert(2)',
          d: 'script:alert(3)',
          e: 'java\t',
          f: 'script:alert(4)',
          g: 'p q',
        },
      },
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const html = String(out.body.html);
    assert.doesNotMatch(html, /javascript:/i);
    assert.equal(html.match(/<a href=""[^>]*>/g)?.length, 4, html);
    assert.match(html, /<a href="https:\/\/safe\.example\/p q"[^>]*>ok<\/a>/);
  } finally {
    live.restore();
  }
});

test('a page href checks the scheme when tag whitespace wraps the = sign', async () => {
  // Any whitespace the markup allows inside a tag (space, tab, line feed,
  // form feed, carriage return) around the = sign still makes the island a
  // URL value slot, so the scheme check runs on the assembled value.
  const cases: { name: string; template: string; input: Record<string, string> }[] = [];
  for (const [name, gap] of [
    ['line feed', '\n'],
    ['CRLF', '\r\n'],
    ['carriage return', '\r'],
    ['form feed', '\f'],
    ['mixed whitespace', ' \t\n\f\r '],
  ] as const) {
    cases.push({
      name: `href ${name} on both sides`,
      template: `<a href${gap}=${gap}"<%= input.a %>">x</a>`,
      input: { a: 'javascript:alert(1)' },
    });
  }
  cases.push({
    name: 'static scheme pieces split by an island over a line break',
    template: `<a href=\n"java<%= input.a %>script:alert(1)">x</a>`,
    input: { a: '' },
  });
  cases.push({
    name: 'img src with a line feed after =',
    template: `<img src=\n"<%= input.a %>">`,
    input: { a: 'javascript:alert(1)' },
  });
  const live = await liveStore({});
  try {
    for (const c of cases) {
      const { files, model } = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n${c.template}`)}`));
      const snippetFiles = uiSnippetFiles(model);
      assert.equal(snippetFiles.length, 1, c.name);
      const mod = await loadTree(files, snippetFiles[0].path);
      const out = await invoke(mod.default as never, { ...USER, body: { input: c.input } });
      assert.equal(out.status, 200, `${c.name}: ${JSON.stringify(out.body)}`);
      const html = String(out.body.html);
      assert.doesNotMatch(html, /javascript:|data:|vbscript:/i, `${c.name}: ${html}`);
      if (c.name.startsWith('img')) assert.match(html, /<img src=""/, `${c.name}: ${html}`);
      else assert.match(html, /<a href=""/, `${c.name}: ${html}`);
      if (c.name.includes('form feed') || c.name.includes('mixed')) {
        const page = pageWithSnippet(`htmlpage hp1()\ncontent\n${c.template}`);
        assert.equal(page.includes('\f'), true, c.name);
        assert.equal(page.includes('\\f'), false, c.name);
      }
    }
  } finally {
    live.restore();
  }
});

test('a stray quote does not make the next unquoted URL slot a plain attribute', async () => {
  const rows = [
    `<img alt=Bob's src=<%= input.a %>>`,
    `<img alt=Bob"s src=<%= input.a %>>`,
    `<a title=it's href=<%= input.a %>>x</a>`,
    `<a title=it"s href=<%= input.a %>>x</a>`,
    `<a title=a"b href=<%= input.a %>>x</a>`,
    `<a title=a'b href=<%= input.a %>>x</a>`,
    `<a x"=1 href=<%= input.a %>>x</a>`,
    `<a x'=1 href=<%= input.a %>>x</a>`,
    `x < y" <a href=<%= input.a %>>x</a>`,
    `x < y' <a href=<%= input.a %>>x</a>`,
    `<a href=<%= input.a %>>x</a>`,
  ];
  for (const body of rows) await assertStaysSnippet(body, { a: 'javascript:alert(1)' });
});

test('a stray quote before a quoted URL attribute still runs the scheme check', async () => {
  const rows = [
    `<img alt=Bob's src="<%= input.a %>">`,
    `<img alt=Bob"s src='<%= input.a %>'>`,
    `<a title=a"b href="<%= input.a %>">x</a>`,
    `<a title=a'b href='<%= input.a %>'>x</a>`,
    `<a x"=1 href="<%= input.a %>">x</a>`,
    `<a x'=1 href='<%= input.a %>'>x</a>`,
    `x < y" <a href="<%= input.a %>">x</a>`,
    `x < y' <a href='<%= input.a %>'>x</a>`,
  ];
  const live = await liveStore({});
  try {
    for (const template of rows) {
      const { files, model } = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n${template}`)}`));
      const compiled = uiSnippetFiles(model);
      assert.equal(compiled.length, 1, template);
      const mod = await loadTree(files, compiled[0].path);
      const out = await invoke(mod.default as never, { ...USER, body: { input: { a: 'javascript:alert(1)' } } });
      assert.equal(out.status, 200, `${template}: ${JSON.stringify(out.body)}`);
      const html = String(out.body.html);
      assert.doesNotMatch(html, /javascript:|data:|vbscript:/i, `${template}: ${html}`);
      if (template.startsWith('<img')) assert.match(html, /src=""/, `${template}: ${html}`);
      else assert.match(html, /href=""/, `${template}: ${html}`);
    }
  } finally {
    live.restore();
  }
});

test('a non-space control after = stays a relative URL and not a script scheme', async () => {
  const live = await liveStore({});
  try {
    for (const gap of ['\0', '\v', '\u00A0', '\u2028']) {
      const { files, model } = generateUi(
        appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n<a href=${gap}"<%= input.a %>">x</a>`)}`),
      );
      const compiled = uiSnippetFiles(model);
      assert.equal(compiled.length, 1, String(gap.codePointAt(0)));
      const mod = await loadTree(files, compiled[0].path);
      const out = await invoke(mod.default as never, { ...USER, body: { input: { a: 'javascript:alert(1)' } } });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const html = String(out.body.html);
      assert.doesNotMatch(html, /href="javascript:/i, html);
      assert.match(html, /&quot;javascript:alert\(1\)&quot;/, html);
    }
  } finally {
    live.restore();
  }
});

test('a quoted style attribute island renders through the CSS-value grammar', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<div style="width:<%= input.pct %>%;" title="w">w</div><div style='background:<%= input.c %>;border:1px <%= input.border %>;'>c</div>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const live = await liveStore({});
  try {
    const ok = await invoke(mod.default as never, {
      ...USER,
      body: { input: { pct: 75, c: '#a1b2c3', border: 'solid' } },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const html = String(ok.body.html);
    assert.match(html, /style="width:75%;"/, html);
    assert.match(html, /style="background:#a1b2c3;border:1px solid;"/, html);
    assert.deepEqual(ok.body.notes, []);

    const palette = await invoke(mod.default as never, {
      ...USER,
      body: { input: { pct: 'rgb(12, 34, 200)', c: 'red', border: 'hsl(120, 50%, 50%)' } },
    });
    assert.match(String(palette.body.html), /width:rgb\(12, 34, 200\)%/, String(palette.body.html));
    assert.match(String(palette.body.html), /1px hsl\(120, 50%, 50%\);"/, String(palette.body.html));
    assert.deepEqual(palette.body.notes, []);

    const bad = await invoke(mod.default as never, {
      ...USER,
      body: { input: { pct: 'red;background:url(x)', c: 'a"b', border: '"><script>alert(1)</script>' } },
    });
    assert.equal(bad.status, 200, JSON.stringify(bad.body));
    const out = String(bad.body.html);
    assert.doesNotMatch(out, /<script/i);
    assert.doesNotMatch(out, /url\(|expression\(|javascript:/i);
    assert.match(out, /style="width:%;"/, out);
    assert.match(out, /style="background:;border:1px ;"/, out);
    assert.equal((bad.body.notes as unknown[]).length >= 3, true, JSON.stringify(bad.body.notes));
  } finally {
    live.restore();
  }
});

test('an island inside a style element or an unquoted style attribute stays a snippet', async () => {
  await assertStaysSnippet(`<div style=<%= input.w %>>x</div>`, { w: '1px' });
});

const STYLE_VALUE_NOTE = 'a style island value was not a safe CSS value and rendered empty';

type FragmentEl = {
  attributes: ArrayLike<{ name: string }>;
  getAttribute(name: string): string | null;
};

type FragmentDoc = {
  querySelector(selector: string): FragmentEl | null;
  querySelectorAll(selector: string): ArrayLike<FragmentEl>;
};

/** Parse endpoint HTML with the DOM parser and read attributes from the result. */
function readFragment<T>(html: string, read: (doc: FragmentDoc) => T): T {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`) as unknown as {
    window: { document: FragmentDoc; close(): void };
  };
  try {
    return read(dom.window.document);
  } finally {
    dom.window.close();
  }
}

function parsedStyle(html: string): { style: string | null; onAttrs: string[] } {
  return readFragment(html, (doc) => {
    const onAttrs: string[] = [];
    const nodes = doc.querySelectorAll('*');
    for (let n = 0; n < nodes.length; n++) {
      const el = nodes[n];
      if (!el) continue;
      for (let i = 0; i < el.attributes.length; i++) {
        const name = el.attributes[i]?.name ?? '';
        if (/^on/i.test(name)) onAttrs.push(name);
      }
    }
    return { style: doc.querySelector('div')?.getAttribute('style') ?? null, onAttrs };
  });
}

test('a quoted style expression renders only the CSS value the grammar allows', async () => {
  const rejected = [
    'red;background:url(//x)',
    'expression(alert(1))',
    '\\75 rl(x)',
    '\\\\75 rl(x)',
    '/**/',
    'red/**/blue',
    '}',
    '{',
    '"',
    "'",
    '</style><script>',
    '"><img src=x onerror=1>',
    "'><img src=x onerror=1>",
    'ｕｒｌ(',
    'rgb(1,2,3) url(x)',
    '#fff\u0000',
    'calc(1px)',
    'var(--x)',
    'attr(x)',
    'image-set(',
    '-moz-binding',
    '-moz-binding:url(x)',
    'u\u0000rl(x)',
    'ex\u0000pression(alert(1))',
    'ex pression(alert(1))',
    'URL(x)',
    'javascript:alert(1)',
    'vbscript:alert(1)',
    '@import',
    'red !important',
    '&quot;><img>',
    'color:red',
    'rgb(1 2 3 / 0.5)',
    'rgb(1,2,3))',
    'https://x.test/y onclick=alert(1)',
    'https://x.test/y onclick=globalThis.__hit=1//',
  ];
  for (const gap of [' ', '\t', '\n', '\r', '\f', '\v', '\u00A0', '\u200B']) rejected.push(`url${gap}(x)`);

  const kept: Array<[string, string]> = [
    ['red', 'width:red;'],
    ['  red  ', 'width:red;'],
    ['#a1b2c3', 'width:#a1b2c3;'],
    ['rgb(12, 34, 200)', 'width:rgb(12, 34, 200);'],
    ['hsl(120, 50%, 50%)', 'width:hsl(120, 50%, 50%);'],
    ['75', 'width:75;'],
    ['1px solid', 'width:1px solid;'],
    ['red/blue', 'width:red/blue;'],
    ['red\nblue', 'width:red\nblue;'],
  ];

  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<div style="width:<%= input.v %>;" id="t">x</div>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const bare = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<div style="width:<% input.v %>;" id="t">x</div>`)}`),
  );
  assert.deepEqual(bare.model.todos, []);
  const bareMod = await loadTree(bare.files, uiSnippetFiles(bare.model)[0].path);
  const live = await liveStore({});
  try {
    for (const value of rejected) {
      const out = await invoke(mod.default as never, { ...USER, body: { input: { v: value } } });
      assert.equal(out.status, 200, JSON.stringify(value));
      const html = String(out.body.html);
      const parsed = parsedStyle(html);
      assert.deepEqual(parsed.onAttrs, [], `${JSON.stringify(value)} ${html}`);
      assert.equal(parsed.style, 'width:;', `${JSON.stringify(value)} ${html}`);
      assert.deepEqual(out.body.notes, [STYLE_VALUE_NOTE], JSON.stringify(value));
    }
    for (const value of ['', '   ', '\n\t']) {
      const out = await invoke(mod.default as never, { ...USER, body: { input: { v: value } } });
      assert.equal(out.status, 200, JSON.stringify(value));
      const parsed = parsedStyle(String(out.body.html));
      assert.deepEqual(parsed.onAttrs, [], JSON.stringify(value));
      assert.equal(parsed.style, 'width:;', JSON.stringify(value));
      assert.deepEqual(out.body.notes, [], JSON.stringify(value));
    }
    for (const [value, style] of kept) {
      const out = await invoke(mod.default as never, { ...USER, body: { input: { v: value } } });
      assert.equal(out.status, 200, JSON.stringify(value));
      const html = String(out.body.html);
      const parsed = parsedStyle(html);
      assert.deepEqual(parsed.onAttrs, [], `${JSON.stringify(value)} ${html}`);
      assert.equal(parsed.style, style, `${JSON.stringify(value)} ${html}`);
      assert.deepEqual(out.body.notes, [], JSON.stringify(value));
    }
    const plain = await invoke(bareMod.default as never, { ...USER, body: { input: { v: 'red' } } });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    const plainHtml = String(plain.body.html);
    const plainParsed = parsedStyle(plainHtml);
    assert.deepEqual(plainParsed.onAttrs, [], plainHtml);
    assert.equal(plainParsed.style, 'width:red;', plainHtml);
    assert.deepEqual(plain.body.notes, []);
  } finally {
    live.restore();
  }
});

test('a statement island inside a quoted attribute stays a snippet', async () => {
  const input = { v: 'https://x.test/y onclick=globalThis.__hit=1//' };
  const bodies = [
    `<div style="color:<% openUrl(input.v, "new window"); %>">x</div>`,
    `<div style='color:<% openUrl(input.v, "new window"); %>'>x</div>`,
    `<div style="<% openUrl(input.v, "new window"); %>">x</div>`,
    `<div style="color:<% if (input.v != "") { openUrl(input.v, "new window"); } %>">x</div>`,
    `<div style="color:<% openUrl(input.v, "new window"); openUrl(input.v, "same window"); %>">x</div>`,
    `<div style="color:<%{ openUrl(input.v, "new window"); }%>">x</div>`,
    `<div style="color:<% for each row in Orders[ID != 0] { openUrl(input.v, "new window"); } %>">x</div>`,
    `<div title="<% openUrl(input.v, "new window"); %>">x</div>`,
    `<div class="<% openUrl(input.v, "new window"); %>">x</div>`,
    `<a href="<% openUrl(input.v, "new window"); %>">x</a>`,
    `<div title="<% x = input.v; %>">x</div>`,
  ];
  for (const body of bodies) await assertStaysSnippet(body, input);
});

test('a statement island inside a dropped element stays a snippet', async () => {
  const v = 'https://x.test/y onclick=globalThis.__hit=1//';
  const open = `<% openUrl(input.v, "new window"); %>`;
  const bodies = [
    `<div style="color:<%= input.c %>"><style>${open}</style></div>`,
    `<div style='color:<%= input.c %>'><style>${open}</style></div>`,
    `<div title="<%= input.c %>"><style>${open}</style></div>`,
    `<div title='<%= input.c %>'><style>${open}</style></div>`,
    `<a href="<%= input.c %>"><style>${open}</style></a>`,
    `<img alt="<%= input.c %>"><style>${open}</style>`,
    `<img src="<%= input.c %>"><style>${open}</style>`,
    `<img width="<%= input.c %>"><style>${open}</style>`,
  ];
  for (const body of bodies) await assertStaysSnippet(body, { c: 'red', v });
});

test('an if-wrapped openUrl inside a dropped element stays a snippet', async () => {
  const v = 'https://x.test/y onclick=globalThis.__hit=1//';
  const bodies = [
    `<div style="color:<%= input.c %>"><style><% if (input.v != "") { openUrl(input.v, "new window"); } %></style></div>`,
    `<div title="<%= input.c %>"><script><% openUrl(input.v, "new window"); %></script></div>`,
    `<div title="<%= input.c %>"><textarea><% openUrl(input.v, "new window"); %></textarea></div>`,
    `<div title="<%= input.c %>"><xmp><% openUrl(input.v, "new window"); %></xmp></div>`,
    `<div title="<%= input.c %>"><iframe><% openUrl(input.v, "new window"); %></iframe></div>`,
    `<div title="<%= input.c %>"><template><% openUrl(input.v, "new window"); %></template></div>`,
    `<div title="<%= input.c %>"><svg><% openUrl(input.v, "new window"); %></svg></div>`,
    `<div title="<%= input.c %>"><section><% openUrl(input.v, "new window"); %></section></div>`,
    `<div style="color:<%= input.c %>"><style><% openUrl(input.u, "new window"); %></style></div>`,
  ];
  const inputs = [
    { c: 'red', v, u: 'https://x.test/y onerror=globalThis.__hit=1//' },
  ];
  for (const body of bodies) for (const input of inputs) await assertStaysSnippet(body, input);
});

test('an island inside a dropped element keeps handler text out of the parsed output', async () => {
  const { model } = buildUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<div style="color:<%= input.c %>"><style><% openUrl(input.v, "new window"); %></style></div>`)}`),
  );
  assert.equal(uiSnippetFiles(model).length, 0);
  assert.equal(model.todos.filter((todo) => todo.reason === SNIPPET_TODO).length, 1);
});

test('an openUrl in page text stays outside a quoted style expression', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<div style="color:<%= input.c %>" id="t">x</div><%
openUrl(input.v, "new window");
%>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const live = await liveStore({});
  try {
    const value = 'https://x.test/y onclick=globalThis.__hit=1//';
    const out = await invoke(mod.default as never, { ...USER, body: { input: { c: 'red', v: value } } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const html = String(out.body.html);
    const parsed = parsedStyle(html);
    assert.deepEqual(parsed.onAttrs, [], html);
    assert.equal(parsed.style, 'color:red', html);
    const href = readFragment(html, (doc) => doc.querySelector('a')?.getAttribute('href') ?? null);
    assert.equal(href, value, html);
  } finally {
    live.restore();
  }
});

test('a thisapp function call stays a snippet and is not a compiled endpoint', async () => {
  await assertStaysSnippet(`<p><%= thisapp.myfn() %></p>`, {});
  await assertStaysSnippet(
    `<%
x = thisapp.orders.mark(input.id);
%>
<p><%= x %></p>`,
    { id: '1' },
  );
});

test('the read-only island check refuses an await that is not a shim read', () => {
  assert.equal(islandReadOnly('x = await shim.datastore.query(ctx, "Orders", c);'), true);
  assert.equal(islandReadOnly('x = await shim.datastore.aggregate(ctx, q, "count", undefined);'), true);
  assert.equal(islandReadOnly('x = await shim.datastore.field(ctx, q, "Name");'), true);
  assert.equal(islandReadOnly('x = await shim.datastore.column(ctx, q, "Name");'), true);
  assert.equal(islandReadOnly('x = await shim.datastore.rows(ctx, q);'), true);
  assert.equal(
    islandReadOnly(
      'x = await shim.datastore.field(ctx, shim.datastore.query(ctx, "Orders", { op: "==", field: "Status", value: "a)b" }), "Name");',
    ),
    true,
  );
  assert.equal(islandReadOnly('await shim.datastore.field(ctx, q, "Name") = "x";'), false);
  assert.equal(islandReadOnly('shim.list.add(await shim.datastore.field(ctx, rec, "Tags"), "x");'), false);
  assert.equal(islandReadOnly('shim.list.add(local, "x");'), true);
  assert.equal(islandReadOnly('await shim.datastore.column(ctx, q, "Name") = [];'), false);
  assert.equal(islandReadOnly('await shim.datastore.setField(ctx, q, "Name", "x");'), false);
  assert.equal(islandReadOnly('await shim.datastore.flush(ctx);'), false);
  assert.equal(islandReadOnly('await shim.datastore.insert(ctx, "Orders", {});'), false);
  assert.equal(islandReadOnly('await shim.datastore.update(ctx, "Orders", c, {});'), false);
  assert.equal(islandReadOnly('await shim.datastore.delete(ctx, "Orders", c);'), false);
  assert.equal(islandReadOnly('shim.input.set(ctx, ["Status"], "x");'), true);
  assert.equal(islandReadOnly('shim.input.set(ctx, ["page"], shim.ifnull(shim.input.get(ctx, "page"), "1"));'), true);
  assert.equal(islandReadOnly('shim.input.set(ctx, ["row"], await shim.datastore.insert(ctx, "Orders", {}));'), false);
  assert.equal(islandReadOnly('shim.record.set(row, ["Status"], "x");'), false);
  assert.equal(islandReadOnly('x = await foo(ctx);'), false);
  assert.equal(islandReadOnly('x = await (foo(ctx));'), false);
  assert.equal(islandReadOnly('x = await shim.thisapp.call(ctx, "f");'), false);
});

interface FieldGrant {
  fields?: string[];
  read?: boolean;
  write?: boolean;
  ownerScope?: 'view' | 'modify';
}

function rewritePolicy(files: { path: string; data: string | Buffer }[], profiles: Record<string, Record<string, FieldGrant>>): void {
  const file = files.find((item) => item.path === 'functions/access-policy.json');
  assert.ok(file, 'access policy is generated');
  const policy = JSON.parse(String(file.data)) as { profiles: Record<string, unknown> };
  Object.assign(policy.profiles, profiles);
  file.data = JSON.stringify(policy);
}

async function renderLive(
  snippet: string,
  rows: Record<string, unknown>[],
  input: Record<string, unknown>,
  user: typeof USER = USER,
  policy?: Record<string, Record<string, FieldGrant>>,
) {
  const { files, model } = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n${snippet}`)}`));
  const compiled = uiSnippetFiles(model);
  assert.equal(compiled.length, 1, JSON.stringify(model.todos));
  assert.equal(model.todos.filter((todo) => todo.reason === SNIPPET_TODO).length, 0);
  if (policy) rewritePolicy(files, policy);
  const source = String(files.find((file) => file.path === compiled[0]!.path)?.data ?? '');
  const mod = await loadTree(files, compiled[0]!.path);
  const live = await liveStore({ Orders: rows });
  try {
    const out = await invoke(mod.default as never, { ...user, body: { input } });
    const stored = await live.datastore.query('Orders', 'true', 300);
    return { out, source, stored };
  } finally {
    live.restore();
  }
}

async function renderLiveZml(
  snippet: string,
  rows: Record<string, unknown>[],
  input: Record<string, unknown>,
  user: typeof USER = USER,
  policy?: Record<string, Record<string, FieldGrant>>,
) {
  const { files, model } = generateUi(appOf(`${ORDERS}\n${pageWithZmlSnippet(`htmlpage zml1()\ncontent\n${snippet}`)}`));
  const compiled = uiSnippetFiles(model);
  assert.equal(compiled.length, 1, JSON.stringify(model.todos));
  assert.equal(model.todos.filter((todo) => todo.reason === SNIPPET_TODO).length, 0);
  if (policy) rewritePolicy(files, policy);
  const source = String(files.find((file) => file.path === compiled[0]!.path)?.data ?? '');
  const mod = await loadTree(files, compiled[0]!.path);
  const live = await liveStore({ Orders: rows });
  try {
    const out = await invoke(mod.default as never, { ...user, body: { input } });
    const stored = await live.datastore.query('Orders', 'true', 300);
    return { out, source, stored };
  } finally {
    live.restore();
  }
}

test('convertZmlSnippetToHtml converts panel, pr, pc, text, prefix, suffix into safe HTML and CSS', () => {
  const zml = `<panel>
\t<pr width="100%" height="50px;">
\t\t<pc width="100%" paddingLeft="10px" hAlign="left">
\t\t\t<text value="" style="">
\t\t\t\t<prefix value="Welcome " size="4"></prefix>
\t\t\t\t<suffix value="<%=userName%>" size="4" bold="true" color="#962FFF"></suffix>
\t\t\t</text>
\t\t</pc>
\t</pr>
</panel>`;
  const html = convertZmlSnippetToHtml(zml);
  assert.match(html, /<div data-zml="panel">/);
  assert.match(html, /<div data-zml="pr" style="width:100%;height:50px">/);
  assert.match(html, /<div data-zml="pc" style="width:100%;text-align:left;padding-left:10px">/);
  assert.match(html, /<span style="font-size:18px">Welcome <\/span>/);
  assert.match(html, /<span style="color:#962FFF;font-size:18px;font-weight:bold"><%=userName%><\/span>/);
});

test('Shape B: a ZML snippet with single-record query lookup and prefix/suffix interpolation compiles and renders', async () => {
  const { out, source, stored } = await renderLiveZml(
    `<%{
rec = Orders[ID == input.id];
userName = ifnull(rec.Name, "");
%>
<panel>
\t<pr width="100%" height="50px;">
\t\t<pc width="100%" paddingLeft="10px" hAlign="left">
\t\t\t<text value="" style="">
\t\t\t\t<prefix value="Welcome " size="4"></prefix>
\t\t\t\t<suffix value="<%=userName%>" size="4" bold="true" color="#962FFF"></suffix>
\t\t\t</text>
\t\t</pc>
\t</pr>
</panel>
<%
}%>`,
    [{ Name: 'Ada', Status: 'open', Amount: 1 }],
    { id: FIRST_ID },
  );
  assert.match(source, /shim\.datastore\.field\(/);
  assert.match(source, /"forms":\["Orders"\]/);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(String(out.body.html), /<span style="font-size:18px">Welcome <\/span>/);
  assert.match(String(out.body.html), /<span style="color:#962FFF;font-size:18px;font-weight:bold">Ada<\/span>/);
  assert.equal(stored[0]?.Name, 'Ada');
});

test('Shape B: a ZML snippet with direct criteria field interpolation in text element compiles and renders', async () => {
  const { out, source } = await renderLiveZml(
    `<panel>
  <pr height="fill" width="fill">
    <pc width="100%" bgColor="#FFFFFF" padding="20px" hAlign="center" vAlign="middle">
      <text type="Text" value="<%=Orders[ID == input.id].Name%>" size="5" color="#7268cd" bold="true" textAlign="center"> </text>
    </pc>
  </pr>
</panel>`,
    [{ Name: 'Ada', Status: 'open', Amount: 1 }],
    { id: FIRST_ID },
  );
  assert.match(source, /shim\.datastore\.field\(/);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(String(out.body.html), /<div data-zml="pc" style="width:100%;background-color:#FFFFFF;text-align:center;vertical-align:middle;padding:20px"/);
  assert.match(String(out.body.html), /<div style="color:#7268cd;font-size:24px;font-weight:bold;text-align:center">Ada<\/div>/);
});

test('Shape B: an unauthorized caller to a ZML snippet endpoint is refused', async () => {
  const { out } = await renderLiveZml(
    `<panel><pr><pc><text value="<%=Orders[ID == input.id].Name%>"/></pc></pr></panel>`,
    [{ Name: 'OnlyAda', Status: 'open', Amount: 1 }],
    { id: FIRST_ID },
    CLERK,
    { Clerk: {} },
  );
  assert.equal(out.status, 403, JSON.stringify(out.body));
  assert.equal(out.body.html, undefined);
});

test('Shape B: sales-management real page generation and DOM structure comparison against ZML source', async () => {
  const fixtureDir = process.env.C2C_FIXTURES_DIR;
  const salesMgmtPath = fixtureDir ? join(fixtureDir, 'gallery/sales-management/Sales_Management.ds') : '';
  const fallbackApp = `form Add_Sales_Rep
{
\tName
\t(
\t\ttype = text
\t)
\tEmail
\t(
\t\ttype = email
\t)
}
pages
{
\tpage Dashboard
\t{
\t\tdisplayname = "Dashboard"
\t\tContent = "<zml>\\n\\t<layout>\\n\\t<row>\\n\\t<column width='100%'>\\n\\t<dspZml id='zml_snippet' elementName='ZML Snippet'>\\n\\t<![CDATA[htmlpage zml_snippet()\\ncontent\\n&lt;%{\\n\\tgetCurrentUser = Add_Sales_Rep[Email == zoho.loginuserid];\\n\\tuserName = ifnull(getCurrentUser.Name,&quot;&quot;);\\n\\t%&gt;\\n&lt;panel&gt; \\n\\t&lt;pr width=&quot;100%&quot; height=&quot;50px;&quot;&gt;\\n\\t\\t&lt;pc width=&quot;100%&quot; paddingLeft=&quot;10px&quot; hAlign=&quot;left&quot;&gt;\\n\\t\\t\\t&lt;text value=&quot;&quot; style=&quot;&quot;&gt; \\n\\t\\t\\t\\t&lt;prefix value=&quot;Welcome&quot; size=&quot;4&quot;&gt;&lt;/prefix&gt;\\n\\t\\t\\t\\t&lt;suffix value=&quot;&lt;%=userName%&gt;&quot; size=&quot;4&quot; bold=&quot;true&quot; color=&quot;#962FFF&quot;&gt;&lt;/suffix&gt;\\n\\t\\t\\t\\t\\n\\t\\t\\t&lt;/text&gt;\\n\\t\\t&lt;/pc&gt;\\n\\t&lt;/pr&gt;\\n&lt;/panel&gt;\\n&lt;%\\n\\n}%&gt;]]>\\n</dspZml>\\n</column>\\n</row>\\n</layout>\\n</zml>"
\t}
}`;

  const isFixture = existsSync(salesMgmtPath);
  const app = isFixture ? parseFile(salesMgmtPath).ir : appOf(fallbackApp);
  const bundle = generateUi(app);

  // 1. Generation assertions: zero snippet TODOs, Dashboard page model exists
  assert.equal(bundle.model.todos.filter((t) => t.reason === SNIPPET_TODO).length, 0);
  const page = bundle.model.pages.find((p) => p.name === 'Dashboard');
  assert.ok(page, 'Dashboard page exists in generated model');

  // 2. Client-runtime page render: assert produced DOM structure against ZML source
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    renderPage(page: unknown, doc: unknown, appModel: unknown): string;
    sanitizeSnippet(raw: string, doc: unknown): string;
  };
  interface TestElement {
    style: Record<string, string>;
    textContent: string | null;
    innerHTML: string;
    querySelector(selector: string): TestElement | null;
    querySelectorAll(selector: string): TestElement[];
  }
  interface TestDoc {
    body: TestElement;
    querySelector(selector: string): TestElement | null;
    querySelectorAll(selector: string): TestElement[];
  }

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>') as unknown as {
    window: { document: TestDoc };
  };
  const doc = dom.window.document;
  const pageHtml = runtime.renderPage(page, doc, bundle.model);
  doc.body.innerHTML = pageHtml;

  // Root article & layout hierarchy
  const article = dom.window.document.querySelector('article[data-page="Dashboard"]');
  assert.ok(article, 'Dashboard article rendered');
  const layout = article.querySelector('div[data-zml="layout"]');
  assert.ok(layout, 'layout container rendered');
  const firstRow = layout.querySelector('div[data-zml="row"]');
  assert.ok(firstRow, 'first row rendered');
  const firstCol = firstRow.querySelector('div[data-zml="column"][data-width="100%"]');
  assert.ok(firstCol, 'first column with width 100% rendered');

  // Snippet container and static shell mapping
  const snippetHost = firstCol.querySelector('[data-snippet-src="/htmlpages/Dashboard/s0"]');
  assert.ok(snippetHost, 'snippet host element rendered with endpoint src');
  const staticPanel = snippetHost.querySelector('div[data-zml="panel"]');
  assert.ok(staticPanel, 'panel mapped to div[data-zml="panel"]');
  const staticPr = staticPanel.querySelector('div[data-zml="pr"]');
  assert.ok(staticPr, 'pr mapped to div[data-zml="pr"]');
  assert.equal(staticPr.style.width, '100%');
  assert.equal(staticPr.style.height, '50px');
  const staticPc = staticPr.querySelector('div[data-zml="pc"]');
  assert.ok(staticPc, 'pc mapped to div[data-zml="pc"]');
  assert.equal(staticPc.style.width, '100%');
  assert.equal(staticPc.style.textAlign, 'left');
  assert.equal(staticPc.style.paddingLeft, '10px');

  // 3. Dynamic endpoint execution: assert live DOM structure and escaped values
  const snippetFile = bundle.files.find((f) => f.path === 'functions/htmlpages/dashboard-s0.mjs');
  assert.ok(snippetFile, 'functions/htmlpages/dashboard-s0.mjs is generated');
  const mod = await loadTree(bundle.files, snippetFile.path);
  const live = await liveStore({
    Add_Sales_Rep: [
      {
        Name: '<script>alert("XSS")</script> & Ada Lovelace',
        Email: 'ada@example.com',
      },
    ],
  });
  try {
    const out = await invoke(mod.default as never, {
      user: { profile: 'Administrator', loginUser: 'ada@example.com', userId: 'ada@example.com' },
      body: { input: {} },
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const endpointHtml = String(out.body.html);

    // Verify endpoint HTML escaping and element structure
    assert.match(endpointHtml, /<div data-zml="panel">/);
    assert.match(endpointHtml, /<div data-zml="pr" style="width:100%;height:50px">/);
    assert.match(endpointHtml, /<div data-zml="pc" style="width:100%;text-align:left;padding-left:10px">/);
    assert.match(endpointHtml, /<span style="font-size:18px">Welcome<\/span>/);
    assert.match(
      endpointHtml,
      /<span style="color:#962FFF;font-size:18px;font-weight:bold">&lt;script&gt;alert\(&quot;XSS&quot;\)&lt;\/script&gt; &amp; Ada Lovelace<\/span>/,
    );
    assert.equal(renderedDocumentViolation(endpointHtml), '');

    // Insert dynamic HTML into the rendered page DOM and assert DOM nodes
    snippetHost.innerHTML = runtime.sanitizeSnippet(endpointHtml, doc);
    const livePanel = snippetHost.querySelector('div[data-zml="panel"]');
    assert.ok(livePanel, 'live panel exists in DOM');
    const livePr = livePanel.querySelector('div[data-zml="pr"]');
    assert.ok(livePr, 'live pr exists in DOM');
    assert.equal(livePr.style.width, '100%');
    assert.equal(livePr.style.height, '50px');

    const livePc = livePr.querySelector('div[data-zml="pc"]');
    assert.ok(livePc, 'live pc exists in DOM');
    assert.equal(livePc.style.width, '100%');
    assert.equal(livePc.style.textAlign, 'left');
    assert.equal(livePc.style.paddingLeft, '10px');

    const spans = livePc.querySelectorAll('span');
    assert.equal(spans.length, 2, 'prefix and suffix spans present');
    assert.equal(spans[0]?.textContent, 'Welcome');
    assert.equal(spans[0]?.style.fontSize, '18px');
    assert.equal(spans[1]?.textContent, '<script>alert("XSS")</script> & Ada Lovelace');
    assert.equal(spans[1]?.style.fontSize, '18px');
    assert.equal(spans[1]?.style.fontWeight, 'bold');
    assert.equal(doc.querySelectorAll('script').length, 0, 'malicious script element not in DOM');
  } finally {
    live.restore();
  }
});

test('a criteria field read compiles to an endpoint and returns that record', async () => {
  const { out, source, stored } = await renderLive(
    '<p><%= Orders[ID == input.id].Name %></p>',
    [{ Name: 'Ada', Status: 'open', Amount: 1 }],
    { id: FIRST_ID },
  );
  assert.match(source, /shim\.datastore\.field\(/);
  assert.match(source, /"forms":\["Orders"\]/);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(String(out.body.html), /<p>Ada<\/p>/);
  assert.equal(stored[0]?.Name, 'Ada');
});

test('a query variable field read compiles to an endpoint', async () => {
  const { out, source } = await renderLive(
    `<%
rec = Orders[ID == input.id];
%>
<p><%= rec.Name %></p>`,
    [{ Name: 'Ada', Status: 'open', Amount: 1 }],
    { id: FIRST_ID },
  );
  assert.match(source, /shim\.datastore\.field\(/);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(String(out.body.html), /<p>Ada<\/p>/);
});

test('getAll compiles to a column read of the matching records', async () => {
  const { out, source } = await renderLive(
    '<p><%= Orders[Status == "open"].Name.getAll() %></p>',
    [
      { Name: 'Ada', Status: 'open', Amount: 1 },
      { Name: 'Bea', Status: 'open', Amount: 2 },
      { Name: 'Cy', Status: 'closed', Amount: 3 },
    ],
    {},
  );
  assert.match(source, /shim\.datastore\.column\(/);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(String(out.body.html), /<p>Ada, Bea<\/p>/);
  assert.equal(String(out.body.html).includes('Cy'), false);
});

test('a caller without read access to the form gets no record data', async () => {
  const { out, stored } = await renderLive(
    '<p><%= Orders[ID == input.id].Name %></p>',
    [{ Name: 'OnlyAda', Status: 'open', Amount: 1 }],
    { id: FIRST_ID },
    CLERK,
    { Clerk: {} },
  );
  assert.equal(out.status, 403, JSON.stringify(out.body));
  assert.equal(out.body.html, undefined);
  assert.equal(JSON.stringify(out.body).includes('OnlyAda'), false);
  assert.equal(stored[0]?.Name, 'OnlyAda');
});

test('a field outside the caller field list is not returned', async () => {
  const denied = await renderLive(
    '<p><%= Orders[ID == input.id].Name %></p>',
    [{ Name: 'OnlyAda', Status: 'open', Amount: 1 }],
    { id: FIRST_ID },
    CLERK,
    { Clerk: { Orders: { fields: ['Status'] } } },
  );
  assert.equal(denied.out.status, 403, JSON.stringify(denied.out.body));
  assert.equal(JSON.stringify(denied.out.body).includes('OnlyAda'), false);
  assert.equal(denied.stored[0]?.Name, 'OnlyAda');

  const allowed = await renderLive(
    '<p><%= Orders[ID == input.id].Status %></p>',
    [{ Name: 'OnlyAda', Status: 'open', Amount: 1 }],
    { id: FIRST_ID },
    CLERK,
    { Clerk: { Orders: { fields: ['Status'] } } },
  );
  assert.equal(allowed.out.status, 200, JSON.stringify(allowed.out.body));
  assert.match(String(allowed.out.body.html), /<p>open<\/p>/);
  assert.equal(String(allowed.out.body.html).includes('OnlyAda'), false);
});

test('assigning a criteria field stays a snippet and does not update rows', async () => {
  await assertStaysSnippet(
    `<%
Orders[ID == input.id].Name = input.payload;
%>
<p>x</p>`,
    { id: FIRST_ID, payload: 'pwned' },
  );
});

test('an input assignment only changes the request-local values for this render', async () => {
  const { out, source } = await renderLive(
    `<%
input.Status = "closed";
%>
<p><%= input.Status %></p>`,
    [{ Name: 'Ada', Status: 'open', Amount: 1 }],
    { Status: 'open' },
  );
  assert.match(source, /shim\.input\.set\(/);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(String(out.body.html), /<p>closed<\/p>/);
});

test('an ifnull-style input default renders and feeds a bound criteria value', async () => {
  const { out, source } = await renderLive(
    `<%
input.page = ifnull(input.page, "1");
input.status = ifnull(input.status, "open");
n = Orders[Status == input.status].count();
%>
<p><%= input.page %>|<%= n %></p>`,
    [
      { Name: 'Ada', Status: 'open', Amount: 1 },
      { Name: 'Bea', Status: 'open', Amount: 2 },
      { Name: 'Cy', Status: 'closed', Amount: 3 },
    ],
    {},
  );
  // The defaulted value reaches the read as a bound criteria parameter, never
  // concatenated text.
  assert.match(source, /\{ op: "==", field: "Status", value: shim\.input\.get\(ctx, "status"\) \}/);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(String(out.body.html), /<p>1\|2<\/p>/);

  const supplied = await renderLive(
    `<%
input.page = ifnull(input.page, "1");
input.status = ifnull(input.status, "open");
n = Orders[Status == input.status].count();
%>
<p><%= input.page %>|<%= n %></p>`,
    [
      { Name: 'Ada', Status: 'open', Amount: 1 },
      { Name: 'Bea', Status: 'closed', Amount: 2 },
    ],
    { page: '7', status: 'closed' },
  );
  assert.match(String(supplied.out.body.html), /<p>7\|1<\/p>/);
});

test('a write through a prototype path stays a snippet on member and index targets', async () => {
  const attempts = [
    'input.__proto__.leaked = "x";',
    'input.__proto__ = {"leaked":"x"};',
    'input.constructor.prototype.leaked = "x";',
    'input.a.__proto__.leaked = "x";',
    'input["__proto__"]["leaked"] = "x";',
    'input["constructor"]["prototype"]["leaked"] = "x";',
    'old["constructor"]["prototype"]["leaked"] = "x";',
  ];
  for (const stmt of attempts) {
    delete (Object.prototype as Record<string, unknown>).leaked;
    await assertStaysSnippet(`<%\n${stmt}\n%>\n<p><%= input.leaked %></p>`, {});
    assert.equal(({} as Record<string, unknown>).leaked, undefined, stmt);
  }
});

test('an input write with a computed or escaped key compiles but cannot reach the prototype', async () => {
  for (const stmt of ['k = "__proto__";\ninput[k] = {"leaked":"x"};', 'input["\\u005f\\u005fproto__"] = {"leaked":"x"};']) {
    delete (Object.prototype as Record<string, unknown>).leaked;
    const { out, source } = await renderLive(`<%\n${stmt}\n%>\n<p><%= input.leaked %></p>`, SEEDED.Orders, {});
    assert.match(source, /shim\.input\.set\(ctx, \[/);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.doesNotMatch(String(out.body.html), /x<\/p>/);
    assert.equal(({} as Record<string, unknown>).leaked, undefined, stmt);
  }
});

test('a prototype object is never a readable value or a writable target', async () => {
  const attempts = [
    // Index read of a prototype key, then a member write through the local.
    'p = input["__proto__"];\np.leaked = "x";',
    'k = "__proto__";\np = input[k];\np.leaked = "x";',
    'k = "__proto__";\np = old[k];\np.leaked = "x";',
    'c = input["constructor"];\np = c["prototype"];\np.leaked = "x";',
    // Member read on a local map, then a member write.
    'm = Map();\np = m.__proto__;\np.leaked = "x";',
    // A stored prototype: the holder path must be inert on read and write.
    'input.holder = input["__proto__"];\ninput.holder.leaked = "x";',
    'input.holder = input["constructor"].prototype;\ninput.holder.leaked = "x";',
    'input.holder = input["__proto__"];\np = input.holder;\np.leaked = "x";',
  ];
  for (const stmt of attempts) {
    delete (Object.prototype as Record<string, unknown>).leaked;
    const { out } = await renderLive(`<%\n${stmt}\n%>\n<p><%= input.leaked %></p>`, SEEDED.Orders, {});
    assert.equal(out.status, 200, `${stmt}: ${JSON.stringify(out.body)}`);
    assert.doesNotMatch(String(out.body.html), /x<\/p>/, stmt);
    assert.equal(({} as Record<string, unknown>).leaked, undefined, stmt);
  }
});

test('a computed map write cannot reach the prototype, including keys from request input', async () => {
  const direct = await renderLive(
    '<%\nm = Map();\nk = "__proto__";\nf = "leaked";\nm[k][f] = "x";\n%>\n<p><%= m.leaked %></p>',
    SEEDED.Orders,
    {},
  );
  assert.equal(direct.out.status, 200, JSON.stringify(direct.out.body));
  assert.equal(({} as Record<string, unknown>).leaked, undefined);

  // k, f, and v all arrive from the request.
  const viaInput = await renderLive(
    '<%\nm = Map();\nk = input.k;\nf = input.f;\nv = input.v;\nm[k][f] = v;\np = m[k];\np[f] = v;\n%>\n<p><%= m.leaked %></p>',
    SEEDED.Orders,
    { k: '__proto__', f: 'leaked', v: 'x' },
  );
  assert.equal(viaInput.out.status, 200, JSON.stringify(viaInput.out.body));
  assert.equal(({} as Record<string, unknown>).leaked, undefined);

  // Assigning the key itself cannot reparent the map.
  const reparent = await renderLive(
    '<%\nm = Map();\nm["safe"] = "yes";\nm[input.k] = {"leaked":"x"};\n%>\n<p><%= m.leaked %>|<%= m.safe %></p>',
    SEEDED.Orders,
    { k: '__proto__' },
  );
  assert.equal(reparent.out.status, 200, JSON.stringify(reparent.out.body));
  assert.match(String(reparent.out.body.html), /<p>\|yes<\/p>/);
  assert.equal(({} as Record<string, unknown>).leaked, undefined);
});

test('an inherited or unsafe key reads as undefined on input, old, and map index surfaces', async () => {
  const spellings = ['__proto__', 'constructor', 'prototype', '__defineGetter__', '__lookupGetter__', 'toString', 'valueOf', 'hasOwnProperty'];
  for (const key of spellings) {
    // No own key: the inherited member must not render (a native source leak
    // for `toString`, a writable prototype for the rest).
    const plain = await renderLive(
      `<%\nm = Map();\nm["safe"] = "yes";\n%>\n<p><%= input["${key}"] %>|<%= old["${key}"] %>|<%= m["${key}"] %></p>`,
      SEEDED.Orders,
      {},
    );
    assert.equal(plain.out.status, 200, `${key}: ${JSON.stringify(plain.out.body)}`);
    assert.match(String(plain.out.body.html), /<p>\|\|<\/p>/, key);
    assert.doesNotMatch(String(plain.out.body.html), /native code/, key);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    // Even an own key spelled like a prototype segment is refused by name.
    const owned = await renderLive(
      `<%\nm = Map();\n%>\n<p><%= input["${key}"] %>|<%= m["${key}"] %></p>`,
      SEEDED.Orders,
      { [key]: 'x' },
    );
    assert.equal(owned.out.status, 200, `${key}: ${JSON.stringify(owned.out.body)}`);
    assert.match(String(owned.out.body.html), /<p>\|<\/p>/, key);
  }
});

test('writing an inherited method name only sets an own key on the request values', async () => {
  const { out } = await renderLive('<%\ninput.toString = "mine";\n%>\n<p><%= input.toString %></p>', SEEDED.Orders, {});
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(String(out.body.html), /<p>mine<\/p>/);
  assert.equal(typeof ({} as Record<string, unknown>).toString, 'function');
});

test('an input assignment followed by a datastore write stays a snippet', async () => {
  await assertStaysSnippet(
    `<%
input.Status = "open";
insert into Orders [ Status : "open" ];
%>
<p>x</p>`,
    {},
  );
  await assertStaysSnippet(
    `<%
input.Status = "open";
row = insert into Orders [ Status : input.Status ];
%>
<p>x</p>`,
    {},
  );
});

test('a caller-supplied value assigned to input is escaped when rendered', async () => {
  const { out } = await renderLive(
    `<%
input.x = ifnull(input.payload, "none");
%>
<p title="<%= input.x %>"><%= input.x %></p>`,
    [],
    { payload: '<script>alert(1)</script>" onclick="x' },
  );
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const html = String(out.body.html);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /" onclick="/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a list add on a fetched field stays a snippet', async () => {
  const { model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<%
rec = Orders[ID == input.id];
rec.Tags.add("x");
%>
<p>x</p>`)}`),
  );
  assert.equal(uiSnippetFiles(model).length, 0);
  assert.equal(model.todos.filter((todo) => todo.reason === SNIPPET_TODO).length, 1);
});

test('the browser runtime flattens the same characters and refuses the same schemes', () => {
  const policy = readFileSync(join(process.cwd(), 'packages/ui/src/url-policy.ts'), 'utf8');
  const client = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  assert.match(policy, /\[\\u0000-\\u0020\]/);
  assert.match(client, /\[\\u0000-\\u0020\]/);
  for (const scheme of ['javascript:', 'data:', 'vbscript:']) {
    assert.equal(policy.includes(`'${scheme}'`), true, scheme);
    assert.equal(client.includes(`'${scheme}'`), true, scheme);
  }
  for (const scheme of ['http:', 'https:', 'mailto:']) {
    assert.equal(policy.includes(`'${scheme}'`), true, scheme);
  }
});

test('islands outside the handled classes keep the counted TODO', () => {
  const writes = `htmlpage hp1()
content
<%
row = insert into Orders [ Status : "open" ];
%>`;
  for (const snippet of [writes]) {
    const { model } = buildUi(appOf(`${ORDERS}\n${pageWithSnippet(snippet)}`));
    assert.equal(model.todos.length, 1, snippet);
    assert.equal(model.todos[0].reason, 'Server-side Deluge snippet requires manual translation');
    assert.equal(uiSnippetFiles(model).length, 0);
  }
});

test('a ZML ExecuteFunction button keeps the snippet counted with a button-specific reason', () => {
  const specific = "Server-side Deluge snippet with an ExecuteFunction button requires manual translation of the button's function call";
  const button = (params: string, action = 'ExecuteFunction') =>
    `<button text='Go' type='rounded' action='${action}' functionName='helpers.mark' parameters='${params}' successMsg='Done' />`;
  const wrap = (inner: string) => `htmlpage hp1()
content
<%{
  rec = Orders[Status == "open"];
  %>
<panel><pr><pc><text type='Text' value='<%=rec.Status%>' /></pc></pr>
<pr><pc>${inner}</pc></pr></panel>
<%
}%>`;
  // An island parameter, two island parameters, a static parameter, and an
  // action written with odd case and spacing all name the button.
  for (const inner of [button('<%=rec.ID%>'), button('<%=rec.ID%>,<%=rec.Amount%>'), button('7'), button('1', ' executeFunction ')]) {
    const snippet = wrap(inner);
    const compiled = compileHtmlpage(appOf(ORDERS), 'Home', 'hp1', snippet);
    assert.equal(compiled.ok, false, inner);
    assert.equal(compiled.reason, 'ZML ExecuteFunction button', inner);
    const { model } = buildUi(appOf(`${ORDERS}\n${pageWithSnippet(snippet)}`));
    assert.equal(model.todos.length, 1, inner);
    assert.match(model.todos[0].reason, /<button> "Go" click action ExecuteFunction calling function helpers\.mark is not generated/, inner);
    assert.equal(uiSnippetFiles(model).length, 0, inner);
  }
  // Without the button the same snippet compiles: the button alone is the blocker.
  assert.equal(compileHtmlpage(appOf(ORDERS), 'Home', 'hp1', wrap('')).ok, true);
  // A button with another action is not an ExecuteFunction call and keeps today's result.
  const other = compileHtmlpage(appOf(ORDERS), 'Home', 'hp1', wrap(button('1', 'OpenUrl')));
  assert.notEqual(other.reason, 'ZML ExecuteFunction button');
});

test('a plain dsp snippet with a ZML ExecuteFunction button is counted, not sanitized away', () => {
  const button = (action: string) =>
    `<button text='Go' type='rounded' action='${action}' functionName='helpers.mark' parameters='7' successMsg='Done' />`;
  // No htmlpage header and no island: the snippet used to reach the sanitizer,
  // which dropped the function call without a TODO.
  for (const action of ['ExecuteFunction', ' executeFunction ']) {
    const snippet = `<div class='card'><p>Mark the order</p>${button(action)}</div>`;
    const { model } = buildUi(appOf(`${ORDERS}\n${pageWithSnippet(snippet)}`));
    assert.equal(model.todos.length, 1, action);
    assert.match(model.todos[0].reason, /<button> "Go" click action ExecuteFunction calling function helpers\.mark is not generated/, action);
    assert.equal(uiSnippetFiles(model).length, 0, action);
  }
  // Without the button, or with another action, the plain snippet keeps today's sanitized result.
  for (const inner of ['', button('OpenUrl')]) {
    const { model } = buildUi(appOf(`${ORDERS}\n${pageWithSnippet(`<div class='card'><p>Mark the order</p>${inner}</div>`)}`));
    assert.equal(model.todos.length, 0, inner);
  }
});

/** An app with one read-only Deluge function `helpers.mark` plus the Orders page shell. */
function appWithFns(fns: { name: string; signature: string; deluge: string }[], body = ORDERS): App {
  const app = appOf(body);
  const span = { start: 0, end: 0 };
  for (const fn of fns) {
    app.functions.push({ name: fn.name, kind: 'deluge', signature: fn.signature, deluge: [{ text: fn.deluge, span }], properties: [], span });
  }
  return app;
}

const execButton = (fn: string, params: string, extra = '') =>
  `<button text='Go' type='rounded' action='ExecuteFunction' functionName='${fn}' parameters='${params}' successMsg='Done'${extra} />`;

test('an ExecuteFunction button on a clean read-only function compiles to a call button', async () => {
  const app = appWithFns(
    [{ name: 'helpers.mark', signature: 'int helpers.mark(int n)', deluge: 'return n + 1;' }],
    `${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<% x = 1; %>
<p>Mark</p>
${execButton('helpers.mark', '7')}`)}`,
  );
  const snippet = `htmlpage hp1()\ncontent\n<% x = 1; %>\n<p>Mark</p>\n${execButton('helpers.mark', '7')}`;
  const compiled = compileHtmlpage(app, 'Home', 'hp1', snippet);
  assert.equal(compiled.ok, true, compiled.reason);
  assert.match(compiled.html ?? '', /<button type="button" data-fn-call="\/functions\/helpers-mark\/call" data-fn-args="c=7" data-fn-msg="Done">Go<\/button>/);
  const callFile = (compiled.files ?? []).find((f) => f.path === 'functions/custom/helpers-mark-call.mjs');
  assert.ok(callFile, 'the generated client-call endpoint is emitted with the snippet');
  assert.match(callFile!.source, /path: "\/functions\/helpers-mark\/call"/);

  const { files, model } = generateUi(app);
  assert.deepEqual(model.todos, []);
  const names = uiSnippetFiles(model).map((f) => f.path);
  assert.ok(names.includes('functions/custom/helpers-mark-call.mjs'));
  // The call endpoint answers like any other generated client call.
  const mod = await loadTree(files, 'functions/custom/helpers-mark-call.mjs');
  const out = await invoke(mod.default as never, { ...USER, body: { args: [7] } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.ok, true);
});

test('a wired ExecuteFunction button is not counted but an image action beside it still is', () => {
  const image = `<image action='Function' functionName='notify_team' elementName='Bell' src='https://example.com/bell.png'>`;
  const snippet = `htmlpage hp1()\ncontent\n<% x = 1; %>\n<p>Mark</p>\n${execButton('helpers.mark', '7')}${image}`;
  const app = appWithFns(
    [{ name: 'helpers.mark', signature: 'int helpers.mark(int n)', deluge: 'return n + 1;' }],
    `${ORDERS}\n${pageWithSnippet(snippet)}`,
  );
  const { model } = generateUi(app);
  assert.equal(model.todos.length, 1, JSON.stringify(model.todos));
  assert.match(model.todos[0].reason, /"Bell" click action Function calling function notify_team is not generated/);
  assert.ok(uiSnippetFiles(model).some((f) => f.path === 'functions/custom/helpers-mark-call.mjs'));
});

test('an ExecuteFunction button for an unknown function stays counted', () => {
  const snippet = `htmlpage hp1()\ncontent\n<% x = 1; %>\n<p>Mark</p>\n${execButton('ghost.fn', '7')}`;
  const compiled = compileHtmlpage(appWithFns([], `${ORDERS}\n${pageWithSnippet('x')}`), 'Home', 'hp1', snippet);
  assert.equal(compiled.ok, false);
  assert.equal(compiled.reason, 'ZML ExecuteFunction button');
  const { model } = buildUi(appWithFns([], `${ORDERS}\n${pageWithSnippet(snippet)}`));
  assert.equal(model.todos.length, 1);
  assert.match(model.todos[0].reason, /<button> "Go" click action ExecuteFunction calling function ghost\.fn is not generated/);
});

test('an ExecuteFunction button for a function with a translation TODO stays counted', () => {
  const deluge = 'x = median("abc");\nreturn 1;';
  const a = appWithFns(
    [{ name: 'helpers.bad', signature: 'int helpers.bad(int n)', deluge }],
    `${ORDERS}\n${pageWithSnippet('x')}`,
  );
  const snippet = `htmlpage hp1()\ncontent\n<% x = 1; %>\n<p>Mark</p>\n${execButton('helpers.bad', '7')}`;
  const compiled = compileHtmlpage(a, 'Home', 'hp1', snippet);
  assert.equal(compiled.ok, false, deluge);
  assert.equal(compiled.reason, 'ZML ExecuteFunction button', deluge);
  const { model } = buildUi(appWithFns([{ name: 'helpers.bad', signature: 'int helpers.bad(int n)', deluge }], `${ORDERS}\n${pageWithSnippet(snippet)}`));
  assert.equal(model.todos.length, 1, deluge);
  assert.match(model.todos[0].reason, /<button> "Go" click action ExecuteFunction calling function helpers\.bad is not generated/, deluge);
});

test('ExecuteFunction button arguments are URL-encoded constants and declared page params', async () => {
  const tricky = ['a&b', 'x=y', 'c#d', '50%', 'café ☕', 'javascript:alert(1)'];
  const params = tricky.map((s) => `"${s}"`).join(',');
  const app = appWithFns(
    [{ name: 'helpers.mark', signature: 'int helpers.mark(string a, string b, string c, string d, string e, string f, string id)', deluge: 'return 0;' }],
    `${ORDERS}\n${pageWithSnippet(`htmlpage hp1(id)
content
<% x = 1; %>
${execButton('helpers.mark', `${params},<%=id%>`)}`)}`,
  );
  const snippet = `htmlpage hp1(id)\ncontent\n<% x = 1; %>\n${execButton('helpers.mark', `${params},<%=id%>`)}`;
  const compiled = compileHtmlpage(app, 'Home', 'hp1', snippet);
  assert.equal(compiled.ok, true, compiled.reason);
  const html = compiled.html ?? '';
  const m = /data-fn-args="([^"]*)"/.exec(html);
  assert.ok(m, html);
  assert.match(sanitizeSnippet(html), /data-fn-args="/, 'button attrs survive the build-time sanitizer');
  const doc = new JSDOM('<!doctype html><body></body>').window.document;
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    sanitizeSnippet: (raw: string, doc?: unknown) => string;
  };
  const clean = runtime.sanitizeSnippet(html, doc);
  const cm = /data-fn-args="([^"]*)"/.exec(clean);
  assert.ok(cm, `button attrs survive the snippet sanitizer: ${clean}`);
  const decoded = cm![1].replace(/&amp;/g, '&').split('&').map((part) => {
    const eq = part.indexOf('=');
    return { kind: part.slice(0, eq), value: decodeURIComponent(part.slice(eq + 1)) };
  });
  assert.deepEqual(
    decoded.slice(0, tricky.length).map((d) => ({ kind: d.kind, value: JSON.parse(d.value) })),
    tricky.map((s) => ({ kind: 'c', value: s })),
  );
  assert.deepEqual(decoded[tricky.length], { kind: 'p', value: 'id' });
  assert.equal(html.includes('javascript:'), false, 'the javascript: constant is only ever inside the encoded value');
});

test('ExecuteFunction button island and non-plain arguments stay counted', () => {
  const app = appWithFns(
    [{ name: 'helpers.mark', signature: 'int helpers.mark(int n)', deluge: 'return n;' }],
    `${ORDERS}\n${pageWithSnippet('x')}`,
  );
  for (const params of [
    '<%=memberID%>', // caller-derived value, not a declared page param
    '<%=rec.ID%>', // a fetched record id
    '<%=id + 1%>', // not a plain read
    'pre_<%=id%>', // an island that does not span the whole argument
    'input.id', // unquoted non-constant
  ]) {
    const snippet = `htmlpage hp1(id)\ncontent\n<% x = 1; %>\n${execButton('helpers.mark', params)}`;
    const compiled = compileHtmlpage(app, 'Home', 'hp1', snippet);
    assert.equal(compiled.ok, false, params);
    assert.equal(compiled.reason, 'ZML ExecuteFunction button', params);
  }
});


test('an ExecuteFunction button can invoke a writing function with a rendered argument', async () => {
  const writeFn = `update Orders[ID == id] [ Status : "closed" ];`;
  const snippet = `htmlpage hp1()\ncontent\n<%{\n  row = Orders[Status == "open"];\n  if(row.count() != 0)\n  {\n    %>\n${execButton('helpers.close', '<%=row.ID%>')}\n<%\n  }\n}%>`;
  const app = appWithFns([{ name: 'helpers.close', signature: 'void helpers.close(int id)', deluge: writeFn }], `${ORDERS}\n${pageWithSnippet(snippet)}`);
  const { files, model } = generateUi(app);
  assert.deepEqual(model.todos, []);
  const callPath = 'functions/custom/helpers-close-call.mjs';
  const callFile = uiSnippetFiles(model).find((f) => f.path === callPath);
  assert.ok(callFile, 'the write-call endpoint is emitted with the snippet');
  assert.match(callFile!.source, /writeForms = \[\{"form":"Orders","op":"update"\}\]/);

  const pageFile = uiSnippetFiles(model).find((f) => f.path === 'functions/htmlpages/home-s0.mjs');
  assert.ok(pageFile, 'the button keeps its server-rendered argument');
  const pageMod = await loadTree(files, pageFile!.path);
  const live = await liveStore({ Orders: [{ Status: 'open', Amount: 1 }] });
  try {
    const rendered = await invoke(pageMod.default as never, { ...USER, body: { input: {} } });
    assert.equal(rendered.status, 200, JSON.stringify(rendered.body));
    const html = String(rendered.body.html);
    assert.match(html, /data-fn-call="\/functions\/helpers-close\/call"/);
    assert.match(html, /data-fn-arg-0="n:1000"/);

    const callMod = await loadTree(files, callPath);
    const ok = await invoke(callMod.default as never, { ...USER, body: { args: [1000] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((live.tables.get('Orders') ?? [])[0]?.Status, 'closed');
  } finally {
    live.restore();
  }
});

test('an ExecuteFunction write call refuses a caller without the write grant', async () => {
  const writeFn = `update Orders[ID == id] [ Status : "closed" ];`;
  const app = appWithFns([{ name: 'helpers.close', signature: 'void helpers.close(int id)', deluge: writeFn }], `${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n<% x = 1; %>\n${execButton('helpers.close', '7')}`)}`);
  const { files, model } = generateUi(app);
  const callPath = 'functions/custom/helpers-close-call.mjs';
  assert.ok(uiSnippetFiles(model).some((f) => f.path === callPath));
  const callMod = await loadTree(files, callPath);
  const live = await liveStore({ Orders: [{ Status: 'open', Amount: 1 }] });
  try {
    const denied = await invoke(callMod.default as never, { ...CLERK, body: { args: [1000] } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal((live.tables.get('Orders') ?? [])[0]?.Status, 'open');
  } finally {
    live.restore();
  }
});

test('an ExecuteFunction write call rejects tampered argument envelopes', async () => {
  const writeFn = `update Orders[ID == id] [ Status : "closed" ];`;
  const app = appWithFns([{ name: 'helpers.close', signature: 'void helpers.close(int id)', deluge: writeFn }], `${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n<% x = 1; %>\n${execButton('helpers.close', '7')}`)}`);
  const { files, model } = generateUi(app);
  const callPath = 'functions/custom/helpers-close-call.mjs';
  assert.ok(uiSnippetFiles(model).some((f) => f.path === callPath));
  const callMod = await loadTree(files, callPath);
  const live = await liveStore({ Orders: [{ Status: 'open', Amount: 1 }] });
  try {
    for (const args of [[], [1000, 2], [{ __row: true, form: 'Orders', values: { ID: 1000 } }]]) {
      const out = await invoke(callMod.default as never, { ...USER, body: { args } });
      assert.equal(out.status, 400, JSON.stringify({ args, body: out.body }));
      assert.equal((live.tables.get('Orders') ?? [])[0]?.Status, 'open');
    }
  } finally {
    live.restore();
  }
});

test('an ExecuteFunction write call refuses an unauthenticated caller and injected arguments', async () => {
  const writeFn = `update Orders[ID == id] [ Status : "closed" ];`;
  const app = appWithFns([{ name: 'helpers.close', signature: 'void helpers.close(int id)', deluge: writeFn }], `${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n<% x = 1; %>\n${execButton('helpers.close', '7')}`)}`);
  const { files, model } = generateUi(app);
  const callPath = 'functions/custom/helpers-close-call.mjs';
  assert.ok(uiSnippetFiles(model).some((f) => f.path === callPath));
  const callMod = await loadTree(files, callPath);
  const live = await liveStore({ Orders: [{ Status: 'open', Amount: 1 }] });
  try {
    const anon = await invoke(callMod.default as never, { body: { args: [1000] } });
    assert.equal(anon.status, 401, JSON.stringify(anon.body));
    for (const args of [[JSON.parse('{"__proto__":{"polluted":"yes"}}')], [JSON.parse('{"safe":{"__proto__":{"polluted":"yes"}}}')], [{ __row: true, form: 'Orders', values: { ID: 1000 } }]]) {
      const out = await invoke(callMod.default as never, { ...USER, body: { args } });
      assert.equal(out.status, 400, JSON.stringify({ args, body: out.body }));
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'no prototype pollution');
    assert.equal((live.tables.get('Orders') ?? [])[0]?.Status, 'open');
  } finally {
    live.restore();
  }
});

test('an ExecuteFunction write call cannot reach a row outside the caller\'s owner scope', async () => {
  const writeFn = `update Orders[ID == id] [ Status : "closed" ];`;
  const app = appWithFns([{ name: 'helpers.close', signature: 'void helpers.close(int id)', deluge: writeFn }], `${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n<% x = 1; %>\n${execButton('helpers.close', '7')}`)}`);
  const { files, model } = generateUi(app);
  const callPath = 'functions/custom/helpers-close-call.mjs';
  assert.ok(uiSnippetFiles(model).some((f) => f.path === callPath));
  // Clerk may update Orders but only rows it owns (Added_User == login user).
  const callFile = files.find((f) => f.path === callPath);
  assert.ok(callFile);
  const callSrc = String(callFile.data);
  const accessDecl = callSrc.match(/export const access = (\{.*\});/);
  assert.ok(accessDecl, 'call module embeds its access policy');
  const callAccess = JSON.parse(accessDecl[1]!) as { profiles: Record<string, Record<string, FieldGrant>> };
  Object.assign(callAccess.profiles, { Clerk: { Orders: { write: true, ownerScope: 'view' } } });
  callFile.data = callSrc.replace(accessDecl[0], `export const access = ${JSON.stringify(callAccess)};`);
  const callMod = await loadTree(files, callPath);
  const clerk = { user: { profile: 'Clerk', loginUser: 'cy@example.com', userId: 'u3' } };
  const live = await liveStore({ Orders: [{ Status: 'open', Amount: 1, Added_User: 'bea@example.com' }, { Status: 'open', Amount: 2, Added_User: 'cy@example.com' }] });
  try {
    // Another user's ROWID is invisible to the caller-scoped read: no write persists.
    const foreign = await invoke(callMod.default as never, { ...clerk, body: { args: [1000] } });
    assert.notEqual(foreign.status, 500, JSON.stringify(foreign.body));
    assert.equal((live.tables.get('Orders') ?? [])[0]?.Status, 'open');
    // The same call on the caller's own row works, proving the write path itself.
    const own = await invoke(callMod.default as never, { ...clerk, body: { args: [1001] } });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal((live.tables.get('Orders') ?? [])[1]?.Status, 'closed');
    assert.equal((live.tables.get('Orders') ?? [])[0]?.Status, 'open');
  } finally {
    live.restore();
  }
});

test('the ExecuteFunction button tag scan stays linear on adversarial templates', () => {
  const app = appWithFns(
    [{ name: 'helpers.mark', signature: 'int helpers.mark(int n)', deluge: 'return n + 1;' }],
    `${ORDERS}\n${pageWithSnippet('x')}`,
  );
  const junk = [
    `<button${' '.repeat(50_000)}`, // unterminated tag: a run of spaces
    `<button a=b${' /'.repeat(60_000)}`, // unterminated tag: `/` and space runs
    `<button ${'x=1 '.repeat(40_000)}`, // unterminated tag: attribute runs
    `<button a='${'b'.repeat(150_000)}`, // a quote that never closes
    '<button '.repeat(25_000), // many `<button` opens, none closed
  ];
  // Warm the compile path once so the timing measures the scan, not JIT.
  compileHtmlpage(app, 'Home', 'hp1', `htmlpage hp1()\ncontent\n<% x = 1; %>\n${execButton('helpers.mark', '7')}`);
  for (const hostile of junk) {
    const snippet = `htmlpage hp1()\ncontent\n<% x = 1; %>\n${hostile}${execButton('helpers.mark', '7')}${hostile}`;
    const t0 = performance.now();
    compileHtmlpage(app, 'Home', 'hp1', snippet);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 250, `input of ${snippet.length} chars took ${elapsed.toFixed(1)} ms`);
  }
});

test('page input query parameters cannot reach prototype properties', async () => {
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    snippetPageInput: (docRef: unknown) => Record<string, string>;
  };
  const input = runtime.snippetPageInput({
    location: { search: '?__proto__=x&constructor=y&prototype=z&toString=w&a=1&a=2', hash: '#frag?b=3' },
  });
  assert.equal(Object.getPrototypeOf(input), null);
  assert.equal(input.a, '1', 'the first value wins');
  assert.equal(input.b, '3', 'hash query parameters are read');
  assert.equal(input.toString, 'w', 'a plain string param cannot shadow a builtin');
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(Object.prototype.hasOwnProperty.call(input, key), false, key);
  }
  assert.equal(({} as Record<string, string>).x, undefined, 'no prototype pollution');
});

test('a for-each loop over a form query renders a row per record', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<ul><%
for each row in Orders[Status == "open"] {
%><li><%= row.Status %>:<%= row.Amount %></li><%
}
%></ul>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const entry = uiSnippetFiles(model)[0];
  const source = String(files.find((file) => file.path === entry.path)?.data ?? '');
  assert.match(source, /await shim\.datastore\.rows\(ctx/);
  assert.doesNotMatch(source, /datastore\.flush/);
  const mod = await loadTree(files, entry.path);
  const live = await liveStore(SEEDED);
  try {
    const out = await invoke(mod.default as never, { ...USER, body: { input: {} } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const html = String(out.body.html);
    assert.equal(html.match(/<li>/g)?.length, 2, html);
    assert.match(html, /<li>open:1<\/li>/);
    assert.match(html, /<li>open:2<\/li>/);
    assert.doesNotMatch(html, /closed/);
  } finally {
    live.restore();
  }
});

test('a for-each loop over a plain list renders each element', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<ul><%
for each v in {"alpha", "beta"} {
%><li><%= v %></li><%
}
%></ul>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const live = await liveStore({});
  try {
    const out = await invoke(mod.default as never, { ...USER, body: { input: {} } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const html = String(out.body.html);
    assert.match(html, /<li>alpha<\/li><li>beta<\/li>/);
  } finally {
    live.restore();
  }
});

test('comment island dropped', async () => {
  const live = await liveStore({});
  try {
    const cases = [
      {
        template: '<p>before</p><!-- <%= input.secret %> --><p>after</p>',
        input: { secret: '--> <script>alert(1)</script>' },
        expected: '<p>before</p><p>after</p>',
      },
      {
        template: '<b>shown</b><!-- <% x = 1; %> --><!-- <%= input.val %> --><i>also shown</i>',
        input: { val: 'omitted' },
        expected: '<b>shown</b><i>also shown</i>',
      },
      {
        template: '<p>before</p><!-- <%= input.secret %> --!><p>after</p>',
        input: { secret: '--> <script>alert(1)</script>' },
        expected: '<p>before</p><p>after</p>',
      },
      {
        template: '<p>before</p><!-- <%= input.secret %>',
        input: { secret: '--> <script>alert(1)</script>' },
        expected: '<p>before</p>',
      },
    ];
    for (const c of cases) {
      const { files, model } = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n${c.template}`)}`));
      const compiled = uiSnippetFiles(model);
      assert.equal(compiled.length, 1, c.template);
      const mod = await loadTree(files, compiled[0].path);
      const out = await invoke(mod.default as never, { ...USER, body: { input: c.input } });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const html = String(out.body.html);
      assert.equal(html, c.expected);
      for (const bad of ['alert', 'script', '-->', '--!>', 'omitted']) assert.ok(!html.includes(bad), `${bad} in ${html}`);
    }
  } finally {
    live.restore();
  }
});

test('a comment closed by --!> ends where the HTML parser ends it', async () => {
  const live = await liveStore({});
  try {
    // The sanitizer's comment scan must stop at --!> exactly as DOMParser
    // does: the text after it is markup again, not comment content.
    const cases = [
      {
        template: '<p>a</p><!-- <%= input.drop %> --> <%= input.val %> <p>b</p>',
        input: { drop: 'gone', val: 'shown' },
        expected: '<p>a</p> shown <p>b</p>',
      },
      {
        template: '<p>a</p><!-- <%= input.drop %> --!> <%= input.val %> <p>b</p>',
        input: { drop: 'gone', val: 'shown' },
        expected: '<p>a</p> shown <p>b</p>',
      },
      {
        // A comment nested inside a comment is not a new comment: the first
        // close ends it and the tail is markup again.
        template: '<p>a</p><!-- one <!-- <%= input.val %> --> tail <p>b</p>',
        input: { val: 'omitted' },
        expected: '<p>a</p> tail <p>b</p>',
      },
      {
        template: '<p>a</p><!-- never <%= input.val %> closed <p>b</p>',
        input: { val: 'omitted' },
        expected: '<p>a</p>',
      },
    ];
    for (const c of cases) {
      const { files, model } = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n${c.template}`)}`));
      const compiled = uiSnippetFiles(model);
      assert.equal(compiled.length, 1, c.template);
      const mod = await loadTree(files, compiled[0].path);
      const out = await invoke(mod.default as never, { ...USER, body: { input: c.input ?? {} } });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const html = String(out.body.html);
      assert.equal(html, c.expected);
      for (const bad of ['-->', '--!>', 'omitted']) assert.ok(!html.includes(bad), `${bad} in ${html}`);
    }
  } finally {
    live.restore();
  }
});

test('page names and snippet ids with long dash runs slugify in linear time', () => {
  // ReDoS regression: the file-path slug used to be two regex passes whose
  // alternation backtracked quadratically on uncontrolled separator runs.
  const dashes = `x${'-'.repeat(100_000)}x`;
  const t0 = performance.now();
  const compiled = compileHtmlpage(appOf(ORDERS), dashes, 'hp1', 'htmlpage hp1()\ncontent\n<p><%= input.val %></p>', {
    id: dashes,
  });
  const elapsed = performance.now() - t0;
  assert.ok(compiled.ok, compiled.ok ? '' : compiled.reason);
  assert.equal(compiled.file!.path, 'functions/htmlpages/x-x-x-x.mjs');
  assert.ok(elapsed < 1000, `compile took ${elapsed} ms`);
});

test('a field value inside a loop is escaped in the rendered page', async () => {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<ul><%
for each row in Orders[ID != 0] {
%><li><%= row.Status %></li><%
}
%></ul>`)}`),
  );
  assert.deepEqual(model.todos, []);
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const live = await liveStore({ Orders: [{ Status: 'x"><script>alert(1)</script>', Amount: 1 }] });
  try {
    const out = await invoke(mod.default as never, { ...USER, body: { input: {} } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const html = String(out.body.html);
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  } finally {
    live.restore();
  }
});

test('unquoted value with space/quote/> stays inside one quoted attribute', async () => {
  const live = await liveStore({});
  try {
    const cases = [
      {
        template: '<div title=<%= input.v %>>text</div>',
        input: { v: 'a "b" c > d' },
        expected: '<div title="a &quot;b&quot; c &gt; d">text</div>',
      },
      {
        template: '<span title=pre_<%= input.v %>_suf>text</span>',
        input: { v: 'mid "quoted" > end' },
        expected: '<span title="pre_mid &quot;quoted&quot; &gt; end_suf">text</span>',
      },
      {
        template: '<img alt=<%= input.v %> src="https://example.com/p.png">',
        input: { v: 'photo "view" > 1' },
        expected: '<img alt="photo &quot;view&quot; &gt; 1" src="https://example.com/p.png">',
      },
    ];
    for (const c of cases) {
      const { files, model } = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()\ncontent\n${c.template}`)}`));
      const compiled = uiSnippetFiles(model);
      assert.equal(compiled.length, 1, c.template);
      const mod = await loadTree(files, compiled[0].path);
      const out = await invoke(mod.default as never, { ...USER, body: { input: c.input } });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const html = String(out.body.html);
      assert.equal(html, c.expected);
      assert.doesNotMatch(html, /data-style-dropped/);
    }
  } finally {
    live.restore();
  }
});

test('a for-each loop that writes stays a snippet and does not update rows', async () => {
  await assertStaysSnippet(
    `<%
for each row in Orders[Status == "open"] {
  row.Status = "pwned";
}
%>
<p>x</p>`,
    {},
  );
  await assertStaysSnippet(
    `<%
for each row in Orders[ID != 0] {
  insert into Orders [ Status : "open" ];
}
%>
<p>x</p>`,
    {},
  );
  // A request-local `input.<param>` write inside a loop is allowed like it is
  // outside one: it rewrites only this render's input map, never a row.
  {
    const { files, model } = generateUi(
      appOf(`${ORDERS}\n${pageWithSnippet(`htmlpage hp1()
content
<%
for each row in Orders[ID != 0] {
  input.hack = "y";
}
%>
<p>x</p>`)}`),
    );
    assert.deepEqual(model.todos, []);
    const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
    const live = await liveStore(SEEDED);
    try {
      const out = await invoke(mod.default as never, { ...USER, body: { input: {} } });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const rows = await live.datastore.query('Orders', 'true', 300);
      assert.deepEqual(rows.map((row) => String(row.Status)), ['open', 'open', 'closed']);
    } finally {
      live.restore();
    }
  }
});

test('an unquoted island in a URL-bearing or handler attribute stays a counted snippet', async () => {
  const cases = [
    '<a href=<%= input.v %>>x</a>',
    '<a HREF=<%= input.v %>>x</a>',
    '<img src=<%= input.v %>>',
    '<img srcset=<%= input.v %>>',
    '<img SRCSET=<%= input.v %>>',
    '<form action=<%= input.v %>><p>x</p></form>',
    '<button formaction=<%= input.v %>>x</button>',
    '<a xlink:href=<%= input.v %>>x</a>',
    '<object data=<%= input.v %>></object>',
    '<video poster=<%= input.v %>></video>',
    '<body background=<%= input.v %>><p>x</p></body>',
    '<q cite=<%= input.v %>>x</q>',
    '<img longdesc=<%= input.v %>>',
    '<a ping=<%= input.v %>>x</a>',
    '<html manifest=<%= input.v %>><p>x</p></html>',
    '<object codebase=<%= input.v %>></object>',
    '<object archive=<%= input.v %>></object>',
    '<img usemap=<%= input.v %>>',
    '<img lowsrc=<%= input.v %>>',
    '<img dynsrc=<%= input.v %>>',
    '<iframe srcdoc=<%= input.v %>></iframe>',
    '<div style=<%= input.v %>>x</div>',
    '<div onclick=<%= input.v %>>x</div>',
    '<img onerror=<%= input.v %>>',
  ];
  for (const body of cases) await assertStaysSnippet(body, { v: 'javascript:alert(1)' });
});

test('an island the attribute allowlist removes stays a counted snippet, quoted or unquoted', async () => {
  const cases = [
    '<img srcset="<%= input.v %>">',
    "<img srcset='<%= input.v %>'>",
    '<div id=<%= input.v %>>x</div>',
    '<div id="<%= input.v %>">x</div>',
    '<div class="<%= input.v %>">x</div>',
    '<div data-x=<%= input.v %>>x</div>',
    '<div width=<%= input.v %>>x</div>',
    '<iframe srcdoc="<%= input.v %>"></iframe>',
    '<a ping="<%= input.v %>" href="https://example.com/">x</a>',
    '<a rel="<%= input.v %>" href="https://example.com/">x</a>',
    '<div onclick="<%= input.v %>">x</div>',
    '<img onerror=<%= input.v %> src="https://example.com/p.png">',
    '<div title=a"b <%= input.v %>>x</div>',
    '</div data-x=<%= input.v %>>',
  ];
  for (const body of cases) await assertStaysSnippet(body, { v: 'javascript:alert(1)' });
});

test('an island inside a raw-text element stays a counted snippet', async () => {
  const cases = [
    '<textarea><a href="<%= input.v %>"></a></textarea>',
    '<textarea><%= input.v %></textarea>',
    '<title><%= input.v %></title>',
    '<title><a href="<%= input.v %>"></a></title>',
    '<script><%= input.v %></script>',
    '<script><% x = 1; %></script>',
    '<style><%= input.v %></style>',
    '<xmp><a href="<%= input.v %>"></a></xmp>',
    '<noscript><a href="<%= input.v %>"></a></noscript>',
    '<iframe><a href="<%= input.v %>"></a></iframe>',
    '<noembed><%= input.v %></noembed>',
    '<noframes><%= input.v %></noframes>',
    '<template><a href="<%= input.v %>"></a></template>',
    '<plaintext><a href="<%= input.v %>">',
  ];
  for (const body of cases) await assertStaysSnippet(body, { v: 'javascript:alert(1)' });
});

test('an island whose marker the sanitizer removes stays a counted snippet', async () => {
  const cases = [
    // Inside an element the allowlist drops entirely.
    '<svg><a href="<%= input.v %>"></a></svg>',
    '<math><a href="<%= input.v %>"></a></math>',
    // An allowlisted attribute on a tag the sanitizer unwraps. `<button>` is
    // allowlisted now that a generated ExecuteFunction call renders one, so a
    // title island on it survives — the unwrap cases use other tags.
    '<section title="<%= input.v %>">x</section>',
    '<form title="<%= input.v %>">x</form>',
    '<label title="<%= input.v %>">x</label>',
    // A refused static scheme drops the attribute and the marker with it.
    '<a href="javascript:<%= input.v %>">x</a>',
    // A '<' restarts the tag in the slot scan but the parser keeps the island
    // on the original tag's attribute, which the sanitizer then removes.
    '<div title=<a href="<%= input.v %>">x</div>',
    '<img alt=<a href="<%= input.v %>">',
    '<img alt=x <a href="<%= input.v %>">',
    '<div title="ok" <a href="<%= input.v %>">x</div>',
    '<a href="https://example.com/" <img src="<%= input.v %>">x</a>',
  ];
  for (const body of cases) await assertStaysSnippet(body, { v: 'javascript:alert(1)' });
});

test('the endpoint render audit refuses elements and attributes outside the allowlist', () => {
  const source = `${c2cUrlFunctionSource()}\n${renderAuditSource()}\nreturn c2cAuditViolation(html);`;
  const audit = new Function('html', 'renderedHtmlElements', 'renderedDocumentViolation', source) as (
    html: string,
    walk: typeof renderedHtmlElements,
    structural: typeof renderedDocumentViolation,
  ) => string;
  const refused = [
    '<p onclick="alert(1)">x</p>',
    "<a href='javascript:alert(1)'>x</a>",
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="java&#x09;script:alert(1)">x</a>',
    '<img src=x onerror=alert(1)>',
    '<iframe srcdoc="<p>x</p>"></iframe>',
    '<div id="x">x</div>',
    '<div class="x">x</div>',
    '<a ping="https://example.com/">x</a>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<svg onload="alert(1)">x</svg>',
    // Smuggled elements carry no attribute a name-only scan could refuse: a
    // parsed audit still refuses them, because the tag itself is outside the
    // allowlist.
    '<div>x</div><script>alert(1)</scr' + 'ipt>',
    '<div>x</div><style>body{display:none}</style>',
    '<svg><script>alert(1)</script></svg>',
    '<object data="https://x.test/y"></object>',
    '<embed src="https://x.test/y.png">',
    '<base href="https://x.test/">',
    '<meta http-equiv="refresh" content="0">',
    '<link rel="stylesheet" href="https://x.test/x.css">',
    '<iframe src="https://x.test/"></iframe>',
    '<form action="https://x.test/"><input></form>',
    '<template><script>alert(1)</script></template>',
    // The fragment walk drops these start tags, so only the document-level
    // check sees the attributes a document consumer would run.
    '<body onload=alert(1)><p>x</p>',
    '<html onload=alert(1)><p>x</p>',
    '<frameset onload=alert(1)>',
    '<head onload=alert(1)><p>x</p>',
  ];
  for (const html of refused) assert.notEqual(audit(html, renderedHtmlElements, renderedDocumentViolation), '', html);
  const kept = [
    '<p>plain text</p>',
    '<a href="https://example.com/" rel="noopener noreferrer">x</a>',
    '<a href="">x</a>',
    '<img src="https://example.com/p.png" alt="p" width="10" height="10">',
    '<div title="a &quot;b&quot;" style="color: red">x</div>',
    '<font color="red" face="serif" size="3">x</font>',
    '<td colspan="2" title="t">x</td>',
    'no markup at all',
    'a < b and c > d',
    '</p><p>x</p>',
    '<!-- <div onclick=x> -->',
  ];
  for (const html of kept) assert.equal(audit(html, renderedHtmlElements, renderedDocumentViolation), '', html);
});

/** A page whose render is one static, one value island, one static. */
function valuePage(): { files: { path: string; data: string | Buffer }[]; entry: string } {
  const { files, model } = generateUi(
    appOf(`${ORDERS}\n${pageWithSnippet('htmlpage hp1()\ncontent\n<p><%= input.value %></p>')}`),
  );
  assert.deepEqual(model.todos, []);
  return { files, entry: uiSnippetFiles(model)[0].path };
}

/** Replace one generated `c2c_static_N` literal with new markup. */
function withStatic(source: string, index: number, html: string): string {
  const needle = `const c2c_static_${index} = `;
  const at = source.indexOf(needle);
  assert.ok(at >= 0, `the generated endpoint has no c2c_static_${index}`);
  const end = source.indexOf(';\n', at);
  assert.ok(end > at, 'the generated static literal is unterminated');
  return `${source.slice(0, at + needle.length)}${JSON.stringify(html)}${source.slice(end)}`;
}

function withEntrySource(
  files: { path: string; data: string | Buffer }[],
  entry: string,
  mutate: (source: string) => string,
): { path: string; data: string | Buffer }[] {
  let changed = false;
  const out = files.map((file) => {
    if (file.path !== entry) return file;
    changed = true;
    return { ...file, data: mutate(String(file.data)) };
  });
  assert.ok(changed, `the generated tree has no ${entry}`);
  return out;
}

test('a compiled endpoint returns its rendered page with notes', async () => {
  const { files, entry } = valuePage();
  const mod = await loadTree(files, entry);
  const live = await liveStore({});
  try {
    const out = await invoke(mod.default as never, { ...USER, body: { input: { value: 'Ada' } } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.match(String(out.body.html), /<p>Ada<\/p>/);
    assert.ok('notes' in out.body);
  } finally {
    live.restore();
  }
});

test('a compiled endpoint refuses rendered markup its audit rejects', async () => {
  // The audit is wired into the generated handler: a violation returns the
  // refusal status instead of the page HTML.
  const { files, entry } = valuePage();
  const cases = [
    // A script element the fragment walk sees.
    `<scr${'ipt'}>alert(1)</scr${'ipt'}><p>`,
    // A body handler only the document-level check sees: the fragment walk
    // drops the tag, so this is the regression case for the structural check.
    '<body onload=alert(1)><p>',
  ];
  for (const markup of cases) {
    const mutated = withEntrySource(files, entry, (source) => withStatic(source, 0, markup));
    const mod = await loadTree(mutated, entry);
    const live = await liveStore({});
    try {
      const out = await invoke(mod.default as never, { ...USER, body: { input: { value: 'Ada' } } });
      assert.equal(out.status, 500, markup);
      assert.equal(out.body.error, 'rendered markup failed the output attribute check', markup);
      assert.equal('html' in out.body, false, markup);
    } finally {
      live.restore();
    }
  }
});

test('a compiled endpoint fails closed when the markup parser cannot load', async () => {
  // The audit helpers throw when parse5 is missing; the handler turns that
  // into the same refusal — it never returns unaudited markup.
  const { files, entry } = valuePage();
  const stubPath = 'functions/htmlpages/c2c-audit-stub.mjs';
  const stub = `export { createRuntime, jsonReplacer, principalFromRequest } from "creator-to-catalyst/shims";
export function renderedHtmlElements() { throw new Error("Cannot find package parse5"); }
export function renderedDocumentViolation() { throw new Error("Cannot find package parse5"); }
`;
  const mutated = withEntrySource(files, entry, (source) => {
    assert.ok(source.includes('"creator-to-catalyst/shims"'), 'the generated endpoint has no shims import to stub');
    return source.split('"creator-to-catalyst/shims"').join(JSON.stringify('./c2c-audit-stub.mjs'));
  });
  mutated.push({ path: stubPath, data: stub });
  const mod = await loadTree(mutated, entry);
  const live = await liveStore({});
  try {
    const out = await invoke(mod.default as never, { ...USER, body: { input: { value: 'Ada' } } });
    assert.equal(out.status, 500, JSON.stringify(out.body));
    assert.equal(out.body.error, 'rendered markup failed the output attribute check');
    assert.equal('html' in out.body, false);
  } finally {
    live.restore();
  }
});

test('a compiled endpoint fails closed when the markup parse itself throws', async () => {
  // Deeply nested markup makes the real parser throw a RangeError, which the
  // handler turns into the same refusal.
  const { files, entry } = valuePage();
  const mutated = withEntrySource(files, entry, (source) => withStatic(source, 0, `<div>${'<div>'.repeat(20000)}`));
  const mod = await loadTree(mutated, entry);
  const live = await liveStore({});
  try {
    const out = await invoke(mod.default as never, { ...USER, body: { input: { value: 'Ada' } } });
    assert.equal(out.status, 500, JSON.stringify(out.body));
    assert.equal(out.body.error, 'rendered markup failed the output attribute check');
    assert.equal('html' in out.body, false);
  } finally {
    live.restore();
  }
});

test('tag-name island refused', async () => {
  const rejected = [
    '<<%= input.a %>>x</p>',
    '<d<%= input.a %>>x</d>',
    '</<%= input.a %>>',
    '</div<%= input.a %>>',
    '<div /<%= input.a %>>',
    '<div <%= input.a %>="1">x</div>',
    '<div <%= input.a %>>x</div>',
    '<div at<%= input.a %>="1">x</div>',
    '<div attr <%= input.a %>>x</div>',
  ];
  for (const body of rejected) {
    await assertStaysSnippet(body, { a: 'test' });
  }
});

/**
 * Shape A, minimized from a gallery lead board: the template sits in a
 * `<html><body>` shell, a guarded query is bound per caller, and a `for each`
 * over that query prints record fields. The sanitizer unwraps the shell and
 * keeps its children, so the islands are text positions.
 */
const SHAPE_A = `htmlpage hp1()
content
<html><head><style>.c { color: #333; }</style></head>
<body>
<%{
if (zoho.loginuserid == "u1") {
  open = Orders[Status == "open"];
} else {
  open = Orders[Status == "archived"];
}
%><h3><%= open.count() %> open</h3><ul><%
for each row in open {
  %><li><%= row.Status %>:<%= row.Amount %></li><%
}
%></ul>
<%}%>
</body></html>`;
const SHAPE_A_GOLDEN = join(process.cwd(), 'packages/ui/test/golden/htmlpage-shape-a.mjs');

test('shape A golden: a query loop inside a <body> shell compiles to the pinned endpoint, byte-identical on regeneration', () => {
  const build = () => generateUi(appOf(`${ORDERS}\n${pageWithSnippet(SHAPE_A)}`));
  const first = build();
  const second = build();
  assert.deepEqual(first.model.todos.map((todo) => [todo.name, todo.reason]), []);
  assert.match(first.model.pages[0]?.scopedCss ?? '', /\[data-page="Home"\] \.c\{color: #333\}/);
  const entry = uiSnippetFiles(first.model)[0];
  assert.equal(entry.path, 'functions/htmlpages/home-s0.mjs');
  const source = String(first.files.find((file) => file.path === entry.path)?.data ?? '');
  assert.equal(source, String(second.files.find((file) => file.path === entry.path)?.data ?? ''));
  assert.match(source, /shim\.datastore\.rows\(ctx, open\)/);
  assert.match(source, /shim\.datastore\.query\(ctx, "Orders"/);
  assert.doesNotMatch(source, /executeZCQLQuery|datastore\.(flush|insert|update|delete)\b/);
  if (process.env.C2C_UPDATE_GOLDEN === '1') writeFileSync(SHAPE_A_GOLDEN, source);
  assert.equal(source, readFileSync(SHAPE_A_GOLDEN, 'utf8'));
});

test('shape A renders one escaped row per record for the caller\'s query, and none for another caller', async () => {
  const { files, model } = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(SHAPE_A)}`));
  const mod = await loadTree(files, uiSnippetFiles(model)[0].path);
  const live = await liveStore({ Orders: [...SEEDED.Orders, { Status: 'open', Amount: 4 }] });
  try {
    const out = await invoke(mod.default as never, { ...USER, body: { input: {} } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const html = String(out.body.html).replace(/\s+/g, '');
    assert.equal(html, '<h3>3open</h3><ul><li>open:1</li><li>open:2</li><li>open:4</li></ul>');
    assert.doesNotMatch(html, /closed|<body|<html|<style/);
    // Another caller binds the other arm's query, which matches no row.
    const other = await invoke(mod.default as never, { user: { ...USER.user, userId: 'u2' }, body: { input: {} } });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.doesNotMatch(String(other.body.html), /<li/);
    const anon = await invoke(mod.default as never, { body: { input: {} } });
    assert.equal(anon.status, 401);
  } finally {
    live.restore();
  }
});

test('shape A: a text island the sanitizer would not keep still stays the counted snippet', () => {
  const loop = (wrap: (inner: string) => string) =>
    `htmlpage hp1()\ncontent\n<%\nfor each row in Orders[ID != 0] {\n%>${wrap('<%= row.Status %>')}<%\n}\n%>`;
  for (const wrap of [
    (inner: string) => `<head><title>${inner}</title></head>`,
    (inner: string) => `<noscript><body>${inner}</body></noscript>`,
    (inner: string) => `<body><script>${inner}</script></body>`,
  ]) {
    const snippet = loop(wrap);
    const { model } = buildUi(appOf(`${ORDERS}\n${pageWithSnippet(snippet)}`));
    assert.deepEqual(model.todos.map((todo) => todo.reason), [SNIPPET_TODO], snippet);
    assert.equal(uiSnippetFiles(model).length, 0, snippet);
  }
});

test('a ZML snippet opened by a statement block and closed by a later brace island still converts its tags', async () => {
  const snippet = `<%{
rec = Orders[ID == input.id];
%>
<panel><pr><pc><text type="Text" value="<%=rec.Name%>" size="3"> </text></pc></pr></panel>
<%}%>`;
  const html = convertZmlSnippetToHtml(snippet);
  assert.match(html, /<div data-zml="panel">/);
  assert.match(html, /<div style="font-size:16px"><%=rec\.Name%><\/div>/);
  assert.doesNotMatch(html, /<text\b/);
  const { out } = await renderLiveZml(snippet, [{ Name: 'Ada', Status: 'open', Amount: 1 }], { id: FIRST_ID });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(String(out.body.html), /<div style="font-size:16px">Ada<\/div>/);
});

test('a ZML icon image in a snippet renders as a styled tile and keeps its colour island', async () => {
  const html = convertZmlSnippetToHtml(`<image color="#FFFFFF" bgColor="#00aa00" width="20px" height="20px" type="icon" value="glyph-x" cornerRadius="10px" />`);
  assert.equal(html, '<div data-zml="icon" style="width:20px;height:20px;background-color:#00aa00;color:#FFFFFF;border-radius:10px"></div>');
  // A non-icon image is not this tile.
  assert.doesNotMatch(convertZmlSnippetToHtml(`<panel><image type="url" value="x.png" /></panel>`), /data-zml="icon"/);
  const { out } = await renderLiveZml(
    `<%{
rec = Orders[ID == input.id];
tone = "#111111";
if(rec.Status == "open")
{
\ttone = "#00aa00";
}
%>
<panel><pr><pc><image bgColor="<%=tone%>" width="20px" height="20px" type="icon" value="glyph-x" /></pc></pr></panel>
<%}%>`,
    [{ Name: 'Ada', Status: 'open', Amount: 1 }],
    { id: FIRST_ID },
  );
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(String(out.body.html), /<div data-zml="icon" style="width:20px;height:20px;background-color:#00aa00"><\/div>/);
});

test('a snippet loop whose condition reads server data renders on the server; a server-side todo still stays counted', async () => {
  const snippet = `<%{
steps = {"open","closed"};
tone = "#111111";
current = Orders[ID == input.id].Status;
for each step in steps
{
\tif(step == current)
\t{
\t\ttone = "#00aa00";
\t}
}
%>
<p style="color:<%=tone%>">x</p>
<%}%>`;
  const compiled = compileHtmlpage(appOf(ORDERS), 'Home', 'zml1', `htmlpage zml1()\ncontent\n${snippet}`);
  assert.equal(compiled.ok, true, compiled.reason);
  const { out } = await renderLiveZml(snippet, [{ Name: 'Ada', Status: 'closed', Amount: 1 }], { id: FIRST_ID });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(String(out.body.html), /color:#00aa00/);
  const miss = await renderLiveZml(snippet, [{ Name: 'Ada', Status: 'held', Amount: 1 }], { id: FIRST_ID });
  assert.match(String(miss.out.body.html), /color:#111111/);

  // An unknown builtin in the same position is a server-side todo.
  const refused = compileHtmlpage(
    appOf(ORDERS),
    'Home',
    'zml1',
    `htmlpage zml1()\ncontent\n<%{\ntone = input.id.frobnicate();\n%>\n<p><%=tone%></p>\n<%}%>`,
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'island needs manual translation');
});

test('a write or external action anywhere in an island is refused as an effectful render: no endpoint, one counted TODO', () => {
  const effects: Array<{ name: string; island: string; reason: string }> = [
    { name: 'insert into', island: 'if(Orders[Status == "open"].count() == 0)\n{\n\tinsert into Orders\n\t[\n\t\tStatus="open"\n\t]\n}', reason: 'island writes are unguarded' },
    { name: 'assigned insert', island: 'row = insert into Orders [ Status : "open" ];', reason: 'island writes are unguarded' },
    { name: 'criteria field write', island: 'Orders[Status == "open"].Name = "x";', reason: 'island writes are unguarded' },
    { name: 'update', island: 'update Orders[Status == "open"] [ Status = "closed" ];', reason: 'island writes are unguarded' },
    { name: 'delete', island: 'delete from Orders[Status == "open"];', reason: 'island is not a read-only render' },
    { name: 'sendmail', island: 'sendmail\n[\n\tfrom :zoho.adminuserid\n\tto :"a@example.com"\n\tsubject :"x"\n\tmessage :"y"\n]', reason: 'island is not a read-only render' },
    { name: 'invokeUrl', island: 'r = invokeurl\n[\n\turl :"https://example.com"\n\ttype :GET\n];', reason: 'island is not a read-only render' },
  ];
  for (const e of effects) {
    const template = `htmlpage hp1()\ncontent\n<%{\n${e.island}\n%}\n<p><%= Orders[Status == "open"].count() %></p>`;
    const compiled = compileHtmlpage(appOf(ORDERS), 'Home', 'hp1', template);
    assert.equal(compiled.ok, false, e.name);
    assert.equal(compiled.file, undefined, e.name);
    assert.equal(compiled.src, undefined, e.name);
    assert.equal(compiled.reason, e.reason, e.name);
    const { model } = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(template)}`));
    assert.deepEqual(model.todos.map((todo) => todo.reason), [SNIPPET_TODO], e.name);
    assert.ok(model.todos[0]?.manualReasons?.includes('write'), e.name);
    assert.deepEqual(uiSnippetFiles(model), [], e.name);
  }
});

test('the same read-only island without the write still compiles, so the effect alone is what refuses it', () => {
  const compiled = compileHtmlpage(
    appOf(ORDERS),
    'Home',
    'hp1',
    'htmlpage hp1()\ncontent\n<%{\nif(Orders[Status == "open"].count() == 0)\n{\n\tn = 0;\n}\n%}\n<p><%= Orders[Status == "open"].count() %></p>',
  );
  assert.equal(compiled.ok, true, compiled.reason);
});

test('a text remove whose operands mix a date-to-text and a datetime-to-text stays the counted TODO', () => {
  // Creator renders both operands in the app date format, so `str.remove(dt)`
  // leaves the time. The shims render String(datetime) and date text in other
  // formats, so a translation would not match Creator: the snippet stays counted.
  const island = 'for each re in Orders[Status == "open"]\n{\n\tstr = re.Added_Time.toString();\n\tdte = re.Added_Time.toDate();\n\tdt = dte.toString();\n\ttym = str.remove(dt);\n}';
  const template = `htmlpage hp1()\ncontent\n<%{\n${island}\n%}\n<p><%= Orders[Status == "open"].count() %></p>`;
  const compiled = compileHtmlpage(appOf(ORDERS), 'Home', 'hp1', template);
  assert.equal(compiled.ok, false, 'remove over mixed date texts must not compile');
  assert.equal(compiled.file, undefined);
  const { model } = generateUi(appOf(`${ORDERS}\n${pageWithSnippet(template)}`));
  assert.deepEqual(model.todos.map((todo) => todo.reason), [SNIPPET_TODO]);
  assert.ok(model.todos[0]?.manualStep, 'the counted TODO carries a manual step');
  assert.deepEqual(uiSnippetFiles(model), []);
});


test('record-summary iframe maps only a recognized read or page parameter to the record route', () => {
  const read = `<iframe title="Employee" src='<%=zoho.appuri%>record-summary/Add_Employee/<%=Add_Employee[Official_Email == zoho.loginuserid].ID%>'></iframe>`;
  const param = `<iframe src='<%=zoho.appuri%>record-summary/Case/<%=input.caseID%>'></iframe>`;
  assert.match(rewriteRecordSummaryFrames(read), /#\/record\/Add_Employee\/<%=Add_Employee\[Official_Email == zoho\.loginuserid\]\.ID%>/);
  assert.match(rewriteRecordSummaryFrames(param), /#\/record\/Case\/<%=input\.caseID%>/);
  const untrusted = `<iframe src='<%=zoho.appuri%>record-summary/Case/<%=input.otherValue + "/admin"%>'></iframe>`;
  assert.equal(rewriteRecordSummaryFrames(untrusted), untrusted, 'arbitrary expressions remain counted');
  const wrongForm = `<iframe src='<%=zoho.appuri%>record-summary/Case/<%=Other[ID > 0].ID%>'></iframe>`;
  assert.equal(rewriteRecordSummaryFrames(wrongForm), wrongForm, 'a read of another form does not bind this route');
  const concatenated = `<iframe src='<%=zoho.appuri%>record-summary/Case/<%=Case[Status == "Open"] + input.x + Case[Status == "x"].ID%>'></iframe>`;
  assert.equal(rewriteRecordSummaryFrames(concatenated), concatenated, 'concatenated reads stay counted');
  const unknownForm = `<iframe src='<%=zoho.appuri%>record-summary/Nope/<%=input.caseID%>'></iframe>`;
  assert.equal(rewriteRecordSummaryFrames(unknownForm, appOf(ORDERS)), unknownForm, 'unknown app targets stay counted');
});

test('record-summary iframe scan reads quoted attributes, case, and closing-tag whitespace like the markup', () => {
  const param = `<iframe src='<%=zoho.appuri%>record-summary/Case/<%=input.caseID%>'></iframe>`;
  const routed = rewriteRecordSummaryFrames(param);
  assert.equal(rewriteRecordSummaryFrames(`a ${param} b ${param} c`), `a ${routed} b ${routed} c`, 'every element is rewritten, text between kept');
  assert.match(
    rewriteRecordSummaryFrames(`<IFRAME title="a>b" src='<%=zoho.appuri%>record-summary/Case/<%=input.caseID%>'>Open</IFRAME \n>`),
    /^<a title="a>b" href='#\/record\/Case\/<%=input\.caseID%>'>Open<\/a>$/,
    'a quoted > stays inside the attribute; the tag name is case-insensitive; whitespace may precede the closing >',
  );
  const unclosed = `<iframe src='<%=zoho.appuri%>record-summary/Case/<%=input.caseID%>'>`;
  assert.equal(rewriteRecordSummaryFrames(unclosed), unclosed, 'an element with no closing tag is left as written');
  const prefixed = `<iframex src='<%=zoho.appuri%>record-summary/Case/<%=input.caseID%>'></iframe>`;
  assert.equal(rewriteRecordSummaryFrames(prefixed), prefixed, 'a longer tag name is not an iframe');
  assert.equal(
    rewriteRecordSummaryFrames(`<iframe data-x=" src='<%=zoho.appuri%>record-summary/Case/<%=input.caseID%>'></iframe>`),
    `<a data-x=" href='#/record/Case/<%=input.caseID%>'>View record summary</a>`,
    'a quote with no partner is plain text',
  );
});

test('record-summary iframe scan stays linear on adversarial markup', () => {
  const inputs = [
    `<iframe${' "'.repeat(100_000)}`,
    '<iframe>'.repeat(25_000),
    `<iframe a>${'</iframe '.repeat(25_000)}`,
    "<iframe '".repeat(25_000),
    `<iframe${' x'.repeat(100_000)}`,
  ];
  for (const input of inputs) {
    const started = performance.now();
    rewriteRecordSummaryFrames(input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `${input.length} chars took ${elapsed.toFixed(1)} ms`);
  }
});

test('record-summary report link resolves to its scoped report detail route', () => {
  const app = appOf(`${ORDERS}
\tlist Employee_Profile1
\t{
\t\tshow all rows from Orders [Status == "open"]
\t\t(
\t\t\tName
\t\t)
\t}`);
  const snippet = `<iframe src='<%=zoho.appuri%>record-summary/Employee_Profile1/<%=input.recordID%>'></iframe>`;
  const rewritten = rewriteRecordSummaryFrames(snippet, app);
  assert.match(rewritten, /#\/report\/Employee_Profile1\/row\/<%=input\.recordID%>/);
  const unknown = `<iframe src='<%=zoho.appuri%>record-summary/No_Such_Report/<%=input.recordID%>'></iframe>`;
  assert.equal(rewriteRecordSummaryFrames(unknown, app), unknown, 'unknown report names remain counted');

  const record = generateUi(app).files.find((file) => file.path === 'functions/aio/orders/record.mjs')?.data;
  assert.match(String(record), /reportScopes/);
  assert.match(String(record), /REPORT/);
  assert.match(String(record), /reportScope\.profiles\.includes\(principal\.profile\)/);
  assert.match(String(record), /Status.*open/);
});


test('a record-summary frame generates a link to the authorized record route', () => {
  const snippet = `htmlpage hp1()\ncontent\n<iframe src='<%=zoho.appuri%>record-summary/Orders/<%=Orders[Status == "Open"].ID%>'></iframe>`;
  const compiled = compileHtmlpage(appOf(ORDERS), 'Home', 'hp1', snippet);
  assert.equal(compiled.ok, true, compiled.reason);
  assert.match(compiled.file?.source ?? '', /#\/record\/Orders/);
  assert.match(compiled.file?.source ?? '', /shim\.datastore\.query/);
});

test('one page with carried <style> CSS, a <script>, an ExecuteFunction button and a ZML image counts only lost constructs', () => {
  const snippet = [
    '<style>.highlight { color: red; }</style>',
    '<script>alert("hello")</script>',
    "<button text='Go' type='rounded' action='ExecuteFunction' functionName='helpers.mark' parameters='1' />",
    "<image action='Function' functionName='notify_team' elementName='Bell' src='https://example.com/bell.png'>",
  ].join('\n');
  const { model } = buildUi(appOf(`${ORDERS}\n${pageWithSnippet(snippet)}`));
  assert.equal(model.todos.length, 3);
  assert.deepEqual(
    model.todos.map((todo) => [todo.name, todo.reason]),
    [
      ['Home.image', 'ZML <image> "Bell" click action Function calling function notify_team is not generated; wire the click to the function by hand'],
      ['Home.button', 'ZML <button> "Go" click action ExecuteFunction calling function helpers.mark is not generated; wire the click to the function by hand'],
      ['Home.dsp', 'The <script> element is removed from this page snippet by the sanitizer'],
    ],
  );
});

const ACCOUNTS = `\tform Accounts
\t{
\t\tEmail
\t\t(
\t\t\ttype = text
\t\t)
\t\tRole
\t\t(
\t\t\ttype = text
\t\t)
\t}`;

test('shape C: non-administrator profile is refused before the write', async () => {
  const snippet = `htmlpage hp1()
content
<p>
<%
if (zoho.loginuserid == zoho.adminuserid) {
  if (Accounts[Email == zoho.adminuserid].count() == 0) {
    insert into Accounts [
      Email = zoho.adminuserid
      Role = "Admin"
    ];
  }
}
%>
Ready
</p>`;
  const { files, model } = generateUi(appOf(`${ACCOUNTS}\n${pageWithSnippet(snippet)}`));
  assert.deepEqual(model.todos, []);
  const entry = uiSnippetFiles(model)[0];
  const mod = await loadTree(files, entry.path);
  const live = await liveStore({});
  try {
    const out = await invoke(mod.default as never, { ...CLERK, body: { input: {} } });
    assert.equal(out.status, 403, JSON.stringify(out.body));
    const rows = live.tables.get('Accounts') ?? [];
    assert.equal(rows.length, 0);
  } finally {
    live.restore();
  }
});

test('shape C: admin render writes exactly once (idempotent when existence check is present)', async () => {
  const snippet = `htmlpage hp1()
content
<p>
<%
if (zoho.loginuserid == zoho.adminuserid) {
  rec = Accounts[Email == zoho.adminuserid];
  if (rec.count() <= 0) {
    insert into Accounts [
      Email = zoho.loginuserid
      Role = "Admin"
    ];
  }
}
%>
Ready
</p>`;
  const { files, model } = generateUi(appOf(`${ACCOUNTS}\n${pageWithSnippet(snippet)}`));
  assert.deepEqual(model.todos, []);
  const entry = uiSnippetFiles(model)[0];
  const mod = await loadTree(files, entry.path);
  const live = await liveStore({});
  try {
    const out1 = await invoke(mod.default as never, { ...USER, body: { input: {} } });
    assert.equal(out1.status, 200, JSON.stringify(out1.body));
    const rows1 = live.tables.get('Accounts') ?? [];
    assert.equal(rows1.length, 1);
    assert.equal(rows1[0].Email, 'u1');
    assert.equal(rows1[0].Role, 'Admin');

    const out2 = await invoke(mod.default as never, { ...USER, body: { input: {} } });
    assert.equal(out2.status, 200, JSON.stringify(out2.body));
    const rows2 = live.tables.get('Accounts') ?? [];
    assert.equal(rows2.length, 1);
  } finally {
    live.restore();
  }
});

test('shape C without an existence check keeps Creator every-render semantics', async () => {
  const snippet = `htmlpage hp1()
content
<p>
<%
if (zoho.loginuserid == zoho.adminuserid) {
  insert into Accounts [
    Email = zoho.adminuserid
    Role = "Admin"
  ];
}
%>
Ready
</p>`;
  const { files, model } = generateUi(appOf(`${ACCOUNTS}\n${pageWithSnippet(snippet)}`));
  assert.deepEqual(model.todos, []);
  const entry = uiSnippetFiles(model)[0];
  const mod = await loadTree(files, entry.path);
  const live = await liveStore({});
  try {
    await invoke(mod.default as never, { ...USER, body: { input: {} } });
    const rows1 = live.tables.get('Accounts') ?? [];
    assert.equal(rows1.length, 1);

    await invoke(mod.default as never, { ...USER, body: { input: {} } });
    const rows2 = live.tables.get('Accounts') ?? [];
    assert.equal(rows2.length, 2);
  } finally {
    live.restore();
  }
});

test('shape C: write failure renders the Creator error path (HTTP 500 without HTML)', async () => {
  const snippet = `htmlpage hp1()
content
<p>
<%
if (zoho.loginuserid == zoho.adminuserid) {
  insert into Accounts [
    Email = zoho.adminuserid
    Role = "Admin"
  ];
}
%>
Ready
</p>`;
  const { files, model } = generateUi(appOf(`${ACCOUNTS}\n${pageWithSnippet(snippet)}`));
  assert.deepEqual(model.todos, []);
  const entry = uiSnippetFiles(model)[0];
  const mod = await loadTree(files, entry.path);
  const live = await liveStore({});
  try {
    live.datastore.insert = async () => {
      throw new Error('database connection lost');
    };
    const out = await invoke(mod.default as never, { ...USER, body: { input: {} } });
    assert.equal(out.status, 500, JSON.stringify(out.body));
    assert.equal(out.body.error, 'render failed');
    assert.equal('html' in out.body, false);
  } finally {
    live.restore();
  }
});

test('shape C negative: unconditional write refused', () => {
  const snippet = `htmlpage hp1()
content
<p>
<%
insert into Accounts [
  Email = "x@example.com"
  Role = "Admin"
];
%>
Done
</p>`;
  const { model } = buildUi(appOf(`${ACCOUNTS}\n${pageWithSnippet(snippet)}`));
  assert.deepEqual(model.todos.map((todo) => todo.reason), [SNIPPET_TODO]);
  assert.equal(uiSnippetFiles(model).length, 0);
});

test('shape C negative: write in for each loop refused', () => {
  const snippet = `htmlpage hp1()
content
<p>
<%
for each row in Accounts[ID != 0] {
  if (zoho.loginuserid == zoho.adminuserid) {
    insert into Accounts [
      Email = zoho.adminuserid
      Role = "Admin"
    ];
  }
}
%>
Done
</p>`;
  const { model } = buildUi(appOf(`${ACCOUNTS}\n${pageWithSnippet(snippet)}`));
  assert.deepEqual(model.todos.map((todo) => todo.reason), [SNIPPET_TODO]);
  assert.equal(uiSnippetFiles(model).length, 0);
});

test('shape C negative: write guarded by non-user condition refused', () => {
  const snippet = `htmlpage hp1()
content
<p>
<%
if (input.setup == "yes") {
  insert into Accounts [
    Email = "x@example.com"
    Role = "Admin"
  ];
}
%>
Done
</p>`;
  const { model } = buildUi(appOf(`${ACCOUNTS}\n${pageWithSnippet(snippet)}`));
  assert.deepEqual(model.todos.map((todo) => todo.reason), [SNIPPET_TODO]);
  assert.equal(uiSnippetFiles(model).length, 0);
});

test('shape C negative: guards that merely mention a user identity are refused', () => {
  const guards = [
    'zoho.loginuserid != "never"',
    'zoho.loginuserid == zoho.adminuserid || input.force == true',
    'input.user == zoho.adminuserid',
    'zoho.loginuserid == input.admin',
    'zoho.loginuserid == "admin@example.com"',
  ];
  for (const guard of guards) {
    const snippet = `htmlpage hp1()\ncontent\n<p><%\nif (${guard}) {\n  insert into Accounts [ Email = zoho.loginuserid Role = "Admin" ];\n}\n%>Done</p>`;
    const { model } = buildUi(appOf(`${ACCOUNTS}\n${pageWithSnippet(snippet)}`));
    assert.deepEqual(model.todos.map((todo) => todo.reason), [SNIPPET_TODO], guard);
    assert.equal(uiSnippetFiles(model).length, 0, guard);
  }
});

test('shape C endpoint accepts only this app\'s configured page origins, before writes', async () => {
  const snippet = `htmlpage hp1()\ncontent\n<p><%\nif (zoho.loginuserid == zoho.adminuserid) {\n  insert into Accounts [ Email = zoho.loginuserid Role = "Admin" ];\n}\n%>Done</p>`;
  const { files, model } = generateUi(appOf(`${ACCOUNTS}\n${pageWithSnippet(snippet)}`));
  const mod = await loadTree(files, uiSnippetFiles(model)[0]!.path);
  const live = await liveStore({});
  try {
    const get = await invoke(mod.default as never, { ...USER, method: 'GET' });
    assert.equal(get.status, 405);
    // The app's own Slate page — Origin is the Slate host, Host the function's.
    const own = await invoke(mod.default as never, { ...USER });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    // Same-origin calls from the function's own domain also run.
    const ownFunction = await invoke(mod.default as never, { ...USER, headers: { host: FUNCTION_HOST, origin: FUNCTION_ORIGIN } });
    assert.equal(ownFunction.status, 200);
    assert.equal((live.tables.get('Accounts') ?? []).length, 2);
    // Another app on the same Slate platform is not this app.
    const otherSlate = await invoke(mod.default as never, { ...USER, headers: { host: FUNCTION_HOST, origin: 'https://other-app-9z9q.onslate.in' } });
    assert.equal(otherSlate.status, 403);
    const foreign = await invoke(mod.default as never, { ...USER, headers: { host: FUNCTION_HOST, origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    // Exact match: scheme, port and host-suffix variants of a listed origin all refuse.
    for (const origin of ['http://c2c-app-4f3a.onslate.in', 'https://c2c-app-4f3a.onslate.in:8443', 'https://c2c-app-4f3a.onslate.in.evil.test', 'https://onslate.in']) {
      const res = await invoke(mod.default as never, { ...USER, headers: { host: FUNCTION_HOST, origin } });
      assert.equal(res.status, 403, origin);
    }
    const missing = await invoke(mod.default as never, { ...USER, headers: { host: FUNCTION_HOST } });
    assert.equal(missing.status, 403);
    const malformed = await invoke(mod.default as never, { ...USER, headers: { host: FUNCTION_HOST, origin: 'not-a-url' } });
    assert.equal(malformed.status, 403);
    const clerk = await invoke(mod.default as never, { ...CLERK });
    assert.equal(clerk.status, 403);
    assert.equal((live.tables.get('Accounts') ?? []).length, 2);
  } finally {
    live.restore();
  }
});

test('shape C endpoint refuses every origin when the deploy config lists none', async () => {
  const snippet = `htmlpage hp1()\ncontent\n<p><%\nif (zoho.loginuserid == zoho.adminuserid) {\n  insert into Accounts [ Email = zoho.loginuserid Role = "Admin" ];\n}\n%>Done</p>`;
  const { files, model } = generateUi(appOf(`${ACCOUNTS}\n${pageWithSnippet(snippet)}`));
  const mod = await loadTree(files, uiSnippetFiles(model)[0]!.path, []);
  const live = await liveStore({});
  try {
    const own = await invoke(mod.default as never, { ...USER });
    assert.equal(own.status, 403);
    assert.equal((live.tables.get('Accounts') ?? []).length, 0);
  } finally {
    live.restore();
  }
});
