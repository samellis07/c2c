/**
 * Schema-change safety on redeploy: a rename is told from a drop plus an add and
 * its values move, a destructive change is refused and says what it would lose,
 * and additive changes go through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployedModelPath, loadApp, recordDeployedModel, type Io } from '../src/cli.js';
import { planCli } from '../src/offline-plan.js';
import { applySchemaDelta, DeltaRefused, planDelta, reviewSchemaChange, type ModelPlan, type StoreDriver } from '../src/delta.js';
import { deriveScenarios, runSchemaChangeScenarios } from '../src/schema-change-runner.js';
import type { SchemaColumn, SchemaPlan, SchemaTable } from '../../schema/src/generator.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LIBRARY = join(root, 'fixtures/redistributable/library-application-system/library_application.ds');
const SDK = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-schema-safety-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function io(): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (x: string) => out.push(x), stderr: (x: string) => err.push(x), env: {}, spawn: () => { throw new Error('no spawn'); }, fetch: () => Promise.reject(new Error('no network')) } as unknown as Io & { out: string[]; err: string[] };
}

function col(name: string, extra: Partial<SchemaColumn> = {}): SchemaColumn {
  return { name, dataType: 'VARCHAR', length: 100, mandatory: false, unique: false, ...extra } as SchemaColumn;
}

function model(...columns: SchemaColumn[]): ModelPlan {
  const table = { name: 'Book', form: 'Book', role: 'form', nosql: false, columns } as SchemaTable;
  return { schema: { tables: [table] } as SchemaPlan, files: new Map(), roles: [] };
}

const OPTS = { app: 'x', edits: [], renames: [] };

test('a re-export with one field gone and one added in its place, same type and constraints, reads as a rename', () => {
  const delta = planDelta(model(col('Title'), col('Author'), col('Year')), model(col('Title'), col('Writer'), col('Year')), { ...OPTS, detect: true });
  assert.deepEqual(delta.columns, [{ op: 'rename', table: 'Book', from: 'Author', to: 'Writer', detected: true }]);
});

test('without the detect option a drop plus add stays a drop plus add (the edit log is the only rename record)', () => {
  const delta = planDelta(model(col('Title'), col('Author')), model(col('Title'), col('Writer')), OPTS);
  assert.deepEqual(delta.columns.map((c) => c.op).sort(), ['add', 'drop']);
});

test('a different type, a different slot or two look-alikes is NOT paired: it stays drop plus add', () => {
  const type = planDelta(model(col('Title'), col('Author')), model(col('Title'), col('Writer', { dataType: 'BigInt', length: undefined })), { ...OPTS, detect: true });
  assert.deepEqual(type.columns.map((c) => c.op).sort(), ['add', 'drop']);
  const slot = planDelta(model(col('Author'), col('Title'), col('Year')), model(col('Title'), col('Year'), col('Writer')), { ...OPTS, detect: true });
  assert.deepEqual(slot.columns.map((c) => c.op).sort(), ['add', 'drop']);
  const twins = planDelta(model(col('Title'), col('A'), col('B')), model(col('Title'), col('X'), col('Y')), { ...OPTS, detect: true });
  assert.deepEqual(twins.columns.map((c) => c.op).sort(), ['add', 'add', 'drop', 'drop']);
});

test('the review lists what each destructive change would lose', () => {
  const lib = loadApp(LIBRARY);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-schema-safety-'));
  try {
    const derived = deriveScenarios(lib, readFileSync(LIBRARY, 'utf8'));
    const drop = derived.changes.find((c) => c.id === 'delete-field')!;
    writeFileSync(join(dir, 'drop.ds'), drop.apply(readFileSync(LIBRARY, 'utf8')));
    const review = reviewSchemaChange(lib, loadApp(join(dir, 'drop.ds')), 'in');
    assert.ok(review.losses.some((l) => /^Book\.Rating: every stored value is deleted/.test(l)), review.losses.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a type change or a shorter length on a column that holds values is refused without confirm and names the count', async () => {
  const before = model(col('Title'), col('Notes', { length: 500 }));
  const after = model(col('Title'), col('Notes', { length: 50 }));
  const delta = planDelta(before, after, OPTS);
  assert.equal(delta.needsConfirm, true, 'a narrowing alter needs confirm');
  const calls: string[] = [];
  const driver = {
    columns: async () => ['Title', 'Notes'],
    rowCount: async () => 4,
    valueCount: async () => 4,
    alterColumn: async () => void calls.push('alter'),
  } as unknown as StoreDriver;
  await assert.rejects(applySchemaDelta(delta, after.schema, driver, {}), (e: unknown) => e instanceof DeltaRefused && /Book\.Notes/.test(e.message) && /4 row\(s\)/.test(e.message));
  assert.deepEqual(calls, []);
  await applySchemaDelta(delta, after.schema, driver, { confirm: true, backedUp: new Set(['Book']) });
  assert.deepEqual(calls, ['alter']);
});

test('a narrowing alter is refused without confirm even when the column holds no value, and applies with confirm', async () => {
  const before = model(col('Title'), col('Notes', { length: 500 }));
  const after = model(col('Title'), col('Notes', { length: 50 }));
  const delta = planDelta(before, after, OPTS);
  const calls: string[] = [];
  const driver = {
    columns: async () => ['Title', 'Notes'],
    rowCount: async () => 0,
    valueCount: async () => 0,
    alterColumn: async () => void calls.push('alter'),
  } as unknown as StoreDriver;
  await assert.rejects(applySchemaDelta(delta, after.schema, driver, { confirm: false }), (e: unknown) => e instanceof DeltaRefused && /Book\.Notes/.test(e.message) && /--confirm/.test(e.message));
  assert.deepEqual(calls, [], 'nothing was altered');
  await applySchemaDelta(delta, after.schema, driver, { confirm: true });
  assert.deepEqual(calls, ['alter']);
  // A direct type change on the primitive behaves the same.
  const typeDelta = { ...delta, columns: [{ op: 'alter' as const, table: 'Book', column: 'Notes', changes: ['type VARCHAR -> INT'] }] };
  await assert.rejects(applySchemaDelta(typeDelta, after.schema, driver, {}), DeltaRefused);
});

test('a mandatory column with no default added to a table that has rows needs confirm, in the plan and in the primitive', async () => {
  const before = model(col('Title'));
  const after = model(col('Title'), col('Isbn', { mandatory: true }));
  const delta = planDelta(before, after, OPTS);
  assert.equal(delta.needsConfirm, true, 'a required add without a default needs confirm');
  const added: string[] = [];
  const driver = {
    columns: async () => ['Title'],
    rowCount: async () => 3,
    valueCount: async () => 3,
    addColumn: async (_t: string, c: { name: string }) => void added.push(c.name),
  } as unknown as StoreDriver;
  await assert.rejects(applySchemaDelta(delta, after.schema, driver, {}), (e: unknown) => e instanceof DeltaRefused && /Book\.Isbn/.test(e.message) && /3 row\(s\)/.test(e.message));
  assert.deepEqual(added, []);
  await applySchemaDelta(delta, after.schema, driver, { confirm: true });
  assert.deepEqual(added, ['Isbn']);
  // With a default, or an empty table, the add is additive and needs no confirm.
  const withDefault = planDelta(before, model(col('Title'), col('Isbn', { mandatory: true, defaultValue: 'n/a' })), OPTS);
  assert.equal(withDefault.needsConfirm, false);
  await applySchemaDelta(delta, after.schema, { ...driver, rowCount: async () => 0 } as unknown as StoreDriver, {});
});

test('widening a length is additive: it needs no confirm', async () => {
  const delta = planDelta(model(col('Notes', { length: 50 })), model(col('Notes', { length: 500 })), OPTS);
  assert.equal(delta.needsConfirm, false);
});

test('a rename on a store that cannot rename in place copies the values and keeps the old column until it is confirmed', async () => {
  const delta = planDelta(model(col('Title'), col('Author')), model(col('Title'), col('Writer')), { ...OPTS, detect: true });
  const rows: Record<string, string>[] = [{ Title: 'a', Author: 'x' }, { Title: 'b', Author: 'y' }];
  let cols = ['Title', 'Author'];
  const driver: StoreDriver = {
    nativeRename: false,
    columns: async () => cols.slice(),
    rowCount: async () => rows.length,
    valueCount: async (_t, c) => rows.filter((r) => r[c]).length,
    createTable: async () => {},
    addColumn: async (_t, c) => void cols.push(c.name),
    renameColumn: async () => {
      throw new Error('no in-place rename');
    },
    copyColumn: async (_t, from, to) => void rows.forEach((r) => (r[to] = r[from]!)),
    alterColumn: async () => {},
    dropColumn: async (_t, c) => {
      cols = cols.filter((x) => x !== c);
      rows.forEach((r) => delete r[c]);
    },
    dropTable: async () => {},
  };
  const kept = await applySchemaDelta(delta, model(col('Title'), col('Writer')).schema, driver, {});
  assert.deepEqual(rows.map((r) => r.Writer), ['x', 'y']);
  assert.deepEqual(rows.map((r) => r.Author), ['x', 'y'], 'the old column keeps its values until confirmed');
  assert.ok(kept.applied.some((l) => /copy values Book\.Author -> Book\.Writer \(2 value\(s\)\)/.test(l)), kept.applied.join('\n'));
  assert.ok(kept.retained?.some((l) => /Book\.Author/.test(l)));
  cols = ['Title', 'Author'];
  const done = await applySchemaDelta(delta, model(col('Title'), col('Writer')).schema, { ...driver, columns: async () => cols.slice() }, { confirm: true, backedUp: new Set(['Book']) });
  assert.ok(done.applied.some((l) => /drop column Book\.Author/.test(l)));
  assert.deepEqual(rows.map((r) => r.Writer), ['x', 'y']);
});

test('c2c plan --previous on a Creator rename with no --rename: refused, names the detected rename (values move) and, with --no-detect-renames, what is lost', async (t) => {
  const dir = scratch(t);
  const text = readFileSync(LIBRARY, 'utf8');
  const lib = loadApp(LIBRARY);
  const rename = deriveScenarios(lib, text).changes.find((c) => c.id === 'rename-field')!;
  const next = join(dir, 'next.ds');
  writeFileSync(next, rename.apply(text));
  const run = io();
  assert.equal(await planCli([next, '--out', join(dir, 'plan'), '--dc', 'in', '--previous', LIBRARY, '--allow-budget-fail'], run), 1);
  const err = run.err.join('');
  assert.match(err, /detected rename Book\.Author -> Author_Renamed/);
  assert.match(err, /values move to the new name/);
  assert.doesNotMatch(err, /- drop column Book\.Author/);
});

test('--previous may be a .ds file, a path under a file (ENOTDIR on Linux) or a folder, and a linked model is not recorded', (t) => {
  const dir = scratch(t);
  // A path whose parent is a plain file: stat says ENOTDIR on Linux, ENOENT elsewhere; both mean nothing is there.
  const underFile = join(LIBRARY, '.c2c-deployed-model');
  assert.equal(deployedModelPath(underFile), underFile, 'a path under a file is passed through, not thrown');
  assert.equal(deployedModelPath(LIBRARY), LIBRARY, 'a .ds file is passed through');
  const deploy = join(dir, 'deploy');
  const recorded = recordDeployedModel(deploy, LIBRARY);
  assert.ok(recorded, 'a plain .ds file is recorded');
  assert.equal(deployedModelPath(deploy), recorded, 'a deploy folder resolves to its recorded model');
  assert.equal(deployedModelPath(join(dir, 'missing')), join(dir, 'missing'), 'a missing path is passed through');
  // A link is never followed when recording: the model would be whatever the link points at by then.
  const link = join(dir, 'linked.ds');
  symlinkSync(LIBRARY, link);
  assert.equal(recordDeployedModel(join(dir, 'deploy2'), link), undefined, 'a symbolic link is not recorded');
});

test('the deployed model is recorded beside the deploy and --previous accepts that folder instead of the old export', async (t) => {
  const dir = scratch(t);
  const text = readFileSync(LIBRARY, 'utf8');
  const recorded = recordDeployedModel(join(dir, 'deploy'), LIBRARY);
  assert.ok(recorded && readFileSync(recorded, 'utf8') === text);
  assert.equal(deployedModelPath(join(dir, 'deploy')), recorded);
  assert.equal(deployedModelPath(LIBRARY), LIBRARY, 'a plain .ds path is unchanged');
  const next = join(dir, 'next.ds');
  writeFileSync(next, deriveScenarios(loadApp(LIBRARY), text).changes.find((c) => c.id === 'rename-field')!.apply(text));
  const viaFolder = io();
  const viaFile = io();
  assert.equal(await planCli([next, '--out', join(dir, 'p1'), '--dc', 'in', '--previous', join(dir, 'deploy'), '--allow-budget-fail'], viaFolder), 1);
  assert.equal(await planCli([next, '--out', join(dir, 'p2'), '--dc', 'in', '--previous', LIBRARY, '--allow-budget-fail'], viaFile), 1);
  assert.match(viaFolder.err.join(''), /detected rename Book\.Author -> Author_Renamed/);
  assert.equal(readFileSync(join(dir, 'p1/schema-change/delta.json'), 'utf8'), readFileSync(join(dir, 'p2/schema-change/delta.json'), 'utf8'));
});

test('a deploy folder with no recorded model, a garbage record or an empty previous model is refused, never planned as all-new', async (t) => {
  const dir = scratch(t);
  const text = readFileSync(LIBRARY, 'utf8');
  const next = join(dir, 'next.ds');
  writeFileSync(next, deriveScenarios(loadApp(LIBRARY), text).changes.find((c) => c.id === 'rename-field')!.apply(text));
  // 1. A deploy folder (it has the state file) whose recorded model is missing.
  const bare = join(dir, 'bare');
  mkdirSync(bare, { recursive: true });
  writeFileSync(join(bare, '.c2c-deploy-state.json'), '{}');
  assert.throws(() => deployedModelPath(bare), /no recorded deployed model/);
  const r1 = io();
  assert.notEqual(await planCli([next, '--out', join(dir, 'p1'), '--dc', 'in', '--previous', bare, '--allow-budget-fail'], r1), 0, 'a deploy folder without its model is refused');
  assert.match(r1.err.join(''), /no recorded deployed model/);
  // 2. A record that is garbage parses to no forms: refused, nothing planned.
  const garbage = join(dir, 'garbage');
  mkdirSync(join(garbage, '.c2c-deployed-model'), { recursive: true });
  writeFileSync(join(garbage, '.c2c-deployed-model', 'x.ds'), 'this is not a model');
  const r2 = io();
  assert.notEqual(await planCli([next, '--out', join(dir, 'p2'), '--dc', 'in', '--previous', garbage, '--allow-budget-fail'], r2), 0, 'a garbage record is refused');
  assert.match(r2.err.join(''), /holds no forms to compare against/);
  // 3. A plain garbage .ds as --previous is refused the same way.
  const junk = join(dir, 'junk.ds');
  writeFileSync(junk, 'not a model either');
  const r3 = io();
  assert.notEqual(await planCli([next, '--out', join(dir, 'p3'), '--dc', 'in', '--previous', junk, '--allow-budget-fail'], r3), 0, 'a garbage previous export is refused');
  assert.match(r3.err.join(''), /holds no forms to compare against|parse|unexpected|cannot|invalid/i);
});

test('a project folder target is not recorded: nothing is written', (t) => {
  const dir = scratch(t);
  assert.equal(recordDeployedModel(join(dir, 'deploy'), dir), undefined);
});

test('a change that cannot be applied to the export is a failed scenario, not a crash', async (t) => {
  const broken = { id: 'add-field', title: 'broken', kind: 'additive' as const, apply: () => { throw new Error('schema change anchor not found: Book.Gone'); } };
  const report = await runSchemaChangeScenarios({ ds: LIBRARY, workDir: scratch(t), sdkPath: SDK, changes: [broken] });
  assert.equal(report.summary.fail, 1);
  assert.match(report.scenarios[0]!.evidence[0]!, /^FAIL: the change could not be applied to the export: schema change anchor not found/);
});
