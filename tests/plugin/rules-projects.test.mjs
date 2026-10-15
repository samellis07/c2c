/**
 * rules-projects: plugin/references/facts/projects.md is a shipped rules file —
 * unique headings, every rule carries a `Rule:` line or an exact recipe
 * (method + path), every `Recipe:`/`Rule:` line carries an allowed public
 * evidence label, no provenance fields or internal bracket tags, no dates,
 * no hard-coded DC, and no hygiene failures.
 */
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanText } from '../../scripts/check-hygiene.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const factsDir = path.join(repo, 'plugin', 'references', 'facts');
const file = path.join(factsDir, 'projects.md');

const PUBLIC_EVIDENCE = /\[(?:DOC|CLI|MCP-LISTED|TESTED|UNVERIFIED)\]/g;
const EVIDENCE_LABEL = /\[[A-Z][A-Z0-9 -]{1,14}\]/;
const FIELD_LABEL = /^\s*[-*]?\s*\*{0,2}(status|evidence|verified|source|date)\s*\*{0,2}\s*:/im;
const ISO_DATE = /\b20\d\d-\d\d-\d\d\b/;
const HARDCODED_DC = /\b(api|console)\.catalyst\.(in|com|eu|au|jp|sa|ca)\b|\bonslate\.(in|com|eu|au|jp|sa|ca)\b/;

const REQUIRED = [
  'baas/v1/project/import',
  'redirect_url',
  'DUPLICATE_ENTRY',
  'project-template-1.0.0.json',
  '/export',
  'DELETE /baas/v1/project/<project-id>',
  'INVALID_OPERATION',
  'X-CATALYST-Environment',
  'slate',
  'onslate',
  'Start Exploring',
  'Please access the Slate service',
  'create-only',
  'authentication secrets',
  'role_name',
  'is_authenticated',
];

function text() {
  return readFileSync(file, 'utf8');
}

function ruleSections(md) {
  const sections = [];
  let current = null;
  for (const line of md.split('\n')) {
    const h = line.match(/^### (.+)$/);
    if (h) {
      if (current) sections.push(current);
      current = { heading: h[1].trim(), body: '' };
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  if (current) sections.push(current);
  return sections;
}

test('projects.md exists as a regular file', () => {
  const info = lstatSync(file, { throwIfNoEntry: false });
  assert.ok(info, 'plugin/references/facts/projects.md is missing');
  assert.ok(info.isFile() && !info.isSymbolicLink());
});

test('rule headings are unique and each rule has a Rule: line or a recipe', () => {
  const sections = ruleSections(text());
  assert.ok(sections.length >= 8, `expected >= 8 rules, found ${sections.length}`);
  const seen = new Set();
  for (const section of sections) {
    assert.ok(!seen.has(section.heading), `duplicate heading ${section.heading}`);
    seen.add(section.heading);
    const hasRuleLine = /^Rule:/m.test(section.body);
    const hasRecipe = /\b(GET|POST|PUT|PATCH|DELETE)\s+\/?[\w/<>?&=.-]+|catalyst \w/m.test(section.body);
    assert.ok(hasRuleLine || hasRecipe, `rule "${section.heading}" has no Rule: line and no recipe`);
  }
});

test('required project/IaC/Slate recipes are present', () => {
  const md = text();
  for (const needle of REQUIRED) {
    assert.ok(md.includes(needle), `missing recipe fragment: ${needle}`);
  }
});

test('importing rule labels the platform assumption and the tested client behavior', () => {
  const section = ruleSections(text()).find((item) => item.heading.includes('Importing'));
  assert.ok(section, 'missing Importing rule');
  assert.match(section.body, /^Rule: .*\[UNVERIFIED\]/m, 'the delete assumption needs [UNVERIFIED] on the Rule line');
  assert.match(section.body, /\[TESTED\]/, 'tested client behavior needs [TESTED]');
  assert.doesNotMatch(`${section.heading}\n${section.body}`, /cannot be deleted/);
});

test('every Recipe and Rule line carries an evidence label', () => {
  const md = text();
  const lines = md.split('\n').filter((line) => /^(Recipe|Rule):/.test(line));
  assert.ok(lines.length > 0, 'expected recipe and rule lines');
  for (const line of lines) {
    assert.match(line, /\[(?:TESTED|UNVERIFIED|DOC|CLI|MCP-LISTED)\]/, `missing evidence label: ${line}`);
  }
});

test('no provenance fields, internal labels or dates in the shipped rules', () => {
  const md = text().replace(PUBLIC_EVIDENCE, '');
  assert.equal(EVIDENCE_LABEL.test(md), false, md.match(EVIDENCE_LABEL)?.[0]);
  assert.equal(FIELD_LABEL.test(md), false, md.match(FIELD_LABEL)?.[0]);
  assert.equal(ISO_DATE.test(md), false, md.match(ISO_DATE)?.[0]);
  assert.equal(HARDCODED_DC.test(md), false, `hard-coded DC: ${md.match(HARDCODED_DC)?.[0]}`);
});

test('shipped rules pass the generic hygiene scan', () => {
  assert.deepEqual(scanText('rules.md', text()), []);
});
