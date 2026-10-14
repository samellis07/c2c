/**
 * Behaviour of plugin/references/facts/errors.md.
 * A rule is a level-3 heading. Headings are unique. Every rule has
 * Rule:, Cause:, Fix:, and Recipe: lines. The file passes the generic hygiene scan.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanText } from '../../scripts/check-hygiene.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rel = 'plugin/references/facts/errors.md';
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
  const all = headings(md);
  return all.filter((head) => head.level === 3).map((head) => {
    const next = all.find((other) => other.line > head.line && other.level <= 3);
    const end = next ? next.line : lines.length;
    return { title: head.title, body: lines.slice(head.line + 1, end).join('\n') };
  });
}

test('error rules file exists with unique headings and cause, fix, recipe', () => {
  const md = load();
  assert.match(md, /^# /);
  const titles = headings(md).map((head) => head.title);
  assert.deepEqual(titles, [...new Set(titles)]);
  const rules = ruleBodies(md);
  assert.ok(rules.length >= 40, `expected at least 40 error rules, got ${rules.length}`);
  for (const rule of rules) {
    assert.match(rule.body, /^Rule: /m, `${rule.title} lacks Rule:`);
    assert.match(rule.body, /^Cause: /m, `${rule.title} lacks Cause:`);
    assert.match(rule.body, /^Fix: /m, `${rule.title} lacks Fix:`);
    assert.match(rule.body, /^Recipe: /m, `${rule.title} lacks Recipe:`);
  }
});

test('error rules quote the exact Catalyst and Creator strings', () => {
  const md = load();
  const must = [
    '409 DUPLICATE_ENTRY',
    '400 PROJECT_CREATION_NOT_ALLOWED',
    'Internal error occurred while importing the project',
    '401 OAUTH_SCOPE_MISMATCH',
    '401 AUTHENTICATION_FAILURE',
    '404 INVALID_URL_PATTERN',
    '406 INVALID_OPERATION',
    '403 INVALID_OPERATION',
    'Reached max number of columns of Unique varchar type',
    '409 DUPLICATE_VALUE',
    '403 MANDATORY_MISSING',
    '400 INVALID_INPUT',
    'date value expected',
    '400 JSON_PARSE_ERROR',
    '400 PATTERN_NOT_MATCHED',
    'For input string: "nu"',
    'data too long for column',
    '408 EXECUTION_TIME_EXCEEDED',
    '403 VERIFICATION_NEEDED',
    '403 PUBLIC_SIGNUP_ERROR',
    '400 INVALID_REQUEST_METHOD',
    '400 BROWSER_COOKIES_DISABLED',
    'TypeError: Cannot read properties of undefined (reading \'bucket_name\')',
    'TypeError: existingSlates.findIndex is not a function',
    'An unexpected error has occurred. Kindly contact Catalyst support',
    'cron_url_details cannot be null',
    'ORGID_HEADER_UNAVAILABLE',
    'API_LIMIT_REACHED',
    'Table Join Limitation',
    'More than 30 select columns are not allowed',
    'Throttle Limit Reached',
    'Concurrency limit reached for the feature COMPONENT',
    '{"error":"sign in required"}',
    'The number of arguments for',
    'Void function',
    'success message',
    'DS IMPORT :: DS FILE LIMIT EXCEEDED',
    'UPLOAD_RULE_NOT_CONFIGURED',
    'No Data Available',
    'Improper Statement',
    '401 NO_ACCESS',
    'Please access the Slate service in your project',
    '<org-id>',
    '<project-id>',
  ];
  for (const needle of must) {
    assert.ok(md.includes(needle), `missing error text: ${needle}`);
  }
});

test('email and bare encrypted are invalid column types, not a unique-column refusal', () => {
  const rules = ruleBodies(load());
  const typeError = rules.find((rule) => rule.title === '`400 PATTERN_NOT_MATCHED` on column type');
  assert.ok(typeError, 'missing column-type PATTERN_NOT_MATCHED rule');
  assert.match(typeError.body, /`email` and bare `encrypted` are not valid column data_type names/);
  assert.match(typeError.body, /The encrypted column type is `encrypted text`/);
  assert.match(typeError.body, /returned even when is_unique is set/);
  assert.match(typeError.body, /app-side email check/);
  assert.match(typeError.body, /Do not drop is_unique to clear this error/);

  const textUnique = rules.find((rule) => rule.title === '`Text column cannot be Unique`');
  assert.ok(textUnique, 'missing text-unique rule');
  assert.doesNotMatch(textUnique.body, /PATTERN_NOT_MATCHED/);
  assert.doesNotMatch(textUnique.body, /email and encrypted unique columns/);
});

test('shipped rules pass the generic hygiene scan', () => {
  assert.deepEqual(scanText('rules.md', load()), []);
});
