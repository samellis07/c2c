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
import { deployCli, loadApp, type Io } from '../src/cli.js';
import { planCli } from '../src/offline-plan.js';
import { deriveScenarios, formatSchemaChangeReport, runSchemaChangeScenarios, SCENARIO_IDS, type SchemaChange } from '../src/schema-change-runner.js';
import type { StoreDriver } from '../src/delta.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LIBRARY = join(root, 'fixtures/redistributable/library-application-system/library_application.ds');
const SDK = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-schema-change-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function deriveAppFrom(ds: string) {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-schema-change-'));
  try {
    writeFileSync(join(dir, 'app.ds'), ds);
    return loadApp(join(dir, 'app.ds'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LIBRARY_SCENARIOS = deriveScenarios(loadApp(LIBRARY), readFileSync(LIBRARY, 'utf8'));

function change(id: string): SchemaChange {
  return LIBRARY_SCENARIOS.changes.find((c) => c.id === id)!;
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
    SCENARIO_IDS.map((id) => [id, 'PASS']),
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
  assert.ok(report.scenarios.find((s) => s.id === 'picklist-remove')!.evidence.some((e) => /note: Book\.Genre: "Sci-Fi" removed/.test(e)));
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
  assert.match(s!.lost[0]!, /^Book\.Author row \d+: "[^"]+"$/);
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
  assert.equal(await planCli([next, '--out', join(dir, 'plan'), '--dc', 'in', '--previous', LIBRARY, '--rename', 'Book.Author=Author_Renamed', '--allow-budget-fail'], paired), 1);
  assert.match(paired.err.join(''), /- rename column Book\.Author -> Author_Renamed/);
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

test('the library scenarios are derived from the model: form Book, text Author, picklist Genre, deletable Rating', () => {
  assert.deepEqual(LIBRARY_SCENARIOS.target, {
    form: 'Book',
    text: 'Author',
    renamedTo: 'Author_Renamed',
    picklist: 'Genre',
    removedChoice: 'Sci-Fi',
    addedChoice: 'Added Choice',
    deletable: 'Rating',
    addedField: 'Added_Field',
    addedForm: 'Added_Form',
  });
  assert.deepEqual(LIBRARY_SCENARIOS.changes.map((c) => c.id), [...SCENARIO_IDS]);
  assert.deepEqual(LIBRARY_SCENARIOS.gaps, []);
  // Title is named by a page criteria and lookups, Isbn_Number comes after Author: neither is the rename target.
  const again = deriveScenarios(loadApp(LIBRARY), readFileSync(LIBRARY, 'utf8'));
  assert.equal(JSON.stringify(again.seed), JSON.stringify(LIBRARY_SCENARIOS.seed), 'the same app gives byte-identical seed rows');
  const cells = LIBRARY_SCENARIOS.seed.tables.flatMap((t) => t.rows.flatMap((r) => Object.values(r.columns)));
  assert.ok(cells.some((v) => v.includes('@')));
  for (const v of cells.filter((c) => c.includes('@'))) assert.match(v, /@example\.com$/);
});

const NO_SUITABLE = `application "Synthetic_Counter"
{
	date format = "dd-MMM-yyyy"
	time zone = "Asia/Kolkata"
	section Main_Section
	{
		displayname = "Main"
		form Item
		{
			must have Count
			(
				type = number
				displayname = "Count"
			)
			Label
			(
				type = text
				displayname = "Label"
			)
		}
		list All_Items
		{
			displayName = "All Items"
			show all rows from Item [Label != ""]
			(
				Count as "Count"
				Label as "Label"
			)
		}
	}
	share_settings
	{
		Administrator
		{
			type = Users_Permissions
		}
	}
}
`;

test('an app with no picklist, no renameable text field and no deletable field: those scenarios are gaps with the reason, never a pass', async (t) => {
  const dir = scratch(t);
  const ds = join(dir, 'counter.ds');
  writeFileSync(ds, NO_SUITABLE);
  const report = await runSchemaChangeScenarios({ ds, workDir: join(dir, 'work'), sdkPath: SDK });
  assert.equal(report.target?.form, 'Item');
  assert.deepEqual(
    report.scenarios.map((s) => [s.id, s.status]),
    [
      ['add-field', 'PASS'],
      ['add-form', 'PASS'],
    ],
    formatSchemaChangeReport(report),
  );
  const gaps = new Map(report.gaps.map((g) => [g.id, g.detail]));
  for (const id of ['picklist-add', 'picklist-remove', 'rename-field', 'delete-field']) assert.match(gaps.get(`no-${id}`) ?? '', /^form Item has no /, id);
  // Label is named by the report criteria, Count is required.
  assert.equal(report.target?.text, undefined);
  assert.equal(report.target?.deletable, undefined);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.gaps, report.gaps.length);
  assert.deepEqual(report.scenarios[0]!.rows.before, { Item: 3 });
});

test('the same app without the criteria: Label becomes the rename target', () => {
  const ds = NO_SUITABLE.replace(' [Label != ""]', '');
  const derived = deriveScenarios(deriveAppFrom(ds), ds);
  assert.equal(derived.target?.text, 'Label');
  assert.equal(derived.target?.deletable, undefined, 'Count is required');
  assert.ok(derived.changes.some((c) => c.id === 'rename-field'));
});

test('an app with no form the seed can fill: every scenario is a gap', async (t) => {
  const dir = scratch(t);
  const ds = join(dir, 'pictures.ds');
  writeFileSync(ds, NO_SUITABLE.replace('must have Count\n\t\t\t(\n\t\t\t\ttype = number', 'must have Count\n\t\t\t(\n\t\t\t\ttype = image'));
  const report = await runSchemaChangeScenarios({ ds, workDir: join(dir, 'work'), sdkPath: SDK });
  assert.equal(report.target, undefined);
  assert.deepEqual(report.scenarios, []);
  assert.deepEqual(
    report.gaps.filter((g) => g.id.startsWith('no-')).map((g) => g.scenario),
    [...SCENARIO_IDS],
  );
  assert.match(report.gaps[0]!.detail, /Item: required image field Count has no offline seed value/);
  assert.equal(report.summary.pass, 0);
  assert.equal(report.summary.fail, 0);
});
