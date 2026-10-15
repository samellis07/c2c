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

function specCodexLabel(specText) {
  const specRow = specText.split('\n').find((l) => l.startsWith('| D-A1 |')) ?? '';
  return specRow.match(/OpenAI Codex:[^\n]*?(\[[A-Z-]+\])/)?.[1];
}

function codexCopyProblems(text, label) {
  const problems = [];
  if (!label || !text.includes(label)) problems.push(`missing verification label ${label ?? '<none>'}`);
  if (
    /\bcopies the `?skills\/?`? tree\b/i.test(text) ||
    /\bclaude-plugin`? repo[^\n]*into `?~\/\.codex/i.test(text) ||
    /\bcopy the Catalyst agent skills into [^\s]+\/skills(?![^\n.;]*\[[A-Z-]+\])/i.test(text)
  ) {
    problems.push('states settled OpenAI Codex copy procedure while spec marks repo path unverified');
  }
  return problems;
}

test('D-A1 OpenAI Codex wording matches doctor-spec verification status', () => {
  const spec = readFileSync(path.join(repo, 'plugin/references/doctor-spec.md'), 'utf8');
  const label = specCodexLabel(spec);
  assert.equal(label, '[UNVERIFIED]', 'doctor-spec D-A1 row must carry [UNVERIFIED] on the OpenAI Codex repo path');
  const skillRow = skill.split('\n').find((l) => l.startsWith('| D-A1 |')) ?? '';
  const fixMatch = source.match(/const D_A1_FIX =\s*'([^']+)'/);
  assert.ok(skillRow.length > 0 && fixMatch?.[1], 'D-A1 troubleshooting row and D_A1_FIX exist');
  assert.deepEqual(codexCopyProblems(skillRow, label), []);
  assert.deepEqual(codexCopyProblems(fixMatch[1], label), []);
});

test('negative control: planting a settled OpenAI Codex copy procedure or dropping the label fails', () => {
  const spec = readFileSync(path.join(repo, 'plugin/references/doctor-spec.md'), 'utf8');
  const label = specCodexLabel(spec);
  const skillRow = skill.split('\n').find((l) => l.startsWith('| D-A1 |')) ?? '';
  const settledSkillRow = `${skillRow} OpenAI Codex copies the skills tree from the claude-plugin repo into ~/.codex/skills.`;
  assert.notDeepEqual(codexCopyProblems(settledSkillRow, label), []);
  const unhedgedFix =
    'the official Catalyst skills are not installed. Claude Code: /plugin marketplace add catalystbyzoho/claude-plugin then /plugin install catalyst-by-zoho@catalyst-by-zoho. Codex: copy the Catalyst agent skills into ~/.codex/skills/. Cursor: clone the skills repo and set C2C_CATALYST_SKILLS_DIR=<path>/skills';
  assert.notDeepEqual(codexCopyProblems(unhedgedFix, label), []);
});
