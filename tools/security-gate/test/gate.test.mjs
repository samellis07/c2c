/**
 * The security gate catches what it is for: a route that answers without a
 * principal, a route that ignores the profile grant, and a read/edit/delete
 * that ignores the record owner. Each case plants the defect in a freshly
 * generated tree and checks the gate reports FAIL on that route and check,
 * and that the clean tree passes the same checks.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { EXPECTED_FAIL, REPO_ROOT, applyExpected, buildTreeFromApp, groupFailures, runGate, serverGate, summarize, toMarkdown, wrapperChecks } from '../gate.mjs';
import { listApps, listSkipped } from '../run-all.mjs';
import { GATE_DS } from './fixture-app.mjs';

const dirs = [];
let app;

before(async () => {
  const core = await import(pathToFileURL(join(REPO_ROOT, 'dist/core/src/index.js')).href);
  app = core.deriveIr(core.parse(GATE_DS));
});

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function freshTree() {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-security-gate-test-'));
  dirs.push(dir);
  await buildTreeFromApp(app, dir);
  return dir;
}

function row(report, route) {
  const found = report.server.routes.find((item) => item.route === route);
  assert.ok(found, `${route} is in the report`);
  return found;
}

test('every route in the generated routes.json is checked, and the clean tree passes a, b and c', async () => {
  const dir = await freshTree();
  const routes = Object.keys(JSON.parse(readFileSync(join(dir, 'functions/c2c_api/routes.json'), 'utf8')));
  const report = await runGate(dir, 'gate-check', { client: false });
  assert.deepEqual(
    report.server.routes.map((item) => item.route),
    routes,
  );
  for (const item of report.server.routes) {
    assert.equal(item.checks.a.status, 'pass', `${item.route} a: ${item.checks.a.detail}`);
    // a2 is a known issue: an expected failure, never a plain one.
    assert.ok(['pass', 'xfail'].includes(item.checks.a2.status), `${item.route} a2: ${item.checks.a2.detail}`);
    if (item.checks.a2.status === 'xfail') assert.equal(item.checks.a2.issue, 'known-401-unmapped-role');
  }
  for (const route of ['POST /forms/Ticket/record', 'POST /forms/Ticket/delete', 'POST /forms/Ticket/submit', 'POST /reports/All_Tickets']) {
    assert.equal(row(report, route).checks.b.status, 'pass', route);
    assert.equal(row(report, route).checks.c.status, 'pass', `${route} c: ${row(report, route).checks.c.detail}`);
  }
  assert.equal(row(report, 'POST /admin/smoke').checks.b.status, 'pass');
});

test('a planted route that answers without a principal fails a, a2 and b', async () => {
  const dir = await freshTree();
  const fn = join(dir, 'functions/c2c_api');
  writeFileSync(
    join(fn, 'aio/ticket/leak.mjs'),
    [
      'export const endpoint = { type: "advancedio", method: "POST", path: "/forms/Ticket/leak" };',
      'export const formName = "Ticket";',
      'export default async function handler(req, res) {',
      '  res.writeHead(200, { "Content-Type": "application/json" });',
      '  res.end(JSON.stringify({ rows: [{ Title: "secret" }] }));',
      '}',
      '',
    ].join('\n'),
  );
  const routesFile = join(fn, 'routes.json');
  const routes = JSON.parse(readFileSync(routesFile, 'utf8'));
  routes['POST /forms/Ticket/leak'] = './aio/ticket/leak.mjs';
  writeFileSync(routesFile, `${JSON.stringify(routes, null, 2)}\n`);
  // The regression being guarded: an entry that lets one path through unsigned.
  const entryFile = join(fn, 'index.js');
  const entry = readFileSync(entryFile, 'utf8');
  assert.ok(entry.includes('if (!principal) {'));
  writeFileSync(entryFile, entry.replace('if (!principal) {', "if (!principal && path !== '/forms/Ticket/leak') {"));

  const report = await runGate(dir, 'planted', { client: false, expected: false });
  const leak = row(report, 'POST /forms/Ticket/leak');
  assert.equal(leak.checks.a.status, 'fail');
  assert.match(leak.checks.a.detail, /^200 /);
  assert.match(leak.checks.a2.detail, /^200 for /);
  assert.equal(leak.checks.b.status, 'fail');
  assert.ok(report.summary.failures.some((f) => f.route === 'POST /forms/Ticket/leak' && f.check === 'a'));
  // Every other route still passes a.
  for (const item of report.server.routes) if (item.route !== 'POST /forms/Ticket/leak') assert.equal(item.checks.a.status, 'pass', item.route);
  assert.match(toMarkdown(report), /FAIL 200 /);
});

test('a declared-public route is listed with its reason, not failed', async () => {
  const dir = await freshTree();
  const report = await runGate(dir, 'public', { client: false, publicRoutes: { 'POST /admin/smoke': 'fixture: declared public for the test' } });
  const smoke = row(report, 'POST /admin/smoke');
  for (const id of ['a', 'a2', 'a3']) {
    assert.equal(smoke.checks[id].status, 'public');
    assert.equal(smoke.checks[id].detail, 'fixture: declared public for the test');
  }
});

test('an owner-scoped grant that is not enforced fails c on read, edit, delete and the report', async () => {
  const dir = await freshTree();
  const file = join(dir, 'functions/c2c_api/access-policy.json');
  const policy = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(policy.profiles['Portal Customer'].Ticket.ownerScope, 'view');
  // Planting: the copy the handlers enforce loses the owner scope, while the
  // gate still holds them to the declared policy.
  const stripped = JSON.parse(JSON.stringify(policy));
  delete stripped.profiles['Portal Customer'].Ticket.ownerScope;
  writeFileSync(file, `${JSON.stringify(stripped, null, 2)}\n`);
  const report = { server: await serverGate(dir, { declaredPolicy: policy }) };
  for (const route of ['POST /forms/Ticket/record', 'POST /forms/Ticket/delete', 'POST /forms/Ticket/submit', 'POST /reports/All_Tickets']) {
    assert.equal(row(report, route).checks.c.status, 'fail', `${route} c: ${row(report, route).checks.c.detail}`);
  }
});

test('the client checks pass a wrapper that redirects on 401 and renders denied on 403, and fail one that does neither', async () => {
  const good = async (view) => {
    const res = await view.fetch('/x');
    if (res.status === 401) view.location.assign(`/__catalyst/auth/login?service_url=${encodeURIComponent(view.location.href)}`);
    if (res.status === 403) view.document.getElementById('main').setAttribute('data-access-status', '403');
    return res;
  };
  const results = await wrapperChecks('fixture good', good, 'fixture');
  assert.deepEqual(
    results.map((item) => item.status),
    ['pass', 'pass'],
  );
  const silent = await wrapperChecks('fixture silent', (view) => view.fetch('/x'), 'fixture:1');
  assert.deepEqual(
    silent.map((item) => [item.status, item.ref]),
    [
      ['fail', 'fixture:1'],
      ['fail', 'fixture:1'],
    ],
  );
  const wrongTarget = await wrapperChecks('fixture wrong target', async (view) => {
    await view.fetch('/x');
    view.location.href = '/__catalyst/auth/login?service_url=%2F';
  }, 'fixture:2');
  assert.equal(wrongTarget[0].status, 'fail', 'service_url must be the current page');
});

test('failures group by check, result and fix site', () => {
  const groups = groupFailures([
    { route: 'POST /a', check: 'a3', detail: '400 before auth', ref: 'x:1' },
    { route: 'POST /b', check: 'a3', detail: '400 before auth', ref: 'x:1' },
    { route: 'POST /c', check: 'b', detail: '200 for P', ref: 'y:2' },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.check, g.routes.length]),
    [
      ['a3', 2],
      ['b', 1],
    ],
  );
});

test('an unauthenticated call that reaches the Data Store fails a even when it answers 401', async () => {
  const dir = await freshTree();
  const file = join(dir, 'functions/c2c_api/index.js');
  const entry = readFileSync(file, 'utf8');
  // Planted: the entry reads the table before it refuses the caller.
  const planted = entry.replace(
    'if (!principal) {',
    "if (!principal) {\n      await sdk.initialize(req, { scope: 'admin' }).zcql().executeZCQLQuery('SELECT * FROM Ticket LIMIT 1');",
  );
  assert.notEqual(planted, entry);
  writeFileSync(file, planted);
  const report = await runGate(dir, 'touch', { client: false, expected: false });
  const record = row(report, 'POST /forms/Ticket/record');
  assert.equal(record.checks.a.status, 'fail');
  assert.match(record.checks.a.detail, /^401 after \d+ Data Store call/);
});

function markedReport({ a2, a3, entry404, entry405, client401, client403 }) {
  return {
    server: {
      routes: [{ route: 'POST /x', checks: { a: { status: 'pass', detail: '401' }, a2, a3 } }],
      entry: [
        { id: 'unknown-route', ...entry404 },
        { id: 'wrong-method', ...entry405 },
      ],
    },
    client: [
      { wrapper: 'w', check: '401 -> sign-in redirect', ...client401 },
      { wrapper: 'w', check: '403 -> access denied shown', ...client403 },
    ],
  };
}

test('an expected failure with its known outcome is XFAIL with the issue id and does not fail the run', () => {
  const report = markedReport({
    a2: { status: 'fail', detail: '401 for App User, 401 for C2C Gate Undeclared Role' },
    a3: { status: 'fail', detail: '400 before auth' },
    entry404: { status: 'fail', detail: '404 before auth' },
    entry405: { status: 'fail', detail: '405 before auth' },
    client401: { status: 'fail', detail: 'no navigation' },
    client403: { status: 'fail', detail: 'nothing rendered' },
  });
  applyExpected(report);
  const summary = summarize(report);
  assert.equal(summary.counts.fail, 0);
  assert.equal(summary.counts.xfail, 6);
  assert.equal(report.server.routes[0].checks.a2.issue, EXPECTED_FAIL.a2.issue);
  assert.deepEqual(
    summary.failures.map((f) => f.issue),
    [EXPECTED_FAIL.a2.issue, EXPECTED_FAIL.a3.issue, EXPECTED_FAIL['unknown-route'].issue, EXPECTED_FAIL['wrong-method'].issue, EXPECTED_FAIL.client.issue, EXPECTED_FAIL.client.issue],
  );
});

test('a bypass under an expected-fail marker is a plain FAIL, not XFAIL', () => {
  // Bypass cases: an unmapped role that gets data, and a 200 before auth.
  const report = markedReport({
    a2: { status: 'fail', detail: '200 for App User' },
    a3: { status: 'fail', detail: '200 before auth' },
    entry404: { status: 'fail', detail: '200 before auth' },
    entry405: { status: 'fail', detail: '204 before auth' },
    client401: { status: 'fail', detail: 'navigated to https://evil.example.test/' },
    client403: { status: 'fail', detail: 'nothing rendered (threw: boom)' },
  });
  applyExpected(report);
  const summary = summarize(report);
  assert.equal(summary.counts.xfail, 0);
  assert.equal(summary.counts.fail, 6);
  assert.equal(report.server.routes[0].checks.a2.status, 'fail');
  assert.equal(report.server.routes[0].checks.a3.status, 'fail');
  assert.match(report.server.routes[0].checks.a2.detail, /^200 for App User \(not the known outcome of expected-fail known-401-unmapped-role/);
  assert.ok(summary.failures.every((f) => !f.issue));
  // A partial bypass: one unmapped role still gets 401, the other gets data.
  const partial = markedReport({ a2: { status: 'fail', detail: '401 for App User, 200 for C2C Gate Undeclared Role' } , a3: { status: 'n/a', detail: 'GET has no body' }, entry404: {}, entry405: {}, client401: {}, client403: {} });
  applyExpected(partial);
  assert.equal(partial.server.routes[0].checks.a2.status, 'fail');
});

test('a check that passes under an expected-fail marker FAILS until the marker is removed', () => {
  const report = markedReport({
    a2: { status: 'pass', detail: '403 ROLE_UNMAPPED' },
    a3: { status: 'pass', detail: '401' },
    entry404: { status: 'pass', detail: '401' },
    entry405: { status: 'pass', detail: '401' },
    client401: { status: 'pass', detail: 'redirected' },
    client403: { status: 'pass', detail: 'access-denied state rendered' },
  });
  applyExpected(report);
  const summary = summarize(report);
  assert.equal(summary.counts.fail, 6);
  assert.equal(summary.counts.pass, 1, 'only the unmarked check a still passes');
  assert.match(report.server.routes[0].checks.a2.detail, /passes under expected-fail known-401-unmapped-role, remove the marker/);
  assert.match(report.server.routes[0].checks.a2.ref, /^tools\/security-gate\/gate\.mjs:\d+$/);
  // Without the marker the same report is clean.
  const cleared = markedReport({
    a2: { status: 'pass', detail: '403 ROLE_UNMAPPED' },
    a3: { status: 'pass', detail: '401' },
    entry404: { status: 'pass', detail: '401' },
    entry405: { status: 'pass', detail: '401' },
    client401: { status: 'pass', detail: 'redirected' },
    client403: { status: 'pass', detail: 'access-denied state rendered' },
  });
  applyExpected(cleared, {});
  assert.equal(summarize(cleared).counts.fail, 0);
});

test('a marker without a known outcome is refused', () => {
  const report = markedReport({ a2: { status: 'fail', detail: '200 for App User' }, a3: {}, entry404: {}, entry405: {}, client401: {}, client403: {} });
  assert.throws(() => applyExpected(report, { a2: 'issue-a2' }), /scoped to its known outcome/);
});

test('the default markers keep a real bypass red end to end', async () => {
  const dir = await freshTree();
  const file = join(dir, 'functions/c2c_api/index.js');
  const entry = readFileSync(file, 'utf8');
  // Planted: an unmapped role is let through as if it were mapped (a2 -> 200).
  const planted = entry.replace("errorReply(res, 401, 'Sign in required')", "send(res, 200, { rows: [{ Title: 'secret' }] })");
  assert.notEqual(planted, entry);
  writeFileSync(file, planted);
  const report = await runGate(dir, 'bypass', { client: false });
  const record = row(report, 'POST /forms/Ticket/record');
  assert.equal(record.checks.a.status, 'fail');
  assert.equal(record.checks.a2.status, 'fail', record.checks.a2.detail);
  assert.match(record.checks.a2.detail, /^200 for /);
  assert.ok(report.summary.counts.fail > 0);
});

test('a handler module that does not import is an entry failure, not a silent n/a', async () => {
  const dir = await freshTree();
  const fn = join(dir, 'functions/c2c_api');
  const routes = JSON.parse(readFileSync(join(fn, 'routes.json'), 'utf8'));
  const spec = routes['POST /forms/Ticket/record'];
  writeFileSync(join(fn, spec), 'export const formName = "Ticket";\nthis is not javascript;\n');
  const report = await runGate(dir, 'import', { client: false });
  const broken = report.server.entry.find((item) => item.id === 'handler-import');
  assert.ok(broken, 'handler-import entry check');
  assert.equal(broken.status, 'fail');
  assert.match(broken.detail, /^import failed: /);
  assert.ok(report.summary.counts.fail > 0);
});

test('a sweep lists directories without a .ds as skipped, not silently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-security-gate-list-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'flat'));
  writeFileSync(join(dir, 'flat/app.ds'), '');
  mkdirSync(join(dir, 'nested/scenario-1'), { recursive: true });
  writeFileSync(join(dir, 'nested/scenario-1/app.ds'), '');
  writeFileSync(join(dir, 'single.ds'), '');
  assert.deepEqual(
    listApps(dir).map((a) => a.name),
    ['flat', 'single'],
  );
  assert.deepEqual(
    listSkipped(dir).map((a) => a.name),
    ['nested'],
  );
});
