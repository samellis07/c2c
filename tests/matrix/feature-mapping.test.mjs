import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFileWithSidecars, appFacts } from '../../dist/core/src/index.js';
import { FEATURE_MAPPING, MAPPING_BY_ID, evaluateAppFeatures } from '../../scripts/feature-mapping.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const snapshotPath = path.join(repoRoot, 'packages/cli/data/feature-matrix-v4.snapshot.json');
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

test('feature mapping table maps all 194 matrix rows', () => {
  assert.equal(FEATURE_MAPPING.length, 194);
  assert.equal(snapshot.rows.length, 194);

  const seenIds = new Set();
  for (let i = 1; i <= 194; i++) {
    const entry = MAPPING_BY_ID.get(i);
    assert.ok(entry, `missing mapping entry for row id ${i}`);
    assert.equal(entry.id, i);
    assert.ok(typeof entry.title === 'string' && entry.title.length > 0, `row ${i} has empty title`);
    assert.ok(typeof entry.area === 'string' && entry.area.length > 0, `row ${i} has empty area`);
    assert.ok(typeof entry.status === 'string' && entry.status.length > 0, `row ${i} has empty status`);
    assert.ok(typeof entry.detectable === 'boolean', `row ${i} detectable flag is not boolean`);

    if (entry.detectable) {
      assert.equal(typeof entry.predicate, 'function', `row ${i} is detectable but has no predicate`);
      assert.equal(typeof entry.count, 'function', `row ${i} is detectable but has no count function`);
      assert.equal(entry.reason, null, `row ${i} is detectable but has non-null reason`);
      assert.ok(typeof entry.method === 'string' && entry.method.length > 0, `row ${i} has empty method`);
    } else {
      assert.equal(entry.predicate, null, `row ${i} is undetectable but has a predicate`);
      assert.equal(entry.count, null, `row ${i} is undetectable but has a count function`);
      assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0, `row ${i} is undetectable but has no reason`);
    }

    seenIds.add(i);
  }
  assert.equal(seenIds.size, 194);
});

test('evaluates mapping on synthetic kitchen-sink fixture', () => {
  const ksPath = path.join(repoRoot, 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds');
  assert.ok(fs.existsSync(ksPath), 'kitchen-sink fixture missing');

  const parsed = parseFileWithSidecars(ksPath);
  const facts = appFacts(parsed.ir);
  const { detected, counts } = evaluateAppFeatures(facts);

  // Standard field types known to be present in kitchen-sink
  // Row 1: Single line
  assert.ok(detected.has(1), 'kitchen-sink should have Single line (row 1)');
  assert.ok((counts.get(1) ?? 0) > 0);

  // Row 2: Multi line
  assert.ok(detected.has(2), 'kitchen-sink should have Multi line (row 2)');

  // Row 5: Number
  assert.ok(detected.has(5), 'kitchen-sink should have Number (row 5)');

  // Row 9: Date
  assert.ok(detected.has(9), 'kitchen-sink should have Date (row 9)');

  // Row 19: Subform
  assert.ok(detected.has(19), 'kitchen-sink should have Subform (row 19)');

  // Row 44: Mandatory
  assert.ok(detected.has(44), 'kitchen-sink should have Mandatory (row 44)');

  // Ensure undetectable rows are never in detected
  for (const m of FEATURE_MAPPING) {
    if (!m.detectable) {
      assert.equal(detected.has(m.id), false, `undetectable row ${m.id} was flagged as detected`);
    }
  }
});

test('evaluates mapping on synthetic kitchen-sink-gaps fixture', () => {
  const ksgPath = path.join(repoRoot, 'fixtures/synthetic/kitchen-sink-gaps/kitchen_sink_gaps.ds');
  assert.ok(fs.existsSync(ksgPath), 'kitchen-sink-gaps fixture missing');

  const parsed = parseFileWithSidecars(ksgPath);
  const facts = appFacts(parsed.ir);
  const { detected, counts } = evaluateAppFeatures(facts);

  assert.ok(detected.size > 0, 'kitchen-sink-gaps should have detected features');

  // Single line should be present
  assert.ok(detected.has(1), 'kitchen-sink-gaps should have Single line (row 1)');

  // Determinism check: repeating evaluation yields identical detected rows and counts
  const run2 = evaluateAppFeatures(facts);
  assert.deepEqual([...detected].sort((a, b) => a - b), [...run2.detected].sort((a, b) => a - b));
  assert.deepEqual([...counts.entries()].sort((a, b) => a[0] - b[0]), [...run2.counts.entries()].sort((a, b) => a[0] - b[0]));
});
