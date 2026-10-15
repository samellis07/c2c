import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CATALYST_LIMITS } from '../../dist/schema/src/limits.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const docs = readFileSync(path.join(repo, 'plugin/references/limits.md'), 'utf8');
const facts = readFileSync(path.join(repo, 'plugin/references/facts/limits.md'), 'utf8');
const schemaSkill = readFileSync(path.join(repo, 'plugin/skills/c2c-schema-and-data/SKILL.md'), 'utf8');
const verifySkill = readFileSync(path.join(repo, 'plugin/skills/c2c-verify-and-cutover/SKILL.md'), 'utf8');

// Every registry entry in CATALYST_LIMITS carries its canonical label, so the
// expected label map is derived from the schema registry rather than copied.
const EXPECTED_LABELS = new Map(CATALYST_LIMITS.map((limit) => [limit.id, limit.label]));

function parseLimitTable(markdown) {
  const rows = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*(true|false)\s*\|$/);
    if (!match) continue;
    const [, label, key, rawValue, unit, verified] = match;
    assert.ok(!rows.has(key), `duplicate limit key ${key}`);
    rows.set(key, { label, value: rawValue.trim() === 'unstated' ? null : Number(rawValue), unit: unit.trim(), verified: verified === 'true' });
  }
  return rows;
}

function assertRegistryParity(markdown) {
  const documented = parseLimitTable(markdown);
  const expected = new Map(CATALYST_LIMITS.map((limit) => [limit.id, {
    label: EXPECTED_LABELS.get(limit.id),
    value: limit.value,
    unit: limit.unit,
    verified: limit.verified,
  }]));
  assert.deepEqual([...documented.keys()].sort(), [...expected.keys()].sort(), 'document every registry key exactly once');
  assert.deepEqual([...EXPECTED_LABELS.keys()].sort(), [...expected.keys()].sort(), 'state an expected label for every registry key');
  for (const [key, value] of expected) {
    assert.ok(typeof value.label === 'string' && value.label.trim().length > 0, `missing label on registry key ${key}`);
    assert.deepEqual(documented.get(key), value, `documented metadata drift for ${key}`);
  }
}

test('documented limit values, units, and verified flags match the schema registry', () => {
  assertRegistryParity(docs);
  const uniqueHeading = facts.match(/^### (Unique varchar columns)\n\nRule: At most 2 columns per table may be data_type varchar with is_unique true \[TESTED\]\.[^\n]*A text column cannot be unique\./m);
  assert.ok(uniqueHeading, 'facts/limits.md must record the [TESTED] Unique varchar columns heading and rule');
  assert.equal(EXPECTED_LABELS.get('datastore.unique_text_columns'), uniqueHeading[1]);
});

test('RED: changing a documented registry value fails parity', () => {
  const mutated = docs.replace('| ZCQL SELECT columns | `zcql.select_columns` | 30 | columns | false |', '| ZCQL SELECT columns | `zcql.select_columns` | 29 | columns | false |');
  assert.throws(() => assertRegistryParity(mutated), /documented metadata drift for zcql\.select_columns/);
});

test('RED: changing a documented registry label fails parity', () => {
  const mutated = docs.replace('| ZCQL SELECT columns | `zcql.select_columns` |', '| ZCQL SELECT projection | `zcql.select_columns` |');
  assert.throws(() => assertRegistryParity(mutated), /documented metadata drift for zcql\.select_columns/);
  const mislabelled = docs.replace('| Unique varchar columns | `datastore.unique_text_columns` |', '| Unique text columns | `datastore.unique_text_columns` |');
  assert.throws(() => assertRegistryParity(mislabelled), /documented metadata drift for datastore\.unique_text_columns/);
});

test('RED: deleting a registry row fails parity', () => {
  const mutated = docs.replace(/^\| ZCQL SELECT columns \|.*\n/m, '');
  assert.throws(() => assertRegistryParity(mutated), /document every registry key exactly once/);
});

test('the facts and skills reflect the current limit behavior', () => {
  assert.match(facts, /warns when the estimate is at or above 200000/);
  assert.match(facts, /mover does not pace writes or retry using Retry-After/);
  assert.match(facts, /at most 30 columns/);
  assert.match(schemaSkill, /raised cap 250 columns per table \[UNVERIFIED\]/);
  assert.match(schemaSkill, /projection ≤ 30 columns/);
  assert.match(verifySkill, /30 columns \(`zcql\.select_columns`/);
});
