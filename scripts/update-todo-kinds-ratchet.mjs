#!/usr/bin/env node
/**
 * Explicit TODO-kind baseline updater.
 * The test runner never executes this file. UPDATE_TODO_RATCHET is ignored.
 * Refuses to write when CI is set, and refuses to replace malformed JSON.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TodoRatchetError,
  baselineFile,
  collectAllFixtureCounts,
  planBaselineWrite,
  repoRoot,
} from '../tests/ratchet/todo-kinds-lib.mjs';

function ciEnabled() {
  const value = process.env.CI;
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

function fail(err) {
  if (err instanceof TodoRatchetError) {
    console.error(`${err.name} ${err.code}`);
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

if (ciEnabled()) {
  fail(new TodoRatchetError(
    'TODO_RATCHET_UPDATE_REFUSED_IN_CI',
    'npm run ratchet:update refuses to write when CI is set. The ratchet test is read-only.',
  ));
}

const allowIncrease = process.argv.includes('--allow-increase');
const current = collectAllFixtureCounts(repoRoot);
const exists = existsSync(baselineFile);
let raw = '';
if (exists) {
  try {
    raw = readFileSync(baselineFile, 'utf8');
  } catch (err) {
    fail(new TodoRatchetError(
      'TODO_RATCHET_BASELINE_MALFORMED',
      `Failed to read tests/ratchet/todo-kinds.json: ${err instanceof Error ? err.message : String(err)}`,
    ));
  }
}

let next;
try {
  next = planBaselineWrite({ exists, raw, current, allowIncrease });
} catch (err) {
  fail(err);
}

const tmp = `${baselineFile}.${process.pid}.tmp`;
writeFileSync(tmp, next);
renameSync(tmp, baselineFile);
console.log(`Updated ${path.relative(repoRoot, baselineFile)}`);
