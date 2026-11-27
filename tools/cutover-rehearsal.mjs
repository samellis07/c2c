#!/usr/bin/env node
/**
 * Offline cut-over rehearsal for one app: initial load, parallel run, freeze,
 * final delta, verify, switch and rollback against an in-memory Data Store.
 * Needs `npm run build` first. No network, no Catalyst CLI.
 *
 *   node tools/cutover-rehearsal.mjs --out <dir> --ds <file.ds|dir> [--rows <n>]
 *
 * Writes <out>/cutover-rehearsal.json and <out>/cutover-rehearsal.md.
 * Exit 1 while any criterion FAILs or is a GAP, 2 on usage errors.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadApp } from '../dist/deploy/src/index.js';
import { rehearsalMarkdown, rehearseCutover } from '../dist/cli/src/cutover-rehearsal.js';

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const args = process.argv.slice(2);
const out = flag(args, '--out');
const ds = flag(args, '--ds');
if (!out || !ds || args.includes('--help')) {
  process.stderr.write('usage: node tools/cutover-rehearsal.mjs --out <dir> --ds <file.ds|dir> [--rows <n>]\n');
  process.exit(2);
}
const rows = Number(flag(args, '--rows') ?? 30);
const target = resolve(ds);
const outDir = resolve(out);
const report = await rehearseCutover(loadApp(target), { workDir: join(outDir, 'work'), target, rows });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'cutover-rehearsal.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(outDir, 'cutover-rehearsal.md'), rehearsalMarkdown(report));
const t = report.totals;
process.stdout.write(`cutover-rehearsal: PASS ${t.PASS}  FAIL ${t.FAIL}  GAP ${t.GAP}\nwrote ${join(outDir, 'cutover-rehearsal.md')}\n`);
process.exit(t.FAIL > 0 || t.GAP > 0 ? 1 : 0);
