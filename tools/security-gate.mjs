#!/usr/bin/env node
/**
 * Security gate entry point.
 *
 *   npm run build
 *   node tools/security-gate.mjs <apps-dir> --out <results-dir>   every app, one at a time, under nice
 *   node tools/security-gate.mjs <app.ds | app-dir> [--out <dir>]  one app
 *
 * A directory whose entries are apps (each a .ds or a folder holding one) is a
 * sweep (tools/security-gate/run-all.mjs); a .ds file or a folder that holds a
 * .ds is one app (tools/security-gate/gate.mjs). See those files for the checks.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), 'security-gate');
const args = process.argv.slice(2);
const target = args.find((arg, i) => !arg.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!target) {
  process.stderr.write('usage: node tools/security-gate.mjs <apps-dir | app.ds | app-dir> [--out <dir>]\n');
  process.exit(2);
}
const path = resolve(target);
const st = statSync(path);
const oneApp = !st.isDirectory() || readdirSync(path).some((name) => name.toLowerCase().endsWith('.ds'));
const script = join(here, oneApp ? 'gate.mjs' : 'run-all.mjs');
const rest = oneApp ? args : ['--dir', target, ...args.filter((arg) => arg !== target)];
const child = spawnSync(process.execPath, [script, ...rest], { stdio: 'inherit' });
process.exit(child.status ?? 2);
