import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const plugin = path.join(repo, 'plugin');
const groups = ['analyze/plan', 'provision/deploy', 'data/cutover', 'doctor/preflight', 'fill-todos', 'status/troubleshoot'];
const humanSteps = ['Accept the admin invite', 'Sign in once', 'Run the in-app check and paste its code', 'Verify the mail sender (only if your app sends mail)'];
const expected = {
  'analyze/plan': { commands: ['commands/analyze.md', 'commands/plan.md'], skills: ['skills/c2c-analyze-and-precheck/SKILL.md', 'skills/c2c-migrate/SKILL.md', 'skills/c2c-edit/SKILL.md'], verbs: ['analyze', 'precheck', 'plan', 'edit'] },
  'provision/deploy': { commands: ['commands/migrate.md'], skills: ['skills/c2c-migrate/SKILL.md', 'skills/c2c-provision-and-deploy/SKILL.md', 'skills/c2c-auth-and-access/SKILL.md', 'skills/c2c-ui/SKILL.md', 'skills/c2c-integrations/SKILL.md'], verbs: ['provision', 'deploy', 'auth', 'users', 'ui', 'ui-react'] },
  'data/cutover': { commands: ['commands/verify.md', 'commands/rollback.md'], skills: ['skills/c2c-schema-and-data/SKILL.md', 'skills/c2c-verify-and-cutover/SKILL.md'], verbs: ['schema', 'migrate-data', 'seed', 'sync-delta', 'smoke', 'proof', 'cutover-checklist', 'rollback-export'] },
  'doctor/preflight': { commands: ['commands/doctor.md'], skills: ['skills/c2c-preflight/SKILL.md'], verbs: ['doctor'] },
  'fill-todos': { commands: [], skills: ['skills/c2c-logic/SKILL.md'], verbs: ['fill-todos'] },
  'status/troubleshoot': { commands: ['commands/troubleshoot.md'], skills: ['skills/c2c-troubleshooting/SKILL.md', 'skills/c2c-status/SKILL.md'], verbs: ['status'] },
};
function parseMap(markdown) {
  const lines = markdown.split('\n');
  const i = lines.findIndex((line) => line.startsWith('|') && /command group/i.test(line));
  assert.notEqual(i, -1, 'command map table missing');
  const rows = [];
  for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) {
    const cells = lines[j].split('|').slice(1, -1).map((s) => s.trim());
    if (cells.length === 5) rows.push({ group: cells[0].replaceAll('`', ''), command: cells[1], skill: cells[2], verbs: cells[3], human: cells[4], raw: lines[j] });
  }
  return rows;
}
function paths(cell) { return [...cell.matchAll(/`([^`]+\.md)`/g)].map((m) => m[1]); }
function words(cell) { return cell.replaceAll('`', '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'none').map((s) => s.replace(/^c2c\s+/, '')); }
function normalizedWhitespace(value) { return value.trim().replace(/\s+/g, ' '); }
function validate(rows) {
  assert.ok(rows.length);
  const verbs = new Set([...readFileSync(path.join(repo, 'packages/cli/src/c2c.ts'), 'utf8').matchAll(/\bcmd\s*===\s*'([^']+)'/g)].map((m) => m[1]));
  for (const group of groups) {
    const groupRows = rows.filter((r) => r.group === group);
    assert.ok(groupRows.length, `group missing: ${group}`);
    for (const [key, field] of [['commands', 'command'], ['skills', 'skill'], ['verbs', 'verbs']]) {
      const actual = [...new Set(groupRows.flatMap((r) => key === 'verbs' ? words(r[field]) : paths(r[field])))].sort();
      assert.deepEqual(actual, [...expected[group][key]].sort(), `${group} ${key} differ`);
    }
  }
  for (const row of rows) {
    for (const p of [...paths(row.command), ...paths(row.skill)]) assert.ok(existsSync(path.join(plugin, p)), `missing ${p}`);
    for (const verb of words(row.verbs)) assert.ok(verbs.has(verb), `unknown c2c verb ${verb}`);
    for (const step of row.human.replaceAll('`', '').split(',').map((s) => s.trim()).filter((s) => s !== 'none')) {
      assert.ok(humanSteps.includes(normalizedWhitespace(step)), `unapproved human step: ${step}`);
    }
  }
  const namedCommands = new Set(rows.flatMap((r) => paths(r.command)));
  const namedSkills = new Set(rows.flatMap((r) => paths(r.skill)));
  for (const name of readdirSync(path.join(plugin, 'commands')).filter((f) => f.endsWith('.md')).map((f) => `commands/${f}`)) assert.ok(namedCommands.has(name), `command omitted: ${name}`);
  for (const name of readdirSync(path.join(plugin, 'skills')).filter((d) => existsSync(path.join(plugin, 'skills', d, 'SKILL.md'))).map((d) => `skills/${d}/SKILL.md`)) assert.ok(namedSkills.has(name), `skill omitted: ${name}`);
}

test('public command map matches commands, skills, CLI verbs and approved human steps', () => {
  const rows = parseMap(readFileSync(path.join(plugin, 'C2C.md'), 'utf8'));
  validate(rows);
  const readme = readFileSync(path.join(plugin, 'README.md'), 'utf8');
  assert.match(readme, /\[command map\]\(C2C\.md#4-command-map\)/);
});

test('validation fails when a command or skill row is removed', () => {
  const rows = parseMap(readFileSync(path.join(plugin, 'C2C.md'), 'utf8'));
  assert.throws(() => validate(rows.filter((r) => !r.command.includes('analyze.md'))));
  assert.throws(() => validate(rows.filter((r) => !r.skill.includes('c2c-edit'))));
});

test('validation rejects unknown verbs and human steps', () => {
  const rows = parseMap(readFileSync(path.join(plugin, 'C2C.md'), 'utf8'));
  rows[0] = { ...rows[0], verbs: 'bogusverb' };
  assert.throws(() => {
    const cliVerbs = new Set([...readFileSync(path.join(repo, 'packages/cli/src/c2c.ts'), 'utf8').matchAll(/\bcmd\s*===\s*'([^']+)'/g)].map((m) => m[1]));
    for (const row of rows) for (const verb of words(row.verbs)) assert.ok(cliVerbs.has(verb), `unknown c2c verb ${verb}`);
  }, /unknown c2c verb/);
  const valid = parseMap(readFileSync(path.join(plugin, 'C2C.md'), 'utf8'));
  valid[0] = { ...valid[0], human: 'Click arbitrary button' };
  assert.throws(() => validate(valid), /unapproved human step/);
  valid[0] = { ...valid[0], human: 'Start services once' };
  assert.throws(() => validate(valid), /unapproved human step/);
});
