/**
 * Rules behaviour: plugin/references/facts/zcql.md must read as plain
 * imperative system rules (method, path, headers, body, polling, success
 * signal, error codes) and passes the generic hygiene scan.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanText } from '../../scripts/check-hygiene.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = path.join(repo, 'plugin/references/facts/zcql.md');

function sections(text) {
  const heads = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
  const bodies = text.split(/^### .+$/m).slice(1);
  return { heads, bodies };
}

test('zcql.md exists with unique rule headings', () => {
  const text = readFileSync(file, 'utf8');
  const { heads } = sections(text);
  assert.ok(heads.length >= 8, `expected >=8 rules, saw ${heads.length}`);
  assert.deepEqual([...new Set(heads)], heads, 'rule headings must be unique');
});

test('zcql.md: every rule carries a recipe or explicit rule line', () => {
  const text = readFileSync(file, 'utf8');
  const { heads, bodies } = sections(text);
  bodies.forEach((body, i) => {
    assert.match(body, /(Recipe|Rule):/, `rule "${heads[i]}" needs a Recipe: or Rule: line`);
  });
});

test('zcql.md passes the generic hygiene scan', () => {
  assert.deepEqual(scanText('zcql.md', readFileSync(file, 'utf8')), []);
});

test('zcql.md: token envelope names the versioned Accept header', () => {
  const text = readFileSync(file, 'utf8');
  assert.ok(
    text.includes('Accept: application/vnd.catalyst.v2+json'),
    'token envelope must name the versioned Accept header',
  );
});

function skillFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return skillFiles(full);
    return entry.isFile() && entry.name === 'SKILL.md' ? [full] : [];
  });
}

function anchorFor(heading) {
  return heading
    .replace(/\s+#+\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

function parseFacts(text) {
  const factMatches = [...text.matchAll(/^### (?:\[(ZC-\d+)\]\s*)?(.+)$/gm)];
  const bodies = text.split(/^### .+$/m).slice(1);
  return factMatches.map((m, i) => {
    const id = m[1] || null;
    const title = m[2].trim();
    const rawHeading = m[0].replace(/^### /, '').trim();
    return {
      id,
      title,
      rawHeading,
      anchor: anchorFor(rawHeading),
      plainAnchor: anchorFor(title),
      body: bodies[i] || '',
      isInternalOnly: /\binternal-only\b/i.test(bodies[i] || ''),
    };
  });
}

function findUnreferencedFacts(facts, skillsText) {
  return facts.filter((fact) => {
    if (fact.isInternalOnly) return false;
    const byId = fact.id && skillsText.includes(fact.id);
    const byAnchor = fact.anchor && skillsText.includes(`#${fact.anchor}`);
    const byPlainAnchor = fact.plainAnchor && skillsText.includes(`#${fact.plainAnchor}`);
    return !(byId || byAnchor || byPlainAnchor);
  });
}

test('every zcql.md fact heading has a unique stable ID', () => {
  const text = readFileSync(file, 'utf8');
  const facts = parseFacts(text);
  assert.ok(facts.length >= 8, `expected >=8 facts, saw ${facts.length}`);
  for (const fact of facts) {
    assert.ok(fact.id, `fact "${fact.rawHeading}" must have a stable [ZC-xx] ID`);
  }
  const ids = facts.map((f) => f.id);
  assert.deepEqual([...new Set(ids)], ids, 'fact IDs must be unique');
});

test('every zcql fact is referenced by a SKILL.md (by id/anchor) or explicitly marked internal-only', () => {
  const text = readFileSync(file, 'utf8');
  const facts = parseFacts(text);
  const skillsDir = path.join(repo, 'plugin/skills');
  const allSkills = skillFiles(skillsDir)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const unreferenced = findUnreferencedFacts(facts, allSkills)
    .map((f) => f.rawHeading);
  assert.deepEqual(unreferenced, [], `unreferenced ZCQL facts:\n${unreferenced.join('\n')}`);
});

test('each zcql fact is present in its owning plugin skill', () => {
  const text = readFileSync(file, 'utf8');
  const facts = parseFacts(text);
  const logicSkill = readFileSync(path.join(repo, 'plugin/skills/c2c-logic/SKILL.md'), 'utf8');
  const schemaSkill = readFileSync(path.join(repo, 'plugin/skills/c2c-schema-and-data/SKILL.md'), 'utf8');
  const ownerFor = (id) => ['ZC-01', 'ZC-02', 'ZC-03', 'ZC-04', 'ZC-07', 'ZC-09', 'ZC-11'].includes(id)
    ? logicSkill
    : schemaSkill;
  const unowned = facts
    .filter((f) => !f.isInternalOnly && !ownerFor(f.id).includes(f.id))
    .map((f) => f.id);
  assert.deepEqual(unowned, [], `ZCQL facts missing from their owning skill:\n${unowned.join('\n')}`);
});

test('negative control: unreferenced ZCQL fact fails parity check', () => {
  const text = readFileSync(file, 'utf8');
  const facts = parseFacts(text);
  const skillsDir = path.join(repo, 'plugin/skills');
  const allSkills = skillFiles(skillsDir)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  const targetFact = facts[0];
  const scrubbedSkills = allSkills
    .replaceAll(targetFact.id, 'ZC-999')
    .replaceAll(`#${targetFact.anchor}`, '#unlinked')
    .replaceAll(`#${targetFact.plainAnchor}`, '#unlinked');

  const unreferenced = findUnreferencedFacts(facts, scrubbedSkills);
  assert.ok(
    unreferenced.some((f) => f.id === targetFact.id),
    `removing references to ${targetFact.id} must cause findUnreferencedFacts to fail`,
  );
});

test('negative control: an internal-only fact is exempt from skill reference requirement', () => {
  const mockMarkdown = `### [ZC-99] Internal engine metric\n\nRule: internal-only; not for skill references.\n`;
  const mockFacts = parseFacts(mockMarkdown);
  assert.equal(mockFacts[0].isInternalOnly, true);
  const unreferenced = findUnreferencedFacts(mockFacts, '');
  assert.deepEqual(unreferenced, []);
});
