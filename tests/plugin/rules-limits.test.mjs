/**
 * Behaviour of plugin/references/facts/limits.md.
 * A rule is a level-3 heading. Headings are unique. Every rule has an
 * explicit Rule: line and a Recipe: line. The file passes the generic hygiene scan.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { scanText } from '../../scripts/check-hygiene.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rel = 'plugin/references/facts/limits.md';
function load() {
  return readFileSync(path.join(repo, rel), 'utf8');
}

function headings(md) {
  const out = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6}) (.+?)\s*$/.exec(lines[i]);
    if (match) out.push({ level: match[1].length, title: match[2], line: i });
  }
  return out;
}

function ruleBodies(md) {
  const lines = md.split('\n');
  const heads = headings(md).filter((head) => head.level === 3);
  return heads.map((head, index) => {
    const next = headings(md).find((other) => other.line > head.line && other.level <= 3);
    const end = next ? next.line : lines.length;
    return { title: head.title, body: lines.slice(head.line + 1, end).join('\n') };
  });
}

test('limits rules file exists with unique headings and a recipe on every rule', () => {
  const md = load();
  assert.match(md, /^# /);
  const titles = headings(md).map((head) => head.title);
  assert.deepEqual(titles, [...new Set(titles)], `duplicate heading: ${titles.filter((title, i) => titles.indexOf(title) !== i).join(', ')}`);
  const rules = ruleBodies(md);
  assert.ok(rules.length >= 30, `expected at least 30 limit rules, got ${rules.length}`);
  for (const rule of rules) {
    assert.match(rule.body, /^Rule: /m, `${rule.title} lacks a Rule: line`);
    assert.match(rule.body, /^Recipe: /m, `${rule.title} lacks a Recipe: line`);
    assert.match(rule.body, /^Rule: .*\[(DOC|CLI|MCP-LISTED|TESTED|UNVERIFIED)\]/m, `${rule.title} Rule: line lacks an evidence label`);
  }
});

test('limits state the budgets c2c plan enforces', () => {
  const md = load();
  const must = [
    'Plan for 250 columns per table',
    'the stated default is 100 columns per table',
    'Reached max number of columns of Unique varchar type',
    'Plan for 15 foreign keys per table',
    'Plan for 130 text-type columns',
    'Plan for 4 JOIN clauses',
    'Plan for 20 columns in one SELECT',
    '300 rows',
    '200 rows',
    '100000 rows',
    '408 EXECUTION_TIME_EXCEEDED',
    '15 minutes',
    'Plan for 50 projects per account',
    'org-wide limit on table creates',
    '30 minutes',
    'API_LIMIT_REACHED',
    'max-age=31536000',
    'yyyy-MM-dd',
    'HALF_UP',
    'Plan for 10 concurrent executions',
    'Plan for 100 writes per minute per table',
    'Plan for 25 app users in Development',
    '<org-id>',
    '<project-id>',
  ];
  for (const needle of must) {
    assert.ok(md.includes(needle), `missing limit text: ${needle}`);
  }
  assert.ok(!md.includes('200 tables per organisation'), 'must not assert a 200-table count cap');
});

test('shipped rules pass the generic hygiene scan', () => {
  assert.deepEqual(scanText('rules.md', load()), []);
});

test('projects-per-account label agrees across facts, limits index, and doctor spec', () => {
  const factsRule = ruleBodies(load()).find((rule) => rule.title === 'Projects per account');
  assert.ok(factsRule, 'facts limits lack a Projects per account rule');
  const factsLabel = factsRule.body.match(/^Rule: .*?\[(DOC|TESTED|UNVERIFIED)\]/m)?.[1];
  assert.equal(factsLabel, 'DOC', `facts Projects per account is [${factsLabel}]`);
  assert.ok(hasExactHttpsHost(factsRule.body, 'docs.catalyst.zoho.com'), 'facts Projects per account names no docs source URL');

  const index = readFileSync(path.join(repo, 'plugin/references/limits.md'), 'utf8');
  const indexRow = index.match(/^### L-PROJECTS:.*\n\nValue:.*Label: \[(DOC|TESTED|UNVERIFIED)\]/m);
  assert.ok(indexRow, 'limits index lacks an L-PROJECTS row with a label');
  assert.ok(hasExactHttpsHost(index, 'docs.catalyst.zoho.com'), 'limits index L-PROJECTS names no docs source URL');

  const spec = readFileSync(path.join(repo, 'plugin/references/doctor-spec.md'), 'utf8');
  const dF1 = spec.split('\n').find((line) => line.startsWith('| D-F1 |'));
  assert.ok(dF1, 'doctor spec lacks a D-F1 row');
  const specLabel = dF1.match(/Cap 50 per account \[(DOC|TESTED|UNVERIFIED)\]/)?.[1];
  assert.ok(specLabel, 'D-F1 states no evidence label for the 50-project cap');
  assert.ok(dF1.includes('references/facts/limits.md'), 'D-F1 does not cite the facts entry');

  assert.deepEqual(
    [factsLabel, indexRow[1], specLabel],
    ['DOC', 'DOC', 'DOC'],
    'projects-per-account label diverged between facts, limits index, and doctor spec',
  );
});

/** Phrases that state the account project cap. The docs quotation "upto 50 projects" is not one of these. */
const CAP_ASSERTION = /50 projects per account|Cap 50 per account|allows 50 projects|account allows 50(?! projects)|50\/50 projects used/g;
const CAP_LABEL = /\[(DOC|TESTED|UNVERIFIED|CLI|MCP-LISTED)\]/;
const CAP_DOC_URL = 'https://docs.catalyst.zoho.com/en/cli/v1/initialize-resources/initialize-new-project/';
const CAP_SURFACES = [
  'docs/guide/02-before-you-start.md',
  'docs/guide/06-troubleshooting.md',
  'plugin/README.md',
  'plugin/references/doctor-spec.md',
  'plugin/references/facts/limits.md',
  'plugin/references/route-map.md',
  'plugin/skills/c2c-provision-and-deploy/SKILL.md',
];

function scanProjectCapLabels(rel, text) {
  const issues = [];
  for (const match of text.matchAll(new RegExp(CAP_ASSERTION.source, 'g'))) {
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 320);
    const label = after.match(CAP_LABEL);
    if (!label) {
      issues.push(`${rel}: "${match[0]}" has no evidence label`);
      continue;
    }
    if (label[1] !== 'DOC') issues.push(`${rel}: "${match[0]}" is [${label[1]}], not [DOC]`);
    const window = text.slice(match.index, match.index + match[0].length + 320);
    if (!hasExactHttpsHost(window, 'docs.catalyst.zoho.com')) issues.push(`${rel}: "${match[0]}" does not cite ${CAP_DOC_URL}`);
  }
  return issues;
}

function* markdownUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownUnder(child);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield child;
  }
}

function hasExactHttpsHost(text, hostname) {
  return [...text.matchAll(/https?:\/\/[^\s)\]}>"']+/g)].some(([value]) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === hostname;
    } catch {
      return false;
    }
  });
}

test('every 50-project cap mention is [DOC] with the CLI docs URL', () => {
  const issues = [];
  for (const root of ['docs', 'plugin']) {
    for (const file of markdownUnder(path.join(repo, root))) {
      const rel = path.relative(repo, file);
      issues.push(...scanProjectCapLabels(rel, readFileSync(file, 'utf8')));
    }
  }
  assert.deepEqual(issues, []);

  for (const rel of CAP_SURFACES) {
    const hits = readFileSync(path.join(repo, rel), 'utf8').match(new RegExp(CAP_ASSERTION.source, 'g'));
    assert.ok(hits && hits.length >= 1, `${rel} no longer states the 50-project cap`);
  }

  const index = readFileSync(path.join(repo, 'plugin/references/limits.md'), 'utf8');
  const indexSection = index.match(/### L-PROJECTS:[\s\S]*?(?=\n### )/);
  assert.ok(indexSection, 'limits index lacks an L-PROJECTS section');
  assert.match(indexSection[0], /Label: \[DOC\]/);
  assert.ok(hasExactHttpsHost(indexSection[0], 'docs.catalyst.zoho.com'), 'L-PROJECTS section dropped the docs URL');
  assert.doesNotMatch(indexSection[0], /\[(TESTED|UNVERIFIED)\]/);

  const projects = readFileSync(path.join(repo, 'plugin/references/facts/projects.md'), 'utf8');
  assert.deepEqual(scanProjectCapLabels('plugin/references/facts/projects.md', projects), []);
  assert.match(projects, /the account project cap is the Projects per account rule in `references\/facts\/limits\.md`/);
  assert.doesNotMatch(projects, /assume 50/);
});

test('project-cap scan rejects a different label, a missing label, and a missing URL', () => {
  const badLabel = scanProjectCapLabels('x.md', 'An account allows 50 projects [TESTED] (https://docs.catalyst.zoho.com/en/cli/v1/initialize-resources/initialize-new-project/).');
  assert.ok(badLabel.some((issue) => issue.includes('[TESTED]')));
  const unverified = scanProjectCapLabels('x.md', '50 projects per account [UNVERIFIED] (https://docs.catalyst.zoho.com/en/cli/v1/initialize-resources/initialize-new-project/).');
  assert.ok(unverified.some((issue) => issue.includes('[UNVERIFIED]')));
  const missing = scanProjectCapLabels('x.md', 'An account allows 50 projects.');
  assert.ok(missing.some((issue) => issue.includes('no evidence label')));
  const noUrl = scanProjectCapLabels('x.md', 'Cap 50 per account [DOC].');
  assert.ok(noUrl.some((issue) => issue.includes('does not cite')));
  const good = scanProjectCapLabels('x.md', '50/50 projects used [DOC](https://docs.catalyst.zoho.com/en/cli/v1/initialize-resources/initialize-new-project/).');
  assert.deepEqual(good, []);
});
