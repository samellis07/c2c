#!/usr/bin/env node
/**
 * Run the security gate over every app in a directory, one app at a time.
 *
 *   npm run build
 *   node tools/security-gate/run-all.mjs --dir <apps-dir> --out <results-dir> [--only a,b] [--nice 10]
 *
 * <apps-dir> holds one entry per app: a .ds file, or a directory with a .ds
 * (the same layout determinism:gallery reads; C2C_GALLERY_DIR is the default).
 * Each app runs in its own child process under `nice -n <n>` (default 10),
 * strictly sequentially, so a full sweep never loads more than one generated
 * app at once. Results: <out>/<app>/security-gate.{json,md}, plus
 * <out>/summary.json and <out>/summary.md (one row per app, and the failures
 * of every app grouped by fix site).
 *
 * Exit 0 when every app passes, 1 when any check fails, 2 on a usage error or
 * when an app could not be generated.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupFailures } from './gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gate = join(here, 'gate.mjs');

function opt(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

/** The apps in a directory. A directory without a .ds directly inside is not an app; listSkipped names those. */
export function listApps(dir) {
  return scan(dir).apps;
}

/** Directories listApps leaves out (no .ds directly inside, e.g. nested scenario folders), so a sweep can report them. */
export function listSkipped(dir) {
  return scan(dir).skipped;
}

function scan(dir) {
  const out = [];
  const skipped = [];
  for (const name of readdirSync(dir).filter((n) => !n.startsWith('.')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const path = join(dir, name);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (readdirSync(path).some((child) => child.toLowerCase().endsWith('.ds'))) out.push({ name, path });
      else skipped.push({ name, path });
    } else if (name.toLowerCase().endsWith('.ds')) out.push({ name: name.replace(/\.ds$/i, ''), path });
  }
  return { apps: out, skipped };
}

function hasNice() {
  return process.platform !== 'win32' && spawnSync('nice', ['-n', '0', 'true']).status === 0;
}

function main() {
  const args = process.argv.slice(2);
  const dir = opt(args, '--dir', process.env.C2C_GALLERY_DIR ?? '');
  const out = opt(args, '--out', '');
  if (!dir || !out) {
    process.stderr.write('usage: node tools/security-gate/run-all.mjs --dir <apps-dir> --out <results-dir> [--only a,b] [--nice 10]\n');
    return 2;
  }
  const only = new Set(opt(args, '--only', '').split(',').map((s) => s.trim()).filter(Boolean));
  const niceArg = Number(opt(args, '--nice', '10'));
  const niceness = String(Number.isInteger(niceArg) ? niceArg : 10);
  const found = scan(resolve(dir));
  const apps = found.apps.filter((app) => !only.size || only.has(app.name));
  const skipped = found.skipped.filter((app) => !only.size || only.has(app.name));
  mkdirSync(resolve(out), { recursive: true });
  const useNice = hasNice();
  const rows = [];
  const failures = [];
  let worst = 0;
  for (const app of apps) {
    const appOut = join(resolve(out), app.name);
    mkdirSync(appOut, { recursive: true });
    const cmd = useNice ? 'nice' : process.execPath;
    const cmdArgs = useNice ? ['-n', niceness, process.execPath, gate, app.path, '--out', appOut] : [gate, app.path, '--out', appOut];
    const started = Date.now(); // determinism-allow: wall-clock duration of a sweep step, not generated output
    const child = spawnSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000 });
    const seconds = Math.round((Date.now() - started) / 100) / 10; // determinism-allow: same duration
    process.stdout.write(child.stdout || '');
    if (child.stderr) process.stderr.write(child.stderr);
    const file = join(appOut, 'security-gate.json');
    const report = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { error: `gate exited ${child.status}${child.signal ? ` (${child.signal})` : ''}` };
    if (report.error || !report.summary) {
      rows.push({ app: app.name, error: report.error ?? `gate exited ${child.status}`, seconds });
      worst = 2;
      continue;
    }
    const s = report.summary;
    rows.push({ app: app.name, routes: s.routes, ...s.counts, seconds });
    for (const f of s.failures) failures.push({ ...f, route: `${app.name}: ${f.route}` });
    if (s.counts.fail && worst < 1) worst = 1;
  }
  writeFileSync(join(resolve(out), 'summary.json'), `${JSON.stringify({ apps: rows, skipped: skipped.map((s) => s.name), failures }, null, 2)}\n`);
  const md = ['# Security gate sweep', '', '| app | routes | pass | fail | expected-fail | n/a | public | s |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    md.push(r.error ? `| ${r.app} | error: ${r.error} | | | | | | ${r.seconds} |` : `| ${r.app} | ${r.routes} | ${r.pass} | ${r.fail} | ${r.xfail} | ${r['n/a']} | ${r.public} | ${r.seconds} |`);
  }
  for (const s of skipped) md.push(`| ${s.name} | skipped: no .ds directly inside (nested apps are not swept) | | | | | | |`);
  if (failures.length) {
    md.push('', '## Failures by fix site (all apps)', '', '| check | result | fix at | expected-fail issue | routes |', '|---|---|---|---|---|');
    for (const g of groupFailures(failures.map((f) => ({ ...f, detail: f.detail.replace(/ for .*$/, '') })))) {
      md.push(`| ${g.check} | ${g.detail} | \`${g.ref ?? ''}\` | ${g.issue ?? '**none: new failure**'} | ${g.routes.length}: ${g.routes.slice(0, 4).map((r) => `\`${r}\``).join(', ')}${g.routes.length > 4 ? ', ...' : ''} |`);
    }
  }
  writeFileSync(join(resolve(out), 'summary.md'), `${md.join('\n')}\n`);
  for (const s of skipped) process.stderr.write(`security-gate sweep: skipped ${s.name}: no .ds directly inside\n`);
  process.stdout.write(`security-gate sweep: apps=${rows.length} skipped=${skipped.length} -> ${join(resolve(out), 'summary.md')}\n`);
  return worst;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());

