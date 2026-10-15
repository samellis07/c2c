/** Two-way parity between failing doctor ids and the troubleshooting skill. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(path.join(repo, 'packages/doctor/src/checks.ts'), 'utf8');
const skill = readFileSync(path.join(repo, 'plugin/skills/c2c-troubleshooting/SKILL.md'), 'utf8');

// Fail IDs are emitted by fail('D-*') or fail('D-*', ...), including calls
// split over lines. Ignore strings in comments and unrelated prose by requiring
// the actual fail helper call syntax used throughout checks.ts.
function failIds(text) {
  return new Set([...text.matchAll(/\bfail\(\s*['"](D-[A-Z][A-Z0-9]*)['"]/g)].map((m) => m[1]));
}

function routeIds(text) {
  const section = text.split('## Doctor check failures\n')[1]?.split('\n## ')[0] ?? '';
  return new Set([...section.matchAll(/^\| (D-[A-Z][A-Z0-9]*) \|/gm)].map((m) => m[1]));
}

test('every failing doctor check has a troubleshooting route', () => {
  assert.deepEqual([...failIds(source)].filter((id) => !routeIds(skill).has(id)), []);
});

test('every troubleshooting check id exists as a doctor failure', () => {
  assert.deepEqual([...routeIds(skill)].filter((id) => !failIds(source).has(id)), []);
});

test('negative control: removing a route row makes the parity check fail', () => {
  assert.ok(routeIds(skill).has('D-C1'));
  const broken = skill.split('\n').filter((line) => !line.startsWith('| D-C1 |')).join('\n');
  assert.deepEqual([...failIds(source)].filter((id) => !routeIds(broken).has(id)), ['D-C1']);
});

test('D-A1 OpenAI Codex wording matches doctor-spec verification status', () => {
  const spec = readFileSync(path.join(repo, 'plugin/references/doctor-spec.md'), 'utf8');
  const specRow = spec.split('\n').find((l) => l.startsWith('| D-A1 |')) ?? '';
  const skillRow = skill.split('\n').find((l) => l.startsWith('| D-A1 |')) ?? '';
  assert.ok(specRow.length > 0 && skillRow.length > 0, 'D-A1 rows exist');
  // While the spec marks the OpenAI Codex source repo path as unverified (PROBE FIRST),
  // the route must not state a specific repo/copy procedure as settled fact.
  if (specRow.includes('PROBE FIRST')) {
    assert.match(skillRow, /PROBE FIRST|not (yet )?verified|unverified/i);
    assert.doesNotMatch(skillRow, /copies the `?skills\/?`? tree|claude-plugin repo.*into `~\/\.codex/);
  }
});
