#!/usr/bin/env node
// Rewrites packages/cli/data/feature-matrix-v4.snapshot.json from a feature-matrix
// v4 JSON file, plus the committed citation sidecar
// packages/cli/data/feature-matrix-v4.citations.json that
// tests/matrix/matrix-check.test.mjs re-verifies at HEAD.
//   node packages/cli/scripts/refresh-matrix-snapshot.mjs <source.json> [YYYY-MM-DD]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCites, extractCites } from './check-matrix-citations.mjs';

const sourcePath = process.argv[2];
if (!sourcePath) {
  process.stderr.write('usage: node packages/cli/scripts/refresh-matrix-snapshot.mjs <source.json> [YYYY-MM-DD]\n');
  process.exit(2);
}
const snapshotDate = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data');
const repo = path.resolve(dataDir, '..', '..', '..');

const raw = readFileSync(sourcePath);
const sourceSha256 = createHash('sha256').update(raw).digest('hex');
const sourceRows = JSON.parse(raw.toString('utf8'));

const cites = extractCites(sourceRows);
const stale = checkCites(cites, { repo, rev: 'HEAD' });
if (stale.length > 0) {
  for (const f of stale) process.stderr.write(`stale cite row ${f.id}: ${f.spec} — ${f.reason}\n`);
  process.stderr.write(`refusing to refresh: ${stale.length} stale cite(s) of ${cites.length} at HEAD\n`);
  process.exit(1);
}

const rows = sourceRows.map(({ id, area, feature, status }) => ({ id, area, feature, status }));
const meta = {
  matrix: 'feature-matrix-v4',
  source: 'feature-matrix-v4',
  sourceSha256,
  snapshotDate,
};
const snapshot = {
  schema: 'c2c-feature-matrix-snapshot/1',
  ...meta,
  provisional: false,
  note: 'Statuses are conservative: verified/migrated need a migration run plus e2e, of which none exists, so 0 rows are verified.',
  rows,
};
writeFileSync(path.join(dataDir, 'feature-matrix-v4.snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
const citations = {
  schema: 'c2c-matrix-citations/1',
  ...meta,
  cites,
};
writeFileSync(path.join(dataDir, 'feature-matrix-v4.citations.json'), `${JSON.stringify(citations, null, 2)}\n`);
process.stdout.write(`wrote snapshot: ${rows.length} rows + citations: ${cites.length} cites, sha256 ${sourceSha256}\n`);
