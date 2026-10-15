/**
 * Rules behaviour: plugin/references/facts/datastore.md must read as plain
 * imperative system rules (method, path, headers, body, polling, success
 * signal, error codes) and passes the generic hygiene scan.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanText } from '../../scripts/check-hygiene.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = path.join(repo, 'plugin/references/facts/datastore.md');

function sections(text) {
  const heads = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
  const bodies = text.split(/^### .+$/m).slice(1);
  return { heads, bodies };
}

test('datastore.md exists with unique rule headings', () => {
  const text = readFileSync(file, 'utf8');
  const { heads } = sections(text);
  assert.ok(heads.length >= 10, `expected >=10 rules, saw ${heads.length}`);
  assert.deepEqual([...new Set(heads)], heads, 'rule headings must be unique');
});

test('datastore.md: every rule carries a recipe or explicit rule line', () => {
  const text = readFileSync(file, 'utf8');
  const { heads, bodies } = sections(text);
  bodies.forEach((body, i) => {
    assert.match(body, /(Recipe|Rule):/, `rule "${heads[i]}" needs a Recipe: or Rule: line`);
  });
});

test('datastore.md passes the generic hygiene scan', () => {
  assert.deepEqual(scanText('datastore.md', readFileSync(file, 'utf8')), []);
});

test('datastore.md: foreign-key recipe uses the hyphenated constraint enum', () => {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('ON-DELETE-CASCADE'), 'must name ON-DELETE-CASCADE');
  assert.ok(!text.includes('ON DELETE CASCADE'), 'spaced token makes column create fail');
});

test('datastore.md: REST inserts apply column default_value', () => {
  const text = readFileSync(file, 'utf8');
  assert.match(text, /REST inserts apply .*default_value/, 'must state inserts apply default_value');
  assert.ok(!text.includes('REST inserts skip'), 'must not claim inserts skip initial values');
});

test('datastore.md: email/encrypted 400 is an invalid-type error', () => {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('`encrypted text`'), 'must name the real encrypted type');
  assert.ok(!text.includes('unique `email`'), 'must not frame email 400 as a uniqueness failure');
  assert.ok(!text.includes('unique `encrypted`'), 'must not frame encrypted 400 as a uniqueness failure');
});

test('datastore.md: exact rolled date and versioned Accept header', () => {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('0011-04-18'), 'must record the exact stored value of 05-10-2026');
  assert.ok(
    text.includes('Accept: application/vnd.catalyst.v2+json'),
    'token envelope must name the versioned Accept header',
  );
});

test('datastore.md: the JSON report export always carries record ids; a CSV only when it includes the ID column', () => {
  const text = readFileSync(file, 'utf8');
  assert.match(text, /JSON report export/, 'must name the JSON report export');
  assert.match(text, /CSV export carries it only when the export includes/, 'must state the CSV export carries ids only with the ID column');
  assert.match(text, /display value/, 'must state lookups export as display values');
  assert.match(text, /Refuse to map a lookup/, 'must refuse ambiguous display values');
});

test('datastore.md: a 5xx on a schema write is re-read before re-sending', () => {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('5xx'), 'must name the 5xx case');
  assert.match(text, /re-read the table or column list\s+before re-sending/, 'must require a re-read before retry');
});

function skillFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return skillFiles(full);
    return entry.isFile() && entry.name === 'SKILL.md' ? [full] : [];
  });
}

const INTERNAL_ONLY_MARKER = /^(?:Internal-only:(?:\s*\S+)?|<!--\s*internal-only\s*-->)/im;

function isInternalOnly(body) {
  return INTERNAL_ONLY_MARKER.test(body);
}

function findUnreferencedFacts(ledger, skillText) {
  const factHeads = [...ledger.matchAll(/^### \[(DS-\d+)\] (.+)$/gm)];
  return factHeads.filter(([, id]) => {
    const heading = `### [${id}]`;
    const start = ledger.indexOf(heading);
    const next = ledger.indexOf('\n### ', start + heading.length);
    const body = ledger.slice(start, next === -1 ? ledger.length : next);
    return !skillText.includes(id) && !isInternalOnly(body);
  }).map(([, id, heading]) => `${id} ${heading}`);
}

function findInternalOnlyViolations(ledger, skillText) {
  const factHeads = [...ledger.matchAll(/^### \[(DS-\d+)\] (.+)$/gm)];
  return factHeads.filter(([, id]) => {
    const heading = `### [${id}]`;
    const start = ledger.indexOf(heading);
    const next = ledger.indexOf('\n### ', start + heading.length);
    const body = ledger.slice(start, next === -1 ? ledger.length : next);
    return skillText.includes(id) && isInternalOnly(body);
  }).map(([, id, heading]) => `${id} ${heading}`);
}

test('every datastore fact is referenced by a skill or marked internal-only', () => {
  const ledger = readFileSync(file, 'utf8');
  const factHeads = [...ledger.matchAll(/^### \[(DS-\d+)\] (.+)$/gm)];
  assert.ok(factHeads.length > 0, 'datastore fact headings need stable IDs');
  assert.equal(new Set(factHeads.map((match) => match[1])).size, factHeads.length, 'fact IDs must be unique');

  const skills = skillFiles(path.join(repo, 'plugin/skills'));
  const skillText = skills.map((skill) => readFileSync(skill, 'utf8')).join('\n');
  const unreferenced = findUnreferencedFacts(ledger, skillText);
  assert.deepEqual(unreferenced, [], `unreferenced datastore facts:\n${unreferenced.join('\n')}`);
  const markedWhileReferenced = findInternalOnlyViolations(ledger, skillText);
  assert.deepEqual(
    markedWhileReferenced,
    [],
    `datastore facts referenced by a skill must not be marked internal-only:\n${markedWhileReferenced.join('\n')}`,
  );
});

test('datastore parity negative control: prose mentioning internal-only still requires a citation', () => {
  const mockLedger = [
    '### [DS-90] Incidental prose fact',
    '',
    'Rule: this behavior is not internal-only; client code relies on it.',
    '',
    'Recipe: calls to internal-only endpoints return 401.',
  ].join('\n');
  const unreferenced = findUnreferencedFacts(mockLedger, 'no citations here');
  assert.deepEqual(
    unreferenced,
    ['DS-90 Incidental prose fact'],
    'prose mentioning internal-only must not exempt an unreferenced fact from citation',
  );
});

test('datastore parity: explicit internal-only marker exempts unreferenced fact', () => {
  const mockLedger = [
    '### [DS-91] Explicit internal-only fact',
    '',
    'Internal-only: this storage sizing detail is not part of the supported migration workflow.',
    '',
    'Rule: do not expose to migration planning.',
  ].join('\n');
  const unreferenced = findUnreferencedFacts(mockLedger, 'no citations here');
  assert.deepEqual(unreferenced, [], 'explicit internal-only marker must exempt unreferenced fact');
});

test('datastore parity: comment tag exempts unreferenced fact', () => {
  const mockLedger = [
    '### [DS-92] Tagged internal-only fact',
    '',
    '<!-- internal-only -->',
    'Rule: platform maintenance detail only.',
  ].join('\n');
  const unreferenced = findUnreferencedFacts(mockLedger, 'no citations here');
  assert.deepEqual(unreferenced, [], 'comment tag must exempt unreferenced fact');
});

test('datastore parity negative control rejects an unreferenced fact', () => {
  const mockLedger = [
    '### [DS-99] Unreferenced sample fact',
    '',
    'Rule: this rule is missing from skills.',
  ].join('\n');
  const unreferenced = findUnreferencedFacts(mockLedger, 'no citations here');
  assert.deepEqual(unreferenced, ['DS-99 Unreferenced sample fact']);
});
