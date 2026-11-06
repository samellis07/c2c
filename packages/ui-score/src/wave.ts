#!/usr/bin/env node
/**
 * Independent UI scorer per wave: scores each app in a wave run against its
 * Creator source and reference captures (from ui-reference, v3 and v5-all)
 * using the side-by-side rubric (packages/ui-score/rubric.json).
 *
 * Enforces the 8/10 bar on both desktop (1440x900) and phone (390x844).
 * A wave passes iff every app meets or exceeds 8/10 on both viewports.
 *
 * When run against a wave directory with evidence/ folders, writes score.json
 * and ui-score.txt into each app's evidence directory, matching the wave runner's
 * evidence contract.
 *
 *   node dist/ui-score/src/wave.js <wave-dir | app-path...> [--reference <dir>] [--ui vanilla|react|both] [--out <file>] [--write] [--json]
 *   c2c score-ui --wave <wave-dir> [--reference <dir>] [--write] [--out <file>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryKind, openKind, parseFileOrProject, type App } from '../../core/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import {
  CHECK_KINDS,
  VIEWPORTS,
  bundleFromDir,
  bundleFromFiles,
  checkKind,
  loadRubric,
  scoreFileOf,
  scoreUi,
  uiScoreAsText,
  type Rubric,
  type UiBundle,
  type Check,
  type UiScore,
  type Viewport,
} from './score.js';
export { loadRubric } from './score.js';
import { scoreReactUi, scoreVanillaUi, type UiMode } from './gallery.js';

export interface ReferenceCapture {
  viewport: 'desktop' | 'phone';
  kind: 'nav' | 'form' | 'report' | 'page' | 'detail';
  name: string;
  menuLabel: string;
  file: string;
}

export interface AppReferenceCaptures {
  app: string;
  dir: string;
  captures: ReferenceCapture[];
  byViewport: {
    desktop: ReferenceCapture[];
    phone: ReferenceCapture[];
  };
  byKind: Record<string, ReferenceCapture[]>;
}

export interface ReferenceMatchDetail {
  capture: ReferenceCapture;
  matched: boolean;
  reason?: string;
}

export interface ReferenceCoverageReport {
  app: string;
  referenceDir: string;
  totalCaptures: number;
  matchedCaptures: number;
  coverageRatio: number;
  desktopCaptures: number;
  desktopMatched: number;
  phoneCaptures: number;
  phoneMatched: number;
  details: ReferenceMatchDetail[];
}

export interface WaveAppScoreResult {
  slug: string;
  name: string;
  source?: string;
  desktop: {
    score: number;
    pass: boolean;
    criteria: { id: string; title: string; points: number; weight: number; passed: number; total: number }[];
  };
  phone: {
    score: number;
    pass: boolean;
    criteria: { id: string; title: string; points: number; weight: number; passed: number; total: number }[];
  };
  score: number;
  pass: boolean;
  passBar: number;
  scale: number;
  uiMode: 'vanilla' | 'react';
  reference?: ReferenceCoverageReport;
  error?: string;
  uiScore?: UiScore;
}

export interface WaveScoreReport {
  schema: 'c2c-wave-score/1';
  wave?: string;
  totalApps: number;
  scoredApps: number;
  passedApps: number;
  failedApps: number;
  passBar: number;
  pass: boolean;
  desktopMean: number;
  phoneMean: number;
  desktopMedian: number;
  phoneMedian: number;
  lowestScore: number;
  apps: WaveAppScoreResult[];
  referenceSummary?: {
    totalAppsWithReferences: number;
    totalCaptures: number;
    totalMatched: number;
    overallCoverage: number;
  };
}

export interface WaveAppTarget {
  slug: string;
  name?: string;
  source?: string;
  bundleDir?: string;
  evidenceDir?: string;
  ui?: 'vanilla' | 'react';
}

export interface ScoreWaveOptions {
  referenceDir?: string;
  rubric?: Rubric;
  ui?: UiMode;
  passBar?: number;
  write?: boolean;
  out?: string;
  only?: string[];
  waveName?: string;
}

/**
 * Parses index.md in a reference capture directory (ui-reference/v3/<app>/index.md).
 * Format:
 * | viewport | kind | name | menu label | file |
 * | desktop | nav | menu | (app menu) | desktop/nav-menu.png |
 * | mobile | nav | home | (phone home + tab bar) | mobile/nav-home.png |
 * | desktop | form | Add_Product | Add Product | desktop/form-Add_Product.png |
 */
export function parseReferenceIndex(indexMdPath: string): ReferenceCapture[] {
  if (!existsSync(indexMdPath)) return [];
  const content = readFileSync(indexMdPath, 'utf8');
  const lines = content.split('\n');
  const captures: ReferenceCapture[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    const parts = trimmed.slice(1, -1).split('|').map((s) => s.trim());
    if (parts.length < 5) continue;
    const [vpStr, kindStr, nameStr, menuLabelStr, fileStr] = parts;
    if (!vpStr || vpStr === 'viewport' || vpStr.includes('---')) continue;

    const lowerVp = vpStr.toLowerCase();
    const vp: 'desktop' | 'phone' = lowerVp === 'mobile' || lowerVp === 'phone' ? 'phone' : 'desktop';
    const lowerKind = (kindStr ?? '').toLowerCase() as ReferenceCapture['kind'];
    if (!['nav', 'form', 'report', 'page', 'detail'].includes(lowerKind)) continue;

    captures.push({
      viewport: vp,
      kind: lowerKind,
      name: nameStr ?? '',
      menuLabel: menuLabelStr ?? '',
      file: fileStr ?? '-',
    });
  }
  return captures;
}

/**
 * Discovers reference captures for an app in ui-reference directories:
 * - <referenceDir>/<app>
 * - <referenceDir>/v3/<app>
 * - <referenceDir>/v5-all/<app>
 * - or local default fixture paths.
 */
export function findReferenceDir(appNameOrSlug: string, referenceBaseDir?: string): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[-_ ]/g, '');
  const targetNorm = norm(appNameOrSlug);

  const checkCandidate = (dir: string): string | undefined => {
    if (!existsSync(dir)) return undefined;
    if (existsSync(join(dir, 'index.md'))) return dir;
    // Check subdirectories for a matching slug
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && norm(ent.name) === targetNorm) {
          const sub = join(dir, ent.name);
          if (existsSync(join(sub, 'index.md'))) return sub;
        }
      }
    } catch {
      // not accessible
    }
    return undefined;
  };

  const bases: string[] = [];
  if (referenceBaseDir) {
    bases.push(
      join(referenceBaseDir, appNameOrSlug),
      join(referenceBaseDir, 'v3', appNameOrSlug),
      join(referenceBaseDir, 'v5-all', appNameOrSlug),
      join(referenceBaseDir, 'final', appNameOrSlug),
      referenceBaseDir,
      join(referenceBaseDir, 'v3'),
      join(referenceBaseDir, 'v5-all'),
    );
  }

  const envDir = process.env.C2C_UI_REFERENCE_DIR;
  if (envDir) {
    bases.push(
      join(envDir, appNameOrSlug),
      join(envDir, 'v3', appNameOrSlug),
      join(envDir, 'v5-all', appNameOrSlug),
      join(envDir, 'final', appNameOrSlug),
      envDir,
      join(envDir, 'v3'),
      join(envDir, 'v5-all'),
    );
  }

  const standardLocal = [
    process.env.C2C_FIXTURES_DIR ? join(process.env.C2C_FIXTURES_DIR, 'ui-reference') : '',
    'c2c-fixtures-local/ui-reference',
    '../c2c-fixtures-local/ui-reference',
    '../../c2c-fixtures-local/ui-reference',
  ].filter(Boolean);

  for (const root of standardLocal) {
    bases.push(
      join(root, 'v3', appNameOrSlug),
      join(root, 'v5-all', appNameOrSlug),
      join(root, 'final', appNameOrSlug),
      join(root, appNameOrSlug),
      join(root, 'v3'),
      join(root, 'v5-all'),
    );
  }

  for (const b of bases) {
    const match = checkCandidate(b);
    if (match) return match;
  }
  return undefined;
}

export function loadAppReferenceCaptures(appNameOrSlug: string, referenceBaseDir?: string): AppReferenceCaptures | undefined {
  const dir = findReferenceDir(appNameOrSlug, referenceBaseDir);
  if (!dir) return undefined;
  const indexMd = join(dir, 'index.md');
  const captures = parseReferenceIndex(indexMd);
  const byViewport = {
    desktop: captures.filter((c) => c.viewport === 'desktop'),
    phone: captures.filter((c) => c.viewport === 'phone'),
  };
  const byKind: Record<string, ReferenceCapture[]> = {};
  for (const c of captures) {
    (byKind[c.kind] ??= []).push(c);
  }
  return {
    app: appNameOrSlug,
    dir,
    captures,
    byViewport,
    byKind,
  };
}

/**
 * Verifies that the rendered DOM and IR match each reference capture from the Creator captures index.
 */
export function verifyReferenceCaptures(ir: App, uiScore: UiScore, ref: AppReferenceCaptures): ReferenceCoverageReport {
  const details: ReferenceMatchDetail[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/[-_ ]/g, '');

  for (const cap of ref.captures) {
    // Skip empty / non-captured records
    if (cap.file === '-' && cap.kind === 'detail') {
      continue;
    }

    if (cap.kind === 'nav') {
      if (cap.viewport === 'desktop') {
        const navChecks = uiScore.checks.filter((c) => c.criterion === 'navigation' && c.viewport === 'desktop');
        const pass = navChecks.length > 0 && navChecks.every((c) => c.pass);
        details.push({
          capture: cap,
          matched: pass,
          reason: pass ? undefined : 'desktop navigation menu or link check failed',
        });
      } else {
        const phoneNavChecks = uiScore.checks.filter(
          (c) => (c.criterion === 'navigation' || c.id === 'phone-tabbar') && c.viewport === 'phone',
        );
        const pass = phoneNavChecks.length > 0 && phoneNavChecks.every((c) => c.pass);
        details.push({
          capture: cap,
          matched: pass,
          reason: pass ? undefined : 'phone navigation or tab bar check failed',
        });
      }
      continue;
    }

    if (cap.kind === 'form') {
      const formNorm = norm(cap.name);
      const labelNorm = norm(cap.menuLabel);
      const matchedForm = ir.forms.find((f) => norm(f.name) === formNorm || norm(f.displayName ?? '') === labelNorm || norm(f.displayName ?? '') === formNorm);
      if (!matchedForm) {
        details.push({ capture: cap, matched: false, reason: `form ${cap.name} not found in Creator IR` });
        continue;
      }
      const formCheck = uiScore.checks.find((c) => c.id === `form:${matchedForm.name}` && c.viewport === cap.viewport);
      const pass = formCheck?.pass ?? false;
      details.push({
        capture: cap,
        matched: pass,
        reason: pass ? undefined : formCheck?.evidence ?? `form ${matchedForm.name} failed heading or route check`,
      });
      continue;
    }

    if (cap.kind === 'report') {
      const repNorm = norm(cap.name);
      const labelNorm = norm(cap.menuLabel);
      const matchedReport = ir.reports.find((r) => norm(r.name) === repNorm || norm(r.displayName ?? '') === labelNorm || norm(r.displayName ?? '') === repNorm);
      if (!matchedReport) {
        details.push({ capture: cap, matched: false, reason: `report ${cap.name} not found in Creator IR` });
        continue;
      }
      const repCheck = uiScore.checks.find((c) => c.id === `report:${matchedReport.name}` && c.viewport === cap.viewport);
      const pass = repCheck?.pass ?? false;
      details.push({
        capture: cap,
        matched: pass,
        reason: pass ? undefined : repCheck?.evidence ?? `report ${matchedReport.name} failed heading or route check`,
      });
      continue;
    }

    if (cap.kind === 'page') {
      const pageNorm = norm(cap.name);
      const labelNorm = norm(cap.menuLabel);
      const matchedPage = ir.pages.find((p) => norm(p.name) === pageNorm || norm(p.displayName ?? '') === labelNorm || norm(p.displayName ?? '') === pageNorm);
      if (!matchedPage) {
        details.push({ capture: cap, matched: false, reason: `page ${cap.name} not found in Creator IR` });
        continue;
      }
      const pageCheck = uiScore.checks.find((c) => c.id === `page:${matchedPage.name}` && c.viewport === cap.viewport);
      const pass = pageCheck?.pass ?? false;
      details.push({
        capture: cap,
        matched: pass,
        reason: pass ? undefined : pageCheck?.evidence ?? `page ${matchedPage.name} route check failed`,
      });
      continue;
    }

    // Default match
    details.push({ capture: cap, matched: true });
  }

  const total = details.length;
  const matched = details.filter((d) => d.matched).length;
  const desktopDetails = details.filter((d) => d.capture.viewport === 'desktop');
  const phoneDetails = details.filter((d) => d.capture.viewport === 'phone');

  return {
    app: ref.app,
    referenceDir: ref.dir,
    totalCaptures: total,
    matchedCaptures: matched,
    coverageRatio: total > 0 ? Math.round((matched / total) * 100) / 100 : 1,
    desktopCaptures: desktopDetails.length,
    desktopMatched: desktopDetails.filter((d) => d.matched).length,
    phoneCaptures: phoneDetails.length,
    phoneMatched: phoneDetails.filter((d) => d.matched).length,
    details,
  };
}

/**
 * Discovers wave app targets from a wave run directory (e.g. wave-runs/wave1/wave1r, or apps/ + evidence/).
 */
export function discoverWaveApps(waveDir: string): WaveAppTarget[] {
  const targets: WaveAppTarget[] = [];
  const resolved = resolve(waveDir);

  // Check if waveDir contains an apps directory or evidence directory
  const appsDir = join(resolved, 'apps');
  const evidenceDir = join(resolved, 'evidence');

  const slugs = new Set<string>();

  if (existsSync(evidenceDir)) {
    try {
      const ents = readdirSync(evidenceDir, { withFileTypes: true });
      for (const ent of ents) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) slugs.add(ent.name);
      }
    } catch {}
  }

  if (existsSync(appsDir)) {
    try {
      const ents = readdirSync(appsDir, { withFileTypes: true });
      for (const ent of ents) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) slugs.add(ent.name);
      }
    } catch {}
  }

  // Also check if waveDir has a manifest (e.g. waves-manifest.json or manifest.json)
  for (const mName of ['waves-manifest.json', 'manifest.json', 'wave.json']) {
    const mPath = join(resolved, mName);
    if (existsSync(mPath)) {
      try {
        const manifest = JSON.parse(readFileSync(mPath, 'utf8')) as { apps?: Array<{ slug?: string; name?: string; source?: string; ui?: 'vanilla' | 'react' }> };
        if (Array.isArray(manifest.apps)) {
          for (const a of manifest.apps) {
            if (a.slug) slugs.add(a.slug);
          }
        }
      } catch {}
    }
  }

  // If waveDir itself is an app directory or file
  if (slugs.size === 0) {
    const kind = openKind(resolved);
    if (kind === 'file' && resolved.endsWith('.ds')) {
      return [{ slug: basename(resolved, '.ds'), source: resolved }];
    }
    if (kind === 'directory') {
      const dsFiles = readdirSync(resolved).filter((f) => f.endsWith('.ds'));
      if (dsFiles.length > 0) {
        return [{ slug: basename(resolved), source: join(resolved, dsFiles[0]!) }];
      }
    }
  }

  for (const slug of [...slugs].sort()) {
    let source: string | undefined;
    const appDir = join(appsDir, slug);
    if (existsSync(appDir)) {
      const ds = readdirSync(appDir).find((f) => f.endsWith('.ds'));
      if (ds) source = join(appDir, ds);
      else source = appDir;
    }
    const appEvDir = join(evidenceDir, slug);
    targets.push({
      slug,
      source,
      evidenceDir: existsSync(appEvDir) ? appEvDir : undefined,
    });
  }

  return targets;
}

/**
 * Finds the Creator .ds file for an app slug across known gallery, synthetic and fixture locations.
 */
export function findAppSource(slug: string, hintSource?: string): string | undefined {
  if (hintSource && existsSync(hintSource)) return hintSource;

  const norm = (s: string) => s.toLowerCase().replace(/[-_ ]/g, '');
  const targetNorm = norm(slug);

  const searchRoots = [
    process.env.C2C_GALLERY_DIR || '',
    process.env.C2C_FIXTURES_DIR ? join(process.env.C2C_FIXTURES_DIR, 'gallery') : '',
    process.env.C2C_FIXTURES_DIR ? join(process.env.C2C_FIXTURES_DIR, 'synthetic') : '',
    'c2c-fixtures-local/gallery',
    'c2c-fixtures-local/synthetic',
    '../c2c-fixtures-local/gallery',
    '../c2c-fixtures-local/synthetic',
    '../../c2c-fixtures-local/gallery',
    '../../c2c-fixtures-local/synthetic',
    'fixtures/redistributable',
    'tests/golden',
  ].filter(Boolean);

  for (const root of searchRoots) {
    if (!existsSync(root)) continue;
    try {
      const entries = readdirSync(root, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) {
          if (norm(ent.name) === targetNorm) {
            const dir = join(root, ent.name);
            const ds = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.ds'));
            if (ds) return join(dir, ds);
            return dir;
          }
          // also search 1-level deep (for synthetic folders like s01-purchase-orders/L1)
          const subDir = join(root, ent.name);
          const subEntries = readdirSync(subDir, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isDirectory() && norm(sub.name) === targetNorm) {
              const fullSub = join(subDir, sub.name);
              const ds = readdirSync(fullSub).find((f) => f.toLowerCase().endsWith('.ds'));
              if (ds) return join(fullSub, ds);
              return fullSub;
            }
          }
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.ds')) {
          if (norm(basename(ent.name, '.ds')) === targetNorm) {
            return join(root, ent.name);
          }
        }
      }
    } catch {}
  }
  return undefined;
}

/**
 * Scores a single wave app against its Creator IR and reference captures.
 */
export async function scoreWaveApp(target: WaveAppTarget, rubric: Rubric = loadRubric(), options: ScoreWaveOptions = {}): Promise<WaveAppScoreResult> {
  const slug = target.slug;
  const passBar = options.passBar ?? rubric.passBar;
  const source = target.source ?? findAppSource(slug);

  if (!source) {
    return {
      slug,
      name: target.name ?? slug,
      desktop: { score: 0, pass: false, criteria: [] },
      phone: { score: 0, pass: false, criteria: [] },
      score: 0,
      pass: false,
      passBar,
      scale: rubric.scale,
      uiMode: target.ui ?? (options.ui === 'react' ? 'react' : 'vanilla'),
      error: `Could not find source .ds or app directory for "${slug}"`,
    };
  }

  try {
    const ir = parseFileOrProject(source).ir;
    const uiMode = target.ui ?? (options.ui === 'react' ? 'react' : 'vanilla');

    let uiScore: UiScore;
    if (target.bundleDir && existsSync(target.bundleDir)) {
      const bundle = bundleFromDir(target.bundleDir);
      uiScore = await scoreUi(ir, bundle, { rubric });
    } else if (uiMode === 'react') {
      uiScore = await scoreReactUi(ir, rubric);
    } else {
      uiScore = await scoreVanillaUi(ir, rubric);
    }

    // Verify reference captures if available
    const refCaptures = loadAppReferenceCaptures(slug, options.referenceDir);
    let refReport: ReferenceCoverageReport | undefined;
    if (refCaptures) {
      refReport = verifyReferenceCaptures(ir, uiScore, refCaptures);
    }

    const dScore = uiScore.desktop.score;
    const pScore = uiScore.phone.score;
    const minScore = Math.min(dScore, pScore);

    // Pass condition: both viewports >= passBar (8/10), and if reference captures exist, reference coverage >= 80%
    const refPass = refReport ? refReport.coverageRatio >= 0.8 : true;
    const pass = dScore >= passBar && pScore >= passBar && refPass;

    const result: WaveAppScoreResult = {
      slug,
      name: ir.name || slug,
      source,
      desktop: {
        score: dScore,
        pass: dScore >= passBar,
        criteria: uiScore.desktop.criteria.map((c) => ({
          id: c.id,
          title: c.title,
          points: c.points,
          weight: c.weight,
          passed: c.passed,
          total: c.total,
        })),
      },
      phone: {
        score: pScore,
        pass: pScore >= passBar,
        criteria: uiScore.phone.criteria.map((c) => ({
          id: c.id,
          title: c.title,
          points: c.points,
          weight: c.weight,
          passed: c.passed,
          total: c.total,
        })),
      },
      score: minScore,
      pass,
      passBar,
      scale: rubric.scale,
      uiMode,
      reference: refReport,
      uiScore,
    };

    // If writing evidence: write score.json and ui-score.txt into evidence directory
    if (options.write && target.evidenceDir) {
      mkdirSync(target.evidenceDir, { recursive: true });
      const scoreJsonPath = join(target.evidenceDir, 'score.json');
      const scoreObj = {
        score: result.score,
        desktop: result.desktop.score,
        phone: result.phone.score,
        pass: result.pass,
        scale: result.scale,
        passBar: result.passBar,
        ui: result.uiMode,
        app: slug,
        ...(result.reference
          ? {
              reference: {
                app: result.reference.app,
                totalCaptures: result.reference.totalCaptures,
                matchedCaptures: result.reference.matchedCaptures,
                coverage: result.reference.coverageRatio,
              },
            }
          : {}),
      };
      writeFileSync(scoreJsonPath, `${JSON.stringify(scoreObj, null, 2)}\n`);

      const scoreTxtPath = join(target.evidenceDir, 'ui-score.txt');
      const textOutput = [
        `App: ${result.name} (${slug})`,
        `Score: ${result.score}/${rubric.scale} (desktop: ${result.desktop.score}/${rubric.scale}, phone: ${result.phone.score}/${rubric.scale})`,
        `Bar: ${passBar}/${rubric.scale} on desktop and phone -> ${result.pass ? 'PASS' : 'FAIL'}`,
        result.reference
          ? `Reference captures: ${result.reference.matchedCaptures}/${result.reference.totalCaptures} matched (${Math.round(result.reference.coverageRatio * 100)}%)`
          : 'Reference captures: none on file',
        '',
        uiScoreAsText(uiScore),
      ].join('\n');
      writeFileSync(scoreTxtPath, `${textOutput}\n`);
    }

    return result;
  } catch (err) {
    return {
      slug,
      name: target.name ?? slug,
      source,
      desktop: { score: 0, pass: false, criteria: [] },
      phone: { score: 0, pass: false, criteria: [] },
      score: 0,
      pass: false,
      passBar,
      scale: rubric.scale,
      uiMode: target.ui ?? 'vanilla',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function mean(values: number[]): number {
  return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : 0;
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : Math.round(((v[mid - 1]! + v[mid]!) / 2) * 100) / 100;
}

/**
 * Formats wave score report as Markdown.
 */
export function waveReportMarkdown(report: WaveScoreReport, rubric: Rubric): string {
  const lines: string[] = [];
  lines.push(`# Wave UI Scores${report.wave ? ` — ${report.wave}` : ''}`);
  lines.push('');
  lines.push(`Independent UI scoring per wave using reference captures and the Creator rubric (v${rubric.version}).`);
  lines.push(`The bar is **${rubric.passBar}/10 on both desktop and phone**.`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| | desktop | phone | overall |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| apps scored | ${report.scoredApps} | ${report.scoredApps} | ${report.totalApps} |`);
  lines.push(`| at or above ${rubric.passBar}/10 | ${report.apps.filter((a) => a.desktop.score >= rubric.passBar).length} | ${report.apps.filter((a) => a.phone.score >= rubric.passBar).length} | ${report.passedApps} |`);
  lines.push(`| mean | ${report.desktopMean} | ${report.phoneMean} | ${mean(report.apps.map((a) => a.score))} |`);
  lines.push(`| median | ${report.desktopMedian} | ${report.phoneMedian} | ${median(report.apps.map((a) => a.score))} |`);
  lines.push(`| lowest | ${report.scoredApps ? Math.min(...report.apps.map((a) => a.desktop.score)) : '-'} | ${report.scoredApps ? Math.min(...report.apps.map((a) => a.phone.score)) : '-'} | ${report.lowestScore} |`);
  lines.push('');
  lines.push(`**${report.passedApps} of ${report.scoredApps} apps pass both viewports** (verdict: **${report.pass ? 'PASS' : 'FAIL'}**).`);
  lines.push('');

  if (report.referenceSummary && report.referenceSummary.totalAppsWithReferences > 0) {
    lines.push('### Reference captures coverage');
    lines.push('');
    lines.push(`- Apps with reference captures on file: **${report.referenceSummary.totalAppsWithReferences}**`);
    lines.push(`- Reference captures verified: **${report.referenceSummary.totalMatched} / ${report.referenceSummary.totalCaptures}** (${Math.round(report.referenceSummary.overallCoverage * 100)}%)`);
    lines.push('');
  }

  lines.push('### Per-app results');
  lines.push('');
  lines.push('| # | app | desktop | phone | score | ref coverage | result | short criteria |');
  lines.push('|---:|---|---:|---:|---:|---:|---|---|');

  report.apps.forEach((app, idx) => {
    const dStr = app.error ? '-' : app.desktop.score.toFixed(1);
    const pStr = app.error ? '-' : app.phone.score.toFixed(1);
    const sStr = app.error ? '-' : app.score.toFixed(1);
    const refStr = app.reference
      ? `${app.reference.matchedCaptures}/${app.reference.totalCaptures} (${Math.round(app.reference.coverageRatio * 100)}%)`
      : 'n/a';
    const resStr = app.error ? `error (${app.error})` : app.pass ? 'pass' : '**FAIL**';

    const short = (vp: 'desktop' | 'phone') =>
      app[vp].criteria
        .filter((c) => c.passed < c.total)
        .map((c) => `${c.id} ${c.points.toFixed(1)}/${c.weight}`)
        .join(', ');

    const dShort = short('desktop');
    const pShort = short('phone');
    const shortText = [dShort ? `d: ${dShort}` : '', pShort ? `p: ${pShort}` : ''].filter(Boolean).join('; ') || 'none';

    lines.push(`| ${idx + 1} | ${app.name} (${app.slug}) | ${dStr} | ${pStr} | ${sStr} | ${refStr} | ${resStr} | ${shortText} |`);
  });

  lines.push('');
  return lines.join('\n');
}

/**
 * Scores an entire wave of apps.
 */
export async function scoreWave(waveDirOrTargets: string | WaveAppTarget[], options: ScoreWaveOptions = {}): Promise<WaveScoreReport> {
  const rubric = options.rubric ?? loadRubric();
  const passBar = options.passBar ?? rubric.passBar;

  let targets: WaveAppTarget[];
  let waveName = options.waveName;

  if (typeof waveDirOrTargets === 'string') {
    waveName ??= basename(resolve(waveDirOrTargets));
    targets = discoverWaveApps(waveDirOrTargets);
  } else {
    targets = waveDirOrTargets;
  }

  if (options.only && options.only.length > 0) {
    const allowed = new Set(options.only);
    targets = targets.filter((t) => allowed.has(t.slug));
  }

  const appResults: WaveAppScoreResult[] = [];
  for (const target of targets) {
    const res = await scoreWaveApp(target, rubric, options);
    appResults.push(res);
  }

  const validScores = appResults.filter((a) => !a.error);
  const desktopScores = validScores.map((a) => a.desktop.score);
  const phoneScores = validScores.map((a) => a.phone.score);
  const overallScores = validScores.map((a) => a.score);

  const passedApps = appResults.filter((a) => a.pass).length;
  const failedApps = appResults.length - passedApps;

  const appsWithRef = appResults.filter((a) => a.reference);
  const totalCaptures = appsWithRef.reduce((sum, a) => sum + (a.reference?.totalCaptures ?? 0), 0);
  const matchedCaptures = appsWithRef.reduce((sum, a) => sum + (a.reference?.matchedCaptures ?? 0), 0);

  const report: WaveScoreReport = {
    schema: 'c2c-wave-score/1',
    wave: waveName,
    totalApps: appResults.length,
    scoredApps: validScores.length,
    passedApps,
    failedApps,
    passBar,
    pass: passedApps === appResults.length && appResults.length > 0,
    desktopMean: mean(desktopScores),
    phoneMean: mean(phoneScores),
    desktopMedian: median(desktopScores),
    phoneMedian: median(phoneScores),
    lowestScore: overallScores.length > 0 ? Math.min(...overallScores) : 0,
    apps: appResults,
    referenceSummary:
      appsWithRef.length > 0
        ? {
            totalAppsWithReferences: appsWithRef.length,
            totalCaptures,
            totalMatched: matchedCaptures,
            overallCoverage: totalCaptures > 0 ? Math.round((matchedCaptures / totalCaptures) * 100) / 100 : 1,
          }
        : undefined,
  };

  if (options.out) {
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    writeFileSync(options.out, waveReportMarkdown(report, rubric));
  }

  return report;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const waveDir = flag('--wave') ?? argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1]?.startsWith('--')));
  if (!waveDir) {
    process.stderr.write('Usage: node dist/ui-score/src/wave.js <wave-dir> [--reference <dir>] [--ui vanilla|react|both] [--out <file>] [--write] [--json]\n');
    process.exitCode = 2;
    return;
  }

  const referenceDir = flag('--reference');
  const ui = (flag('--ui') as UiMode | undefined) ?? 'vanilla';
  const out = flag('--out');
  const write = argv.includes('--write');
  const isJson = argv.includes('--json');
  const onlyStr = flag('--only');
  const only = onlyStr ? onlyStr.split(',').map((s) => s.trim()) : undefined;

  const rubric = loadRubric();
  const report = await scoreWave(waveDir, {
    referenceDir,
    ui,
    out,
    write,
    only,
    rubric,
  });

  if (isJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(waveReportMarkdown(report, rubric));
  }

  process.exitCode = report.pass ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    process.stderr.write(`score-ui:wave: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
