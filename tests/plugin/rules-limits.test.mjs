/**
 * Behaviour of plugin/references/facts/limits.md.
 * A rule is a level-3 heading. Headings are unique. Every rule has an
 * explicit Rule: line and a Recipe: line. The file passes the generic hygiene scan.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
    assert.match(rule.body, /^Rule: .*\[(DOC|TESTED|UNVERIFIED)\]/m, `${rule.title} Rule: line lacks an evidence label`);
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
    'stated ZCQL select cap is 30 columns',
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
    'stated Data Store write rate is 100 requests per minute',
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
