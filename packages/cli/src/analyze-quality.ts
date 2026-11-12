/**
 * `c2c analyze --quality`: per-app quality gate fields next to the readiness report.
 *
 *   compiles    Q2: node --check, free identifiers, checkJs over the shim surface.
 *   smokeClean  Q4: every generated handler on seeded inputs, no uncaught JS error.
 *
 * Offline. Generates the deploy tree in a temp dir, runs it on the dry-run
 * shim, removes the dir. Counts only. See docs/quality-gate.md.
 */
import type { App } from '../../core/src/index.js';
import { qualityGate } from '../../quality/src/index.js';
import type { CompilesReport } from '../../quality/src/static.js';
import type { SmokeCleanReport } from '../../quality/src/smoke.js';
import { analyzeAsText, type AnalyzeReport } from './analyze.js';

export type QualityAnalyzeReport = AnalyzeReport & { compiles: CompilesReport; smokeClean: SmokeCleanReport };

export async function analyzeQuality(app: App, report: AnalyzeReport): Promise<QualityAnalyzeReport> {
  const q = await qualityGate(app);
  return { ...report, compiles: q.compiles, smokeClean: q.smokeClean };
}

export function qualityAsText(r: QualityAnalyzeReport): string {
  const c = r.compiles;
  const s = r.smokeClean;
  return [
    analyzeAsText(r),
    `compiles: ${c.ok}  modules ${c.modules}  node-check failures ${c.nodeCheckFailures}  free identifiers ${c.freeIdentifiers} (${c.modulesWithFreeIdentifiers} modules)  type errors ${c.typeErrors}`,
    `smokeClean: ${s.ok}  handlers ${s.handlers}  calls ${s.calls}  crashing ${s.handlersWithCrash} ${JSON.stringify(s.crashByClass)}  deluge ${JSON.stringify(s.delugeByClass)}  unmapped ${JSON.stringify(s.unmappedByClass)}`,
  ].join('\n');
}

