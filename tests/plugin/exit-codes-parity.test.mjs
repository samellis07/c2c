/**
 * Exit-code table consistency: the customer guide is canonical, it must agree
 * with the exit-code constants in the code and with what the CLI returns, and
 * both skills mirror it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cliExits from '../../dist/cli/src/exit-codes.js';
import { GATE_EXIT, INTEGRITY_EXIT } from '../../dist/doctor/src/gate.js';
import { SMOKE_BLOCKED_EXIT } from '../../dist/deploy/src/cli.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUIDE = 'docs/guide/06-troubleshooting.md';
const GUIDE_HEADING = 'Exit codes: what the number means';
const SKILLS = [
  { file: 'plugin/skills/c2c-troubleshooting/SKILL.md', heading: 'c2c exit codes' },
  { file: 'plugin/skills/c2c-analyze-and-precheck/SKILL.md', heading: 'Exit codes' },
];
const CODES = ['0', '1', '2', '3', '4', '5', '6'];
const cli = path.join(repo, 'dist/cli/src/c2c.js');

// Every exit-code constant in the code, flattened to name -> number.
function codeConstants(modules) {
  const out = new Map();
  for (const [name, value] of Object.entries(modules)) {
    if (typeof value === 'number') out.set(name, value);
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) out.set(`${name}.${key}`, inner);
    }
  }
  return out;
}
const CONSTANTS = codeConstants({ ...cliExits, GATE_EXIT, INTEGRITY_EXIT, SMOKE_BLOCKED_EXIT });

// The words the guide row for each constant's code must contain. A new
// constant without an entry here fails the test until it is documented.
const DOCUMENTED_AS = {
  'PRECHECK_EXIT.clean': 'OK',
  'PRECHECK_EXIT.blockers': 'blockers',
  'PRECHECK_EXIT.missing': 'could not be read, for `precheck`',
  'PRECHECK_EXIT.unparsable': 'not a readable Creator export',
  'CLI_EXIT.inputMissing': 'export file that was not found',
  'CLI_EXIT.lockedExport': 'locked Marketplace export',
  'CLI_EXIT.fillTodoRefused': 'refused TODO fill',
  'CLI_EXIT.inputUnreadable': '`iac-drift`',
  GATE_EXIT: 'Doctor gate',
  INTEGRITY_EXIT: 'integrity',
  SMOKE_BLOCKED_EXIT: '`smoke`',
};

// Code -> meaning from the pipe table under a ## heading (meaning is the
// second column in the guide and in both skills).
function exitTable(text, heading) {
  const section = text.split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';
  return new Map([...section.matchAll(/^\| (\d) \| ([^|]+) \| ([^|]+) \|/gm)].map((m) => [m[1], { meaning: m[2].trim(), next: m[3].trim() }]));
}

// Every way the guide and the code disagree; empty when they match.
function parityProblems(table, constants) {
  const problems = [];
  for (const [name, code] of constants) {
    const phrase = DOCUMENTED_AS[name];
    const row = table.get(String(code));
    if (!phrase) problems.push(`${name} (${code}) has no documented meaning`);
    else if (!row) problems.push(`${name} = ${code} but the guide has no row ${code}`);
    else if (!row.meaning.includes(phrase)) problems.push(`${name} = ${code} but guide row ${code} does not mention "${phrase}"`);
  }
  for (const code of table.keys()) {
    if (![...constants.values()].includes(Number(code))) problems.push(`guide row ${code} matches no exit constant`);
  }
  return problems;
}

const guideText = readFileSync(path.join(repo, GUIDE), 'utf8');
const guideTable = exitTable(guideText, GUIDE_HEADING);

test('the guide lists exactly exit codes 0-6, each with a next step', () => {
  assert.deepEqual([...guideTable.keys()], CODES);
  assert.deepEqual([...guideTable].filter(([, row]) => !row.next || row.next === '—').map(([code]) => code), []);
});

test('the guide table matches every exit-code constant in the code', () => {
  assert.ok(CONSTANTS.size >= 11, `expected the exit constants, found ${[...CONSTANTS.keys()]}`);
  assert.deepEqual(parityProblems(guideTable, CONSTANTS), []);
});

test('negative control: a changed constant or a dropped row fails the parity check', () => {
  const moved = new Map(CONSTANTS).set('GATE_EXIT', 7);
  assert.deepEqual(parityProblems(guideTable, moved), ['GATE_EXIT = 7 but the guide has no row 7', 'guide row 5 matches no exit constant']);
  const swapped = new Map(CONSTANTS).set('PRECHECK_EXIT.missing', 1);
  assert.deepEqual(parityProblems(guideTable, swapped), ['PRECHECK_EXIT.missing = 1 but guide row 1 does not mention "could not be read, for `precheck`"']);
  const undocumented = new Map(CONSTANTS).set('CLI_EXIT.newCase', 2);
  assert.deepEqual(parityProblems(guideTable, undocumented), ['CLI_EXIT.newCase (2) has no documented meaning']);
  const dropped = new Map(guideTable);
  dropped.delete('5');
  assert.deepEqual(parityProblems(dropped, CONSTANTS), ['GATE_EXIT = 5 but the guide has no row 5']);
});

test('the CLI returns the documented code for each case', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-exit-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('C2C_')));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, encoding: 'utf8' }).status;
  try {
    const missing = path.join(dir, 'missing.ds');
    const junk = path.join(dir, 'junk.ds');
    writeFileSync(junk, 'not an export\n');
    const locked = path.join(dir, 'locked.ds');
    copyFileSync(path.join(repo, 'tests/fixtures/locked-export.html'), locked);
    const badJson = path.join(dir, 'bad.json');
    writeFileSync(badJson, '{bad');
    const template = path.join(dir, 'template.json');
    writeFileSync(template, JSON.stringify({ components: { Datastore: [{ type: 'table', name: 'a' }] } }));
    const extra = path.join(dir, 'extra.json');
    writeFileSync(extra, JSON.stringify({ components: { Datastore: [{ type: 'table', name: 'a' }, { type: 'table', name: 'b' }] } }));
    const ds = path.join(repo, 'fixtures/redistributable/library-application-system/library_application.ds');
    const scope = ['--project', '1', '--org', '1', '--dc', 'in'];

    const cases = [
      [['analyze', missing], cliExits.CLI_EXIT.inputMissing],
      [['parse', missing], cliExits.CLI_EXIT.inputMissing],
      [['plan', missing, '--dc', 'in', '--out', path.join(dir, 'out')], cliExits.CLI_EXIT.inputMissing],
      [['analyze', locked], cliExits.CLI_EXIT.lockedExport],
      [['precheck', locked], cliExits.CLI_EXIT.lockedExport],
      [['precheck', missing], cliExits.PRECHECK_EXIT.missing],
      [['precheck', junk], cliExits.PRECHECK_EXIT.unparsable],
      [['cutover-checklist', missing], cliExits.CLI_EXIT.inputUnreadable],
      [['proof', missing], cliExits.CLI_EXIT.inputUnreadable],
      [['iac-drift', badJson, badJson], cliExits.CLI_EXIT.inputUnreadable],
      [['iac-drift', extra, template], 1],
      [['iac-drift', template, extra], 2],
      [['--bogus'], 2],
      [['deploy', ds, ...scope, '--confirm'], GATE_EXIT],
      [['migrate-data', ds, ...scope, '--confirm'], GATE_EXIT],
      [['--verify-vendor', dir], INTEGRITY_EXIT],
    ];
    const got = cases.map(([args]) => [args[0], run(...args)]);
    assert.deepEqual(got, cases.map(([args, code]) => [args[0], code]));
    // Each returned code has a row in the guide.
    for (const [, code] of got) assert.ok(guideTable.has(String(code)), `exit ${code} is not in the guide`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const { file, heading } of SKILLS) {
  test(`${file} lists the same codes 0-6 with identical meanings and points at the guide`, () => {
    const skillText = readFileSync(path.join(repo, file), 'utf8');
    const meanings = (table) => [...table].map(([code, row]) => [code, row.meaning]);
    assert.deepEqual(meanings(exitTable(skillText, heading)), meanings(guideTable));
    assert.ok(skillText.includes(GUIDE), `missing reference to ${GUIDE}`);
  });
}

test('no exit-code section still calls the live doctor gate planned', () => {
  for (const { file, heading } of [{ file: GUIDE, heading: GUIDE_HEADING }, ...SKILLS]) {
    const text = readFileSync(path.join(repo, file), 'utf8');
    const section = text.split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';
    assert.ok(!/planned/i.test(section), `${file} exit-code section says "planned"`);
  }
});
