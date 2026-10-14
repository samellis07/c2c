/**
 * Quality gate layers Q2 (compiles) and Q4 (smoke). See docs/quality-gate.md.
 */
import { rmSync } from 'node:fs';
import type { App } from '../../core/src/index.js';
import { generatedTree } from './modules.js';
import { checkPrefetchReads, type PrefetchReadsReport } from './prefetch-reads.js';
import { checkCompiles, materialize, type CompilesReport, type StaticFinding } from './static.js';
import { smokeApp, type SmokeCleanReport, type SmokeFinding } from './smoke.js';

export { freeIdentifiers, ES_GLOBALS, NODE_GLOBALS, BROWSER_GLOBALS, type FreeIdentifier } from './scope.js';
export { generatedModules, generatedTree, moduleKind, type GeneratedModule, type GeneratedTree, type ModuleKind } from './modules.js';
export { checkCompiles, materialize, typecheck, withCtxTypes, type CompilesReport, type StaticFinding } from './static.js';
export { smokeApp, classify, handlerNames, normalizeMessage, DEFAULT_ITERATIONS, DEFAULT_SEED, type SmokeCleanReport, type SmokeFinding } from './smoke.js';
export { rng, hashSeed, recordFor, fieldValue, family, VARIANTS, ROW_COUNTS } from './inputs.js';
export { checkPrefetchReads, isPrefetchModule, PREFETCH_NON_READ, type PrefetchNonRead, type PrefetchReadsReport } from './prefetch-reads.js';

export interface QualityResult {
  compiles: CompilesReport;
  smokeClean: SmokeCleanReport;
  prefetchReads: PrefetchReadsReport;
  details: { compiles: StaticFinding[]; smoke: SmokeFinding[] };
}

/** Q2 and Q4 for one app over one materialized tree. Offline; writes only a temp dir it removes. */
export async function qualityGate(app: App, opts: { iterations?: number; seed?: string } = {}): Promise<QualityResult> {
  const tree = generatedTree(app);
  const dir = materialize(tree);
  try {
    const q2 = await checkCompiles(tree, { dir });
    const q4 = await smokeApp(app, tree, { ...opts, dir });
    return { compiles: q2.report, smokeClean: q4.report, prefetchReads: checkPrefetchReads(tree), details: { compiles: q2.details, smoke: q4.details } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
