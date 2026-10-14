/**
 * Plugin eval tests for the router skill.
 *
 * - Frontmatter lint for every skill/command (names, descriptions,
 *   versions equal to plugin.json).
 * - Router contract: the router (c2c-migrate SKILL.md plus C2C.md, which the
 *   router requires reading once per session) must instruct: run c2c doctor
 *   first; refuse anything past plan when doctor is red; never log in for
 *   the user; never handle secrets.
 * - `claude plugin eval` case schema check over plugin/evals/ (offline).
 *   Live `claude plugin eval` needs model calls on your own
 *   credential (each case is a full claude child run), so it is NOT run
 *   here; plugin/evals/README.md records the exact command.
 *
 * RED-first: the mutation tests below prove the checker fails when a
 * rule is removed from the router text. Each mutation test copies the
 * plugin files to a temp dir, applies the mutation there, runs the check
 * on the mutated copies, and asserts it FAILS.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanDirectory } from '../../scripts/check-hygiene.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginDir = path.join(repo, 'plugin');
const skillsDir = path.join(pluginDir, 'skills');
const commandsDir = path.join(pluginDir, 'commands');
const evalsDir = path.join(pluginDir, 'evals');

const pluginManifest = JSON.parse(readFileSync(path.join(pluginDir, '.claude-plugin/plugin.json'), 'utf8'));
const PLUGIN_VERSION = pluginManifest.version;

function read(file) {
  return readFileSync(file, 'utf8');
}

/** Split leading `---` YAML-ish frontmatter from the body. Returns { fm, body }. */
export function splitFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { fm: '', body: text };
  return { fm: match[1], body: text.slice(match[0].length) };
}

/**
 * Minimal `key: value` frontmatter reader. Parses line by line so a key
 * with no value on its own line (e.g. a bare `description:`) reads as
 * missing instead of capturing the next line's key as its value (`\s`
 * in a multiline regex crosses the newline).
 */
export function fmGet(fm, key) {
  const line = fm
    .split('\n')
    .map((raw) => raw.replace(/\r$/, ''))
    .find((candidate) => candidate.startsWith(`${key}:`));
  if (line === undefined) return undefined;
  let value = line.slice(key.length + 1).trim();
  if (!value) return undefined;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!value) return undefined;
  return value;
}

/** Lint one skill's SKILL.md text. Returns failure strings (empty = ok). */
export function lintSkillFrontmatter({ dirName, text, expectedVersion }) {
  const failures = [];
  const { fm } = splitFrontmatter(text);
  if (!fm) failures.push(`${dirName}: missing frontmatter block`);
  const name = fmGet(fm, 'name');
  if (!name) failures.push(`${dirName}: frontmatter name is missing`);
  else if (name !== dirName) failures.push(`${dirName}: frontmatter name "${name}" != directory`);
  const description = fmGet(fm, 'description');
  if (!description) failures.push(`${dirName}: frontmatter description is missing or empty`);
  const version = (fm.match(/^metadata:\r?\n\s+version:\s*"([^"]+)"/m) || [])[1];
  if (!version) failures.push(`${dirName}: metadata.version is missing`);
  else if (version !== expectedVersion) {
    failures.push(`${dirName}: metadata.version "${version}" != plugin.json ${expectedVersion}`);
  }
  return failures;
}

/** Lint one command file's text. Returns failure strings (empty = ok). */
export function lintCommandFrontmatter({ fileName, text }) {
  const failures = [];
  const { fm, body } = splitFrontmatter(text);
  if (!fm) failures.push(`${fileName}: missing frontmatter block`);
  const description = fmGet(fm, 'description');
  if (!description) failures.push(`${fileName}: frontmatter description is missing or empty`);
  if (!/c2c-[a-z-]+|bin\/c2c/.test(body)) {
    failures.push(`${fileName}: body routes nowhere (no c2c skill load, no bin/c2c call)`);
  }
  return failures;
}

/**
 * Router contract checker. `router` is c2c-migrate/SKILL.md, `rules` is
 * C2C.md (the router mandates reading it once per session; its rules win).
 * Returns failure strings naming each violated rule (empty = ok).
 */
/**
 * One line states the red-doctor refusal when it names the refusal
 * (refuse/stop), the boundary (past plan / before step 3, provision,
 * deploy), and the gate (doctor red) together. Checked per line so a
 * distant "(exit 5)" cannot stand in for the sentence.
 */
export function hasRedRefusalSentence(text) {
  return text.split('\n').some(
    (line) =>
      /refus|stop/i.test(line) &&
      /past\s+`?plan`?|before step 3|before provision|before deploy/i.test(line) &&
      /doctor/i.test(line) &&
      /red/i.test(line),
  );
}

/** Numbered rule block (`n. ...` up to the next numbered rule) of C2C.md. */
export function ruleBlock(rules, n) {
  const lines = rules.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${n}\\.\\s`).test(line));
  if (start === -1) return '';
  let end = lines.findIndex((line, index) => index > start && /^\d+\.\s/.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

export function checkRouterContract({ router, rules }) {
  const failures = [];
  const bundle = `${router}\n${rules}`;
  const has = (patterns) => patterns.some((pattern) => pattern.test(bundle));
  const routerHas = (patterns) => patterns.some((pattern) => pattern.test(router));
  // 1. Doctor first: the ROUTER itself must say so (routing is its job).
  if (
    !routerHas([/doctor first/i, /starts with the doctor gate/i, /run step 0/i, /\bstep 0\b.*doctor/i]) ||
    !routerHas([/c2c-preflight/i, /\/c2c:doctor/i, /c2c doctor/i])
  ) {
    failures.push('doctor-first: router must instruct running c2c doctor (c2c-preflight) before anything else');
  }
  // 2. Refuse anything past plan while doctor is red. The refusal sentence
  // must appear in BOTH files (router states it, C2C rules win on conflict),
  // independently of the "(exit 5)" gate, which is still required too.
  if (!hasRedRefusalSentence(router) || !hasRedRefusalSentence(rules) || !/exit 5/i.test(bundle)) {
    failures.push('red-refuses: router must refuse anything past plan when doctor is red/stale (exit 5)');
  }
  // 3. Never log in for the user.
  if (!has([/customer does every login/i, /never type a password/i, /never complete an OAuth/i, /never log in/i])) {
    failures.push('no-login: router must forbid logging in / completing auth for the user');
  }
  // 4. Never handle secrets. Anchored to C2C.md rule 3 itself (its
  // heading/bullet), not incidental text: the router's env-values cell
  // ("I will not read or print the values") must not satisfy this.
  const secretsBlock = ruleBlock(rules, 3);
  if (!/never handle secrets/i.test(secretsBlock) || !/secret|credential|token/i.test(secretsBlock)) {
    failures.push('no-secrets: router must forbid reading/printing secrets, tokens, credential files');
  }
  return failures;
}

// --- Frontmatter lint over the real tree ---

test('every skill has a name, description, and plugin.json version', () => {
  const skills = readdirSync(skillsDir).filter((name) => name !== 'evals').sort();
  assert.ok(skills.length > 0, 'plugin/skills holds no skills');
  const failures = [];
  const names = new Set();
  for (const dirName of skills) {
    const text = read(path.join(skillsDir, dirName, 'SKILL.md'));
    failures.push(...lintSkillFrontmatter({ dirName, text, expectedVersion: PLUGIN_VERSION }));
    const { fm } = splitFrontmatter(text);
    const name = fmGet(fm, 'name');
    if (name) {
      assert.ok(!names.has(name), `duplicate skill name "${name}"`);
      names.add(name);
    }
  }
  assert.deepEqual(failures, []);
});

test('router and preflight skill descriptions route through the doctor gate', () => {
  for (const [dirName, keyword] of [['c2c-migrate', 'doctor'], ['c2c-preflight', 'doctor']]) {
    const { fm } = splitFrontmatter(read(path.join(skillsDir, dirName, 'SKILL.md')));
    const description = fmGet(fm, 'description') ?? '';
    assert.ok(
      description.toLowerCase().includes(keyword),
      `${dirName} description must mention "${keyword}" so the agent routes correctly`,
    );
  }
});

test('every command has a description and routes into a c2c skill', () => {
  const files = readdirSync(commandsDir).filter((name) => name.endsWith('.md')).sort();
  assert.ok(files.length > 0, 'plugin/commands holds no commands');
  const failures = [];
  for (const fileName of files) {
    failures.push(...lintCommandFrontmatter({ fileName, text: read(path.join(commandsDir, fileName)) }));
  }
  assert.deepEqual(failures, []);
});

// --- Router contract over the real text ---

test('router contract holds on the shipped skill text', () => {
  const router = read(path.join(skillsDir, 'c2c-migrate/SKILL.md'));
  const rules = read(path.join(pluginDir, 'C2C.md'));
  assert.deepEqual(checkRouterContract({ router, rules }), []);
});

// --- RED-first mutations: the checker must catch a weakened router ---

test('RED: router text without the doctor-first rule fails the contract', () => {
  const router = read(path.join(skillsDir, 'c2c-migrate/SKILL.md'));
  const rules = read(path.join(pluginDir, 'C2C.md'));
  assert.deepEqual(checkRouterContract({ router, rules }), [], 'precondition: base contract is green');
  const stripped = router
    .split('\n')
    .filter((line) => !/doctor/i.test(line))
    .join('\n');
  assert.ok(stripped.length < router.length, 'precondition: stripping removed doctor lines');
  const failures = checkRouterContract({ router: stripped, rules });
  assert.ok(failures.length > 0, 'a router that omits doctor-first must fail');
  assert.ok(failures.some((failure) => failure.startsWith('doctor-first')), `failures name doctor-first: ${failures}`);
});

test('RED: router text without the no-login rule fails the contract', () => {
  const router = read(path.join(skillsDir, 'c2c-migrate/SKILL.md'));
  const rules = read(path.join(pluginDir, 'C2C.md'));
  const strippedRules = rules
    .split('\n')
    .filter((line) => !/login|password|OAuth/i.test(line))
    .join('\n');
  const failures = checkRouterContract({ router, rules: strippedRules });
  assert.ok(failures.length > 0, 'a router that omits no-login must fail');
  assert.ok(failures.some((failure) => failure.startsWith('no-login')), `failures name no-login: ${failures}`);
});

test('RED: router text without the secrets rule fails the contract', () => {
  const router = read(path.join(skillsDir, 'c2c-migrate/SKILL.md'));
  const rules = read(path.join(pluginDir, 'C2C.md'));
  const strippedRouter = router
    .split('\n')
    .filter((line) => !/will not read or print/i.test(line))
    .join('\n');
  const strippedRules = rules
    .split('\n')
    .filter((line) => !/secret|credential|token/i.test(line))
    .join('\n');
  const failures = checkRouterContract({ router: strippedRouter, rules: strippedRules });
  assert.ok(failures.length > 0, 'a router that omits no-secrets must fail');
  assert.ok(failures.some((failure) => failure.startsWith('no-secrets')), `failures name no-secrets: ${failures}`);
});

test('RED: reworded past-plan refusal fails while (exit 5) stays', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-red-refuses-'));
  try {
    const routerFile = path.join(root, 'SKILL.md');
    const rulesFile = path.join(root, 'C2C.md');
    writeFileSync(routerFile, read(path.join(skillsDir, 'c2c-migrate/SKILL.md')));
    writeFileSync(rulesFile, read(path.join(pluginDir, 'C2C.md')));
    assert.deepEqual(
      checkRouterContract({ router: read(routerFile), rules: read(rulesFile) }),
      [],
      'precondition: unmutated temp copies are green',
    );
    // Reword the refusal sentences in BOTH files, leaving every "(exit 5)".
    const router = read(routerFile).replace(
      'refuse anything past `plan` while doctor is red: stop before step 3.',
      'hold work ahead of the third phase until the checks are green.',
    );
    const rules = read(rulesFile).replace(
      'Refuse anything past `plan` while doctor is red: stop and run nothing further until it is green.',
      'Ask the user to fix the checks, then continue in order.',
    );
    assert.notEqual(router, read(routerFile), 'precondition: router mutation applied');
    assert.notEqual(rules, read(rulesFile), 'precondition: rules mutation applied');
    writeFileSync(routerFile, router);
    writeFileSync(rulesFile, rules);
    assert.ok(/exit 5/i.test(`${router}\n${rules}`), 'precondition: (exit 5) is still present');
    const failures = checkRouterContract({ router: read(routerFile), rules: read(rulesFile) });
    assert.ok(failures.length > 0, 'a reworded past-plan refusal must fail even with (exit 5) present');
    assert.ok(failures.some((failure) => failure.startsWith('red-refuses')), `failures name red-refuses: ${failures}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RED: removing only C2C rule 3 fails the contract', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-no-secrets-'));
  try {
    const routerFile = path.join(root, 'SKILL.md');
    const rulesFile = path.join(root, 'C2C.md');
    writeFileSync(routerFile, read(path.join(skillsDir, 'c2c-migrate/SKILL.md')));
    writeFileSync(rulesFile, read(path.join(pluginDir, 'C2C.md')));
    assert.deepEqual(
      checkRouterContract({ router: read(routerFile), rules: read(rulesFile) }),
      [],
      'precondition: unmutated temp copies are green',
    );
    // Reword rule 3 so it names no secret, credential, token, or echo.
    // The router env-values cell ("I will not read or print the values")
    // stays untouched and must not satisfy the check on its own.
    const rules = read(rulesFile)
      .split('\n')
      .map((line) =>
        line.startsWith('3. ')
          ? '3. **Handle local files carefully.** Never open paths outside the workspace. Env values for functions go into a local file that the user fills and `c2c deploy --function-env <file>` reads once.'
          : line,
      )
      .join('\n');
    assert.notEqual(rules, read(rulesFile), 'precondition: rule 3 mutation applied');
    writeFileSync(rulesFile, rules);
    const mutated = read(rulesFile);
    assert.ok(
      /will not read or print/i.test(read(routerFile)),
      'precondition: the router env-values cell is still present',
    );
    assert.ok(
      !/secret|credential|token/i.test(ruleBlock(mutated, 3)),
      'precondition: rule 3 names no secret, credential, or token',
    );
    const failures = checkRouterContract({ router: read(routerFile), rules: mutated });
    assert.ok(failures.length > 0, 'removing only C2C rule 3 must fail');
    assert.ok(failures.some((failure) => failure.startsWith('no-secrets')), `failures name no-secrets: ${failures}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RED: empty description values fail the frontmatter lint', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-empty-desc-'));
  try {
    const skillFile = path.join(root, 'SKILL.md');
    const commandFile = path.join(root, 'plan.md');
    writeFileSync(skillFile, read(path.join(skillsDir, 'c2c-logic/SKILL.md')));
    writeFileSync(commandFile, read(path.join(commandsDir, 'plan.md')));
    // A bare `description:` followed by another key: the old multiline
    // `\s` reader captured the next key ("metadata:" / "argument-hint: …")
    // as the value and stayed green.
    const skill = read(skillFile).replace(/^description:.*$/m, 'description:');
    const command = read(commandFile).replace(/^description:.*$/m, 'description:');
    assert.notEqual(skill, read(skillFile), 'precondition: skill mutation applied');
    assert.notEqual(command, read(commandFile), 'precondition: command mutation applied');
    writeFileSync(skillFile, skill);
    writeFileSync(commandFile, command);
    const mutatedSkill = read(skillFile);
    const mutatedCommand = read(commandFile);
    assert.equal(
      fmGet(splitFrontmatter(mutatedSkill).fm, 'description'),
      undefined,
      'precondition: bare skill description reads as missing',
    );
    assert.equal(
      fmGet(splitFrontmatter(mutatedCommand).fm, 'description'),
      undefined,
      'precondition: bare command description reads as missing',
    );
    const skillFailures = lintSkillFrontmatter({
      dirName: 'c2c-logic',
      text: mutatedSkill,
      expectedVersion: PLUGIN_VERSION,
    });
    assert.ok(skillFailures.length > 0, 'a skill with a bare description: must fail');
    assert.ok(
      skillFailures.some((failure) => failure.includes('description')),
      `failures name description: ${skillFailures}`,
    );
    const commandFailures = lintCommandFrontmatter({ fileName: 'plan.md', text: mutatedCommand });
    assert.ok(commandFailures.length > 0, 'a command with a bare description: must fail');
    assert.ok(
      commandFailures.some((failure) => failure.includes('description')),
      `failures name description: ${commandFailures}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RED: version drift and nameless skills fail the frontmatter lint', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-lint-'));
  try {
    const badVersion = '---\nname: c2c-migrate\ndescription: x\nmetadata:\n  version: "9.9.9"\n---\n\n# x\n';
    assert.ok(
      lintSkillFrontmatter({ dirName: 'c2c-migrate', text: badVersion, expectedVersion: PLUGIN_VERSION }).some(
        (failure) => failure.includes('9.9.9'),
      ),
      'version drift must fail',
    );
    const noName = '---\ndescription: x\nmetadata:\n  version: "0.2.0"\n---\n\n# x\n';
    assert.ok(
      lintSkillFrontmatter({ dirName: 'c2c-migrate', text: noName, expectedVersion: PLUGIN_VERSION }).some(
        (failure) => failure.includes('name'),
      ),
      'missing name must fail',
    );
    const deadCommand = '---\ndescription: x\n---\n\nJust some prose with no route.\n';
    assert.ok(
      lintCommandFrontmatter({ fileName: 'dead.md', text: deadCommand }).length > 0,
      'a command that routes nowhere must fail',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- `claude plugin eval` cases: offline schema check ---

/**
 * Expected eval cases (prompt.md + graders/*.md, the shape
 * `claude plugin eval init --bare` scaffolds). Each grader must pin its
 * rule so a run that violates the router contract cannot pass.
 */
const EVAL_CASES = [
  { dir: 'router-doctor-first', graderMustMention: ['doctor', 'c2c-preflight', 'first'] },
  { dir: 'router-red-doctor-refuses', graderMustMention: ['red', 'refus', 'plan'] },
  { dir: 'router-no-login-no-secrets', graderMustMention: ['login', 'secret', 'refus'] },
  { dir: 'router-offline-plan-preview', graderMustMention: ['preview', 'red', 'plan'] },
  {
    dir: 'skill-provision-and-deploy', graderMustMention: ['read back', 'create-missing', 'yes'],
    verbatimCitations: [
      '- **Plan → apply → read back → record.** Nothing is "done" until its read-back matches.',
      '- **List → match → create-missing.** Never delete, rename or alter existing resources. Update mode is create-missing only.',
      '- **Every write needs the user\'s yes.** Batch the yes per phase ("create these 4 resources?"), not per HTTP call, but never across phases.',
    ],
  },
  {
    dir: 'skill-schema-and-data', graderMustMention: ['budget', 'fail', 'foreign-key'],
    verbatimCitations: ['### Budgets (the plan fails closed)', '- Any budget FAIL in the plan.'],
  },
  {
    dir: 'skill-status', graderMustMention: ['read-only', 'checklist', 'fake'],
    verbatimCitations: ['The status command reports the read-only health and status of a Catalyst project.'],
  },
  {
    dir: 'skill-troubleshooting', graderMustMention: ['exact', 'read-only', 'unsupported'],
    verbatimCitations: ['6. **Not in the index?** Say so. Collect the exact text and context, mark the step blocked, and suggest a probe or a report to the maintainers via the issue tracker. Do not declare the feature unsupported (C2C.md rule 9).'],
  },
  {
    dir: 'skill-ui', graderMustMention: ['app url', 'stop', 'authorized domain'],
    verbatimCitations: ['- No App URL recorded → stop before auth (the domain cannot be authorized).'],
  },
  {
    dir: 'skill-verify-and-cutover', graderMustMention: ['explicit yes', 'production', 'console'],
    verbatimCitations: ["Requires a green doctor. Every probe and every cutover action needs the user's explicit yes.", '2. **Production promotion is a console action by the user:** Catalyst console → Deploy to Production (a payment method is required). c2c cannot do it: no CLI/API for functions or schema [TESTED]. The CLI does have `catalyst deploy slate --production` and `ds:import --production` [CLI] for later updates.'],
  },
];

/** Tools a deterministic offline eval prompt may use: read-only, no network. */
const EVAL_SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Skill']);

test('plugin/evals cases have offline-safe prompts and graders with pinned skill rules', () => {
  const failures = [];
  for (const { dir, graderMustMention, verbatimCitations = [] } of EVAL_CASES) {
    const caseDir = path.join(evalsDir, dir);
    let prompt;
    try {
      prompt = read(path.join(caseDir, 'prompt.md'));
    } catch {
      failures.push(`${dir}: prompt.md is missing`);
      continue;
    }
    const { fm, body } = splitFrontmatter(prompt);
    if (!fm) failures.push(`${dir}/prompt.md: missing frontmatter block`);
    const maxTurns = Number(fmGet(fm, 'max_turns'));
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 25) {
      failures.push(`${dir}/prompt.md: max_turns must be an integer 1..25`);
    }
    const toolsMatch = fm.match(/^allowed_tools:\s*\[(.*)\]\s*$/m);
    if (!toolsMatch) {
      failures.push(`${dir}/prompt.md: allowed_tools [...] is missing`);
    } else {
      for (const tool of toolsMatch[1].split(',').map((name) => name.trim()).filter(Boolean)) {
        if (!EVAL_SAFE_TOOLS.has(tool)) {
          failures.push(`${dir}/prompt.md: tool "${tool}" is not offline-safe (allowed: Read, Glob, Grep, Skill)`);
        }
      }
    }
    if (!body.trim()) failures.push(`${dir}/prompt.md: prompt body is empty`);
    let graderFiles = [];
    try {
      graderFiles = readdirSync(path.join(caseDir, 'graders')).filter((name) => name.endsWith('.md')).sort();
    } catch {
      failures.push(`${dir}: graders/ holds no grader file`);
      continue;
    }
    if (graderFiles.length === 0) failures.push(`${dir}: graders/ holds no grader file`);
    const graderText = graderFiles.map((name) => read(path.join(caseDir, 'graders', name))).join('\n');
    for (const graderFile of graderFiles) {
      const { fm: graderFm, body: graderBody } = splitFrontmatter(
        read(path.join(caseDir, 'graders', graderFile)),
      );
      if (!fmGet(graderFm, 'type')) failures.push(`${dir}/graders/${graderFile}: grader frontmatter type is missing`);
      if (!graderBody.trim()) failures.push(`${dir}/graders/${graderFile}: grader body is empty`);
    }
    for (const keyword of graderMustMention) {
      if (!graderText.toLowerCase().includes(keyword)) {
        failures.push(`${dir}: no grader pins "${keyword}" (a violating run could pass)`);
      }
    }
    for (const citation of verbatimCitations) {
      const skill = read(path.join(skillsDir, dir.replace(/^skill-/, 'c2c-') + '/SKILL.md'));
      if (!skill.includes(citation)) failures.push(`${dir}: test citation is not present verbatim in its skill`);
      if (!graderText.includes(citation)) failures.push(`${dir}: no grader cites the skill line verbatim`);
    }
  }
  assert.deepEqual(failures, []);
});

test('every eval dir in plugin/evals has prompt.md and graders/criteria.md', () => {
  const entries = readdirSync(evalsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(entries.length >= 11, `expected at least 11 eval dirs, got ${entries.length}`);
  const failures = [];
  for (const dir of entries) {
    const caseDir = path.join(evalsDir, dir);
    let prompt;
    try {
      prompt = read(path.join(caseDir, 'prompt.md'));
    } catch {
      failures.push(`${dir}: prompt.md is missing`);
      continue;
    }
    const { fm, body } = splitFrontmatter(prompt);
    if (!fm) failures.push(`${dir}/prompt.md: missing frontmatter block`);
    const maxTurns = Number(fmGet(fm, 'max_turns'));
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 25) {
      failures.push(`${dir}/prompt.md: max_turns must be an integer 1..25`);
    }
    const toolsMatch = fm.match(/^allowed_tools:\s*\[(.*)\]\s*$/m);
    if (!toolsMatch) {
      failures.push(`${dir}/prompt.md: allowed_tools [...] is missing`);
    } else {
      for (const tool of toolsMatch[1].split(',').map((name) => name.trim()).filter(Boolean)) {
        if (!EVAL_SAFE_TOOLS.has(tool)) {
          failures.push(`${dir}/prompt.md: tool "${tool}" is not offline-safe (allowed: Read, Glob, Grep, Skill)`);
        }
      }
    }
    if (!body.trim()) failures.push(`${dir}/prompt.md: prompt body is empty`);

    let grader;
    try {
      grader = read(path.join(caseDir, 'graders/criteria.md'));
    } catch {
      failures.push(`${dir}: graders/criteria.md is missing`);
      continue;
    }
    const { fm: graderFm, body: graderBody } = splitFrontmatter(grader);
    if (!fmGet(graderFm, 'type')) failures.push(`${dir}/graders/criteria.md: grader frontmatter type is missing`);
    if (!graderBody.trim()) failures.push(`${dir}/graders/criteria.md: grader body is empty`);
  }
  assert.deepEqual(failures, []);
});

test('skill eval criteria cite skill lines verbatim', () => {
  const skillRules = [
    {
      evalDir: 'c2c-analyze-and-precheck',
      skill: 'c2c-analyze-and-precheck',
      verbatim: "- **BLOCKING latent fault** → the fix belongs in Creator (it breaks Creator's own export/duplicate too). Recommend: fix in Creator, re-export, re-run precheck. c2c never auto-guesses missing arguments (precheck rule 01).",
    },
    {
      evalDir: 'c2c-auth-and-access',
      skill: 'c2c-auth-and-access',
      verbatim: "- **Creator portal users:** re-invited, never imported with passwords. Users missing in Catalyst must not fall back to a super admin silently; list them as pending.",
    },
    {
      evalDir: 'c2c-edit',
      skill: 'c2c-edit',
      verbatim: 'Generated files are never edited by hand: a hand edit is lost on the next regenerate.',
    },
    {
      evalDir: 'c2c-integrations',
      skill: 'c2c-integrations',
      verbatim: '- Never call Creator from a generated Catalyst function in the request path.',
    },
    {
      evalDir: 'c2c-logic',
      skill: 'c2c-logic',
      verbatim: '- **ZCQL:** unwrap every result row by table name ([ZC-01]); `LIKE` uses `*` (a `%` pattern silently matches nothing [TESTED; ZC-02]; [L-ZCQL-LIKE](../../references/limits.md#l-zcql-like-zcql-like) → map); paging is keyset by ROWID (300 rows per SELECT, offsets 1-based [TESTED; ZC-03/ZC-04]; [L-ZCQL-ROWS](../../references/limits.md#l-zcql-rows-zcql-rows-per-select) / [L-ZCQL-OFFSET](../../references/limits.md#l-zcql-offset-zcql-offset) → split); UPDATE/DELETE loop until the affected count is 0 (300-row silent cap; [L-ZCQL-WRITE-BATCH](../../references/limits.md#l-zcql-write-batch-zcql-updatedelete) → batch; [ZC-09]); use IN-subqueries for traversal filters ([L-ZCQL-SUBQUERIES](../../references/limits.md#l-zcql-subqueries-zcql-subqueries-in-where) → allow; [ZC-07]); re-read after any write error ([L-ZCQL-WRITE-VERIFY](../../references/limits.md#l-zcql-write-verify-zcql-insert-error-after-write) → verify; error-after-write [TESTED; ZC-11]).',
    },
    {
      evalDir: 'c2c-migrate',
      skill: 'c2c-migrate',
      verbatim: "- **One app = one project.** If the target project holds tables not in this app's plan (doctor D-F3), stop and ask the user to create a new project `c2c-<app-link>` in the console. Never merge apps.",
    },
    {
      evalDir: 'c2c-preflight',
      skill: 'c2c-preflight',
      verbatim: 'Doctor is green only when the CLI says so after `--mcp-observed`. Never declare green from your own reading.',
    },
  ];

  const failures = [];
  for (const { evalDir, skill, verbatim } of skillRules) {
    const skillContent = read(path.join(skillsDir, skill, 'SKILL.md'));
    if (!skillContent.includes(verbatim)) {
      failures.push(`${skill}: verbatim line not found in SKILL.md: "${verbatim}"`);
    }
    const criteriaContent = read(path.join(evalsDir, evalDir, 'graders/criteria.md'));
    if (!criteriaContent.includes(verbatim)) {
      failures.push(`${evalDir}: graders/criteria.md does not cite skill line verbatim: "${verbatim}"`);
    }
  }
  assert.deepEqual(failures, []);
});

test('plugin/evals passes the generic hygiene scan', () => {
  assert.deepEqual(scanDirectory(evalsDir), []);
});

test('plugin/evals README marks the live model run as not run offline, with the exact command', () => {
  const readme = read(path.join(evalsDir, 'README.md'));
  assert.ok(/not run offline/i.test(readme), 'README must say the live eval is not run offline');
  assert.ok(readme.includes('claude plugin eval'), 'README must record the exact live eval command');
});
