/**
 * Schema-change safety on redeploy: a rename is told from a drop plus an add and
 * its values move, a destructive change is refused and says what it would lose,
 * and additive changes go through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployedModelPath, loadApp, recordDeployedModel, type Io } from '../src/cli.js';
import { planCli } from '../src/offline-plan.js';
import { applySchemaDelta, DeltaRefused, planDelta, reviewSchemaChange, type ModelPlan, type StoreDriver } from '../src/delta.js';
import { deriveScenarios } from '../src/schema-change-runner.js';
import type { SchemaColumn, SchemaPlan, SchemaTable } from '../../schema/src/generator.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LIBRARY = join(root, 'fixtures/redistributable/library-application-system/library_application.ds');

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

test('a project folder target is not recorded: nothing is written', (t) => {
  const dir = scratch(t);
  assert.equal(recordDeployedModel(join(dir, 'deploy'), dir), undefined);
});
