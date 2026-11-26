import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-ignore shared JavaScript test helper
import { cleanCliEnv } from './cli-test-env.mjs';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'dist/cli/src/c2c.js');
const PATH_COMMANDS = ['analyze', 'parse', 'corpus', 'features', 'schema', 'schema-corpus', 'deluge', 'ui', 'score-ui', 'ui-react', 'auth', 'ui-corpus'];

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cleanCliEnv() });
}

for (const cmd of PATH_COMMANDS) {
  test(`${cmd}: a flag in the path position is an unknown-flag usage error (exit 2), not a missing file`, () => {
    const r = run(cmd, '--bogus-flag');
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), `c2c ${cmd}: unknown flag --bogus-flag (run c2c ${cmd} --help)`);
  });

  test(`${cmd}: a missing path is one line with exit 1 and no stack`, () => {
    const r = run(cmd, '/nonexistent/c2c-path-usage');
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), 'c2c: no such file or directory: /nonexistent/c2c-path-usage');
    assert.doesNotMatch(r.stderr, /^\s*at /m);
  });
}

test('a missing path or a flag that carries control characters is printed on one safe line', () => {
  const esc = String.fromCharCode(27);
  const nl = String.fromCharCode(10);
  const bidi = String.fromCharCode(0x202e);
  for (const cmd of PATH_COMMANDS) {
    const missing = run(cmd, `/nonexistent/${esc}[31mred${nl}forged: line${bidi}`);
    assert.equal(missing.status, 1, `${cmd} exit`);
    assert.doesNotMatch(missing.stderr, new RegExp(`[${esc}${bidi}]`), `${cmd}: no raw escape or direction control`);
    assert.equal(missing.stderr.trim().split(nl).length, 1, `${cmd}: the forged second line is not a line of its own`);
    const flag = run(cmd, `--bad${esc}[31m`);
    assert.equal(flag.status, 2, `${cmd} flag exit`);
    assert.doesNotMatch(flag.stderr, new RegExp(esc), `${cmd}: flag text is escaped`);
  }
});
