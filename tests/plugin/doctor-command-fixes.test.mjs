import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARGV_SPEC, DOCTOR_GATE_FLAGS, argvShapeProblems } from '../../dist/cli/src/argv.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = [
  path.join(repo, 'packages/doctor/src'),
  path.join(repo, 'plugin/references/doctor-spec.md'),
  path.join(repo, 'plugin/commands/troubleshoot.md'),
];

function* filesUnder(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) yield* filesUnder(file);
    else if (file.endsWith('.ts')) yield file;
  }
}

function snippets(text, source) {
  const found = [];
  const argToken = `(?:--[a-z][a-z0-9-]*(?:[ \\t]+(?:<[^>]+>|-(?=$|[\\s\\\\;),.'"\`])))?|<[^>]+>|-(?=$|[\\s\\\\;),.'"\`]))`;
  const argSeq = `(?:[ \\t]+${argToken})*`;
  // 1. Backticked c2c commands in markdown or source comments.
  for (const match of text.matchAll(/`c2c ([a-z][a-z0-9-]*)([^`\n]*)`/g)) {
    const sub = `c2c ${match[1]}${match[2]}`.match(new RegExp(`^c2c ([a-z][a-z0-9-]*)${argSeq}`));
    if (sub) found.push({ source, command: sub[0] });
  }
  // 2. Any c2c <verb> with at least one flag (in .ts strings, comments, or .md prose).
  const flagged = new RegExp(
    `(?<![./-])\\bc2c ([a-z][a-z0-9-]*)(?:[ \\t]+(?:<[^>]+>|-(?=$|[\\s\\\\;),.'"\`])))*(?:[ \\t]+--[a-z][a-z0-9-]*(?:[ \\t]+(?:<[^>]+>|-(?=$|[\\s\\\\;),.'"\`])))?)+`,
    'g',
  );
  for (const match of text.matchAll(flagged)) {
    found.push({ source, command: match[0] });
  }
  // 3. Prose invocations preceded by run/use/then/into (excluding "run c2c from").
  const prose = new RegExp(`\\b(?:run|use|then|into)[ \\t]+(c2c[ \\t]+(?!from\\b)([a-z][a-z0-9-]*)${argSeq})`, 'gi');
  for (const match of text.matchAll(prose)) {
    found.push({ source, command: match[1].replace(/\s+/g, ' ') });
  }
  // 4. Parenthetical command mentions with an uppercase argument token, e.g. "(c2c probe P-TABLES".
  for (const match of text.matchAll(/\(\s*(c2c[ \t]+([a-z][a-z0-9-]*)[ \t]+[A-Z][A-Z0-9_-]*)/g)) {
    found.push({ source, command: `c2c ${match[2]}` });
  }
  return found;
}

function validateCommands(items, verbs) {
  const invalid = [];
  for (const { source, command } of items) {
    const [, verb, rest = ''] = command.match(/^c2c ([a-z][a-z0-9-]*)(.*)$/) ?? [];
    const parsedArgs = (rest.match(/--[a-z][a-z0-9-]*(?:\s+(?:<[^>]+>|-(?=\s|$)))?|<[^>]+>|-(?=\s|$)/g) ?? [])
      .flatMap((arg) => arg.split(/\s+/).map((part) => (part.startsWith('<') ? 'value' : part)));
    if (!verb || !verbs.has(verb)) {
      invalid.push(`${source}: dispatcher has no c2c ${verb ?? '?'} command (${command})`);
    } else if (parsedArgs.length > 0 && !ARGV_SPEC[verb]) {
      invalid.push(`${source}: parser has no command contract for ${command}`);
    } else if (ARGV_SPEC[verb] && (parsedArgs.length > 0 || ARGV_SPEC[verb].positional !== 'required')) {
      const problems = argvShapeProblems(verb, parsedArgs);
      if (problems.length) invalid.push(`${source}: ${command}: ${problems.join(', ')}`);
    }
  }
  return invalid;
}

function dispatcherGateTable(dispatchSource) {
  assert.match(dispatchSource, /function doctorGateRefusal[\s\S]*?if \(!args\.includes\('--confirm'\)\) return undefined;/);
  const table = {};
  for (const match of dispatchSource.matchAll(/^  if \((cmd === '[^)\n]+)\) \{([\s\S]*?)^  \}/gm)) {
    const [, cond, body] = match;
    const gateLine = body.split('\n').find((line) => line.includes('doctorGateRefusal('));
    if (!gateLine) continue;
    const extraFlags = [...gateLine.matchAll(/restAll\.includes\('(--[a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]);
    for (const cmdMatch of cond.matchAll(/cmd === '([a-z][a-z0-9-]*)'/g)) {
      table[cmdMatch[1]] = [...extraFlags, '--confirm'];
    }
  }
  return table;
}

function specGateTable(specText) {
  const line = specText.split('\n').find((l) => l.startsWith('- **The gate:**')) ?? '';
  const head = line.split('refuse with **exit 5**')[0] ?? '';
  const table = {};
  for (const match of head.matchAll(/`([a-z][a-z0-9-]*(?:\s+--[a-z][a-z0-9-]*)*)`/g)) {
    const [cmd, ...flags] = match[1].trim().split(/\s+/);
    table[cmd] = flags;
  }
  return table;
}

test('doctor guidance uses dispatched commands and flags accepted by the real CLI parser', () => {
  const dispatchSource = readFileSync(path.join(repo, 'packages/cli/src/c2c.ts'), 'utf8');
  const verbs = new Set([...dispatchSource.matchAll(/cmd === '([a-z][a-z0-9-]*)'/g)].map((match) => match[1]));
  const found = [];
  for (const source of SOURCES) {
    if (source.endsWith('.md')) {
      const relative = path.relative(repo, source);
      found.push(...snippets(readFileSync(source, 'utf8'), relative));
    } else {
      for (const file of filesUnder(source)) {
        const relative = path.relative(repo, file);
        found.push(...snippets(readFileSync(file, 'utf8'), relative));
      }
    }
  }

  assert.ok(found.length > 0, 'expected to find c2c command guidance');
  assert.ok(
    found.some((item) => item.source === 'packages/doctor/src/checks.ts' && item.command === 'c2c status --table-budget <n>'),
    'expected checks.ts D-F4 guidance to be scanned',
  );
  assert.deepEqual(validateCommands(found, verbs), []);
});

test('negative control: renaming a flag or command in checks.ts or doctor-spec.md fails validation', () => {
  const dispatchSource = readFileSync(path.join(repo, 'packages/cli/src/c2c.ts'), 'utf8');
  const verbs = new Set([...dispatchSource.matchAll(/cmd === '([a-z][a-z0-9-]*)'/g)].map((match) => match[1]));
  const checksSource = readFileSync(path.join(repo, 'packages/doctor/src/checks.ts'), 'utf8');

  const badFlag = checksSource.replace('c2c status --table-budget <n>', 'c2c status --not-a-real-flag <n>');
  const badFlagProblems = validateCommands(snippets(badFlag, 'packages/doctor/src/checks.ts'), verbs);
  assert.ok(
    badFlagProblems.some((p) => p.includes('unknown flag --not-a-real-flag')),
    `expected renamed flag in checks.ts to fail, got: ${JSON.stringify(badFlagProblems)}`,
  );

  const bareRecordMcp = checksSource.replace(
    'run /c2c:doctor again so the evidence is collected fresh',
    'run /c2c:doctor again so the evidence is collected fresh, then c2c doctor --record-mcp',
  );
  const recordMcpProblems = validateCommands(snippets(bareRecordMcp, 'packages/doctor/src/checks.ts'), verbs);
  assert.ok(
    recordMcpProblems.some((p) => p.includes('--record-mcp needs a value')),
    `expected bare --record-mcp in checks.ts to fail, got: ${JSON.stringify(recordMcpProblems)}`,
  );
});

test('doctor-spec gate sentence matches c2c.ts dispatcher and DOCTOR_GATE_FLAGS', () => {
  const dispatchSource = readFileSync(path.join(repo, 'packages/cli/src/c2c.ts'), 'utf8');
  const specText = readFileSync(path.join(repo, 'plugin/references/doctor-spec.md'), 'utf8');
  const fromDispatcher = dispatcherGateTable(dispatchSource);
  assert.deepEqual(fromDispatcher, DOCTOR_GATE_FLAGS);
  assert.deepEqual(specGateTable(specText), DOCTOR_GATE_FLAGS);

  // Negative controls: omitting a gated command or dropping --confirm on edit must fail.
  const missingUsers = specText.replace('`users --confirm`, ', '');
  assert.notDeepEqual(specGateTable(missingUsers), DOCTOR_GATE_FLAGS);
  const partialEdit = specText.replace('`edit --apply --confirm`', '`edit --apply`');
  assert.notDeepEqual(specGateTable(partialEdit), DOCTOR_GATE_FLAGS);
});
