import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const plugin = path.join(repo, 'plugin');
const groups = ['analyze/plan', 'provision/deploy', 'data/cutover', 'doctor/preflight', 'fill-todos', 'status/troubleshoot', 'maintainer-only'];
const humanSteps = ['Accept the admin invite', 'Sign in once', 'Run the in-app check and paste its code', 'Verify the mail sender (only if your app sends mail)'];
const expected = {
  'analyze/plan': { commands: ['commands/analyze.md', 'commands/plan.md'], skills: ['skills/c2c-analyze-and-precheck/SKILL.md', 'skills/c2c-migrate/SKILL.md', 'skills/c2c-edit/SKILL.md'], verbs: ['analyze', 'precheck', 'plan', 'edit'] },
  'provision/deploy': { commands: ['commands/migrate.md'], skills: ['skills/c2c-migrate/SKILL.md', 'skills/c2c-provision-and-deploy/SKILL.md', 'skills/c2c-auth-and-access/SKILL.md', 'skills/c2c-ui/SKILL.md', 'skills/c2c-integrations/SKILL.md'], verbs: ['provision', 'deploy', 'auth', 'users', 'ui', 'ui-react'] },
  'data/cutover': { commands: ['commands/verify.md', 'commands/rollback.md'], skills: ['skills/c2c-schema-and-data/SKILL.md', 'skills/c2c-verify-and-cutover/SKILL.md'], verbs: ['schema', 'migrate-data', 'seed', 'sync-delta', 'smoke', 'proof', 'cutover-checklist', 'rollback-export', 'verify', 'verify-behavior'] },
  'doctor/preflight': { commands: ['commands/doctor.md'], skills: ['skills/c2c-preflight/SKILL.md'], verbs: ['doctor'] },
  'fill-todos': { commands: [], skills: ['skills/c2c-logic/SKILL.md'], verbs: ['fill-todos'] },
  'status/troubleshoot': { commands: ['commands/troubleshoot.md'], skills: ['skills/c2c-troubleshooting/SKILL.md', 'skills/c2c-status/SKILL.md'], verbs: ['status'] },
  'maintainer-only': { commands: [], skills: [], verbs: ['parse', 'corpus', 'features', 'iac-drift', 'schema-corpus', 'migration-report', 'deluge', 'score-ui', 'ui-corpus', '--verify-vendor'] },
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

function cliHelp() {
  const cli = path.join(repo, 'dist/cli/src/c2c.js');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'FORCE_COLOR' && key !== 'NO_COLOR'));
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, `c2c --help failed: ${result.stderr}`);
  return result.stdout;
}

/** Opening `c2c ...` lines of the help text; wrapped continuation lines never start with c2c. */
function helpOpenings(help) {
  return help.split('\n').filter((line) => /^\s*(?:usage: )?c2c \S/.test(line));
}

function openingVerb(line) {
  return line.trim().match(/^(?:usage: )?c2c ([^ <\[]+)/)[1];
}

function openingFlags(line) {
  const rest = line.trim().replace(/^(?:usage: )?c2c [^ <\[]+/, '');
  return new Set([...rest.matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0]));
}

/** The line shape with every flag and every <...> / [...] slot removed. */
function openingShape(line) {
  return line.replace(/--[a-z][a-z0-9-]*/g, '').replace(/<[^<>]*>|\[[^\[\]]*\]/g, '').replace(/\s+/g, ' ').trim();
}

test('help and command map agree: every help verb is mapped, nothing mapped is gone, no repeats', () => {
  const rows = parseMap(readFileSync(path.join(plugin, 'C2C.md'), 'utf8'));
  const customer = new Set(rows.filter((r) => r.group !== 'maintainer-only').flatMap((r) => words(r.verbs)));
  const maintainer = new Set(rows.filter((r) => r.group === 'maintainer-only').flatMap((r) => words(r.verbs)));
  const help = cliHelp();
  const openings = helpOpenings(help);
  const helpVerbs = new Set(openings.map(openingVerb));
  for (const verb of helpVerbs) {
    assert.ok(customer.has(verb) || maintainer.has(verb), `c2c ${verb} is in --help but in neither the command map nor the maintainer-only row`);
  }
  for (const verb of [...customer, ...maintainer]) {
    assert.ok(helpVerbs.has(verb), `map names c2c ${verb} but --help no longer lists it`);
  }
  const seen = new Set();
  for (const line of openings) {
    assert.ok(!seen.has(line), `duplicate help line: ${line.trim()}`);
    seen.add(line);
  }
  const byShape = new Map();
  for (const line of openings) {
    const key = `${openingVerb(line)} ${openingShape(line)}`;
    if (!byShape.has(key)) byShape.set(key, []);
    byShape.get(key).push(line);
  }
  for (const lines of byShape.values()) {
    for (let i = 0; i < lines.length; i++) {
      for (let j = 0; j < lines.length; j++) {
        if (i === j) continue;
        const a = openingFlags(lines[i]);
        const b = openingFlags(lines[j]);
        if (a.size < b.size && [...a].every((flag) => b.has(flag))) {
          assert.fail(`redundant help line (flags subsumed by another ${openingVerb(lines[i])} line): ${lines[i].trim()} << ${lines[j].trim()}`);
        }
      }
    }
  }
});

test('customer help hides the operator-only record-mcp flow', () => {
  const help = cliHelp();
  assert.doesNotMatch(help, /record-mcp|--operator/, 'operator-only flags must stay out of c2c --help');
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
