#!/usr/bin/env node
/**
 * Verify every code citation in a feature-matrix source file resolves at HEAD.
 *
 *   node packages/cli/scripts/check-matrix-citations.mjs [source.json] [--repo dir] [--rev rev]
 *
 * A cite is `path` or `path:line`, taken from each row's `evidence.code`
 * (`<path>[:<line>] @ <sha>`) and from `code: <path>[:<line>]` prefixes in
 * `status_evidence`. A `c2c-matrix-citations/1` sidecar
 * ({ cites: [{ id, spec }] }) is accepted directly. Every cited path must
 * exist as a blob at <rev> (default HEAD of --repo, default the enclosing
 * checkout); a cited line must be within the blob. Exits 0 when all resolve,
 * 1 listing each stale cite. refresh-matrix-snapshot.mjs runs it before
 * rewriting the snapshot and emits the committed sidecar, which
 * tests/matrix/matrix-check.test.mjs re-verifies at HEAD under npm test, so
 * citations cannot go stale silently.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDefault = path.resolve(here, '..', '..', '..');

function usage() {
  return 'usage: check-matrix-citations.mjs [source.json] [--repo dir] [--rev rev]';
}

function cliError(message) {
  console.error(`${message.trimEnd()} [C2C-CLI-021]\nSee plugin/references/error-index.md#c2c-cli-021`);
}

export function extractCites(rows) {
  const out = [];
  for (const row of rows) {
    const id = row && row.id;
    const code = row && row.evidence && row.evidence.code;
    if (typeof code === 'string') {
      const m = /^(.+?)(?::(\d+))?\s*@\s*\S/.exec(code.trim());
      if (m) out.push({ id, spec: m[2] ? `${m[1]}:${m[2]}` : m[1] });
    }
    const ev = row && row.status_evidence;
    if (typeof ev === 'string') {
      for (const m of ev.matchAll(/code: (\S+?)([;,]|\s*\(|\s+@|\s*$)/g)) {
        out.push({ id, spec: m[1] });
      }
    }
  }
  return out;
}

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

export function checkCites(cites, { repo = repoDefault, rev = 'HEAD' } = {}) {
  const failures = [];
  const byPath = new Map();
  for (const cite of cites) {
    const i = cite.spec.lastIndexOf(':');
    const hasLine = i > 0 && /^\d+$/.test(cite.spec.slice(i + 1));
    const p = hasLine ? cite.spec.slice(0, i) : cite.spec;
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push({ ...cite, line: hasLine ? Number(cite.spec.slice(i + 1)) : null });
  }
  for (const [p, items] of byPath) {
    const show = git(repo, ['show', `${rev}:${p}`]);
    if (show.status !== 0) {
      for (const it of items) failures.push({ ...it, reason: `no blob ${rev}:${p}` });
      continue;
    }
    const nlines = show.stdout.split('\n').length - (show.stdout.endsWith('\n') ? 1 : 0);
    for (const it of items) {
      if (it.line !== null && !(it.line >= 1 && it.line <= nlines)) {
        failures.push({ ...it, reason: `line ${it.line} out of range (${p} has ${nlines} lines at ${rev})` });
      }
    }
  }
  return failures;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }
  let source = null;
  let repo = repoDefault;
  let rev = 'HEAD';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo') repo = args[++i];
    else if (args[i] === '--rev') rev = args[++i];
    else if (!args[i].startsWith('--') && source === null) source = args[i];
    else {
      cliError(usage());
      process.exit(2);
    }
  }
  if (repo === undefined || rev === undefined || source === undefined || source === null) {
    cliError(usage());
    process.exit(2);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(source, 'utf8'));
  } catch (error) {
    cliError(`cannot read ${source}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  // A c2c-matrix-citations/1 sidecar carries { cites: [{id, spec}] }; a full
  // matrix carries rows whose cites are extracted.
  const cites = Array.isArray(doc?.cites)
    ? doc.cites
    : extractCites(Array.isArray(doc) ? doc : doc.rows ?? []);
  const failures = checkCites(cites, { repo, rev });
  if (failures.length > 0) {
    for (const f of failures) cliError(`stale cite row ${f.id}: ${f.spec} — ${f.reason}`);
    cliError(`${failures.length} stale cite(s) of ${cites.length} at ${rev}`);
    process.exit(1);
  }
  console.log(`ok: ${cites.length} cites resolve at ${rev}`);
}
