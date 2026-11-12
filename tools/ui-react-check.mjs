#!/usr/bin/env node
/**
 * Build check for the React UI target (docs/react-target.md, "Build and CI").
 * For one Creator app: generate the React app twice and compare the source
 * bytes, type-check it (Q2), build it twice with Vite and compare dist/ bytes
 * (reproducible build), report the bundle budget, and score the built bundle
 * when the UI scorer is present in dist/.
 *
 *   npm run build && node tools/ui-react-check.mjs <file|dir> --out <dir> [--json]
 *   node tools/ui-react-check.mjs [--out <dir>] [--json]
 *
 * With no target the check runs every app under C2C_GALLERY_DIR (or
 * <C2C_FIXTURES_DIR>/gallery) into per-app dirs under --out (a fresh tmp dir
 * otherwise), prints one line per app, and fails when any app does.
 *
 * Dependencies come from packages/ui-react/template/node_modules (install them
 * once with `npm ci --prefix packages/ui-react/template`); the generated app's
 * lockfile is the template's, so the same tree serves every app. Offline: no
 * network, no Catalyst calls.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const out = flag('--out');
const modules = join(root, 'packages/ui-react/template/node_modules');
if (!existsSync(join(modules, '.bin', 'vite'))) {
  process.stderr.write('ui-react-check: run `npm ci --prefix packages/ui-react/template` first\n');
  process.exit(2);
}

/** stdout.write + exit drops the tail once the pipe buffer fills (many apps). */
function emit(text, code = 0) {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) off += writeSync(1, buf, off);
  process.exit(code);
}

const { loadApp } = await import(join(root, 'dist/determinism/src/tree.js'));
const { generateReactApp, writeReactApp } = await import(join(root, 'dist/ui-react/src/index.js'));

function treeHash(dir, skip = new Set()) {
  const lines = [];
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      if (skip.has(name)) continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else lines.push(`${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${relative(dir, path)}`);
    }
  };
  walk(dir);
  return { files: lines.length, sha256: createHash('sha256').update(lines.join('\n')).digest('hex') };
}

function run(cmd, argv, cwd) {
  const res = spawnSync(cmd, argv, { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
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

/** The per-app check: deterministic source, typecheck, two identical dists, budget, score. */
async function checkApp(target, out) {
  const app = loadApp(target);
  const first = generateReactApp(app);
  const second = generateReactApp(app);
  const sourceSame = first.length === second.length && first.every((f, i) => f.path === second[i].path && Buffer.compare(Buffer.from(f.data), Buffer.from(second[i].data)) === 0);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeReactApp(out, first);
  symlinkSync(modules, join(out, 'node_modules'), 'dir');
  const source = treeHash(out, new Set(['node_modules']));

  const bin = (name) => join(modules, '.bin', name);
  const tsc = run(bin('tsc'), ['-p', 'tsconfig.json', '--noEmit'], out);
  const build1 = run(bin('vite'), ['build', '--logLevel', 'warn'], out);
  const dist1 = build1.ok ? treeHash(join(out, 'dist')) : undefined;
  const build2 = build1.ok ? run(bin('vite'), ['build', '--logLevel', 'warn'], out) : { ok: false, output: '' };
  const dist2 = build2.ok ? treeHash(join(out, 'dist')) : undefined;
  const budget = build1.ok ? JSON.parse(readFileSync(join(out, 'dist/c2c-build.json'), 'utf8')) : undefined;

  let score;
  const scorer = join(root, 'dist/ui-score/src/score.js');
  if (build2.ok && existsSync(scorer)) {
    const { scoreUi, bundleFromDir } = await import(scorer);
    const result = await scoreUi(app, bundleFromDir(join(out, 'dist')), { ui: 'react' });
    score = { desktop: result.desktop.score, phone: result.phone.score, pass: result.pass };
  }

  const report = {
    app: app.name,
    sourceDeterministic: sourceSame,
    source,
    tsc: tsc.ok,
    build: build1.ok && build2.ok,
    reproducible: !!dist1 && !!dist2 && dist1.sha256 === dist2.sha256,
    dist: dist1,
    gzip: budget?.gzip,
    budget: budget?.budget,
    score: score ?? 'scorer not present in dist/',
  };
  return { report, ok: sourceSame && tsc.ok && report.build && report.reproducible, tscOut: tsc.output, buildOut: build1.ok ? '' : build1.output };
}

function lineFor(report) {
  const budget = report.gzip ? `js=${report.gzip?.js ?? '-'}B css=${report.gzip?.css ?? '-'}B (budget ${report.budget?.js ?? '-'}/${report.budget?.css ?? '-'})` : '';
  const score = typeof report.score === 'string' ? report.score : JSON.stringify(report.score);
  return `ui-react-check ${report.app}: source ${report.source.files} files deterministic=${report.sourceDeterministic} tsc=${report.tsc ? 'ok' : 'FAIL'} build=${report.build ? 'ok' : 'FAIL'} reproducible=${report.reproducible} ${budget} score=${score}\n`;
}

if (target) {
  if (!out) {
    process.stderr.write('usage: node tools/ui-react-check.mjs <file|dir> --out <dir> [--json]\n       node tools/ui-react-check.mjs [--out <dir>] [--json]   # gallery via C2C_GALLERY_DIR\n');
    process.exit(2);
  }
  const { report, ok, tscOut, buildOut } = await checkApp(target, out);
  if (!report.tsc) process.stderr.write(tscOut);
  if (!report.build) process.stderr.write(buildOut);
  if (args.includes('--json')) emit(`${JSON.stringify(report, null, 2)}\n`, ok ? 0 : 1);
  emit(lineFor(report), ok ? 0 : 1);
}

const gallery = process.env.C2C_GALLERY_DIR || (process.env.C2C_FIXTURES_DIR ? join(process.env.C2C_FIXTURES_DIR, 'gallery') : '');
if (!gallery || !existsSync(gallery)) {
  process.stderr.write('usage: node tools/ui-react-check.mjs <file|dir> --out <dir> [--json]\n       gallery mode needs C2C_GALLERY_DIR (or C2C_FIXTURES_DIR with a gallery/ under it)\n');
  process.exit(2);
}
const outRoot = out ?? mkdtempSync(join(tmpdir(), 'ui-react-check-'));
const targets = listTargets(gallery);
const json = args.includes('--json');
const reports = [];
let failures = 0;
for (const t of targets) {
  const { report, ok, tscOut, buildOut } = await checkApp(t, join(outRoot, basename(t)));
  reports.push(report);
  if (!ok) {
    failures += 1;
    if (tscOut) process.stderr.write(tscOut);
    if (buildOut) process.stderr.write(buildOut);
  }
  if (!json) process.stdout.write(lineFor(report));
}
const summary = `ui-react-check: ${targets.length - failures}/${targets.length} apps pass\n`;
if (json) emit(`${JSON.stringify({ apps: reports.length, failures, reports }, null, 2)}\n${summary}`, failures ? 1 : 0);
emit(summary, failures ? 1 : 0);
