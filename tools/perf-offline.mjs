#!/usr/bin/env node
/**
 * Offline volume run over the library and kitchen-sink fixtures. Needs `npm run build` first.
 *
 *   node tools/perf-offline.mjs --size 10k|100k --out <dir> [--app library|kitchen-sink]
 *     [--seed <text>] [--api-rows <n>] [--page-samples 20] [--search-repeats 5] [--users 25 --days 30 --page-loads 40 --searches 10 --submits 20]
 *
 * Writes perf-<size>.json and perf-<size>.md under --out. Numbers come from an
 * in-process run against the fake Catalyst SDK: they are NOT Catalyst numbers.
 * The quota estimate cites the repo limits table; prices are [UNVERIFIED].
 * Run 100k sizes one at a time: the seed and the in-memory store hold every row.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveIr, parse } from '../dist/core/src/index.js';
import { OFFLINE_NOTE, runPerf } from '../dist/deploy/src/perf-harness.js';
import { estimateQuota } from '../dist/deploy/src/perf-estimate.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = {
  library: 'fixtures/redistributable/library-application-system/library_application.ds',
  'kitchen-sink': 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds',
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const size = flag('--size', '10k');
const out = flag('--out', '');
if (!['10k', '100k'].includes(size) || !out) {
  process.stderr.write('usage: node tools/perf-offline.mjs --size 10k|100k --out <dir> [--app library|kitchen-sink]\n');
  process.exit(2);
}
const only = flag('--app', '');
const apiRows = flag('--api-rows', '');
const profile = {
  users: Number(flag('--users', '25')),
  days: Number(flag('--days', '30')),
  pageLoads: Number(flag('--page-loads', '40')),
  searches: Number(flag('--searches', '10')),
  submits: Number(flag('--submits', '20')),
};

const runs = [];
for (const [name, path] of Object.entries(APPS)) {
  if (only && only !== name) continue;
  const app = deriveIr(parse(readFileSync(join(root, path), 'utf8')));
  const run = await runPerf(app, {
    size,
    seed: flag('--seed', undefined),
    ...(apiRows ? { apiRowsPerTable: Number(apiRows) } : {}),
    ...(flag('--page-samples', '') ? { pageSamples: Number(flag('--page-samples', '')) } : {}),
    ...(flag('--search-repeats', '') ? { searchRepeats: Number(flag('--search-repeats', '')) } : {}),
    log: (line) => process.stderr.write(`${name}: ${line}\n`),
  });
  const max = (values) => Math.max(0, ...values);
  const calls = {
    pageLoad: max(run.reports.map((r) => r.pagedLoad.maxStoreCalls)),
    search: max(run.reports.flatMap((r) => [r.searchBroad.maxStoreCalls, r.searchSelective.maxStoreCalls, r.searchNone.maxStoreCalls])),
    submit: max(run.imports.map((i) => i.storeCallsPerApiRow ?? 0)),
  };
  const tables = run.imports.map((i) => ({ name: i.form, rows: i.rows }));
  runs.push({ name, run, estimate: estimateQuota(tables, profile, calls), calls });
}

const fmt = (n) => (n === null || n === undefined ? 'n/a' : String(n));
const md = [`# Offline volume run, ${size}`, '', `> ${OFFLINE_NOTE}`, ''];
for (const { name, run, estimate, calls } of runs) {
  md.push(`## ${name} (${run.app})`, '', `Rows per table posted through c2c_api: ${apiRows || 'all'}; the rest are stored with insertRows. Seed \`${run.seed}\`, seed.json sha256 \`${run.seedSha256}\`. Page size ${run.pageSize}.`, '');
  md.push('### Import through the generated c2c_api', '', '| Form | Route | Rows | Via API | Refused | API rows/s (offline) | Store calls per API row | Via insertRows | First refusal |', '|---|---|---|---|---|---|---|---|---|');
  for (const i of run.imports) md.push(`| ${i.form} | ${i.route ?? 'none'} | ${i.rows} | ${i.viaApi} | ${i.refused} | ${fmt(i.apiRowsPerSec)} | ${fmt(i.storeCallsPerApiRow)} | ${i.viaStore} | ${(i.firstRefusal ?? '').replace(/\|/g, '/').slice(0, 120)} |`);
  md.push('', '### Reports (offline ms)', '', '| Report | Rows | First page p95 | Paged load p50 / p95 | Search broad p95 | Search selective p95 | Search none p95 | Max store calls |', '|---|---|---|---|---|---|---|---|');
  for (const r of run.reports) {
    const callsMax = Math.max(r.pagedLoad.maxStoreCalls, r.searchBroad.maxStoreCalls, r.searchSelective.maxStoreCalls, r.searchNone.maxStoreCalls);
    md.push(`| ${r.report} | ${r.rows} | ${r.firstPage.p95Ms} | ${r.pagedLoad.p50Ms} / ${r.pagedLoad.p95Ms} | ${r.searchBroad.p95Ms} | ${r.searchSelective.p95Ms} | ${r.searchNone.p95Ms} | ${callsMax} |`);
  }
  md.push('', '### Function timeout risk', '', '| Report | Probe | Store calls | Status |', '|---|---|---|---|');
  for (const t of run.timeoutRisk) md.push(`| ${t.report} | ${t.probe} | ${t.storeCalls} | ${t.status} |`);
  md.push('', `### Quota and cost estimate (calls per request used: page ${calls.pageLoad}, search ${calls.search}, submit ${calls.submit})`, '');
  md.push(`Usage profile (assumption, not a fact): ${estimate.profile.users} users x ${estimate.profile.days} days; per user per day ${estimate.profile.pageLoads} page loads, ${estimate.profile.searches} searches, ${estimate.profile.submits} submits.`, '');
  md.push('| Phase | Item | Quantity | Limit | Share | Note |', '|---|---|---|---|---|---|');
  for (const [phase, lines] of [['import', estimate.import], ['month', estimate.month]]) {
    for (const l of lines) md.push(`| ${phase} | ${l.item} | ${fmt(l.quantity)} ${l.unit} | ${l.limit ? `${fmt(l.limit.value)} ${l.limit.unit} ${l.limit.label} (${l.limit.source})` : ''} | ${fmt(l.share)} | ${l.note ?? ''} |`);
  }
  md.push('', '| Priced item | Price | Label |', '|---|---|---|');
  for (const p of estimate.prices) md.push(`| ${p.item} | n/a | ${p.label} ${p.note} |`);
  md.push('', 'Cost total: n/a [UNVERIFIED] (no price in the repo).', '');
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, `perf-${size}.json`), `${JSON.stringify({ size, note: OFFLINE_NOTE, profile, apiRowsPerTable: apiRows ? Number(apiRows) : 'all', runs }, null, 2)}\n`);
writeFileSync(join(out, `perf-${size}.md`), `${md.join('\n')}\n`);
process.stdout.write(`wrote ${join(out, `perf-${size}.md`)}\n`);
