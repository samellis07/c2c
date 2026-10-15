import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CATALYST_LIMITS } from '../../dist/schema/src/limits.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const docsPath = 'plugin/references/limits.md';
const docs = readFileSync(path.join(repo, docsPath), 'utf8');

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function parseRegistryRows(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headerAt = lines.findIndex((line) => line.startsWith('| Limit | Key | Value | Unit | Verified |'));
  assert.notEqual(headerAt, -1, `${docsPath} must have a keyed values/units/verified table`);
  const header = cells(lines[headerAt]);
  const out = new Map();
  for (const line of lines.slice(headerAt + 2)) {
    if (!line.startsWith('|')) break;
    const row = Object.fromEntries(header.map((key, index) => [key, cells(line)[index]]));
    const id = row.Key?.replaceAll('`', '');
    assert.ok(id, `row has no limit key: ${line}`);
    assert.ok(!out.has(id), `duplicate documented key ${id}`);
    const value = row.Value === 'unstated' ? null : Number(row.Value);
    assert.ok(value === null || Number.isFinite(value), `invalid value for ${id}: ${row.Value}`);
    out.set(id, { value, unit: row.Unit, verified: row.Verified === 'true' });
  }
  return out;
}

export function parseProseRows(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headerAt = lines.findIndex((line) => line.startsWith('| Limit | Value | Label | Enforcement | Probe |'));
  assert.notEqual(headerAt, -1, `${docsPath} must have a prose limits table`);
  const header = cells(lines[headerAt]);
  const out = new Map();
  for (const line of lines.slice(headerAt + 2)) {
    if (!line.startsWith('|')) break;
    const rowCells = cells(line);
    const row = Object.fromEntries(header.map((key, index) => [key, rowCells[index]]));
    const limit = row.Limit;
    assert.ok(limit, `prose row has no limit title: ${line}`);
    assert.ok(!out.has(limit), `duplicate prose limit title ${limit}`);
    out.set(limit, {
      limit,
      value: row.Value,
      label: row.Label,
      enforcement: row.Enforcement,
      probe: row.Probe,
      line,
    });
  }
  return out;
}

export const PROSE_LIMITS_MAP = new Map([
  [
    'Columns per table',
    {
      keys: ['datastore.columns_per_table', 'datastore.columns_per_table_default', 'datastore.columns_per_table_ceiling'],
      label: 'registry',
      value: '250 generation cap; 100 default; 325 stated ceiling (all unverified)',
    },
  ],
  [
    'Unique varchar columns per table',
    {
      keys: ['datastore.unique_text_columns'],
      label: '[E2E]',
      value: '2 → `403 INVALID_OPERATION … Reached max number of columns of Unique varchar type`',
    },
  ],
  [
    'Foreign keys per table',
    {
      keys: ['datastore.fk_columns'],
      label: '[SR]',
      value: '15',
    },
  ],
  [
    'Text-type columns per table',
    {
      keys: ['datastore.text_columns'],
      label: '[SR]',
      value: '130',
    },
  ],
  [
    'varchar length',
    {
      keys: ['datastore.varchar_chars'],
      label: '[HV H12]',
      value: '255 clamp; REST insert **silently truncates**',
    },
  ],
  [
    'text length',
    {
      keys: ['datastore.text_chars'],
      label: '[SR]',
      value: '10,000; not searchable',
    },
  ],
  [
    'ZCQL rows per SELECT',
    {
      keys: [],
      label: '[HV]',
      value: '300',
    },
  ],
  [
    'ZCQL offset',
    {
      keys: [],
      label: '[HV H17]',
      value: '1-based; 0 is clamped to 1',
    },
  ],
  [
    'ZCQL LIKE',
    {
      keys: [],
      label: '[HV H16]',
      value: '`*` any run, `?` one char; `%` silently matches nothing',
    },
  ],
  [
    'ZCQL JOINs',
    {
      keys: ['zcql.joins'],
      label: '[DOC]',
      value: '4 (raise is per environment)',
    },
  ],
  [
    'ZCQL SELECT columns',
    {
      keys: ['zcql.select_columns'],
      label: 'registry',
      value: '30 (unverified)',
    },
  ],
  [
    'ZCQL UPDATE/DELETE',
    {
      keys: [],
      label: '[HV R2-10/18]',
      value: 'stop silently at 300 rows',
    },
  ],
  [
    'ZCQL subqueries in WHERE',
    {
      keys: [],
      label: '[HV H15][DOC]',
      value: 'supported (`IN (SELECT …)`)',
    },
  ],
  [
    'ZCQL INSERT error-after-write',
    {
      keys: [],
      label: '[HV H14]',
      value: '`400 For input string: "nu"` **but the row was written**',
    },
  ],
  [
    'Date strictness',
    {
      keys: [],
      label: '[HV H14]',
      value: 'REST stores `05-10-2026` as `0011-04-18`',
    },
  ],
  [
    'double rounding',
    {
      keys: [],
      label: '[HV H11]',
      value: '`0.105` → `0.10` silently',
    },
  ],
  [
    'Row insert batch',
    {
      keys: [],
      label: '[HV]',
      value: '200 rows per call',
    },
  ],
  [
    'Bulk write',
    {
      keys: ['bulk.rows_per_call'],
      label: '[DOC]',
      value: '100,000 rows per job; needs CSV in Stratus; `find_by`, `fk_mapping`',
    },
  ],
  [
    'Advanced I/O / AppSail request',
    {
      keys: ['function.timeout_seconds'],
      label: '[DOC][HV R2-22]',
      value: '30 s, not raisable',
    },
  ],
  [
    'Job function',
    {
      keys: ['job.timeout_minutes'],
      label: '[DOC]',
      value: '15 min',
    },
  ],
  [
    'Function concurrency',
    {
      keys: ['function.concurrency_dev'],
      label: '[SR]',
      value: '~10 per function in Dev',
    },
  ],
  [
    'Data Store write rate',
    {
      keys: ['datastore.write_requests_per_minute'],
      label: 'registry',
      value: '100 requests/minute (unverified)',
    },
  ],
  [
    'Dev per-table row cap',
    {
      keys: [],
      label: '[SR]',
      value: 'hidden value, `API_LIMIT_REACHED … for row`',
    },
  ],
  [
    'Table creates per org',
    {
      keys: ['datastore.tables_per_org'],
      label: '[HV]',
      value: 'unpublished number and window; `403 API_LIMIT_REACHED … for table` has fired at a visible count above and below 200 and persisted after project deletes — a per-period quota or a count including unpurged tables',
    },
  ],
  [
    'Projects per account',
    {
      keys: [],
      label: '[DOC]',
      value: '50',
    },
  ],
  [
    'App users in Development',
    {
      keys: [],
      label: 'conflict',
      value: '25 [DOC] vs `limit "1000"` observed [E2E]',
    },
  ],
  [
    'Dev API calls',
    {
      keys: ['api.calls_dev'],
      label: 'not currently listed in the limits registry',
      value: '200000 per application (unverified)',
    },
  ],
  [
    'Stratus single object',
    {
      keys: [],
      label: '[SR]',
      value: '250 GB',
    },
  ],
  [
    'Slate `index.html` cache',
    {
      keys: [],
      label: '[HV H20]',
      value: '`cache-control: public, max-age=31536000`',
    },
  ],
  [
    'Creator API from Catalyst',
    {
      keys: [],
      label: '[SR]',
      value: '429 at ~1 req/min',
    },
  ],
  [
    'Unique under concurrency',
    {
      keys: [],
      label: '[HV R2-02]',
      value: 'duplicates persisted; lost updates',
    },
  ],
]);

export function assertProseParity(markdown) {
  const proseRows = parseProseRows(markdown);
  const registryIds = new Set(CATALYST_LIMITS.map((row) => row.id));
  const registryMap = new Map(CATALYST_LIMITS.map((row) => [row.id, row]));

  assert.equal(
    proseRows.size,
    PROSE_LIMITS_MAP.size,
    `prose table must have exactly ${PROSE_LIMITS_MAP.size} rows, found ${proseRows.size}`
  );
  assert.deepEqual(
    [...proseRows.keys()].sort(),
    [...PROSE_LIMITS_MAP.keys()].sort(),
    'every prose limit row must be mapped exactly once'
  );

  for (const [limitTitle, mapped] of PROSE_LIMITS_MAP) {
    const actual = proseRows.get(limitTitle);
    assert.ok(actual, `missing prose row for "${limitTitle}"`);

    // Verify registry alignment for registry-labeled rows
    if (actual.label === 'registry') {
      assert.ok(
        mapped.keys && mapped.keys.length > 0,
        `row "${limitTitle}" claims registry source but has no mapped keys: ${actual.line}`
      );
      for (const key of mapped.keys) {
        assert.ok(
          registryIds.has(key),
          `row "${limitTitle}" claims registry source for absent key ${key}: ${actual.line}`
        );
        const regLimit = registryMap.get(key);
        if (regLimit && regLimit.value !== null) {
          assert.ok(
            actual.value.includes(String(regLimit.value)),
            `row "${limitTitle}" value "${actual.value}" does not contain registry value ${regLimit.value} for key ${key}`
          );
        }
      }
    } else {
      // Row is not labeled registry; verify it does not falsely claim registry for an absent key
      for (const key of mapped.keys || []) {
        if (!registryIds.has(key)) {
          assert.notEqual(
            actual.label,
            'registry',
            `row "${limitTitle}" claims registry source for absent key ${key}: ${actual.line}`
          );
        }
      }
    }

    assert.equal(actual.label, mapped.label, `label mismatch for "${limitTitle}"`);
    assert.equal(actual.value, mapped.value, `value mismatch for "${limitTitle}"`);
  }
}

test('documented limit values, units, and verified flags match the schema registry', () => {
  const documented = parseRegistryRows(docs);
  const registryIds = new Set(CATALYST_LIMITS.map((row) => row.id));
  assert.deepEqual([...documented.keys()].sort(), [...registryIds].sort(), 'document every registry key exactly once');

  assertProseParity(docs);

  for (const limit of CATALYST_LIMITS) {
    assert.deepEqual(
      documented.get(limit.id),
      {
        value: limit.value,
        unit: limit.unit,
        verified: limit.verified,
      },
      `documented metadata drift for ${limit.id}`
    );
    if (limit.verified) {
      assert.ok(docs.includes(`\`${limit.id}\``), `verified registry limit ${limit.id} must be documented`);
    }
  }
});

test('RED: relabeling api.calls_dev to registry fails the parity assertion', () => {
  const mutated = docs.replace(
    '| Dev API calls | 200000 per application (unverified) | not currently listed in the limits registry |',
    '| Dev API calls | 200000 per application (unverified) | registry |'
  );
  assert.throws(
    () => assertProseParity(mutated),
    /claims registry source for absent key api\.calls_dev|label mismatch for "Dev API calls"/
  );
});

test('RED: mutating a documented prose limit value fails the parity assertion', () => {
  const mutated1 = docs.replace('100 requests/minute (unverified)', '99 requests/minute (unverified)');
  assert.throws(
    () => assertProseParity(mutated1),
    /does not contain registry value 100|value mismatch for "Data Store write rate"/
  );

  const mutated2 = docs.replace('250 generation cap', '999 generation cap');
  assert.throws(
    () => assertProseParity(mutated2),
    /does not contain registry value 250|value mismatch for "Columns per table"/
  );
});

test('RED: deleting a documented prose limit row fails the parity assertion', () => {
  const lines = docs.split('\n');
  const rowIdx = lines.findIndex((l) => l.includes('| Dev API calls |'));
  assert.notEqual(rowIdx, -1);
  const mutated = [...lines.slice(0, rowIdx), ...lines.slice(rowIdx + 1)].join('\n');
  assert.throws(() => assertProseParity(mutated), /prose table must have exactly 31 rows|every prose limit row must be mapped/);
});

test('the detailed limits facts and skills use the registry-aligned conclusions', () => {
  const facts = readFileSync(path.join(repo, 'plugin/references/facts/limits.md'), 'utf8');
  const schemaSkill = readFileSync(path.join(repo, 'plugin/skills/c2c-schema-and-data/SKILL.md'), 'utf8');
  const verifySkill = readFileSync(path.join(repo, 'plugin/skills/c2c-verify-and-cutover/SKILL.md'), 'utf8');
  assert.match(facts, /warns when the estimate is at or above 200000/);
  assert.match(facts, /mover does not pace writes or retry using Retry-After/);
  assert.match(facts, /at most 30 columns/);
  assert.doesNotMatch(facts, /warns when the estimate is a large fraction of 200000|mover rate cap \+ `Retry-After`/);
  assert.match(schemaSkill, /columns ≤ 250 per table/);
  assert.match(schemaSkill, /projection ≤ 30 columns/);
  assert.match(verifySkill, /30 columns \(`zcql\.select_columns`/);
  assert.doesNotMatch(schemaSkill + verifySkill, /20 \[DOC\] vs 30|100 \[DOC\] vs 325/);
});
