/**
 * Rules behaviour: plugin/references/facts/jobs-and-files.md must read as
 * plain imperative system rules (method, path, headers, body, polling,
 * success signal, error codes) and passes the generic hygiene scan.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanText } from '../../scripts/check-hygiene.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = path.join(repo, 'plugin/references/facts/jobs-and-files.md');

function sections(text) {
  const heads = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
  const bodies = text.split(/^### .+$/m).slice(1);
  return { heads, bodies };
}

test('jobs-and-files.md exists with unique rule headings', () => {
  const text = readFileSync(file, 'utf8');
  const { heads } = sections(text);
  assert.ok(heads.length >= 8, `expected >=8 rules, saw ${heads.length}`);
  assert.deepEqual([...new Set(heads)], heads, 'rule headings must be unique');
});

test('jobs-and-files.md: every rule carries a recipe or explicit rule line', () => {
  const text = readFileSync(file, 'utf8');
  const { heads, bodies } = sections(text);
  bodies.forEach((body, i) => {
    assert.match(body, /(Recipe|Rule):/, `rule "${heads[i]}" needs a Recipe: or Rule: line`);
  });
});

test('jobs-and-files.md passes the generic hygiene scan', () => {
  assert.deepEqual(scanText('jobs-and-files.md', readFileSync(file, 'utf8')), []);
});

test('jobs-and-files.md: cron create uses job_meta plus job_detail', () => {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('job_meta'), 'cron create must name job_meta');
  assert.ok(text.includes('job_detail'), 'cron create must name job_detail');
  assert.ok(!text.includes('job_details'), 'there is no job_details field');
});

test('jobs-and-files.md: legacy cron error mapped to POST /cron only', () => {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('cron_url_details cannot be null'), 'must keep the legacy error string');
  assert.match(text, /legacy `POST \/cron`/, 'error must be mapped to the legacy POST /cron path');
});

test('jobs-and-files.md: token envelope names the versioned Accept header', () => {
  const text = readFileSync(file, 'utf8');
  assert.ok(
    text.includes('Accept: application/vnd.catalyst.v2+json'),
    'token envelope must name the versioned Accept header',
  );
});
