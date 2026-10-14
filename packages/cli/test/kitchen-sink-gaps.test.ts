/** Synthetic coverage for field types the primary kitchen sink excludes. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse, parseFile, print, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { buildOfflinePlan } from '../../deploy/src/offline-plan.js';
import { analyze, analyzeAsText } from '../src/analyze.js';
import { buildMigrationReport, migrationReportAsText } from '../src/migration-report.js';

const DS = join(repoRoot(), 'fixtures/synthetic/kitchen-sink-gaps/kitchen_sink_gaps.ds');
const EXPECTED = [
  'integration',
  'prediction',
  'keyword',
  'sentiment',
  'ocr',
  'object-detection',
  'barcode',
  'geolocation',
  'legacy-crm',
  'legacy-crm-link',
].sort();

function load(): App {
  return parseFile(DS).ir;
}

test('kitchen sink gaps are named and counted in analyze, plan and migration reports', () => {
  const source = readFileSync(DS, 'utf8');
  assert.equal(print(parse(source)), source);
  const app = load();
  assert.equal(app.workflows.length, 1);
  assert.equal(app.workflows[0]?.event, 'on validate');

  const analysis = analyze(app);
  assert.deepEqual(analysis.fieldGaps.map((gap) => gap.matrixId), EXPECTED);
  for (const gap of analysis.fieldGaps) {
    assert.equal(gap.count, 1, `${gap.matrixId} count`);
    assert.equal(gap.fields.length, 1, `${gap.matrixId} field name`);
    assert.ok(gap.reason.length > 0, `${gap.matrixId} reason`);
  }
  const analysisText = analyzeAsText(analysis);
  for (const id of EXPECTED) assert.match(analysisText, new RegExp(`${id}: 1`));
  assert.equal(analysis.features.used.some((feature) => feature.feature === 'Prediction (Zia field)'), false,
    'unstarted prediction support must still be visible through fieldGaps');

  const { files, plan } = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false });
  assert.deepEqual(plan.fieldGaps.map((gap) => gap.matrixId), EXPECTED);
  const planMd = files.find((file) => file.path === 'plan.md')?.data ?? '';
  for (const id of EXPECTED) assert.match(planMd, new RegExp(`${id}: 1 field`));
  assert.match(planMd, /Field behavior gaps \(no silent shim\)/);

  const migration = buildMigrationReport([{ name: 'kitchen-sink-gaps', ir: app }], 'synthetic');
  assert.equal(migration.apps[0]?.fieldGaps.length, EXPECTED.length);
  assert.equal(migration.aggregate.fieldGapTotal, EXPECTED.length);
  assert.deepEqual(migration.aggregate.fieldGaps.map((gap) => gap.matrixId), EXPECTED);
  const reportText = migrationReportAsText(migration);
  for (const id of EXPECTED) assert.match(reportText, new RegExp(`${id}: 1`));
});
