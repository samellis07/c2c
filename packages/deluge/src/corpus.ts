/**
 * Corpus aggregation. Numbers and construct names only — no source text,
 * paths, or app names (same privacy rule as `c2c corpus`).
 */

import type { App, FunctionDef, Workflow } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import { generate } from './generate.js';
import type { TranslateStats } from './translate.js';

export interface CorpusNumbers {
  apps: number;
  spans: number;
  statements: number;
  translated: number;
  shimmed: number;
  todo: number;
  files: number;
  constructs: { construct: string; count: number }[];
}

export function countSpans(ir: App): number {
  let n = 0;
  const walkW = (w: Workflow) => {
    if (w.deluge?.text.trim()) n++;
    for (const t of w.blueprint?.transitions ?? []) for (const p of t.phases) n += p.deluge.filter((d) => d.text.trim()).length;
  };
  for (const w of ir.workflows) walkW(w);
  const walkF = (fn: FunctionDef) => {
    n += fn.deluge.filter((d) => d.text.trim()).length;
  };
  for (const fn of ir.functions) walkF(fn);
  return n;
}

export function accumulate(ir: App, into: CorpusNumbers): void {
  const g = generate(ir);
  into.apps++;
  into.spans += countSpans(ir);
  add(into, g.stats);
  into.files += g.files.length;
  for (const [construct, count] of [...g.constructs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const row = into.constructs.find((c) => c.construct === construct);
    if (row) row.count += count;
    else into.constructs.push({ construct, count });
  }
}

function add(into: CorpusNumbers, s: TranslateStats): void {
  into.statements += s.statements;
  into.translated += s.translated;
  into.shimmed += s.shimmed;
  into.todo += s.todo;
}

export function emptyNumbers(): CorpusNumbers {
  return { apps: 0, spans: 0, statements: 0, translated: 0, shimmed: 0, todo: 0, files: 0, constructs: [] };
}

export function formatCorpus(label: string, n: CorpusNumbers, top = 20): string {
  const ranked = [...n.constructs].sort((a, b) => b.count - a.count || compareEnUs(a.construct, b.construct)).slice(0, top);
  const lines = [
    `# Deluge translation — ${label}`,
    '',
    'Aggregate only. No app names, paths, or script text.',
    '',
    '| | |',
    '|---|---:|',
    `| apps | ${n.apps} |`,
    `| deluge spans | ${n.spans} |`,
    `| statements | ${n.statements} |`,
    `| translated | ${n.translated} |`,
    `| shimmed | ${n.shimmed} |`,
    `| TODO | ${n.todo} |`,
    `| generated files | ${n.files} |`,
    '',
    'A statement is counted once: TODO if it contains an untranslated construct, else shimmed if it uses the shim library (records, mail, invokeurl, zoho, thisapp, input, dates, decimals, conversions, client prefetch), else translated.',
    '',
    `## Top ${ranked.length} untranslated constructs`,
    '',
    '| construct | count |',
    '|---|---:|',
    ...ranked.map((r) => `| \`${r.construct}\` | ${r.count} |`),
    '',
  ];
  if (!ranked.length) lines.push('_None._', '');
  return lines.join('\n');
}
