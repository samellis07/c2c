import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FEATURES, appFacts, parseFile } from '../../core/src/index.js';
import { analyze } from '../src/analyze.js';
import { FEATURE_MATRIX, MATRIX_SNAPSHOT } from '../src/feature-matrix.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtures = path.join(root, 'packages/cli/test/fixtures/mobile');
const MOBILE = 'Mobile app customization / code-sign / MDM';

function mobileCount(file: string): number {
  const app = parseFile(path.join(fixtures, file)).ir;
  const row = FEATURES.find((r) => r.feature === MOBILE);
  assert.ok(row?.count, 'matrix row has a detector');
  return row.count(appFacts(app));
}

test('standard phone and tablet layout blocks are not an Enterprise mobile marker', () => {
  assert.equal(mobileCount('standard-layout.ds'), 0);
});

test('a custom logo (logo preference other than "none") is an Enterprise mobile marker', () => {
  assert.equal(mobileCount('custom-logo.ds'), 1);
});

test('a code-signing key in a device customize block is an Enterprise mobile marker', () => {
  assert.equal(mobileCount('code-signing.ds'), 1);
});

test('an observed matrix row with status not-started is excluded, not a blocker', () => {
  const r = analyze(parseFile(path.join(fixtures, 'custom-logo.ds')).ir);
  assert.equal(r.features.counts['needs-assessment'], 0);
  assert.equal(r.features.counts.blocker, 0);
  assert.deepEqual(r.features.needsAssessment.map((f) => f.feature), []);
  assert.equal(r.features.excluded, 1);
  assert.equal(r.blockers.filter((b) => b.kind === 'feature').length, 0);
});

test('matrix snapshot carries a date and 194 rows', () => {
  assert.match(MATRIX_SNAPSHOT.snapshotDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(MATRIX_SNAPSHOT.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(FEATURE_MATRIX.length, 194);
});
