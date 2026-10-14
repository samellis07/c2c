#!/usr/bin/env node
/**
 * Per-app migration report over the synthetic fixture set. Offline; needs `npm run build` first.
 *
 * Runs precheck, analyze, the compiles gate, the UI build, the offline plan
 * and the offline deploy plan over every canonical synthetic export and writes
 * a numbered per-app report with no app names:
 *
 *   C2C_FIXTURES_DIR=<fixtures-root> npm run synthetic:report -- --dc <dc>
 *
 * Flags: --dir <synthetic-dir> (default $C2C_FIXTURES_DIR/synthetic),
 * --dc <dc> (default $C2C_DC), --out <file> (default docs/synthetic-report.md).
 * Exit 1 while any FAIL row exists (an app that neither migrates nor lists
 * its manual items), 2 on usage errors.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSyntheticDir, runSyntheticReport } from '../dist/cli/src/synthetic-report.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    'usage: npm run synthetic:report -- [--dir <synthetic-dir>] [--dc <dc>] [--out <file>]\n' +
      '  defaults: --dir $C2C_FIXTURES_DIR/synthetic, --dc $C2C_DC, --out docs/synthetic-report.md\n',
  );
  process.exit(0);
}

const dir = resolveSyntheticDir(process.env, flag(args, '--dir'));
if (!dir) {
  process.stderr.write('synthetic:report: pass --dir or set C2C_FIXTURES_DIR\n');
  process.exit(2);
}
const dc = flag(args, '--dc') ?? process.env.C2C_DC;
if (!dc) {
  process.stderr.write('synthetic:report: pass --dc or set C2C_DC\n');
  process.exit(2);
}
const out = resolve(root, flag(args, '--out') ?? join('docs', 'synthetic-report.md'));

const result = await runSyntheticReport({
  dir,
  dc: dc.toLowerCase(),
  out,
  onProgress: (app, total) => process.stderr.write(`synthetic:report: app ${app.n}/${total}\n`),
});
const c = result.counts;
process.stdout.write(
  `synthetic:report: apps ${c.total}  migrates ${c.migrates}  manual-items ${c.manualItems}  FAIL ${c.fail}  compiles-yes ${c.compilesYes}  todos ${c.todoTotal}\nwrote ${out}\n`,
);
process.exit(c.fail > 0 ? 1 : 0);
