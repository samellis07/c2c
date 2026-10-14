#!/usr/bin/env node
/**
 * The UX-states gate: drive every
 * generated app's bundle through the loading/empty/error/confirm/pending/
 * toast/offline/session/denied/not-found/crash/focus/motion states in jsdom
 * against a scripted fake API — no browser, no network.
 *
 *   npm run build && node tools/ui-states-check.mjs --ui vanilla [--apps <filter>] [--json] [--out <dir>]
 *   npm ci --prefix packages/ui-react/template && node tools/ui-states-check.mjs --ui react [--apps <filter>] [--json] [--out <dir>]
 *
 * --ui react builds each app with Vite (like tools/ui-react-check.mjs) into
 * per-app dirs under --out (a fresh tmp dir otherwise) and checks dist/.
 * --ui vanilla builds the Slate bundle in memory. With no --apps the check
 * runs every app under C2C_GALLERY_DIR (or <C2C_FIXTURES_DIR>/gallery).
 * --apps is a comma list of app names or 1-based gallery indexes.
 *
 * Verdicts: pass / fail / skip / waived. A `fail` names the known issue that
 * tracks it (expected-fail while the issue is open) or `unowned` when none
 * does. Unowned failures fail the run; expected-fails and waivers do not. The pass
 * bar is every applicable row green on all apps in React; vanilla must pass
 * every row or carry a named waiver.
 *
 * A `state` axis on the computed-style visual baseline is planned; for now
 * this gate is DOM + ARIA only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
/** The known issue a failing verdict is tracked under, if any. */
const trackedBy = (v) => v.issue;
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ui = flag('--ui');
if (ui !== 'react' && ui !== 'vanilla') {
  process.stderr.write('usage: node tools/ui-states-check.mjs --ui react|vanilla [--apps <names|indexes>] [--out <dir>] [--json]\n');
  process.exit(2);
}
const out = flag('--out');
const only = flag('--apps') ? new Set(flag('--apps').split(',').map((s) => s.trim())) : undefined;
const json = args.includes('--json');

/** stdout.write + exit drops the tail once the pipe buffer fills (many apps). */
function emit(text, code = 0) {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) off += writeSync(1, buf, off);
  process.exit(code);
}

const gallery = process.env.C2C_GALLERY_DIR || (process.env.C2C_FIXTURES_DIR ? join(process.env.C2C_FIXTURES_DIR, 'gallery') : '');
if (!gallery || !existsSync(gallery)) {
  process.stderr.write('ui-states-check: set C2C_GALLERY_DIR (or C2C_FIXTURES_DIR with a gallery/ under it)\n');
  process.exit(2);
}

const { parseFile, parseProject } = await import(join(root, 'dist/core/src/index.js'));
const { bundleFromDir, bundleFromFiles } = await import(join(root, 'dist/ui-score/src/score.js'));
const { checkUiStates } = await import(join(root, 'dist/ui-score/src/states.js'));
const reactLib = ui === 'react' ? await import(join(root, 'dist/ui-react/src/index.js')) : undefined;
const vanillaLib = ui === 'vanilla' ? await import(join(root, 'dist/ui/src/index.js')) : undefined;
const modules = join(root, 'packages/ui-react/template/node_modules');
if (ui === 'react' && !existsSync(join(modules, '.bin', 'vite'))) {
  process.stderr.write('ui-states-check: run `npm ci --prefix packages/ui-react/template` first\n');
  process.exit(2);
}

function listTargets(dir) {
  const names = readdirSync(dir).filter((name) => !name.startsWith('.'));
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  for (const name of names) {
    const path = join(dir, name);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (readdirSync(path).some((child) => child.toLowerCase().endsWith('.ds'))) out.push(path);
    } else if (name.toLowerCase().endsWith('.ds')) out.push(path);
  }
  return out;
}

const targets = listTargets(gallery).filter((path, index) => {
  if (!only) return true;
  return only.has(basename(path)) || only.has(basename(path, '.ds')) || only.has(String(index + 1));
});
if (!targets.length) {
  process.stderr.write(`ui-states-check: --apps matched nothing under ${gallery}\n`);
  process.exit(2);
}

const outRoot = out ?? mkdtempSync(join(tmpdir(), 'ui-states-check-'));

function bundleFor(app, target, appOut) {
  if (ui === 'vanilla') return bundleFromFiles(vanillaLib.buildUi(app).files);
  mkdirSync(appOut, { recursive: true });
  reactLib.writeReactApp(appOut, reactLib.generateReactApp(app));
  const link = join(appOut, 'node_modules');
  if (!existsSync(link)) symlinkSync(modules, link, 'dir');
  const vite = spawnSync(join(modules, '.bin', 'vite'), ['build', '--logLevel', 'warn'], { cwd: appOut, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  if (vite.status !== 0) throw new Error(`vite build failed: ${`${vite.stdout ?? ''}${vite.stderr ?? ''}`.slice(0, 400)}`);
  return bundleFromDir(join(appOut, 'dist'));
}

const reports = [];
let hardFailures = 0;
for (const [index, target] of targets.entries()) {
  const name = basename(target, '.ds');
  const report = { app: name, index: index + 1, verdicts: [], error: undefined };
  try {
    const ir = statSync(target).isDirectory() ? parseProject(target).ir : parseFile(target).ir;
    const bundle = bundleFor(ir, target, join(outRoot, name));
    report.verdicts = await checkUiStates(ir, bundle, { ui });
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }
  const counts = { pass: 0, fail: 0, skip: 0, waived: 0, error: report.error ? 1 : 0 };
  for (const v of report.verdicts) counts[v.status] = (counts[v.status] ?? 0) + 1;
  report.counts = counts;
  const unowned = report.verdicts.filter((v) => v.status === 'fail' && !trackedBy(v));
  report.hard = counts.error + unowned.length;
  hardFailures += report.hard;
  reports.push(report);
  if (!json) {
    const failing = report.verdicts
      .filter((v) => v.status === 'fail')
      .map((v) => `${v.state}→${trackedBy(v) ?? 'UNOWNED'}`)
      .join(' ');
    process.stdout.write(`ui-states-check ${report.app}: pass=${counts.pass} xfail=${counts.fail} skip=${counts.skip} waived=${counts.waived}${report.error ? ` ERROR ${report.error}` : ''}${unowned.length ? ` UNOWNED: ${unowned.map((v) => v.state).join(',')}` : ''}${failing ? `  [${failing}]` : ''}\n`);
  }
}
const totals = reports.reduce(
  (acc, r) => {
    for (const key of ['pass', 'fail', 'skip', 'waived', 'error']) acc[key] += r.counts[key] ?? 0;
    return acc;
  },
  { pass: 0, fail: 0, skip: 0, waived: 0, error: 0 },
);
const summary = `ui-states-check --ui ${ui}: ${reports.length} apps — pass=${totals.pass} expected-fail=${totals.fail} skip=${totals.skip} waived=${totals.waived} errors=${totals.error} unowned-failures=${hardFailures - totals.error}\n`;
if (json) emit(`${JSON.stringify({ ui, apps: reports.length, totals, unownedFailures: hardFailures - totals.error, reports }, null, 2)}\n`, hardFailures ? 1 : 0);
emit(summary, hardFailures ? 1 : 0);
