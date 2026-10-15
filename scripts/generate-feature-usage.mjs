#!/usr/bin/env node
/**
 * Generates docs/feature-usage.md by evaluating all 194 feature-matrix rows
 * across the 67 gallery apps and the 33 synthetic + 2 kitchen-sink apps in the repo.
 *
 * Usage:
 *   node scripts/generate-feature-usage.mjs [--out <path>] [--fixtures-dir <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProject, parseFileWithSidecars, appFacts } from '../dist/core/src/index.js';
import { compareEnUs } from '../dist/core/src/order.js';
import { listSyntheticApps } from '../dist/cli/src/synthetic-report.js';
import { FEATURE_MAPPING, evaluateAppFeatures } from './feature-mapping.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function defaultFixturesDir(root) {
  if (process.env.C2C_FIXTURES_DIR) return process.env.C2C_FIXTURES_DIR;
  const candidates = [
    path.resolve(root, '../c2c-fixtures-local'),
    path.resolve(root, '../../c2c-fixtures-local'),
    path.resolve(root, '../../../c2c-fixtures-local'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'gallery'))) return candidate;
  }
  return path.resolve(root, '../c2c-fixtures-local');
}

function parseArgs(args) {
  let outPath = path.join(repoRoot, 'docs/feature-usage.md');
  let fixturesDir = defaultFixturesDir(repoRoot);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) {
      outPath = path.resolve(args[++i]);
    } else if (args[i] === '--fixtures-dir' && args[i + 1]) {
      fixturesDir = path.resolve(args[++i]);
    }
  }
  return { outPath, fixturesDir };
}

function resolveGalleryApps(galleryRoot) {
  if (!fs.existsSync(galleryRoot)) {
    throw new Error(`Gallery directory does not exist: ${galleryRoot}`);
  }
  const entries = fs.readdirSync(galleryRoot, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(galleryRoot, e.name))
    .sort((a, b) => compareEnUs(path.basename(a), path.basename(b)));

  if (dirs.length !== 67) {
    process.stderr.write(`Warning: expected 67 gallery apps, found ${dirs.length}\n`);
  }
  return dirs;
}

function resolveSyntheticApps(fixturesDir) {
  const synthRoot = path.join(fixturesDir, 'synthetic');
  const synthApps = [];

  if (fs.existsSync(synthRoot)) {
    const list = listSyntheticApps(synthRoot);
    // 33 canonical synthetic apps (exclude s99 kitchen sink if present)
    for (const app of list) {
      if (!app.rel.startsWith('s99') && !app.rel.startsWith('_run')) {
        synthApps.push({ name: app.rel, file: app.file });
      }
    }
  }

  // Kitchen-sink apps in the repo
  const repoKs = path.join(repoRoot, 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds');
  if (fs.existsSync(repoKs)) {
    synthApps.push({ name: 'fixtures/synthetic/kitchen-sink', file: repoKs });
  }

  const repoKsg = path.join(repoRoot, 'fixtures/synthetic/kitchen-sink-gaps/kitchen_sink_gaps.ds');
  if (fs.existsSync(repoKsg)) {
    synthApps.push({ name: 'fixtures/synthetic/kitchen-sink-gaps', file: repoKsg });
  }

  return synthApps;
}

export function rankFeatures(options = {}) {
  const fixturesDir = options.fixturesDir || defaultFixturesDir(repoRoot);
  const galleryDirs = resolveGalleryApps(path.join(fixturesDir, 'gallery'));
  const syntheticApps = resolveSyntheticApps(fixturesDir);

  const galleryCounts = new Map();
  for (const m of FEATURE_MAPPING) galleryCounts.set(m.id, 0);

  // Sequential scan of gallery apps (no app names stored or emitted)
  for (const appDir of galleryDirs) {
    const parsed = parseProject(appDir);
    const facts = appFacts(parsed.ir);
    const { detected } = evaluateAppFeatures(facts);
    for (const id of detected) {
      galleryCounts.set(id, (galleryCounts.get(id) || 0) + 1);
    }
  }

  const syntheticCounts = new Map();
  for (const m of FEATURE_MAPPING) syntheticCounts.set(m.id, 0);

  // Sequential scan of synthetic apps
  for (const app of syntheticApps) {
    const parsed = parseFileWithSidecars(app.file);
    const facts = appFacts(parsed.ir);
    const { detected } = evaluateAppFeatures(facts);
    for (const id of detected) {
      syntheticCounts.set(id, (syntheticCounts.get(id) || 0) + 1);
    }
  }

  const ranked = FEATURE_MAPPING.map((m) => {
    if (!m.detectable) {
      return {
        id: m.id,
        title: m.title,
        area: m.area,
        status: m.status,
        detectable: false,
        reason: m.reason,
        galleryCount: -1,
        syntheticCount: -1,
      };
    }
    return {
      id: m.id,
      title: m.title,
      area: m.area,
      status: m.status,
      detectable: true,
      reason: null,
      galleryCount: galleryCounts.get(m.id) || 0,
      syntheticCount: syntheticCounts.get(m.id) || 0,
    };
  });

  // Sort: gallery count desc, then id asc; not detectable rows at the end sorted by id
  ranked.sort((a, b) => {
    if (a.detectable && !b.detectable) return -1;
    if (!a.detectable && b.detectable) return 1;
    if (a.detectable && b.detectable) {
      if (b.galleryCount !== a.galleryCount) return b.galleryCount - a.galleryCount;
      return a.id - b.id;
    }
    return a.id - b.id;
  });

  return {
    ranked,
    galleryTotal: galleryDirs.length,
    syntheticTotal: syntheticApps.length,
  };
}

export function formatMarkdown(report) {
  const { ranked, galleryTotal, syntheticTotal } = report;
  const lines = [
    '# Feature Matrix Usage Ranking',
    '',
    `Every row of the Creator-to-Catalyst feature matrix (v4, 194 rows) ranked by how many apps use it across the ${galleryTotal} gallery apps and the ${syntheticTotal} synthetic + kitchen-sink apps in the repo.`,
    '',
    '- Evaluated from the parsed IR using the committed mapping table (`scripts/feature-mapping.mjs`).',
    `- Gallery apps evaluated: ${galleryTotal} (counts only, private gallery app names omitted).`,
    `- Synthetic apps evaluated: ${syntheticTotal} (33 synthetic apps from the local fixtures directory plus the 2 kitchen-sink apps in the repo).`,
    "- Rows that cannot be observed in a `.ds` export are listed as `not detectable` with their documented reason.",
    '',
    '## Ranked Feature Usage',
    '',
    '| row id | title | status in matrix | gallery apps using it | synthetic apps using it |',
    '|---|---|---|---|---|',
  ];

  for (const row of ranked) {
    const galleryCell = row.detectable ? String(row.galleryCount) : `not detectable (${row.reason})`;
    const syntheticCell = row.detectable ? String(row.syntheticCount) : `not detectable (${row.reason})`;
    const cells = [row.id, row.title, row.status, galleryCell, syntheticCell].map(markdownCell);
    lines.push(`| ${cells.join(' | ')} |`);
  }

  lines.push('');
  return lines.join('\n');
}

/** Escapes a value for one Markdown table cell: backslashes first, then pipes; newlines become spaces. */
function markdownCell(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function main() {
  const { outPath, fixturesDir } = parseArgs(process.argv.slice(2));
  const report = rankFeatures({ fixturesDir });
  const md = formatMarkdown(report);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  process.stdout.write(`Wrote feature usage table to ${outPath}\n`);

  const notStarted = report.ranked.filter((r) => r.status === 'not-started');
  process.stdout.write(`\nTop 30 not-started rows by gallery usage:\n`);
  for (let i = 0; i < 30 && i < notStarted.length; i++) {
    const r = notStarted[i];
    const usage = r.detectable ? `${r.galleryCount} / ${report.galleryTotal} gallery apps (${r.syntheticCount} / ${report.syntheticTotal} synthetic)` : `not detectable (${r.reason})`;
    process.stdout.write(`${i + 1}. Row ${r.id}: ${r.title} (${r.area}) — ${usage}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
