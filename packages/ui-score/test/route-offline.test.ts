/**
 * D13 clients: a route change moves focus to the new route's heading (never on
 * first load) and announces the title, and the offline banner is a status
 * region that clears on reconnect and refetches the open report once. The
 * states gate measures both on the vanilla and the React bundle.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { TEMPLATE_DIR, generateReactApp, writeReactApp } from '../../ui-react/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import { bundleFromDir, bundleFromFiles, createFakeApi, loadRuntime, openSession } from '../src/score.js';
import { checkUiStates } from '../src/states.js';

const SOURCE = `application "Order Desk"
{
\tsection Sales
\t{
\t\tform Order
\t\t{
\t\t\tdisplayname = "New Order"
\t\t\tTitle
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Title"
\t\t\t)
\t\t}
\t\tlist All_Orders
\t\t{
\t\t\tdisplayname = "All Orders"
\t\t\tshow all rows from Order
\t\t\t(
\t\t\t\tTitle
\t\t\t)
\t\t}
\t}
}
`;

const app = (): App => deriveIr(parse(SOURCE));
const only = new Set(['offline', 'route-focus']);

test('vanilla: route-focus and offline pass', async () => {
  const bundle = bundleFromFiles(buildUi(app()).files);
  const verdicts = await checkUiStates(app(), bundle, { ui: 'vanilla', only });
  for (const state of only) {
    const v = verdicts.find((row) => row.state === state);
    assert.ok(v, `no verdict for ${state}`);
    assert.equal(v.status, 'pass', `${state}: ${v.evidence}`);
  }
});

test('vanilla: the banner sits in a status region, first load keeps focus, back and forward refocus', async () => {
  const bundle = bundleFromFiles(buildUi(app()).files);
  assert.match(bundle.html, /role="status"[^>]*>\s*<p id="offline" hidden>/);
  const api = createFakeApi(new Map(), []);
  const s = await openSession(bundle, loadRuntime(bundle), api.fetch, new Map(), { desktop: '', phone: '' });
  try {
    await s.go('#/');
    assert.notEqual(s.doc.activeElement?.tagName, 'H1', 'focus must not be taken on first load');
    await s.go('#/report/All_Orders');
    assert.equal(s.doc.activeElement, s.doc.querySelector('#main h1, #main h2'));
    assert.equal(s.doc.activeElement?.getAttribute('tabindex'), '-1');
    assert.match(s.doc.querySelector('[data-route-announcer]')?.textContent ?? '', /All Orders/);
    await s.go('#/form/Order');
    assert.equal(s.doc.activeElement, s.doc.querySelector('#main h1, #main h2'));
    (s.win as unknown as { history: { back(): void } }).history.back();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.win.location.hash, '#/report/All_Orders');
    assert.equal(s.doc.activeElement, s.doc.querySelector('#main h1, #main h2'));
    assert.match(s.doc.title, /All Orders/);
  } finally {
    s.close();
  }
});

test('react: route-focus and offline pass', { timeout: 300_000 }, async () => {
  const templateModules = join(TEMPLATE_DIR, 'node_modules');
  const vite = join(templateModules, '.bin', 'vite');
  assert.ok(existsSync(vite), 'React template dependencies are not installed');
  const outDir = mkdtempSync(join(tmpdir(), 'c2c-route-offline-'));
  try {
    writeReactApp(outDir, generateReactApp(app()));
    symlinkSync(templateModules, join(outDir, 'node_modules'), 'dir');
    const res = spawnSync(vite, ['build', '--logLevel', 'warn'], { cwd: outDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const verdicts = await checkUiStates(app(), bundleFromDir(join(outDir, 'dist')), { ui: 'react', only });
    for (const state of only) {
      const v = verdicts.find((row) => row.state === state);
      assert.ok(v, `no verdict for ${state}`);
      assert.equal(v.status, 'pass', `${state}: ${v.evidence}`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
