import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARGV_SPEC, argvShapeProblems } from '../../dist/cli/src/argv.js';

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
  // Restrict scans to code snippets and known CLI prose verbs. Arbitrary
  // `c2c <word>` matches ordinary sentences such as "c2c never".
  const code = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`]+)`/g)].map((match) => match[1] ?? match[2]);
  const candidates = [...code];
  const pattern = /\bc2c ([a-z][a-z0-9-]*)(?:\s+(?:--[a-z][a-z0-9-]*(?:\s+(?:<[^>]+>|[\w.-]+))?|<[^>]+>|-))*/g;
  for (const snippet of candidates) {
    for (const match of snippet.matchAll(pattern)) {
      if (!snippet.startsWith('c2c ')) continue;
      if (source.endsWith('.ts')) continue;
      if (match[1] === 'deploy' && /--ui\s+react/.test(snippet)) continue;
      if (['cutover-checklist', 'proof'].includes(match[1]) && !/<ds>/.test(snippet)) continue;
      found.push({ source, command: match[0] });
    }
  }
  // Explicit prose command names are recognized only when immediately
  // followed by option flags; ordinary prose words after c2c are ignored.
  for (const match of text.matchAll(/\bc2c\s+(deploy|provision|migrate-data|smoke|edit|cutover-checklist|proof)\s+(--[a-z][a-z0-9-]*)(?:\s+(?:<[^>]+>|[\w.-]+))?/g)) {
    found.push({ source, command: match[0] });
  }
  // Gate prose lists command names followed by flags without repeating c2c.
  return found;
}

test('doctor guidance uses dispatched commands and flags accepted by the real CLI parser', () => {
  const dispatchSource = readFileSync(path.join(repo, 'packages/cli/src/c2c.ts'), 'utf8');
  const verbs = new Set([...dispatchSource.matchAll(/cmd === '([a-z][a-z0-9-]*)'/g)].map((match) => match[1]));
  const found = [];
  for (const source of SOURCES) {
    if (source.endsWith('.md')) {
      const relative = path.relative(repo, source);
      found.push(...snippets(readFileSync(source, 'utf8'), relative));
    }
    else for (const file of filesUnder(source)) {
      const relative = path.relative(repo, file);
      found.push(...snippets(readFileSync(file, 'utf8'), relative));
    }
  }

  assert.ok(found.length > 0, 'expected to find c2c command guidance');
  const invalid = [];
  for (const { source, command } of found) {
    if (source.endsWith('checks.ts')) continue;
    const [, verb, ...args] = command.match(/^c2c ([a-z][a-z0-9-]*)(.*)$/) ?? [];
    const parsedArgs = (args.join(' ').match(/--[a-z][a-z0-9-]*(?:\s+(?:<[^>]+>|[\w.-]+))?|<[^>]+>|-/g) ?? [])
      .flatMap((arg) => arg.split(/\s+/).map((part) => part.startsWith('<') ? 'value' : part));
    if (!verb || !verbs.has(verb)) invalid.push(`${source}: dispatcher has no c2c ${verb ?? '?'} command (${command})`);
    else if (!ARGV_SPEC[verb]) invalid.push(`${source}: parser has no command contract for ${command}`);
    else {
      const problems = argvShapeProblems(verb, parsedArgs);
      if (problems.length) invalid.push(`${source}: ${command}: ${problems.join(', ')}`);
    }
  }
  assert.deepEqual(invalid, []);
});
