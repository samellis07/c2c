import assert from 'node:assert/strict';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = path.join(repo, 'plugin', 'skills', 'c2c-status', 'SKILL.md');

function text() {
  return readFileSync(file, 'utf8');
}

test('status skill document exists and covers the required flags and behaviour', () => {
  const info = lstatSync(file, { throwIfNoEntry: false });
  assert.ok(info, 'plugin/skills/c2c-status/SKILL.md is missing');
  assert.ok(info.isFile() && !info.isSymbolicLink());

  const md = text();
  assert.match(md, /--fake/, 'must mention --fake');
  assert.match(md, /--table-budget/, 'must mention --table-budget');
  assert.match(md, /--json/, 'must mention --json');
  assert.match(md, /checklist/i, 'must mention the checklist fallback');
});
