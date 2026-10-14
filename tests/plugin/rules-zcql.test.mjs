/**
 * Rules behaviour: plugin/references/facts/zcql.md must read as plain
 * imperative system rules (method, path, headers, body, polling, success
 * signal, error codes) and passes the generic hygiene scan.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
