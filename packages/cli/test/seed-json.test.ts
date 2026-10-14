/**
 * `c2c seed --json`: the machine report carries blockers and warnings, the
 * exit code is 1 when a form is blocked, and the written seed.json records
 * every blocked table under `c2c_blocked`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(repo, 'dist/cli/src/c2c.js');
// The `node c2c.js` children below share a V8 compile cache so each e2e spawn
// does not recompile the whole CLI (ignored on runtimes without it).
process.env.NODE_COMPILE_CACHE ??= path.join(tmpdir(), 'c2c-node-compile-cache');

const DS = `application "Demo"
{
\tform Parent
\t{
\t\tmust have Picks
\t\t(
\t\t\ttype = checkboxes
\t\t)
\t}
\tform Opt
\t{
\t\tParent
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Parent.Name
\t\t)
\t}
}
`;

test('c2c seed --json prints blockers and warnings and exits 1', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-seed-json-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ds = path.join(dir, 'app.ds');
  writeFileSync(ds, DS);
  const out = path.join(dir, 'out');
  const run = spawnSync(process.execPath, [cli, 'seed', ds, '--out', out, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout) as {
    blockers: { form: string; field?: string; message: string }[];
    warnings: { form: string; field?: string; message: string }[];
  };
  assert.equal(report.blockers.length, 1);
  assert.equal(report.blockers[0].form, 'Parent');
  assert.equal(report.blockers[0].field, 'Picks');
  assert.match(report.blockers[0].message, /required choice field has no choices/);
  const warning = report.warnings.find((w) => w.form === 'Opt' && w.field === 'Parent');
  assert.match(warning?.message ?? '', /parent form Parent is blocked; lookup left empty/);
  const seedFile = JSON.parse(readFileSync(path.join(out, 'seed.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(seedFile.c2c_blocked, [
    { form: 'Parent', field: 'Picks', reason: 'required choice field has no choices; add choices in the source app or make it optional' },
  ]);
});
