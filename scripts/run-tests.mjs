#!/usr/bin/env node
/**
 * Runs the suite under `node --test`.
 *
 * Targets are command-line paths or the lines of `--list <file>` (see
 * `test-list.mjs`). A path is a test file or a directory of test files. A
 * directory is expanded here to every runnable file (.js, .mjs, .cjs) under
 * it, matching what the test runner does with a directory named `test`. The
 * expansion is done in this script because directory arguments are only
 * scanned on some runtimes: newer runners treat each argument as a file to
 * execute, so a bare directory aborts with MODULE_NOT_FOUND and its tests
 * never run.
 *
 * The expanded list is passed to `node --test` as explicit files, which
 * every supported runtime handles the same way. Exits non-zero when a
 * target is missing, a listed path is duplicated, or any test fails.
 * `--dry-run` prints the expanded list and does not run it. The run carries
 * the heap cap and per-test timeout from `test-limits.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestConcurrencyArgs } from './test-concurrency.mjs';
import { getTestLimitArgs, withHeapCap } from './test-limits.mjs';
import { loadTestList } from './test-list.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const RUNNABLE = /\.(?:c|m)?js$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  let listFile = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--list') {
      const file = argv[i + 1];
      if (!file || file.startsWith('--')) fail('run-tests: --list needs a file path');
      listFile = file;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) fail(`run-tests: unknown option ${arg}`);
    positional.push(arg);
  }
  return { listFile, positional, dryRun };
}

function locate(entry) {
  return entry.line ? `${entry.label}:${entry.line}: ` : '';
}

function expand(entry, files, seen) {
  const abs = resolve(root, entry.path);
  let stat;
  try {
    stat = statSync(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`${locate(entry)}missing path ${entry.path}`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    noteFile(abs, entry, files, seen);
    return;
  }
  const children = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const child of children) {
    const childAbs = join(abs, child.name);
    if (child.isDirectory()) {
      expand({ path: childAbs, line: entry.line, label: entry.label }, files, seen);
    } else if (child.isFile() && RUNNABLE.test(child.name)) {
      noteFile(childAbs, entry, files, seen);
    }
  }
}

function noteFile(abs, entry, files, seen) {
  const real = realpathSync(abs);
  const first = seen.get(real);
  if (first !== undefined) {
    throw new Error(`${locate(entry)}duplicate path ${entry.path} (first at ${first})`);
  }
  seen.set(real, entry.line ? `${entry.label}:${entry.line}` : entry.path);
  files.push(abs);
}

function toPrint(abs) {
  const rel = relative(root, abs).replace(/\\/g, '/');
  return rel.startsWith('..') ? abs : rel;
}

function resolveEntries(entries) {
  const files = [];
  const seen = new Map();
  for (const entry of entries) expand(entry, files, seen);
  return files;
}

const { listFile, positional, dryRun } = parseArgs(process.argv.slice(2));
const entries = [];
if (listFile) {
  try {
    for (const item of loadTestList(resolve(process.cwd(), listFile), listFile)) {
      entries.push({ path: item.path, line: item.line, label: listFile });
    }
  } catch (err) {
    fail(`run-tests: ${err.message}`);
  }
}
for (const path of positional) entries.push({ path, line: null, label: '' });
if (entries.length === 0) fail('run-tests: no test targets');

let files;
try {
  files = resolveEntries(entries);
} catch (err) {
  fail(`run-tests: ${err.message}`);
}
if (files.length === 0) fail('run-tests: targets contained no runnable test files');

if (dryRun) {
  process.stdout.write(`${files.map(toPrint).join('\n')}\n`);
  process.exit(0);
}

const reporter = resolve(root, 'scripts/failure-summary-reporter.mjs');
const args = [
  ...getTestLimitArgs(),
  '--test',
  ...getTestConcurrencyArgs(),
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  `--test-reporter=${reporter}`,
  '--test-reporter-destination=stdout',
  ...files,
];
const env = { ...process.env, NODE_OPTIONS: withHeapCap(process.env.NODE_OPTIONS) };
const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
if (result.error) {
  process.stderr.write(`run-tests: ${result.error.message}\n`);
  process.exit(2);
}
if (result.signal) {
  process.stderr.write(`run-tests: runner ended on ${result.signal}\n`);
  process.exit(2);
}
process.exit(result.status ?? 1);
