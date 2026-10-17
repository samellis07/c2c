#!/usr/bin/env node
// Offline onboarding-readiness check: the per-app migration report and the
// customer guide, PASS / FAIL / GAP per criterion. Run `npm run build` first.
// usage: node packages/cli/scripts/onboarding-readiness.mjs --out <dir> [fixture-id ...]
// Writes <dir>/onboarding-readiness.json and .md; exit 1 when any criterion FAILs.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FIXTURES,
  onboardingReadiness,
  onboardingReadinessAsJson,
  onboardingReadinessAsMarkdown,
} from '../../../dist/cli/src/onboarding-readiness.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = at >= 0 ? args[at + 1] : undefined;
if (!out) {
  process.stderr.write('usage: onboarding-readiness.mjs --out <dir> [fixture-id ...]\n');
  process.exit(2);
}
const ids = args.filter((_, i) => i !== at && i !== at + 1);
const result = await onboardingReadiness(repo, ids.length ? ids : DEFAULT_FIXTURES);
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'onboarding-readiness.json'), onboardingReadinessAsJson(result));
writeFileSync(path.join(out, 'onboarding-readiness.md'), onboardingReadinessAsMarkdown(result));
process.stdout.write(`PASS ${result.counts.PASS}  FAIL ${result.counts.FAIL}  GAP ${result.counts.GAP}  -> ${out}\n`);
process.exit(result.counts.FAIL > 0 ? 1 : 0);
