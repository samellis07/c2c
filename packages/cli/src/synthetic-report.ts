/**
 * Per-app migration report over the synthetic fixture set.
 *
 * Runs precheck, analyze, the compiles gate, the UI build, the offline plan
 * and the offline deploy plan over every synthetic `.ds` file and writes
 * a numbered per-app report with no app names. An app either migrates or lists
 * its exact manual items; an app that does neither is a FAIL row.
 *
 * A counted app is a `.ds` file under the synthetic fixture directory
 * that is not a re-export (`*.exported.ds`), not a `sidecars/` helper
 * file and not a `_run/` driver file.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode, parseFileWithSidecars, type App } from '../../core/src/index.js';
import { compareEnUs } from '../../core/src/order.js';
import { qualityGate } from '../../quality/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import { deployCli, defaultIo, type Io } from '../../deploy/src/cli.js';
import { planCli } from '../../deploy/src/offline-plan.js';
import { analyze } from './analyze.js';
import { precheck } from './precheck.js';

export interface SyntheticApp {
  /** 1-based row number in path order. */
  n: number;
  /** Corpus-relative path, used only for ordering. Never printed. */
  rel: string;
  file: string;
}

export interface ManualItem {
  severity: 'blocker' | 'warning';
  check: string;
  count: number;
}

export interface TodoKindCount {
  construct: string;
  count: number;
}

export interface SyntheticRow {
  n: number;
  compiles: 'yes' | 'no';
  manual: ManualItem[];
  todoCount: number;
  todoKinds: TodoKindCount[];
  planErrors: string[];
  deterministic: boolean;
  planOk: boolean;
  deployOk: boolean;
  uiOk: boolean;
}

export type SyntheticVerdict = 'migrates' | 'manual-items' | 'FAIL';

export interface SyntheticCounts {
  total: number;
  migrates: number;
  manualItems: number;
  fail: number;
  compilesYes: number;
  todoTotal: number;
}

/** Corpus directory from an explicit path or the fixtures root. */
export function resolveSyntheticDir(env: NodeJS.ProcessEnv, dir: string | undefined): string | undefined {
  if (dir) return dir;
  if (env.C2C_FIXTURES_DIR) return join(env.C2C_FIXTURES_DIR, 'synthetic');
  return undefined;
}

const SKIP_DIRS = new Set(['_run', 'sidecars']);

function walk(root: string, rel: string, out: string[]): void {
  const dir = rel ? join(root, rel) : root;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareEnUs(a.name, b.name))) {
    if (entry.name.startsWith('.')) continue;
    const child = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, child, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ds') && !entry.name.toLowerCase().endsWith('.exported.ds')) {
      out.push(child);
    }
  }
}

/** Every canonical export under the corpus, numbered in path order. */
export function listSyntheticApps(root: string): SyntheticApp[] {
  const rels: string[] = [];
  walk(root, '', rels);
  rels.sort(compareEnUs);
  return rels.map((rel, i) => ({ n: i + 1, rel, file: join(root, rel) }));
}

/** Precheck findings grouped by severity and check, blockers first. */
export function summarizeManual(findings: readonly { severity: 'blocker' | 'warning'; check: string }[]): ManualItem[] {
  const counts = new Map<string, ManualItem>();
  for (const finding of findings) {
    const key = `${finding.severity}\0${finding.check}`;
    const item = counts.get(key);
    if (item) item.count++;
    else counts.set(key, { severity: finding.severity, check: finding.check, count: 1 });
  }
  return [...counts.values()].sort(
    (a, b) => (a.severity === b.severity ? compareEnUs(a.check, b.check) : a.severity === 'blocker' ? -1 : 1),
  );
}

/**
 * An app migrates when it is deterministic, has no manual blocker (a precheck
 * blocker means Creator rejects the source; a widget package is rebuilt by
 * hand) and every offline stage builds. Otherwise it must list its manual
 * items (precheck findings, widget packages or unresolved TODOs). Anything
 * else is a FAIL row.
 */
export function verdictOf(row: SyntheticRow): SyntheticVerdict {
  const blocked = row.manual.some((item) => item.severity === 'blocker');
  if (!blocked && row.deterministic && row.compiles === 'yes' && row.planOk && row.deployOk && row.uiOk) return 'migrates';
  if (row.manual.length > 0 || row.todoCount > 0) return 'manual-items';
  return 'FAIL';
}

export function countRows(rows: readonly SyntheticRow[]): SyntheticCounts {
  const counts: SyntheticCounts = { total: rows.length, migrates: 0, manualItems: 0, fail: 0, compilesYes: 0, todoTotal: 0 };
  for (const row of rows) {
    const verdict = verdictOf(row);
    if (verdict === 'migrates') counts.migrates++;
    else if (verdict === 'manual-items') counts.manualItems++;
    else counts.fail++;
    if (row.compiles === 'yes') counts.compilesYes++;
    counts.todoTotal += row.todoCount;
  }
  return counts;
}

/** One table cell: single line, no pipes, no machine paths, no app names. */
function cell(text: string): string {
  return text.replace(/[\r\n]+/g, ' | ').replace(/\|/g, '/').trim();
}

function manualCell(manual: readonly ManualItem[]): string {
  if (!manual.length) return 'none';
  return manual.map((item) => `${item.count} ${item.severity} ${item.check}`).join('; ');
}

function todoCell(row: SyntheticRow): string {
  if (!row.todoCount) return '0';
  return `${row.todoCount} (${row.todoKinds.map((kind) => `${kind.count} ${kind.construct}`).join(', ')})`;
}

export function formatSyntheticReport(rows: readonly SyntheticRow[], opts: { label: string; dc: string }): string {
  const counts = countRows(rows);
  const lines = [
    `# Per-app migration report (${opts.label})`,
    '',
    `Source: the synthetic fixture directory (${rows.length} apps).`,
    `Plan data centre: ${opts.dc}. Rows are numbered in corpus path order and name no app.`,
    '',
    'Columns: compiles is the static gate over the generated tree (yes/no);',
    'manual items are the precheck findings and widget packages grouped by severity and check;',
    'unresolved TODOs are the analyze residual with per-construct counts;',
    'plan errors are the first line of each failing stage (parse, quality, ui, plan, deploy), or none;',
    'verdict is migrates (deterministic, no manual blocker, every offline stage clean),',
    'manual-items (lists what stays manual), or FAIL (neither).',
    '',
    `apps ${counts.total}  migrates ${counts.migrates}  manual-items ${counts.manualItems}  FAIL ${counts.fail}  compiles-yes ${counts.compilesYes}  todos ${counts.todoTotal}`,
    '',
    '| n | compiles | manual items | unresolved TODOs | plan errors | verdict |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.n} | ${row.compiles} | ${cell(manualCell(row.manual))} | ${cell(todoCell(row))} | ${cell(row.planErrors.length ? row.planErrors.join('; ') : 'none')} | ${verdictOf(row)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface QualityOutcome {
  /** True when the generated tree passes every static stage, prefetch read-only included. */
  ok: boolean;
  /** Non-read calls found in the generated prefetch endpoints. */
  prefetchNonReads?: number;
}

export type QualityProbe = (app: App) => Promise<boolean | QualityOutcome>;

const defaultQuality: QualityProbe = async (app) => {
  const q = await qualityGate(app);
  return { ok: q.compiles.ok && q.prefetchReads.ok, prefetchNonReads: q.prefetchReads.nonReads };
};

interface Scrub {
  root: string;
  file: string;
  tmp: string[];
  name: string | null;
}

/** Error text scrubbed of machine paths and app names so the report stays portable. */
function scrub(text: string, scope: Scrub): string {
  let out = text;
  const names = [scope.file, scope.root, ...scope.tmp];
  names.sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (name) out = out.split(name).join(name === scope.file ? 'app file' : name === scope.root ? '<synthetic-dir>' : '<tmp>');
  }
  if (scope.name) out = out.split(scope.name).join('app');
  const first = out.split('\n', 1)[0] ?? '';
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}

function quietIo(captured: { stdout: string; stderr: string }): Io {
  return {
    ...defaultIo(),
    stdout: (text) => {
      captured.stdout += text;
    },
    stderr: (text) => {
      captured.stderr += text;
    },
  };
}

/** Run every offline stage for one app. Stages after a parse failure are skipped. */
export async function runSyntheticApp(
  app: SyntheticApp,
  opts: { root: string; dc: string; quality?: QualityProbe },
): Promise<SyntheticRow> {
  const failed = (planErrors: string[]): SyntheticRow => ({
    n: app.n,
    compiles: 'no',
    manual: [],
    todoCount: 0,
    todoKinds: [],
    planErrors,
    deterministic: false,
    planOk: false,
    deployOk: false,
    uiOk: false,
  });
  const tmp: string[] = [];
  const scope: Scrub = { root: opts.root, file: app.file, tmp, name: null };
  let ir: App;
  let source: string;
  try {
    source = decode(readFileSync(app.file)).text;
    const parsed = parseFileWithSidecars(app.file);
    if (!parsed.ir.name || parsed.ir.dialect === 'snippet') throw new Error('not a Creator application export (no application block)');
    if (parsed.cst.errors.length) throw new Error(`cannot parse: ${parsed.cst.errors[0]!.message}`);
    ir = parsed.ir;
    scope.name = parsed.ir.name;
  } catch (err) {
    return failed([`parse: ${scrub(err instanceof Error ? err.message : String(err), scope)}`]);
  }
  const planErrors: string[] = [];

  const report = precheck(ir, source);
  const analyzed = analyze(ir);
  // Widget packages sit beside the export (html + json, not `.ds`), so they
  // reach the row as analyze blockers rather than precheck findings. List
  // them with the manual items so a widget-only app cannot read as migrates.
  const manual = summarizeManual([
    ...report.findings,
    ...analyzed.blockers
      .filter((blocker) => blocker.label.startsWith('widget '))
      .map((blocker) => ({ severity: 'blocker' as const, check: blocker.label })),
  ]);

  let compiles: 'yes' | 'no' = 'no';
  try {
    const outcome = await (opts.quality ?? defaultQuality)(ir);
    compiles = (typeof outcome === 'boolean' ? outcome : outcome.ok) ? 'yes' : 'no';
    const nonReads = typeof outcome === 'boolean' ? 0 : (outcome.prefetchNonReads ?? 0);
    if (nonReads > 0) planErrors.push(`quality: prefetch-non-reads=${nonReads}`);
  } catch (err) {
    planErrors.push(`quality: ${scrub(err instanceof Error ? err.message : String(err), scope)}`);
  }

  let uiOk = true;
  try {
    buildUi(ir);
  } catch (err) {
    uiOk = false;
    planErrors.push(`ui: ${scrub(err instanceof Error ? err.message : String(err), scope)}`);
  }

  let planOk = true;
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-synthetic-plan-'));
    tmp.push(out);
    const captured = { stdout: '', stderr: '' };
    try {
      const code = await planCli([app.file, '--out', out, '--dc', opts.dc], quietIo(captured));
      if (code !== 0) {
        planOk = false;
        planErrors.push(`plan: ${scrub(captured.stderr.trim() || `exit ${code}`, scope)}`);
      }
    } catch (err) {
      planOk = false;
      planErrors.push(`plan: ${scrub(err instanceof Error ? err.message : String(err), scope)}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  let deployOk = true;
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-synthetic-deploy-'));
    tmp.push(out);
    const captured = { stdout: '', stderr: '' };
    try {
      const code = await deployCli([app.file, '--out', out], quietIo(captured));
      if (code !== 0) {
        deployOk = false;
        planErrors.push(`deploy: ${scrub(captured.stderr.trim() || `exit ${code}`, scope)}`);
      }
    } catch (err) {
      deployOk = false;
      planErrors.push(`deploy: ${scrub(err instanceof Error ? err.message : String(err), scope)}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  return {
    n: app.n,
    compiles,
    manual,
    todoCount: analyzed.determinism.todoCount,
    todoKinds: analyzed.determinism.todoKinds.map((kind) => ({ construct: kind.construct, count: kind.count })),
    planErrors,
    deterministic: analyzed.determinism.deterministic,
    planOk,
    deployOk,
    uiOk,
  };
}

export interface SyntheticReportResult {
  markdown: string;
  counts: SyntheticCounts;
  apps: number;
}

/**
 * Run the exit report over the corpus and write the markdown file.
 * Returns the counts; the caller maps FAIL rows to its exit code.
 */
export async function runSyntheticReport(opts: {
  dir: string;
  dc: string;
  out: string;
  label?: string;
  quality?: QualityProbe;
  onProgress?: (app: SyntheticApp, total: number) => void;
}): Promise<SyntheticReportResult> {
  const apps = listSyntheticApps(opts.dir);
  const rows: SyntheticRow[] = [];
  for (const app of apps) {
    opts.onProgress?.(app, apps.length);
    rows.push(await runSyntheticApp(app, { root: opts.dir, dc: opts.dc, ...(opts.quality ? { quality: opts.quality } : {}) }));
  }
  const markdown = formatSyntheticReport(rows, { label: opts.label ?? 'synthetic', dc: opts.dc });
  writeFileSync(opts.out, markdown);
  return { markdown, counts: countRows(rows), apps: apps.length };
}
