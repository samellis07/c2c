#!/usr/bin/env node
/**
 * The UI scorer over every app in the gallery: docs/ui-scores.md. Not part of
 * npm test. Rows are numbered by the sorted gallery order: no app names, no
 * field or report labels, no source text — scores, criterion points and
 * failing-check kinds only.
 *
 *   C2C_FIXTURES_DIR=<dir> npm run score-ui:gallery                       (summary to stdout)
 *   C2C_FIXTURES_DIR=<dir> npm run score-ui:gallery -- --out docs/ui-scores.md
 *   C2C_FIXTURES_DIR=<dir> npm run score-ui:gallery -- --ui both --out docs/ui-scores.md
 *   node dist/ui-score/src/gallery.js --once <app dir or .ds> [--ui react|both|vanilla]
 *
 * Each app's bundle is what `c2c ui` writes, built in memory, then scored
 * offline by packages/ui-score/src/score.ts.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile, parseProject, type App } from '../../core/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import { generateReactApp, TEMPLATE_DIR, writeReactApp } from '../../ui-react/src/index.js';
import { CHECK_KINDS, VIEWPORTS, bundleFromDir, bundleFromFiles, checkKind, loadRubric, scoreUi, type Rubric, type UiScore, type Viewport } from './score.js';

export type UiMode = 'vanilla' | 'react' | 'both';

export interface ScoreGalleryOptions {
  ui?: UiMode;
  rubric?: Rubric;
}

export interface GalleryRow {
  index: number;
  result?: UiScore;
  error?: string;
  vanilla?: UiScore;
  react?: UiScore;
  vanillaError?: string;
  reactError?: string;
}

/** Gallery entries in sorted order: each sub-folder holding a .ds, or a .ds file. */
export function galleryTargets(dir: string): string[] {
  const st = statSync(dir, { throwIfNoEntry: false });
  if (!st) return [];
  if (st.isFile() && dir.toLowerCase().endsWith('.ds')) return [dir];
  if (st.isDirectory() && readdirSync(dir).some((child) => child.toLowerCase().endsWith('.ds'))) {
    const entries = readdirSync(dir).filter((name) => !name.startsWith('.'));
    const subApp = entries.some((child) => {
      const p = join(dir, child);
      return statSync(p, { throwIfNoEntry: false })?.isDirectory() && readdirSync(p).some((c) => c.toLowerCase().endsWith('.ds'));
    });
    if (!subApp) return [dir];
  }
  const names = readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const s = statSync(path, { throwIfNoEntry: false });
    if (s?.isDirectory() && readdirSync(path).some((child) => child.toLowerCase().endsWith('.ds'))) out.push(path);
    else if (s?.isFile() && name.toLowerCase().endsWith('.ds')) out.push(path);
  }
  return out;
}

export async function scoreVanillaUi(ir: App, rubric: Rubric = loadRubric()): Promise<UiScore> {
  return await scoreUi(ir, bundleFromFiles(buildUi(ir).files), { rubric });
}

/**
 * Score the React build of one app: generate the React sources, build them
 * with Vite the same way tools/ui-react-check.mjs does (the template's own
 * installed dependencies serve every app through a symlink), then score the
 * emitted dist/ offline.
 */
export async function scoreReactUi(ir: App, rubric: Rubric = loadRubric()): Promise<UiScore> {
  const templateModules = join(TEMPLATE_DIR, 'node_modules');
  const viteBin = process.platform === 'win32' ? join(templateModules, '.bin', 'vite.cmd') : join(templateModules, '.bin', 'vite');
  if (!existsSync(viteBin)) {
    throw new Error('React template dependencies are not installed');
  }
  const outDir = mkdtempSync(join(tmpdir(), 'c2c-ui-react-gallery-'));
  try {
    writeReactApp(outDir, generateReactApp(ir));
    symlinkSync(templateModules, join(outDir, 'node_modules'), 'dir');
    const res = spawnSync(viteBin, ['build', '--logLevel', 'warn'], {
      cwd: outDir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    if (res.status !== 0) {
      throw new Error(`vite build failed: ${(res.stderr || res.stdout || '').trim().slice(0, 500)}`);
    }
    return await scoreUi(ir, bundleFromDir(join(outDir, 'dist')), { rubric });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

export async function scoreGalleryTargets(targets: string[], rubric: Rubric = loadRubric(), options: ScoreGalleryOptions = {}): Promise<GalleryRow[]> {
  const mode = options.ui ?? 'vanilla';
  const rows: GalleryRow[] = [];
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    try {
      const ir = statSync(target).isDirectory() ? parseProject(target).ir : parseFile(target).ir;
      if (mode === 'react') {
        const result = await scoreReactUi(ir, rubric);
        rows.push({ index: i + 1, result, react: result });
      } else if (mode === 'both') {
        let vanilla: UiScore | undefined;
        let vanillaError: string | undefined;
        let react: UiScore | undefined;
        let reactError: string | undefined;
        try {
          vanilla = await scoreVanillaUi(ir, rubric);
        } catch (err) {
          vanillaError = err instanceof Error ? err.name : 'Error';
        }
        try {
          react = await scoreReactUi(ir, rubric);
        } catch (err) {
          reactError = err instanceof Error ? err.name : 'Error';
        }
        rows.push({
          index: i + 1,
          result: react ?? vanilla,
          error: reactError && vanillaError ? `${vanillaError}; ${reactError}` : undefined,
          vanilla,
          vanillaError,
          react,
          reactError,
        });
      } else {
        const result = await scoreVanillaUi(ir, rubric);
        rows.push({ index: i + 1, result, vanilla: result });
      }
    } catch (err) {
      rows.push({ index: i + 1, error: err instanceof Error ? err.name : 'Error' });
    }
  }
  return rows;
}

export async function scoreGallery(dir: string, rubric?: Rubric, opts?: ScoreGalleryOptions): Promise<GalleryRow[]>;
export async function scoreGallery(dir: string, opts?: ScoreGalleryOptions): Promise<GalleryRow[]>;
export async function scoreGallery(dir: string, rubricOrOpts: Rubric | ScoreGalleryOptions = loadRubric(), opts?: ScoreGalleryOptions): Promise<GalleryRow[]> {
  let rubric: Rubric;
  let options: ScoreGalleryOptions;
  if (rubricOrOpts && 'criteria' in rubricOrOpts) {
    rubric = rubricOrOpts;
    options = opts ?? {};
  } else {
    options = (rubricOrOpts as ScoreGalleryOptions) ?? {};
    rubric = options.rubric ?? loadRubric();
  }
  return scoreGalleryTargets(galleryTargets(dir), rubric, options);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : Math.round(((v[mid - 1]! + v[mid]!) / 2) * 100) / 100;
}

function mean(values: number[]): number {
  return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : 0;
}

/** The generated block of docs/ui-scores.md: summary, per-criterion, failing kinds, per-app table. */
export function galleryMarkdown(rows: GalleryRow[], rubric: Rubric): string {
  const scored = rows.filter((r) => r.result).map((r) => r.result!);
  const lines: string[] = [];
  const passBoth = scored.filter((r) => r.pass).length;
  const at = (vp: Viewport) => scored.map((r) => r[vp].score);
  lines.push('| | desktop | phone |', '|---|---:|---:|');
  lines.push(`| apps scored | ${scored.length} | ${scored.length} |`);
  lines.push(`| at or above ${rubric.passBar}/10 | ${at('desktop').filter((s) => s >= rubric.passBar).length} | ${at('phone').filter((s) => s >= rubric.passBar).length} |`);
  lines.push(`| mean | ${mean(at('desktop'))} | ${mean(at('phone'))} |`);
  lines.push(`| median | ${median(at('desktop'))} | ${median(at('phone'))} |`);
  lines.push(`| lowest | ${scored.length ? Math.min(...at('desktop')) : '-'} | ${scored.length ? Math.min(...at('phone')) : '-'} |`);
  lines.push('', `**${passBoth} of ${rows.length} apps pass both viewports** (the bar is ${rubric.passBar}/10 on each).${rows.some((r) => r.error && !r.result) ? ` ${rows.filter((r) => r.error && !r.result).length} app(s) could not be scored.` : ''}`);

  const hasReact = rows.some((r) => r.react !== undefined);
  if (hasReact) {
    const reactScored = rows.filter((r) => r.react).map((r) => r.react!);
    const reactPassBoth = reactScored.filter((r) => r.desktop.score >= rubric.passBar && r.phone.score >= rubric.passBar).length;
    lines.push(`**React: ${reactPassBoth} of ${rows.length} apps >= ${rubric.passBar} desktop and phone** (the bar is ${rubric.passBar}/10 on each).${rows.some((r) => r.reactError) ? ` ${rows.filter((r) => r.reactError).length} React app(s) could not be scored.` : ''}`);
  }
  lines.push('');

  lines.push('### Points by criterion (mean over the corpus)', '', '| criterion | desktop | phone | apps losing points (desktop / phone) |', '|---|---:|---:|---:|');
  for (const c of rubric.criteria) {
    const pts = (vp: Viewport) => scored.map((r) => r[vp].criteria.find((x) => x.id === c.id)!);
    const losing = (vp: Viewport) => pts(vp).filter((x) => x.passed < x.total).length;
    lines.push(
      `| ${c.title} | ${mean(pts('desktop').map((x) => x.points))} / ${fmt(c.weights.desktop)} | ${mean(pts('phone').map((x) => x.points))} / ${fmt(c.weights.phone)} | ${losing('desktop')} / ${losing('phone')} |`,
    );
  }

  const kinds = new Map<string, { checks: number; apps: Set<number> }>();
  rows.forEach((row) => {
    for (const check of row.result?.checks ?? []) {
      if (check.pass) continue;
      const kind = checkKind(check);
      const entry = kinds.get(kind) ?? { checks: 0, apps: new Set<number>() };
      entry.checks++;
      entry.apps.add(row.index);
      kinds.set(kind, entry);
    }
  });
  const ranked = [...kinds].sort((a, b) => b[1].apps.size - a[1].apps.size || b[1].checks - a[1].checks || (a[0] < b[0] ? -1 : 1));
  lines.push('', '### Failing checks by kind', '', '| check | failing checks | apps |', '|---|---:|---:|');
  for (const [kind, v] of ranked) lines.push(`| ${CHECK_KINDS[kind] ?? kind} | ${v.checks} | ${v.apps.size} |`);

  lines.push('', '### Per app', '', 'Apps are numbered in sorted corpus order. "Short" lists the criteria below full marks as points/weight.', '');
  if (hasReact) {
    lines.push('| # | desktop | phone | react | result | short on desktop | short on phone |', '|---:|---:|---:|---:|---|---|---|');
  } else {
    lines.push('| # | desktop | phone | result | short on desktop | short on phone |', '|---:|---:|---:|---|---|---|');
  }
  for (const row of rows) {
    const v = row.vanilla ?? row.result;
    if (!v && !row.react) {
      lines.push(`| ${row.index} | - | - |${hasReact ? ' - |' : ''} not scored (${row.error ?? 'Error'}) | | |`);
      continue;
    }
    const r = row.result ?? row.react ?? v!;
    const dScore = v ? fmt(v.desktop.score) : '-';
    const pScore = v ? fmt(v.phone.score) : '-';
    const reactScore = row.react ? `${fmt(row.react.desktop.score)} / ${fmt(row.react.phone.score)}` : row.reactError ? `error (${row.reactError})` : '-';
    const pass = row.react ? row.react.pass : (v?.pass ?? false);
    const short = (vp: Viewport) =>
      r[vp].criteria
        .filter((c) => c.passed < c.total)
        .map((c) => `${c.id} ${fmt(c.points)}/${fmt(c.weight)}`)
        .join(', ');
    if (hasReact) {
      lines.push(`| ${row.index} | ${dScore} | ${pScore} | ${reactScore} | ${pass ? 'pass' : 'FAIL'} | ${short('desktop')} | ${short('phone')} |`);
    } else {
      lines.push(`| ${row.index} | ${dScore} | ${pScore} | ${pass ? 'pass' : 'FAIL'} | ${short('desktop')} | ${short('phone')} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export const DOC_BEGIN = '<!-- ui-scores:begin';
export const DOC_END = '<!-- ui-scores:end -->';

export function tableDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The whole docs/ui-scores.md: fixed prose, the rubric, then the generated block with its digest. */
export function galleryDoc(body: string, rubric: Rubric): string {
  const criteria = rubric.criteria
    .map((c) => `| ${c.title} | ${fmt(c.weights.desktop)} | ${fmt(c.weights.phone)} | ${c.checks.join('; ')} |`)
    .join('\n');
  return `# UI scores

An independent score of each generated app's UI against its Creator source, on a
desktop (${rubric.viewports.desktop.width}x${rubric.viewports.desktop.height}) and a phone (${rubric.viewports.phone.width}x${rubric.viewports.phone.height}) viewport, out of 10 each.
The bar is **${rubric.passBar}/10 on both**; a gate uses the lower of the two.

The scorer (\`packages/ui-score/src/score.ts\`) reads the Creator app through the
parser only, never the UI generator. It boots the generated bundle's own runtime
in jsdom against a fake data API (rows, empty, failing), visits every form, report
and page route, and checks the rendered DOM. Viewport behaviour comes from the
bundle's stylesheet media rules evaluated at each width. Offline, deterministic, no
browser. A criterion's points are its weight times the share of its checks that
pass; the total is rounded down to one decimal.

\`\`\`
c2c score-ui <file|dir> [--ui <c2c ui --out dir>] [--json] [--write score.json]
C2C_FIXTURES_DIR=<fixtures-dir> npm run score-ui:gallery -- --out docs/ui-scores.md
\`\`\`

## Rubric (\`packages/ui-score/rubric.json\`, v${rubric.version})

| criterion | desktop | phone | checks |
|---|---:|---:|---|
${criteria}

## Local corpus

${DOC_BEGIN} table=${tableDigest(body)} -->
${body}${DOC_END}
`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const uiFlag = flag('--ui');
  if (uiFlag && !['vanilla', 'react', 'both'].includes(uiFlag)) {
    process.stderr.write(`score-ui:gallery --ui must be vanilla, react, or both (got ${uiFlag})\n`);
    process.exitCode = 2;
    return;
  }
  const ui: UiMode = (uiFlag as UiMode) ?? 'vanilla';
  const out = flag('--out');
  const once = flag('--once');
  let targets: string[];
  if (once) {
    targets = [once];
  } else {
    const positional = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1]?.startsWith('--')));
    if (positional) {
      targets = [positional];
    } else {
      const dir = process.env.C2C_GALLERY_DIR || (process.env.C2C_FIXTURES_DIR ? join(process.env.C2C_FIXTURES_DIR, 'gallery') : '');
      if (!dir) {
        process.stderr.write('score-ui:gallery requires C2C_GALLERY_DIR or C2C_FIXTURES_DIR (or --once <path>)\n');
        process.exitCode = 2;
        return;
      }
      targets = galleryTargets(dir);
    }
  }
  const rubric = loadRubric();
  const rows = await scoreGalleryTargets(targets, rubric, { ui });
  const body = galleryMarkdown(rows, rubric);
  if (out) {
    writeFileSync(out, galleryDoc(body, rubric));
  }
  const passBoth = rows.filter((r) => r.result?.pass).length;
  if (ui === 'both') {
    const vanillaPass = rows.filter((r) => r.vanilla?.pass).length;
    const reactPass = rows.filter((r) => r.react?.pass).length;
    process.stdout.write(
      `score-ui:gallery apps=${rows.length} ui=both pass-both=${passBoth} vanilla-pass=${vanillaPass} react-pass=${reactPass} ${VIEWPORTS.map((vp) => `react-${vp}>=${rubric.passBar}:${rows.filter((r) => (r.react?.[vp].score ?? 0) >= rubric.passBar).length}`).join(' ')}\n`,
    );
  } else {
    process.stdout.write(
      `score-ui:gallery apps=${rows.length} ui=${ui} pass-both=${passBoth} ${VIEWPORTS.map((vp) => `${vp}>=${rubric.passBar}:${rows.filter((r) => (r.result?.[vp].score ?? 0) >= rubric.passBar).length}`).join(' ')}\n`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    process.stderr.write(`score-ui:gallery: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
