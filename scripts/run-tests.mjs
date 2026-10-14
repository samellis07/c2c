#!/usr/bin/env node
/**
 * Runs the suite under `node --test`.
 *
 * Each argument is a test file or a directory of test files. A directory is
 * expanded here to every runnable file (.js, .mjs, .cjs) under it, matching
 * what the test runner does with a directory named `test`. The expansion is
 * done in this script because directory arguments are only scanned on some
 * runtimes: newer runners treat each argument as a file to execute, so a
 * bare directory aborts with MODULE_NOT_FOUND and its tests never run.
 *
 * The expanded list is passed to `node --test` as explicit files, which
 * every supported runtime handles the same way. Exits non-zero when a
 * target is missing or any test fails.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestConcurrencyArgs } from './test-concurrency.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const RUNNABLE = /\.(?:c|m)?js$/;

function expand(target, files) {
  const path = resolve(root, target);
  const stat = statSync(path); // throws when a listed target is missing
  if (!stat.isDirectory()) {
    files.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) expand(child, files);
    else if (entry.isFile() && RUNNABLE.test(entry.name)) files.push(child);
  }
}


const targets = process.argv.slice(2);
if (targets.length === 0) {
  process.stderr.write('run-tests: no test targets\n');
  process.exit(2);
}
const files = [];
for (const target of targets) expand(target, files);
if (files.length === 0) {
  process.stderr.write('run-tests: targets contained no runnable test files\n');
  process.exit(2);
}

const reporter = resolve(root, 'scripts/failure-summary-reporter.mjs');
const args = [
  '--test',
  ...getTestConcurrencyArgs(),
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  `--test-reporter=${reporter}`,
  '--test-reporter-destination=stdout',
  ...files,
];
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`run-tests: ${result.error.message}\n`);
  process.exit(2);
}
if (result.signal) {
  process.stderr.write(`run-tests: runner ended on ${result.signal}\n`);
  process.exit(2);
}
process.exit(result.status ?? 1);
