#!/usr/bin/env node
/**
 * Visual-regression baseline for the React target (test-only, jsdom).
 *
 * Renders each route of a demo app at desktop + phone widths in every state
 * the harness can force — list, empty list, form, form validation error,
 * detail, access denied, loading — serialises the normalised DOM (see
 * normalize.mjs) and compares it with the committed baselines under
 * tests/ui-snapshots/<app>/. No browser, no CDP, no pixels: the snapshot is
 * DOM structure plus the final class attributes, so it runs in CI with the
 * repo's own toolchain.
 *
 *   npm run build && node tools/ui-snapshot/snapshot.mjs [--app <name>] [--update]
 *
 * --update regenerates the baselines instead of comparing. With no --app,
 * every app in apps.mjs renders in its own process (one compile per app).
 * Exit 0 when every snapshot matches, 1 on mismatch, 2 on harness error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(new URL('.', import.meta.url).pathname, '..', '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const update = args.includes('--update');
const onlyApp = flag('--app');
const baselineDir = flag('--dir') ?? join(root, 'tests', 'ui-snapshots');

const { APPS, ROWS } = await import('./apps.mjs');
const { compileApp, templateReady, MISSING_DEPS } = await import('./compile.mjs');
const { renderSnapshot, VIEWPORTS } = await import('./render.mjs');
const { diffSnapshots } = await import('./normalize.mjs');
const { deriveIr, parse } = await import(pathToFileURL(join(root, 'dist', 'core', 'src', 'index.js')).href);
const { generateReactApp, reactAppSpec } = await import(pathToFileURL(join(root, 'dist', 'ui-react', 'src', 'index.js')).href);

const EMPTY_LOOKUP_PAGE = { ok: true, status: 200, body: { rows: [], field: '', page: 0, pageSize: 300 } };
const DENIED = { ok: false, status: 403, body: { error: 'Forbidden' } };

function fileId(hash, mode) {
  return `${hash.replace(/^#\//, '').replace(/\//g, '-')}-${mode}`;
}

/** Every (route, state) the harness forces for one app spec. */
export function planFor(spec, rows) {
  const plan = [];
  const reports = Object.values(spec.reports);
  const forms = Object.values(spec.forms);
  const pages = spec.nav.flatMap((s) => s.items).filter((i) => i.kind === 'page');
  const firstReport = reports[0];
  if (firstReport) {
    const hash = `#/report/${firstReport.name}`;
    const query = [[firstReport.queryEndpoint, { ok: true, status: 200, body: { rows } }], ['/lookups', EMPTY_LOOKUP_PAGE]];
    plan.push({ hash, mode: 'list', apiRoutes: query });
    plan.push({ hash, mode: 'empty', apiRoutes: [[firstReport.queryEndpoint, { ok: true, status: 200, body: { rows: [] } }], ['/lookups', EMPTY_LOOKUP_PAGE]] });
    plan.push({ hash, mode: 'loading', apiRoutes: [[firstReport.queryEndpoint, 'pending'], ['/lookups', EMPTY_LOOKUP_PAGE]] });
    plan.push({ hash, mode: 'denied', apiRoutes: [[firstReport.queryEndpoint, DENIED], ['/lookups', EMPTY_LOOKUP_PAGE]] });
    if (rows.length && firstReport.recordEndpoint) {
      plan.push({
        hash: `#/report/${firstReport.name}/row/${rows[0].ROWID}`,
        mode: 'detail',
        apiRoutes: [[firstReport.recordEndpoint, { ok: true, status: 200, body: { record: rows[0] } }], ['/lookups', EMPTY_LOOKUP_PAGE]],
      });
    }
  }
  for (const report of reports.slice(1)) {
    plan.push({ hash: `#/report/${report.name}`, mode: 'list', apiRoutes: [[report.queryEndpoint, { ok: true, status: 200, body: { rows } }], ['/lookups', EMPTY_LOOKUP_PAGE]] });
  }
  forms.forEach((form, index) => {
    plan.push({ hash: `#/form/${form.name}`, mode: 'form', apiRoutes: [['/lookups', EMPTY_LOOKUP_PAGE]] });
    if (index === 0) plan.push({ hash: `#/form/${form.name}`, mode: 'invalid', apiRoutes: [['/lookups', EMPTY_LOOKUP_PAGE]] });
  });
  for (const page of pages) {
    plan.push({ hash: `#/page/${page.name}`, mode: 'page', apiRoutes: [['/lookups', EMPTY_LOOKUP_PAGE]] });
  }
  return plan;
}

async function renderApp(name) {
  if (!templateReady()) {
    process.stderr.write(`ui-snapshot: ${MISSING_DEPS}\n`);
    process.exit(2);
  }
  const app = APPS.find((a) => a.name === name);
  if (!app) throw new Error(`unknown app ${name}`);
  const started = Date.now();
  const out = mkdtempSync(join(tmpdir(), `c2c-ui-snapshot-${name}-`));
  try {
    const ir = deriveIr(parse(app.ds));
    const spec = reactAppSpec(ir);
    const compiled = compileApp(out, generateReactApp(ir));
    const bootMod = await import(pathToFileURL(compiled.bootUrl).href);
    const routesMod = await import(pathToFileURL(compiled.routesUrl).href);
    const results = [];
    for (const step of planFor(spec, ROWS[name] ?? [])) {
      for (const viewport of VIEWPORTS) {
        const id = `${fileId(step.hash, step.mode)}-${viewport.name}`;
        const { text } = await renderSnapshot({
          boot: bootMod.bootApp, routes: routesMod.routes, spec, app: name, viewport, hash: step.hash, id, apiRoutes: step.apiRoutes, mode: step.mode,
        });
        results.push({ id, text });
      }
    }
    return { results, ms: Date.now() - started };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function checkAll(name, results) {
  const mismatches = [];
  for (const { id, text } of results) {
    const file = join(baselineDir, name, `${id}.snap`);
    if (!existsSync(file)) {
      mismatches.push(`--- ${id}: no baseline (run with --update)`);
      continue;
    }
    const report = diffSnapshots(id, readFileSync(file, 'utf8'), text);
    if (report) mismatches.push(report);
  }
  return mismatches;
}

// Importable for planFor (the tool's own tests) without running the CLI.
const isCli = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli && !onlyApp) {
  // One process per app: each app compiles its own generated modules, and a
  // fresh module registry per app keeps lazy-widget state from leaking
  // across apps.
  const names = APPS.map((a) => a.name);
  let failed = false;
  let total = 0;
  for (const name of names) {
    const childArgs = [join(root, 'tools', 'ui-snapshot', 'snapshot.mjs'), '--app', name];
    if (update) childArgs.push('--update');
    const child = spawnSync(process.execPath, childArgs, { encoding: 'utf8' });
    process.stdout.write(child.stdout ?? '');
    process.stderr.write(child.stderr ?? '');
    if (child.status !== 0) failed = true;
    const match = /snapshots=(\d+)/.exec(child.stdout ?? '');
    if (match) total += Number(match[1]);
  }
  if (!update) process.stdout.write(`ui-snapshot: apps=${names.length} snapshots=${total} ${failed ? 'MISMATCH' : 'ok'}\n`);
  process.exit(failed ? 1 : 0);
}

if (isCli) {
const { results, ms } = await renderApp(onlyApp);
if (update) {
  const dir = join(baselineDir, onlyApp);
  mkdirSync(dir, { recursive: true });
  for (const { id, text } of results) writeFileSync(join(dir, `${id}.snap`), text);
  process.stdout.write(`ui-snapshot: ${onlyApp} snapshots=${results.length} updated in ${ms}ms\n`);
} else {
  const mismatches = checkAll(onlyApp, results);
  for (const report of mismatches) process.stdout.write(`${report}\n`);
  process.stdout.write(`ui-snapshot: ${onlyApp} snapshots=${results.length} mismatches=${mismatches.length} in ${ms}ms\n`);
  process.exit(mismatches.length ? 1 : 0);
}
}
