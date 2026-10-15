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

// The registry does not carry the docs' human-readable label, so the expected
// label for every key is stated here and compared like value, unit, verified.
const EXPECTED_LABELS = new Map([
  ['datastore.columns_per_table', 'Columns per table (generation cap)'],
  ['datastore.columns_per_table_default', 'Columns per table (default)'],
  ['datastore.columns_per_table_ceiling', 'Columns per table (stated ceiling)'],
  ['datastore.text_columns', 'Text-type columns per table'],
  ['datastore.varchar_chars', 'Varchar length (stated)'],
  ['datastore.text_chars', 'Text length'],
  ['datastore.unique_text_columns', 'Unique text columns'],
  ['datastore.fk_columns', 'Foreign keys per table'],
  ['datastore.tables_per_org', 'Tables per organisation'],
  ['zcql.joins', 'ZCQL JOINs'],
  ['zcql.select_columns', 'ZCQL SELECT columns'],
  ['datastore.write_requests_per_minute', 'Data Store write rate'],
  ['datastore.concurrency_dev', 'Data Store concurrency (Development)'],
  ['function.concurrency_dev', 'Function concurrency (Development)'],
  ['table-name-length-unverified', 'Data Store table name length'],
  ['url.throttle', 'URL throttle'],
  ['function.timeout_seconds', 'Function timeout'],
  ['job.timeout_minutes', 'Job timeout'],
  ['bulk.rows_per_call', 'Bulk rows per call'],
]);

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
  for (const [key, value] of expected) assert.deepEqual(documented.get(key), value, `documented metadata drift for ${key}`);
}

test('documented limit values, units, and verified flags match the schema registry', () => {
  assertRegistryParity(docs);
});

test('RED: changing a documented registry value fails parity', () => {
  const mutated = docs.replace('| ZCQL SELECT columns | `zcql.select_columns` | 30 | columns | false |', '| ZCQL SELECT columns | `zcql.select_columns` | 29 | columns | false |');
  assert.throws(() => assertRegistryParity(mutated), /documented metadata drift for zcql\.select_columns/);
});

test('RED: changing a documented registry label fails parity', () => {
  const mutated = docs.replace('| ZCQL SELECT columns | `zcql.select_columns` |', '| ZCQL SELECT projection | `zcql.select_columns` |');
  assert.throws(() => assertRegistryParity(mutated), /documented metadata drift for zcql\.select_columns/);
});

test('RED: deleting a registry row fails parity', () => {
  const mutated = docs.replace(/^\| ZCQL SELECT columns \|.*\n/m, '');
  assert.throws(() => assertRegistryParity(mutated), /document every registry key exactly once/);
});

test('the facts and skills reflect the current limit behavior', () => {
  assert.match(facts, /warns when the estimate is at or above 200000/);
  assert.match(facts, /mover does not pace writes or retry using Retry-After/);
  assert.match(facts, /at most 30 columns/);
  assert.match(schemaSkill, /columns ≤ 250 per table/);
  assert.match(schemaSkill, /projection ≤ 30 columns/);
  assert.match(verifySkill, /30 columns \(`zcql\.select_columns`/);
});
