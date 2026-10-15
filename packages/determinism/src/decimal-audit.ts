#!/usr/bin/env node
/**
 * Exact-decimal audit of a corpus of sample Creator apps (not included). Counts only — never app names,
 * field names, paths, or script text.
 *
 *   node dist/determinism/src/decimal-audit.js <gallery-dir>   (prints docs/decimal-audit.md)
 *
 * Two counts, each from `c2c ui` generation (server functions and client handlers):
 *
 * 1. Criteria and sort sites on exact-decimal (decimal, currency, percent) columns:
 *    Deluge `Form[criteria] sort by …` and report criteria, filters, and sort. A
 *    site is routed when every such leaf compiles to the Double shadow column and
 *    every such sort orders by the shadow (then the runtime's exact pass).
 * 2. Raw JS arithmetic the translator emitted on a decimal operand, which would
 *    compute in binary64 instead of `shim.decimal`.
 */
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { App } from '../../core/src/ir.js';
import { withDecimalAudit } from '../../deluge/src/audit.js';
import { decimalColumnsOf } from '../../deluge/src/generate.js';
import { reportCriteria } from '../../deluge/src/translate.js';
import { loadCorpusApps } from '../../schema/src/corpus.js';
import { compileCriteria, type Criteria, type DecimalColumns } from '../../shims/src/criteria.js';
import { needsExactRead } from '../../shims/src/runtime.js';
import { buildUi } from '../../ui/src/generate.js';

const COMPARISONS = new Set(['==', '!=', '<', '>', '<=', '>=', 'in']);

export interface DecimalAuditCounts {
  apps: number;
  /** Apps with at least one varchar exact-decimal column. */
  appsWithDecimalColumns: number;
  /** `Form[criteria]` sites the translator emitted. */
  querySites: number;
  /** …of which compare an exact-decimal field. */
  queryCriteriaSites: number;
  /** …of which sort by an exact-decimal field. */
  querySortSites: number;
  /** Report criteria, named filters, and sort keys on an exact-decimal field. */
  reportCriteriaSites: number;
  reportSortSites: number;
  /** Sites above whose decimal leaf or sort does not use the shadow column. Must be 0. */
  unrouted: number;
  /** Raw JS arithmetic ops on a decimal operand (emitted occurrences). Must be 0. */
  arithmeticBypass: number;
}

function routedLeaf(op: string, field: string, decimals: DecimalColumns): boolean {
  const spec = decimals[field]!;
  const leaf = (op === 'in' ? { op, field, value: ['1.00'] } : { op, field, value: '1.00' }) as Criteria;
  const where = compileCriteria(leaf, new Set(), decimals);
  // `!=` has no shadow superset; ZCQL matches every row and the post-filter is exact.
  return (where.includes(spec.shadow) || (op === '!=' && where === '(ROWID IS NOT NULL)')) && needsExactRead(leaf, undefined, decimals);
}

function criteriaLeaves(c: Criteria, out: { op: string; field: string }[]): void {
  if (c.op === 'and' || c.op === 'or') c.args.forEach((a) => criteriaLeaves(a, out));
  else if (c.op === 'not') criteriaLeaves(c.arg, out);
  else if ('field' in c) out.push({ op: c.op, field: c.field });
}

export function auditApp(app: App, counts: DecimalAuditCounts): void {
  const map = decimalColumnsOf(app);
  counts.apps += 1;
  if (Object.keys(map).length) counts.appsWithDecimalColumns += 1;
  const { audit } = withDecimalAudit(() => buildUi(app));
  counts.arithmeticBypass += audit.arithmetic.length;
  for (const site of audit.queries) {
    counts.querySites += 1;
    const decimals = Object.hasOwn(map, site.form) ? map[site.form]! : {};
    const hits = site.leaves.filter((leaf) => COMPARISONS.has(leaf.op) && Object.hasOwn(decimals, leaf.field));
    if (hits.length) {
      counts.queryCriteriaSites += 1;
      if (!hits.every((leaf) => routedLeaf(leaf.op, leaf.field, decimals))) counts.unrouted += 1;
    }
    if (site.sort && Object.hasOwn(decimals, site.sort)) {
      counts.querySortSites += 1;
      if (!needsExactRead({ op: 'true' }, { field: site.sort }, decimals)) counts.unrouted += 1;
    }
  }
  for (const report of app.reports) {
    const decimals = report.form && Object.hasOwn(map, report.form) ? map[report.form]! : {};
    if (!Object.keys(decimals).length) continue;
    const texts = [report.criteria, ...report.filters.map((f) => f.criteria)].filter((t): t is string => !!t?.trim());
    for (const text of texts) {
      const leaves: { op: string; field: string }[] = [];
      criteriaLeaves(reportCriteria(text, app.functions), leaves);
      const hits = leaves.filter((leaf) => COMPARISONS.has(leaf.op) && Object.hasOwn(decimals, leaf.field));
      if (!hits.length) continue;
      counts.reportCriteriaSites += 1;
      if (!hits.every((leaf) => routedLeaf(leaf.op, leaf.field, decimals))) counts.unrouted += 1;
    }
    for (const order of report.sortBy) {
      if (!Object.hasOwn(decimals, order.field)) continue;
      counts.reportSortSites += 1;
      if (!needsExactRead({ op: 'true' }, { field: order.field }, decimals)) counts.unrouted += 1;
    }
  }
}

export function emptyCounts(): DecimalAuditCounts {
  return {
    apps: 0,
    appsWithDecimalColumns: 0,
    querySites: 0,
    queryCriteriaSites: 0,
    querySortSites: 0,
    reportCriteriaSites: 0,
    reportSortSites: 0,
    unrouted: 0,
    arithmeticBypass: 0,
  };
}

export function auditGallery(dir: string): DecimalAuditCounts {
  const counts = emptyCounts();
  for (const app of loadCorpusApps(dir)) auditApp(app.ir, counts);
  return counts;
}

export function formatDecimalAudit(c: DecimalAuditCounts): string {
  return [
    '# Exact-decimal audit',
    '',
    'Regenerable summary of a corpus of sample Creator apps (not included). Recompute with',
    '`node dist/determinism/src/decimal-audit.js <corpus-dir> > docs/decimal-audit.md`; `npm test` fails when this',
    'file is stale and `C2C_FIXTURES_DIR` is set. Counts only — no app names, fields, or script text.',
    '',
    'Decimal, currency, and percent columns are exact decimal strings in VarChar(64). ZCQL compares a varchar',
    'as text, so each such column has a Double shadow (`<Field>__n`). A criteria or sort site on one is routed',
    'when its decimal leaves compile to the shadow column (a widened superset) and its sort orders by the shadow;',
    'the runtime then filters with `shim.decimal.cmp` on the varchar, re-sorts ties exactly, and applies the range.',
    'Sites are counted over `c2c ui` generation. NoSQL forms have no shadow and are not ZCQL tables, so their',
    'fields are not counted here.',
    '',
    '| | |',
    '|---|---:|',
    `| corpus apps | ${c.apps} |`,
    `| apps with exact-decimal columns | ${c.appsWithDecimalColumns} |`,
    `| \`Form[criteria]\` sites emitted | ${c.querySites} |`,
    `| …criteria on an exact-decimal field | ${c.queryCriteriaSites} |`,
    `| …sort by an exact-decimal field | ${c.querySortSites} |`,
    `| report criteria/filters on an exact-decimal field | ${c.reportCriteriaSites} |`,
    `| report sort by an exact-decimal field | ${c.reportSortSites} |`,
    `| sites not routed through the shadow path | ${c.unrouted} |`,
    `| raw JS arithmetic ops on a decimal operand | ${c.arithmeticBypass} |`,
    '',
  ].join('\n');
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('decimal-audit <gallery-dir>\n');
    process.exit(2);
  }
  const text = formatDecimalAudit(auditGallery(dir));
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) off += writeSync(1, buf, off);
}
