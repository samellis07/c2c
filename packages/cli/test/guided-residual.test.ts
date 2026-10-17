import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseFileWithSidecars } from '../../core/src/index.js';
import { analyze } from '../src/analyze.js';
import { genericResidualStep, guidedResiduals } from '../src/guided-residual.js';
import { buildMigrationReport } from '../src/migration-report.js';
import { CONVERTER_GAP_FIX } from '../src/precheck.js';
import type { FieldOutcome } from '../../schema/src/generator.js';
import type { SilentDrop } from '../../quality/src/no-silent-drop.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const library = join(root, 'fixtures/redistributable/library-application-system/library_application.ds');

const outcome: FieldOutcome = { form: 'Orders', field: 'Due', creatorType: 'date', matrixId: 'field-date', status: 'supported', reason: 'Date-only column.' };

test('a field-property drop gets the field-gap reason and a generic step naming the setting', () => {
  const drop: SilentDrop = { kind: 'field-property', name: 'Orders.Due displayformat', note: 'not in the generated field', form: 'Orders', field: 'Due', property: 'displayformat' };
  const [item] = guidedResiduals([drop], [outcome]);
  assert.deepEqual(item, {
    id: 'field-property:Orders.Due displayformat',
    kind: 'field-property',
    construct: 'Orders.Due displayformat',
    form: 'Orders',
    field: 'Due',
    property: 'displayformat',
    reason: 'displayformat is not carried by the generated field-date field. Date-only column.',
    step: 'Set displayformat on Orders.Due manually in the Catalyst console/app; not converted.',
    stepSource: 'generic',
  });
});

test('a drop with workaround text uses the precheck fix; one without a field outcome keeps the ledger note as reason', () => {
  const statement: SilentDrop = { kind: 'statement', name: 'on_add line 3', note: 'statement counted with no todo' };
  const unsupported: SilentDrop = { kind: 'field', name: 'Orders.Map', note: 'no column', form: 'Orders', field: 'Map' };
  const items = guidedResiduals([statement, unsupported], [{ ...outcome, field: 'Map', status: 'unsupported', reason: 'No map column.' }]);
  assert.equal(items[0]!.step, CONVERTER_GAP_FIX.deluge);
  assert.equal(items[0]!.stepSource, 'workaround');
  assert.equal(items[0]!.reason, 'statement counted with no todo');
  assert.equal(items[1]!.step, CONVERTER_GAP_FIX.field);
  assert.equal(items[1]!.reason, 'No map column.');
});

test('the same construct dropped twice gets two distinct stable ids', () => {
  const drop: SilentDrop = { kind: 'report-feature', name: 'All_Orders sortorder', note: 'not emitted' };
  const items = guidedResiduals([drop, drop], []);
  assert.deepEqual(items.map((item) => item.id), ['report-feature:All_Orders sortorder #1', 'report-feature:All_Orders sortorder #2']);
  assert.equal(items[0]!.step, genericResidualStep(drop));
  assert.deepEqual(guidedResiduals([drop, drop], []), items, 'ids are stable across runs');
});

test('analyze and the migration report guide every drop without lowering the drop count', () => {
  const ir = parseFileWithSidecars(library).ir;
  const report = analyze(ir);
  assert.ok(report.determinism.silentDrops > 0);
  assert.equal(report.residuals.length, report.determinism.silentDrops);
  assert.equal(report.determinism.deterministic, false);
  for (const item of report.residuals) {
    assert.ok(item.reason.trim() && item.step.trim() && item.id.trim(), item.id);
    const blocker = report.blockers.find((b) => b.label === `silent drop ${item.kind}: ${item.construct}`);
    assert.equal(blocker?.manualStep, item.step);
  }
  const migration = buildMigrationReport([{ name: 'library', ir }], 'test');
  assert.equal(migration.aggregate.silentDrops, report.determinism.silentDrops);
  assert.equal(migration.aggregate.guidedResiduals, report.determinism.silentDrops);
  assert.equal(migration.aggregate.unguidedSilentDrops, 0);
  assert.equal(migration.aggregate.deterministicApps, 0);
  assert.deepEqual(migration.apps[0]!.residuals, report.residuals);
});
