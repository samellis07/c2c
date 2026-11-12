#!/usr/bin/env node
/**
 * Compare generated trees for every app under C2C_GALLERY_DIR.
 * Not part of npm test. Prints counts only — never app names or source text.
 *
 *   C2C_GALLERY_DIR=path npm run determinism:gallery
 *
 * `--write <path> <out-dir>` writes one app's tree to disk (the CI gate,
 * tools/determinism-gate.sh, hashes two clean runs of it).
 *
 * Twice in this process, then twice in fresh processes.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryKind } from '../../core/src/index.js';
import { digestOf, manifestFor, writeTree } from './tree.js';

/** stdout.write + exit drops the tail once the pipe buffer fills. */
function emit(text: string, code = 0): never {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) off += writeSync(1, buf, off);
  process.exit(code);
}

function listTargets(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((ent) => !ent.name.startsWith('.'));
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[] = [];
  for (const ent of entries) {
    const path = join(dir, ent.name);
    // The entry kind comes from the directory read; a symlink is skipped.
    if (ent.isSymbolicLink()) continue;
    if (entryKind(ent) === 'directory') {
      if (readdirSync(path).some((child) => child.toLowerCase().endsWith('.ds'))) out.push(path);
    } else if (ent.name.toLowerCase().endsWith('.ds')) out.push(path);
  }
  return out;
}

function rollup(targets: readonly string[]): { digest: string; mismatches: number } {
  const lines: string[] = [];
  let mismatches = 0;
  for (let i = 0; i < targets.length; i++) {
    const first = digestOf(manifestFor(targets[i]));
    const second = digestOf(manifestFor(targets[i]));
    if (first !== second) {
      mismatches++;
      process.stderr.write(`mismatch app-index=${i + 1}\n`);
    }
    lines.push(first);
  }
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
  return { digest, mismatches };
}

function digestOnly(dir: string): string {
  const lines = listTargets(dir).map((target) => digestOf(manifestFor(target)));
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

const once = process.argv.indexOf('--once');
if (once >= 0) {
  const target = process.argv[once + 1];
  if (!target) {
    process.stderr.write('determinism:gallery --once <path>\n');
    process.exit(2);
  }
  emit(JSON.stringify(manifestFor(target)));
}

const writeArg = process.argv.indexOf('--write');
if (writeArg >= 0) {
  const target = process.argv[writeArg + 1];
  const out = process.argv[writeArg + 2];
  if (!target || !out) {
    process.stderr.write('determinism:gallery --write <path> <out-dir>\n');
    process.exit(2);
  }
  writeTree(target, out);
  process.exit(0);
}

const digestArg = process.argv.indexOf('--digest');
if (digestArg >= 0) {
  const dir = process.argv[digestArg + 1];
  if (!dir) {
    process.stderr.write('determinism:gallery --digest <dir>\n');
    process.exit(2);
  }
  emit(`${digestOnly(dir)}\n`);
}

const dir = process.env.C2C_GALLERY_DIR;
if (!dir) {
  process.stderr.write('determinism:gallery requires C2C_GALLERY_DIR\n');
  process.exit(2);
}

const targets = listTargets(dir);
const here = rollup(targets);
const script = fileURLToPath(import.meta.url);
const workers: string[] = [];
let workerFailed = false;
for (let n = 0; n < 2; n++) {
  const child = spawnSync(process.execPath, [script, '--digest', dir], { encoding: 'utf8' });
  if (child.status !== 0) {
    workerFailed = true;
    process.stderr.write(child.stderr || 'digest worker failed\n');
    break;
  }
  workers.push(child.stdout.trim());
}

const inProcess = here.mismatches === 0 ? 'identical' : 'NOT-identical';
const separate =
  workerFailed || workers.length !== 2 || workers[0] !== workers[1] || workers[0] !== here.digest
    ? 'NOT-identical'
    : 'identical';
emit(
  `determinism:gallery apps=${targets.length} in-process=${inProcess} mismatches=${here.mismatches} separate-processes=${separate}\n`,
  inProcess === 'identical' && separate === 'identical' ? 0 : 1,
);
