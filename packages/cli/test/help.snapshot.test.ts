import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DISPATCH_COMMANDS } from '../src/commands.js';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'dist/cli/src/c2c.js');
const snapshot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/cli/test/golden/help.snapshot.json');
const dispatcher = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/cli/src/c2c.ts');

interface HelpResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHelp(args: string[]): HelpResult {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'FORCE_COLOR' && key !== 'NO_COLOR'));
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('global and subcommand help output matches the checked-in snapshot', () => {
  const expected = JSON.parse(readFileSync(snapshot, 'utf8')) as {
    global: HelpResult;
    commands: Record<string, HelpResult>;
  };
  assert.deepEqual(runHelp(['--help']), expected.global, 'c2c --help');
  assert.deepEqual(runHelp(['-h']), expected.global, 'c2c -h');

  assert.deepEqual(Object.keys(expected.commands).sort(), [...DISPATCH_COMMANDS].sort());
  const source = readFileSync(dispatcher, 'utf8');
  const dispatched = new Set<string>();
  for (const block of source.matchAll(/if \(cmd === ('[^']+'(?: \|\| cmd === '[^']+')*)\)/g)) {
    for (const match of block[1].matchAll(/'([^']+)'/g)) {
      if (match[1] !== '--help' && match[1] !== '-h') dispatched.add(match[1]);
    }
  }
  assert.deepEqual([...DISPATCH_COMMANDS].sort(), [...dispatched].sort(), 'command table matches c2c.ts dispatch branches');
  for (const [command, help] of Object.entries(expected.commands)) {
    const actual = runHelp([command, '--help']);
    assert.equal(actual.status, 0, `${command} --help should succeed`);
    assert.doesNotMatch(actual.stderr, /(?:Error:|\bat\s+\S+\s*\()/, `${command} --help should not print a stack`);
    assert.deepEqual(actual, help, `${command} --help`);
  }
});

test('a help-looking value is not treated as a help request', () => {
  const consumed = runHelp(['provision', '--name', '--help']);
  assert.equal(consumed.status, 2);
  assert.doesNotMatch(consumed.stdout, /c2c provision/);

  const requested = runHelp(['provision', '--help']);
  assert.equal(requested.status, 0);
  assert.match(requested.stdout, /c2c provision/);
});
