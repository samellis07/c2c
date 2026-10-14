/**
 * rules-auth: plugin/references/facts/auth.md is a shipped rules file —
 * unique headings, every rule carries a `Rule:` line or an exact recipe, every
 * `Rule:` line carries an evidence label, no other provenance wording, no
 * dates, no hard-coded DC, and no hygiene failures.
 */
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanText } from '../../scripts/check-hygiene.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const factsDir = path.join(repo, 'plugin', 'references', 'facts');
const file = path.join(factsDir, 'auth.md');

const EVIDENCE_LABEL = /\[[A-Z][A-Z0-9 -]{1,14}\]/;
const RULE_LABEL = /^Rule: .*\[(DOC|CLI|MCP-LISTED|TESTED|UNVERIFIED)\]/m;
const ALLOWED_LABEL = /\[(DOC|CLI|MCP-LISTED|TESTED|UNVERIFIED)\]/g;
const FIELD_LABEL = /^\s*[-*]?\s*\*{0,2}(status|evidence|verified|source|date)\s*\*{0,2}\s*:/im;
const ISO_DATE = /\b20\d\d-\d\d-\d\d\b/;
const HARDCODED_DC = /\b(api|console)\.catalyst\.(in|com|eu|au|jp|sa|ca)\b|\bonslate\.(in|com|eu|au|jp|sa|ca)\b/;

const REQUIRED = [
  'authentication/enable',
  'public_signup',
  'OAUTH_SCOPE_MISMATCH',
  'Get_Authentication_Configurations',
  'cors-domain',
  '"iframe":true',
  'PUT /cors-domain',
  'project-user',
  'redirect_url',
  'unhosted `/app/` path',
  'PUBLIC_SIGNUP_ERROR',
  '/role',
  'VERIFICATION_NEEDED',
  '/connections',
  'Create_Email_Configuration',
  'service worker',
  '/__catalyst/',
  'signed-out',
  'service_url',
  'signIn(',
  'login_redirect',
  'url_preference',
  'prerequisite of inviting',
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

test('auth.md exists as a regular file', () => {
  const info = lstatSync(file, { throwIfNoEntry: false });
  assert.ok(info, 'plugin/references/facts/auth.md is missing');
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
    if (hasRuleLine) {
      assert.match(section.body, RULE_LABEL, `${section.heading} Rule: line lacks an evidence label`);
    }
  }
});

test('required auth, user, role, connection, and mail recipes are present', () => {
  const md = text();
  for (const needle of REQUIRED) {
    assert.ok(md.includes(needle), `missing recipe fragment: ${needle}`);
  }
});

test('no stray provenance, dates, or hard-coded DCs in the shipped rules', () => {
  const md = text().replace(ALLOWED_LABEL, '');
  assert.equal(EVIDENCE_LABEL.test(md), false, md.match(EVIDENCE_LABEL)?.[0]);
  assert.equal(FIELD_LABEL.test(md), false, md.match(FIELD_LABEL)?.[0]);
  assert.equal(ISO_DATE.test(md), false, md.match(ISO_DATE)?.[0]);
  assert.equal(HARDCODED_DC.test(md), false, `hard-coded DC: ${md.match(HARDCODED_DC)?.[0]}`);
});

test('shipped rules pass the generic hygiene scan', () => {
  assert.deepEqual(scanText('rules.md', text()), []);
});
