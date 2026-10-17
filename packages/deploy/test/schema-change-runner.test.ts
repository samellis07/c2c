/**
 * Change the app later without losing data: the offline schema-change runner
 * over the in-process harness, the `c2c plan --previous` gate, and the faults
 * a data-losing redeploy must fail on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployCli, type Io } from '../src/cli.js';
import { planCli } from '../src/offline-plan.js';
import { LIBRARY_CHANGES, formatSchemaChangeReport, runSchemaChangeScenarios, type SchemaChange } from '../src/schema-change-runner.js';
import type { StoreDriver } from '../src/delta.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LIBRARY = join(root, 'fixtures/redistributable/library-application-system/library_application.ds');
const SDK = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-schema-change-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function change(id: string): SchemaChange {
  return LIBRARY_CHANGES.find((c) => c.id === id)!;
}

function io(): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    env: {},
    spawn: () => {
      throw new Error('no spawn');
    },
    fetch: () => Promise.reject(new Error('no network')),
  } as unknown as Io & { out: string[]; err: string[] };
}

test('the library sequence keeps every row and value, and each destructive step is gated on a verified backup', async (t) => {
  const report = await runSchemaChangeScenarios({ ds: LIBRARY, workDir: scratch(t), sdkPath: SDK });
  assert.deepEqual(
    report.scenarios.map((s) => [s.id, s.status]),
    LIBRARY_CHANGES.map((c) => [c.id, 'PASS']),
    formatSchemaChangeReport(report),
  );
  for (const s of report.scenarios) {
    assert.deepEqual(s.lost, [], s.id);
    assert.deepEqual(s.rows.after, s.rows.before, `${s.id}: row counts`);
    assert.ok(!s.evidence.some((e) => e.startsWith('FAIL')), s.id);
  }
  for (const id of ['rename-field', 'delete-field']) {
    const evidence = report.scenarios.find((s) => s.id === id)!.evidence;
    const backupAt = evidence.findIndex((e) => e.startsWith('ok: a verified rollback export exists before the store changes'));
    const appliedAt = evidence.findIndex((e) => e.startsWith('store delta applied:'));
    assert.ok(backupAt >= 0 && appliedAt > backupAt, `${id}: the backup is verified before the store changes`);
    assert.ok(evidence.some((e) => e.startsWith('ok: c2c plan --previous refuses without --allow-destructive')), id);
  }
  assert.ok(report.scenarios.find((s) => s.id === 'picklist-remove')!.evidence.some((e) => /note: Book\.Genre: "Biography" removed/.test(e)));
  assert.deepEqual(
    report.gaps.map((g) => g.id),
    ['picklist-stored-values', 'live-rename-field', 'live-delete-field', 'deployed-model-not-recorded', 'creator-rename-undetectable'],
  );
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.gaps, report.gaps.length);
});

test('a redeploy whose store rename loses the values fails the runner', async (t) => {
  const lossyRename = (driver: StoreDriver): StoreDriver => ({
    ...driver,
    renameColumn: async (table, from, to) => {
      await driver.dropColumn(table, from);
      await driver.addColumn(table, { name: to } as Parameters<StoreDriver['addColumn']>[1]);
    },
  });
  const report = await runSchemaChangeScenarios({ ds: LIBRARY, workDir: scratch(t), sdkPath: SDK, changes: [change('rename-field')], wrapDriver: lossyRename });
  const [s] = report.scenarios;
  assert.equal(s!.status, 'FAIL');
  assert.equal(s!.lost.length, 3, s!.lost.join('\n'));
  assert.match(s!.lost[0]!, /^Book\.Author row \d+: "Frank Herbert"$/);
  assert.equal(report.summary.fail, 1);
});

test('an additive redeploy that drops rows fails the runner', async (t) => {
  const rowLoss = (driver: StoreDriver): StoreDriver => ({
    ...driver,
    addColumn: async (table, column) => {
      await driver.addColumn(table, column);
      await driver.dropTable(table);
      await driver.createTable({ name: table, columns: [] } as unknown as Parameters<StoreDriver['createTable']>[0]);
    },
  });
  const report = await runSchemaChangeScenarios({ ds: LIBRARY, workDir: scratch(t), sdkPath: SDK, changes: [change('add-field')], wrapDriver: rowLoss });
  const [s] = report.scenarios;
  assert.equal(s!.status, 'FAIL');
  assert.deepEqual(s!.rows.after, {});
  assert.ok(s!.lost.every((line) => line.endsWith('(row gone)')) && s!.lost.length > 0);
});

test('a destructive step without a backup fails and leaves the store untouched', async (t) => {
  const report = await runSchemaChangeScenarios({ ds: LIBRARY, workDir: scratch(t), sdkPath: SDK, changes: [change('delete-field')], skipBackup: true });
  const [s] = report.scenarios;
  assert.equal(s!.status, 'FAIL');
  assert.ok(s!.evidence.some((e) => e.startsWith('FAIL: a verified rollback export exists before the store changes')));
  assert.ok(!s!.evidence.some((e) => e.startsWith('store delta applied')), 'nothing is applied');
  assert.deepEqual(s!.lost, []);
});

test('the delete-field store step without the backup set is refused while the column holds values', async (t) => {
  // The runner passes the verified export's tables as backedUp; without it the
  // existing guard refuses a drop of a column that holds values.
  const { applySchemaDelta, modelPlan, planDelta, DeltaRefused } = await import('../src/delta.js');
  const { loadApp } = await import('../src/cli.js');
  const dir = scratch(t);
  const before = loadApp(LIBRARY);
  writeFileSync(join(dir, 'next.ds'), change('delete-field').apply(readFileSync(LIBRARY, 'utf8')));
  const after = loadApp(join(dir, 'next.ds'));
  const delta = planDelta(modelPlan(before, 'in'), modelPlan(after, 'in'), { app: 'x', edits: [], renames: [] });
  const rows = [{ ROWID: '1', Rating: '5' }];
  const driver = {
    columns: async (table: string) => (table === 'Book' ? ['Title', 'Rating'] : undefined),
    rowCount: async () => rows.length,
    valueCount: async () => rows.length,
    dropColumn: async () => {
      rows.length = 0;
    },
  } as unknown as StoreDriver;
  await assert.rejects(applySchemaDelta(delta, modelPlan(after, 'in').schema, driver, { confirm: true }), (err: unknown) => err instanceof DeltaRefused && /1 row\(s\) hold a value/.test(err.message));
  assert.equal(rows.length, 1);
  await applySchemaDelta(delta, modelPlan(after, 'in').schema, driver, { confirm: true, backedUp: new Set(['Book']) });
  assert.equal(rows.length, 0);
});

test('c2c plan --previous: a Creator rename without --rename reads as drop plus add and the refusal names --rename', async (t) => {
  const dir = scratch(t);
  const next = join(dir, 'next.ds');
  writeFileSync(next, change('rename-field').apply(readFileSync(LIBRARY, 'utf8')));
  const run = io();
  assert.equal(await planCli([next, '--out', join(dir, 'plan'), '--dc', 'in', '--previous', LIBRARY, '--allow-budget-fail'], run), 1);
  const err = run.err.join('');
  assert.match(err, /- drop column Book\.Author/);
  assert.match(err, /needs --allow-destructive with a verified --backup; nothing was planned/);
  assert.match(err, /add --rename Form\.Old=New/);
  assert.match(err, /c2c rollback-export --ds /);
  assert.ok(readFileSync(join(dir, 'plan/schema-change/delta.md'), 'utf8').includes('drop column Book.Author'));
  const paired = io();
  assert.equal(await planCli([next, '--out', join(dir, 'plan'), '--dc', 'in', '--previous', LIBRARY, '--rename', 'Book.Author=Writer', '--allow-budget-fail'], paired), 1);
  assert.match(paired.err.join(''), /- rename column Book\.Author -> Writer/);
  const bad = io();
  assert.equal(await planCli([next, '--out', join(dir, 'plan'), '--dc', 'in', '--previous', LIBRARY, '--rename', 'Book.Author'], bad), 1);
  assert.match(bad.err.join(''), /--rename needs Form\.Old=New/);
});

test('c2c plan --previous passes an additive change with no flags; deploy --previous refuses a drop before any guard', async (t) => {
  const dir = scratch(t);
  const added = join(dir, 'added.ds');
  writeFileSync(added, change('add-field').apply(readFileSync(LIBRARY, 'utf8')));
  const run = io();
  assert.equal(await planCli([added, '--out', join(dir, 'plan'), '--dc', 'in', '--previous', LIBRARY, '--allow-budget-fail'], run), 0, run.err.join(''));
  assert.match(run.out.join(''), /schema change: .*schema-change\/delta\.md/);
  const dropped = join(dir, 'dropped.ds');
  writeFileSync(dropped, change('delete-field').apply(readFileSync(LIBRARY, 'utf8')));
  const deploy = io();
  assert.equal(await deployCli([dropped, '--previous', LIBRARY, '--dc', 'in'], deploy), 1);
  assert.match(deploy.err.join(''), /drop column Book\.Rating: column drop is not yet supported on the live store/);
});
