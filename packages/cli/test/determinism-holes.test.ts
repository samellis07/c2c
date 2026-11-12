import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { generate } from '../../deluge/src/generate.js';
import { analyze } from '../src/analyze.js';
import { buildMigrationReport } from '../src/migration-report.js';

// The `node c2c.js` children below share a V8 compile cache so each e2e spawn
// does not recompile the whole CLI (ignored on runtimes without it).
process.env.NODE_COMPILE_CACHE ??= join(tmpdir(), 'c2c-node-compile-cache');

/**
 * Every hole `generate` counts, `analyze` and `c2c migration-report` count too.
 * These apps have no workflow Deluge text, so a text-only walk sees nothing.
 */

const FIELD_RULE_ONLY = `application "T"
{
\tform Item
\t{
\t\tQty
\t\t(
\t\t\ttype = number
\t\t)
\t\tNotes
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRules as "Rules"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\tfield rules
\t\t\t\t{
\t\t\t\t\tactions (unknownCall().missingMethod() > 1)
\t\t\t\t\t{
\t\t\t\t\t\thide Notes;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

const APPROVER_FIELD_ONLY = `application "T"
{
\tform Item
\t{
\t\tManager
\t\t(
\t\t\ttype = email
\t\t)
\t}
\tworkflow
\t{
\t\tapproval
\t\t{
\t\t\tApprove_Item as "Approve"
\t\t\t{
\t\t\t\ttype = approval
\t\t\t\tform = Item
\t\t\t\ton level 1
\t\t\t\t{
\t\t\t\t\tapprovers
\t\t\t\t\t(
\t\t\t\t\t\tfield = Manager
\t\t\t\t\t)
\t\t\t\t\ton approve
\t\t\t\t\t{
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

function embeddedReport(text: string): { deterministic: boolean; todoCount: number } {
  const file = generate(deriveIr(parse(text))).files.find((item) => item.path === 'migration-report.json');
  assert.ok(file);
  return JSON.parse(file.source) as { deterministic: boolean; todoCount: number };
}

function assertNonDeterministicEverywhere(text: string, construct: string): void {
  const ir = deriveIr(parse(text));
  const generated = generate(ir);
  assert.deepEqual(
    generated.todos.map((item) => item.construct),
    [construct],
    'generate counts exactly the one hole',
  );

  const embedded = embeddedReport(text);
  assert.equal(embedded.deterministic, false, 'migration-report.json');
  assert.equal(embedded.todoCount, 1);

  const report = analyze(ir);
  assert.equal(report.determinism.deterministic, false, 'analyze');
  assert.equal(report.determinism.todoCount, 1);
  assert.deepEqual(report.determinism.todoKinds, [{ construct, count: 1 }]);

  const aggregate = buildMigrationReport([{ name: 'one', ir }], 'synthetic');
  assert.equal(aggregate.apps[0]?.deterministic, false);
  assert.equal(aggregate.aggregate.todoTotal, 1);

  const dir = mkdtempSync(join(tmpdir(), 'c2c-holes-'));
  try {
    mkdirSync(join(dir, 'one'));
    writeFileSync(join(dir, 'one', 'app.ds'), text);
    const cli = join(repoRoot(), 'dist/cli/src/c2c.js');
    const run = spawnSync(process.execPath, [cli, 'migration-report', dir, '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const printed = JSON.parse(run.stdout) as { apps: { deterministic: boolean; todoCount: number }[]; aggregate: { deterministicApps: number } };
    assert.equal(printed.apps[0]?.deterministic, false, 'c2c migration-report');
    assert.equal(printed.apps[0]?.todoCount, 1);
    assert.equal(printed.aggregate.deterministicApps, 0);
    const analyzed = spawnSync(process.execPath, [cli, 'analyze', join(dir, 'one', 'app.ds'), '--json'], { encoding: 'utf8' });
    assert.equal(analyzed.status, 0, analyzed.stderr);
    assert.equal((JSON.parse(analyzed.stdout) as { determinism: { deterministic: boolean } }).determinism.deterministic, false, 'c2c analyze');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an untranslatable field rule is a counted TODO: non-deterministic in analyze, migration-report.json and c2c migration-report', () => {
  const ir = deriveIr(parse(FIELD_RULE_ONLY));
  assert.equal(ir.workflows.length, 1);
  assert.equal(ir.workflows[0]?.deluge, null);
  const client = generate(ir).files.find((file) => file.source.includes('shim.todo('));
  assert.ok(client, 'the field rule is emitted as a shim.todo hole');
  assertNonDeterministicEverywhere(FIELD_RULE_ONLY, 'field-rule-condition');
});

test('an approval whose only residual is an approver field (deluge null) is non-deterministic everywhere', () => {
  const ir = deriveIr(parse(APPROVER_FIELD_ONLY));
  assert.ok(ir.workflows.length >= 1);
  assert.ok(ir.workflows.every((workflow) => !workflow.deluge?.text.trim()), 'no Deluge text to slice');
  assertNonDeterministicEverywhere(APPROVER_FIELD_ONLY, 'approver-field');
});
