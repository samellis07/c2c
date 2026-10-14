/**
 * The ui-snapshot tool's own tests. Unit level: the normaliser strips
 * volatile attributes and the comparator reports readable diffs. Gate level:
 * the same snapshot rendered twice is byte-identical, a planted content
 * change is detected, and the CLI check passes against the committed
 * baselines — including under a far-away TZ, which proves the snapshots do
 * not depend on the machine timezone.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const root = resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');
const tool = join(root, 'tools', 'ui-snapshot');
const cli = join(tool, 'snapshot.mjs');

const { serialise, diffSnapshots } = await import(pathToFileURL(join(tool, 'normalize.mjs')).href);
const { planFor } = await import(pathToFileURL(join(tool, 'snapshot.mjs')).href);

function docOf(html) {
  return new JSDOM(`<!doctype html><body><div id="root">${html}</div></body></html>`).window.document.getElementById('root');
}

test('the normaliser strips ids, styles and svg geometry but keeps structure', () => {
  const rootEl = docOf(
    '<section class="c2c-card" id="r1"><h1 class="t" style="color:red">Hi</h1>' +
      '<svg viewBox="0 0 24 24" width="18"><path d="M1 2L3 4"/></svg>' +
      '<label for="r1">Name</label><input id="r1" value="Ada"/></section>',
  );
  const text = serialise(rootEl, { app: 'a', route: '#/x', state: 's', viewport: 'desktop', width: 1280 });
  assert.match(text, /^app: a\nroute: #\/x\nstate: s\nviewport: desktop 1280\n---\n/);
  assert.doesNotMatch(text, /id=|style=|viewBox|d="M1/);
  assert.match(text, /section class="c2c-card"/);
  assert.match(text, /for="#ref"/);
  assert.match(text, /input value="Ada"/);
  assert.match(text, /svg/);
});

test('the comparator is silent on identical snapshots and readable on change', () => {
  const want = 'app: a\n---\ndiv\n  "hello"\n';
  assert.equal(diffSnapshots('x', want, want), null);
  const report = diffSnapshots('x', want, want.replace('hello', 'goodbye'));
  assert.ok(report?.includes('--- x: differs'));
  assert.ok(report?.includes('hello'));
  assert.ok(report?.includes('goodbye'));
});

test('the plan covers every route and every forcible state at both widths', async () => {
  const { APPS } = await import(pathToFileURL(join(tool, 'apps.mjs')).href);
  const { deriveIr, parse } = await import(pathToFileURL(join(root, 'dist', 'core', 'src', 'index.js')).href);
  const { reactAppSpec } = await import(pathToFileURL(join(root, 'dist', 'ui-react', 'src', 'index.js')).href);
  const states = new Set(['list', 'empty', 'loading', 'denied', 'detail', 'form', 'invalid', 'page']);
  for (const app of APPS) {
    const spec = reactAppSpec(deriveIr(parse(app.ds)));
    const plan = planFor(spec, [{ ROWID: '1' }]);
    const modes = new Set(plan.map((p) => p.mode));
    for (const mode of ['list', 'empty', 'loading', 'denied', 'detail', 'form', 'invalid']) {
      assert.ok(modes.has(mode), `${app.name} plans a ${mode} snapshot`);
    }
    assert.ok(plan.every((p) => states.has(p.mode)), `${app.name} uses only known states`);
    assert.ok(plan.some((p) => p.hash.startsWith('#/form/')), `${app.name} covers a form route`);
    assert.ok(plan.some((p) => p.hash.startsWith('#/report/')), `${app.name} covers a report route`);
  }
  const pageApps = APPS.filter((app) => {
    const spec = reactAppSpec(deriveIr(parse(app.ds)));
    return planFor(spec, []).some((p) => p.mode === 'page');
  });
  assert.ok(pageApps.length >= 1, 'at least one app covers a page route');
});

const contactsOnly = process.env.C2C_UI_SNAPSHOT_FAST === '1' ? test.skip : test;

/** Compile the contacts app once; render the list snapshot through the real boot. */
async function renderList(rows) {
  const { compileApp } = await import(pathToFileURL(join(tool, 'compile.mjs')).href);
  const { renderSnapshot, VIEWPORTS } = await import(pathToFileURL(join(tool, 'render.mjs')).href);
  const { APPS, ROWS } = await import(pathToFileURL(join(tool, 'apps.mjs')).href);
  const { deriveIr, parse } = await import(pathToFileURL(join(root, 'dist', 'core', 'src', 'index.js')).href);
  const { generateReactApp, reactAppSpec } = await import(pathToFileURL(join(root, 'dist', 'ui-react', 'src', 'index.js')).href);
  const app = APPS.find((a) => a.name === 'contacts');
  const ir = deriveIr(parse(app.ds));
  const spec = reactAppSpec(ir);
  const out = mkdtempSync(join(tmpdir(), 'c2c-ui-snapshot-test-'));
  try {
    const compiled = compileApp(out, generateReactApp(ir));
    const bootMod = await import(pathToFileURL(compiled.bootUrl).href);
    const routesMod = await import(pathToFileURL(compiled.routesUrl).href);
    const report = spec.reports.All_Contacts;
    const { text } = await renderSnapshot({
      boot: bootMod.bootApp,
      routes: routesMod.routes,
      spec,
      app: 'contacts',
      viewport: VIEWPORTS[0],
      hash: '#/report/All_Contacts',
      id: 'test',
      apiRoutes: [[report.queryEndpoint, { ok: true, status: 200, body: { rows } }]],
      mode: 'list',
    });
    return text;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

contactsOnly('a no-op render is byte-identical and a planted change is detected', async () => {
  const { ROWS } = await import(pathToFileURL(join(tool, 'apps.mjs')).href);
  const first = await renderList(ROWS.contacts);
  const second = await renderList(ROWS.contacts);
  assert.equal(second, first, 'two renders of the same snapshot are identical');
  const planted = ROWS.contacts.map((row, i) => (i === 0 ? { ...row, Full_Name: 'Planted Change' } : row));
  const third = await renderList(planted);
  assert.notEqual(third, first, 'a planted content change alters the snapshot');
  const report = diffSnapshots('planted', first, third);
  assert.ok(report?.includes('Planted Change'), 'the diff report names the planted change');
});

function runCli(app, env = {}) {
  return spawnSync(process.execPath, [cli, '--app', app], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

contactsOnly('the CLI check passes against the committed baselines, in any timezone', () => {
  const here = runCli('contacts');
  assert.equal(here.status, 0, `check passes locally: ${here.stdout}${here.stderr}`);
  assert.match(here.stdout, /mismatches=0/);
  for (const tz of ['Pacific/Auckland', 'America/New_York']) {
    const far = runCli('contacts', { TZ: tz });
    assert.equal(far.status, 0, `check passes under TZ=${tz}: ${far.stdout}${far.stderr}`);
  }
});
