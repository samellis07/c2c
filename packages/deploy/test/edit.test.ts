/**
 * Edit by asking: typed model edits, the plan diff, and the diff apply.
 *
 * Every op round-trips (edit, regenerate, identical bytes on two runs). A
 * rename is a column rename that keeps rows in a fake Data Store. Refusals
 * name what blocks them. The diff lists only the touched tables, columns,
 * roles, and files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile, type App } from '../../core/src/index.js';
import type { SchemaColumn, SchemaTable } from '../../schema/src/generator.js';
import { deployCli, loadApp, type Io } from '../src/cli.js';
import { applySchemaDelta, DeltaRefused, deltaFiles, modelPlan, planDelta, type PlanDelta, type StoreDriver } from '../src/delta.js';
import { applyEdit, applyEdits, EditError, editsJson, editsPathFor, fieldUsages, normaliseOp, readEdits, type EditOp } from '../src/edit.js';
import { editCli } from '../src/edit-cli.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LIBRARY = join(root, 'fixtures/redistributable/library-application-system/library_application.ds');
const DC = 'us';

function library(): App {
  return parseFile(LIBRARY).ir;
}

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Generated handlers embed the whole-schema `writeRules: {…}` map, so any
 * column change rewrites every handler's embed. Replace each embed with a
 * marker so a writeRules-only change compares equal.
 */
function withoutWriteRules(text: string): string {
  let out = text;
  for (;;) {
    const at = out.indexOf('writeRules: {');
    if (at < 0) return out;
    const start = at + 'writeRules: '.length;
    let depth = 0;
    let end = out.length;
    for (let i = start; i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    out = `${out.slice(0, at)}writeRules: <embed>${out.slice(end)}`;
  }
}

/** Edit the freshly parsed model, regenerate, and return the delta plus a hash of every generated file. */
function run(edits: readonly EditOp[]): { delta: PlanDelta; hashes: string[]; after: ReturnType<typeof modelPlan> } {
  const base = library();
  const prior = applyEdits(base, edits.slice(0, -1));
  const last = applyEdit(prior.app, edits[edits.length - 1]!);
  const before = modelPlan(prior.app, DC);
  const after = modelPlan(last.app, DC);
  const delta = planDelta(before, after, { app: base.name ?? 'app', edits: edits.slice(-1), renames: last.renames });
  const hashes = [...after.files.values()].map((f) => `${f.path} ${sha(f.data)}`).sort();
  return { delta, hashes, after };
}

function refused(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => err instanceof EditError && pattern.test(err.message));
}

const OPS: { name: string; edits: EditOp[] }[] = [
  { name: 'addField', edits: [{ op: 'addField', form: 'Book', field: 'Shelf', type: 'text', label: 'Shelf' }] },
  { name: 'renameField', edits: [{ op: 'renameField', form: 'Book', from: 'Isbn_Number', to: 'ISBN' }] },
  {
    name: 'removeField',
    edits: [
      { op: 'addField', form: 'Book', field: 'Shelf', type: 'text' },
      { op: 'removeField', form: 'Book', field: 'Shelf' },
    ],
  },
  { name: 'setPicklist', edits: [{ op: 'setPicklist', form: 'Book', field: 'Genre', choices: ['Sci-Fi', 'Biography', 'Non-Fiction', 'Fiction', 'Poetry'] }] },
  { name: 'addReportColumn', edits: [{ op: 'addReportColumn', report: 'All_Book_Transactions', field: 'Book.Author', label: 'Author' }] },
  { name: 'addRole', edits: [{ op: 'addRole', role: 'Auditor', parent: 'CEO', description: 'Reads every record.' }] },
];

for (const { name, edits } of OPS) {
  test(`${name}: edit, regenerate, identical output on two runs`, () => {
    const first = run(edits);
    const second = run(edits);
    assert.deepEqual(second.hashes, first.hashes);
    assert.equal(JSON.stringify(second.delta), JSON.stringify(first.delta));
    // The delta lists exactly the files whose bytes changed, and the tree
    // holds only those.
    for (const change of first.delta.files) {
      if (change.op !== 'remove') assert.equal(change.sha256, sha(first.after.files.get(change.path)!.data));
    }
    const tree = deltaFiles(first.delta, first.after).map((f) => f.path);
    assert.deepEqual(tree.slice(2), first.delta.files.filter((f) => f.op !== 'remove').map((f) => `files/${f.path}`));
  });
}

test('addField adds one column to its table and nothing else in the schema', () => {
  const { delta, after } = run(OPS[0]!.edits);
  assert.deepEqual(delta.tables, []);
  assert.deepEqual(delta.columns, [{ op: 'add', table: 'Book', column: 'Shelf', dataType: 'VarChar' }]);
  assert.equal(delta.needsConfirm, false);
  // Another form's generated file may change only through the whole-schema
  // writeRules embed; its own content stays byte-identical.
  const before = modelPlan(library(), DC);
  for (const f of delta.files.filter((f) => f.path.includes('member') || f.path.includes('staff'))) {
    assert.equal(f.op, 'change', `${f.path} may only change`);
    const a = before.files.get(f.path);
    const b = after.files.get(f.path);
    assert.ok(a && b, `${f.path} missing on one side`);
    assert.equal(withoutWriteRules(b.data.toString()), withoutWriteRules(a.data.toString()), `${f.path} differs outside the writeRules embed`);
  }
});

test('a lookup field adds a foreign key to the target table', () => {
  const { delta, after } = run([{ op: 'addField', form: 'Book_Transaction', field: 'Handled_By', type: 'lookup', lookup: 'Staff_Members.Staff_Name' }]);
  assert.deepEqual(delta.columns, [{ op: 'add', table: 'Book_Transaction', column: 'Handled_By', dataType: 'Foreign Key' }]);
  const column = after.schema.tables.find((t) => t.name === 'Book_Transaction')!.columns.find((c) => c.name === 'Handled_By')!;
  assert.equal(column.relation?.table, 'Staff_Members');
});

test('renameField is a column rename, never a drop plus an add, and rewrites the reports that show it', () => {
  const { delta } = run(OPS[1]!.edits);
  assert.deepEqual(delta.columns, [{ op: 'rename', table: 'Book', from: 'Isbn_Number', to: 'ISBN' }]);
  assert.deepEqual(delta.tables, []);
  assert.equal(delta.needsConfirm, false);
  const app = applyEdit(library(), OPS[1]!.edits[0]!).app;
  const columns = app.reports.filter((r) => r.form === 'Book').flatMap((r) => r.columns.map((c) => c.field));
  assert.ok(columns.includes('ISBN') && !columns.includes('Isbn_Number'));
});

test('removing a field it just added returns the generated tree to the original bytes', () => {
  const base = modelPlan(library(), DC);
  const { after, delta } = run(OPS[2]!.edits);
  assert.deepEqual([...after.files.keys()].sort(), [...base.files.keys()].sort());
  for (const [path, file] of base.files) assert.equal(sha(after.files.get(path)!.data), sha(file.data), path);
  assert.deepEqual(delta.columns, [{ op: 'drop', table: 'Book', column: 'Shelf' }]);
  assert.equal(delta.needsConfirm, true);
});

test('addRole changes roles and no table or column', () => {
  const { delta } = run(OPS[5]!.edits);
  assert.deepEqual(delta.tables, []);
  assert.deepEqual(delta.columns, []);
  assert.deepEqual(delta.roles, [{ op: 'add', role: 'Auditor', parent: 'CEO' }]);
  // The role list lives in the function access maps and the auth apply plan; no Slate or schema file changes.
  assert.ok(delta.files.length > 0);
  assert.ok(delta.files.every((f) => f.path.startsWith('functions/') || f.path.startsWith('auth/')), JSON.stringify(delta.files));
});

test('addReportColumn touches the report handler and Slate model only', () => {
  const { delta } = run(OPS[4]!.edits);
  assert.deepEqual(delta.columns, []);
  assert.ok(delta.files.length > 0);
  assert.ok(delta.files.every((f) => f.path.startsWith('slate/') || f.path.includes('all-book-transactions')), JSON.stringify(delta.files));
});

// ---------------------------------------------------------------------------
// refusals

test('refuses an unknown form, report, field, and parent role by name', () => {
  const app = library();
  refused(() => applyEdit(app, { op: 'addField', form: 'Books', field: 'X', type: 'text' }), /unknown form "Books" \(forms: Book, Member_Info/);
  refused(() => applyEdit(app, { op: 'renameField', form: 'Book', from: 'ISBN', to: 'X' }), /form "Book" has no field "ISBN"/);
  refused(() => applyEdit(app, { op: 'addReportColumn', report: 'Nope', field: 'Title' }), /unknown report "Nope"/);
  refused(() => applyEdit(app, { op: 'addRole', role: 'Clerk', parent: 'Boss' }), /parent role "Boss" does not exist/);
});

test('refuses a name collision, a reserved column, and a bad link name', () => {
  const app = library();
  refused(() => applyEdit(app, { op: 'addField', form: 'Book', field: 'title', type: 'text' }), /form "Book" already has a field "Title"/);
  refused(() => applyEdit(app, { op: 'renameField', form: 'Book', from: 'Isbn_Number', to: 'Rating' }), /already has a field "Rating"/);
  refused(() => applyEdit(app, { op: 'addField', form: 'Book', field: 'Added_Time', type: 'text' }), /reserved system column/);
  refused(() => applyEdit(app, { op: 'addField', form: 'Book', field: 'ROWID', type: 'text' }), /reserved system column/);
  refused(() => applyEdit(app, { op: 'addField', form: 'Book', field: '9lives', type: 'text' }), /not a link name/);
  refused(() => applyEdit(app, { op: 'addRole', role: 'librarian' }), /role or profile named "librarian" already exists/);
  refused(() => applyEdit(app, { op: 'addReportColumn', report: 'Book_Report', field: 'Title' }), /already shows "Title"/);
});

test('refuses a lookup whose target form or display field is missing', () => {
  const app = library();
  refused(() => applyEdit(app, { op: 'addField', form: 'Book', field: 'Shelf', type: 'lookup', lookup: 'Shelves' }), /lookup target form "Shelves" does not exist/);
  refused(() => applyEdit(app, { op: 'addField', form: 'Book', field: 'Shelf', type: 'lookup', lookup: 'Staff_Members.Desk' }), /form "Staff_Members" has no field "Desk"/);
  refused(() => applyEdit(app, { op: 'addField', form: 'Book', field: 'Shelf', type: 'lookup' }), /a lookup needs a target/);
});

test('refuses removing a field still used in Deluge or reports, naming each use', () => {
  const app = library();
  refused(() => applyEdit(app, { op: 'removeField', form: 'Book', field: 'Title' }), /Book\.Title is still used in report "Book_Report" column.*Deluge in workflow "Overdue_email"/);
  refused(() => applyEdit(app, { op: 'removeField', form: 'Book', field: 'Rating' }), /still used in report "Book_Report" column/);
});

test('refuses renaming a field that Deluge reads; the report-only field is renamed', () => {
  const app = library();
  refused(() => applyEdit(app, { op: 'renameField', form: 'Book', from: 'Title', to: 'Book_Title' }), /Book\.Title is used in Deluge in workflow "Overdue_email"/);
  assert.equal(applyEdit(app, { op: 'renameField', form: 'Book', from: 'Rating', to: 'Stars' }).renames.length, 1);
});

test('refuses picklist edits on a lookup or a non-choice field, and empty or repeated choices', () => {
  const app = library();
  refused(() => applyEdit(app, { op: 'setPicklist', form: 'Book_Transaction', field: 'Book', choices: ['a'] }), /is a lookup to Book/);
  refused(() => applyEdit(app, { op: 'setPicklist', form: 'Book', field: 'Title', choices: ['a'] }), /Book\.Title \(text\) is not a choice field/);
  refused(() => applyEdit(app, { op: 'setPicklist', form: 'Book', field: 'Genre', choices: [] }), /at least one choice/);
  refused(() => applyEdit(app, { op: 'setPicklist', form: 'Book', field: 'Genre', choices: ['A', 'A'] }), /listed twice/);
});

test('refuses unknown ops and malformed ops read from the edits log', () => {
  assert.throws(() => normaliseOp({ op: 'dropTable' }), /unknown edit op "dropTable"/);
  assert.throws(() => normaliseOp({ op: 'renameField', form: 'Book', from: 'A' }), /"to" is required/);
  assert.throws(() => normaliseOp({ op: 'addRole', role: 'A', colour: 'red' }), /unknown key "colour"/);
});

test('the input model is never changed by an edit', () => {
  const app = library();
  const before = JSON.stringify(app);
  applyEdit(app, OPS[1]!.edits[0]!);
  applyEdit(app, OPS[0]!.edits[0]!);
  assert.equal(JSON.stringify(app), before);
});

// ---------------------------------------------------------------------------
// diff apply against a fake Data Store

interface FakeTable {
  columns: string[];
  rows: Record<string, unknown>[];
}

function fakeStore(tables: readonly SchemaTable[]): { driver: StoreDriver; data: Map<string, FakeTable>; calls: string[] } {
  const data = new Map<string, FakeTable>(tables.map((t) => [t.name, { columns: ['ROWID', ...t.columns.map((c) => c.name)], rows: [] }]));
  const calls: string[] = [];
  const table = (name: string) => {
    const found = data.get(name);
    if (!found) throw new Error(`404 table ${name}`);
    return found;
  };
  const driver: StoreDriver = {
    columns: async (name) => data.get(name)?.columns.slice(),
    rowCount: async (name) => table(name).rows.length,
    valueCount: async (name, column) => table(name).rows.filter((r) => r[column] !== null && r[column] !== undefined && r[column] !== '').length,
    createTable: async (t) => {
      calls.push(`create ${t.name}`);
      data.set(t.name, { columns: ['ROWID', ...t.columns.map((c) => c.name)], rows: [] });
    },
    addColumn: async (name, column: SchemaColumn) => {
      calls.push(`add ${name}.${column.name}`);
      table(name).columns.push(column.name);
    },
    renameColumn: async (name, from, to) => {
      calls.push(`rename ${name}.${from}->${to}`);
      const t = table(name);
      t.columns = t.columns.map((c) => (c === from ? to : c));
      for (const row of t.rows) {
        row[to] = row[from];
        delete row[from];
      }
    },
    alterColumn: async (name, column) => {
      calls.push(`alter ${name}.${column.name}`);
    },
    dropColumn: async (name, column) => {
      calls.push(`drop ${name}.${column}`);
      const t = table(name);
      t.columns = t.columns.filter((c) => c !== column);
      for (const row of t.rows) delete row[column];
    },
    dropTable: async (name) => {
      calls.push(`drop table ${name}`);
      data.delete(name);
    },
  };
  return { driver, data, calls };
}

test('a rename keeps every row value in the fake store and is safe to re-run', async () => {
  const base = modelPlan(library(), DC);
  const { delta, after } = run(OPS[1]!.edits);
  const store = fakeStore(base.schema.tables);
  store.data.get('Book')!.rows.push({ ROWID: '1', Title: 'Dune', Isbn_Number: '978-0441013593' }, { ROWID: '2', Title: 'Emma', Isbn_Number: '978-0141439587' });
  const applied = await applySchemaDelta(delta, after.schema, store.driver);
  assert.deepEqual(applied.applied, ['rename column Book.Isbn_Number -> ISBN']);
  assert.deepEqual(applied.skipped, []);
  assert.deepEqual(store.calls, ['rename Book.Isbn_Number->ISBN']);
  assert.deepEqual(store.data.get('Book')!.rows.map((r) => r.ISBN), ['978-0441013593', '978-0141439587']);
  assert.ok(!store.data.get('Book')!.columns.includes('Isbn_Number'));
  assert.deepEqual(await applySchemaDelta(delta, after.schema, store.driver), { applied: [], skipped: [] }, 'a second run finds the rename done');
});

test('a drop needs confirm, is refused while the column has values, and runs on an empty column', async () => {
  const withShelf = applyEdit(library(), OPS[2]!.edits[0]!).app;
  const { delta, after } = run(OPS[2]!.edits);
  const store = fakeStore(modelPlan(withShelf, DC).schema.tables);
  await assert.rejects(applySchemaDelta(delta, after.schema, store.driver), (err: unknown) => err instanceof DeltaRefused && /pass --confirm to drop/.test(err.message));
  store.data.get('Book')!.rows.push({ ROWID: '1', Shelf: 'A3' });
  await assert.rejects(
    applySchemaDelta(delta, after.schema, store.driver, { confirm: true }),
    (err: unknown) => err instanceof DeltaRefused && /drop of Book\.Shelf refused: 1 row\(s\) hold a value/.test(err.message),
  );
  assert.deepEqual(store.calls, [], 'nothing is written before the drop checks pass');
  store.data.get('Book')!.rows[0]!.Shelf = null;
  assert.deepEqual(await applySchemaDelta(delta, after.schema, store.driver, { confirm: true }), { applied: ['drop column Book.Shelf'], skipped: [] });
  assert.deepEqual(store.data.get('Book')!.rows, [{ ROWID: '1' }]);
});

test('an added column is created once; a re-run skips it', async () => {
  const base = modelPlan(library(), DC);
  const { delta, after } = run(OPS[0]!.edits);
  const store = fakeStore(base.schema.tables);
  assert.deepEqual(await applySchemaDelta(delta, after.schema, store.driver), { applied: ['add column Book.Shelf'], skipped: [] });
  assert.deepEqual(await applySchemaDelta(delta, after.schema, store.driver), { applied: [], skipped: [] });
});

test('a delta op whose target is not in the store is reported, not silently skipped', async () => {
  // [rename Rating -> Stars, remove Stars] where the rename never reached the
  // store: the delta's drop of Stars has nothing to drop and the store keeps
  // Rating and its rows. The skipped list says so.
  const base = modelPlan(library(), DC);
  const store = fakeStore(base.schema.tables);
  store.data.get('Book')!.rows.push({ ROWID: '1', Rating: 4 });
  const delta: PlanDelta = {
    version: 1,
    app: 'x',
    edits: [],
    tables: [],
    columns: [{ op: 'drop', table: 'Book', column: 'Stars' }],
    roles: [],
    files: [],
    needsConfirm: true,
  };
  const result = await applySchemaDelta(delta, base.schema, store.driver, { confirm: true });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, ['drop column Book.Stars: the column is not in the store']);
  assert.deepEqual(store.calls, []);
  assert.ok(store.data.get('Book')!.rows[0]!.Rating === 4, 'the old column and its value are untouched');
});

// ---------------------------------------------------------------------------
// command line

function workdir(): { dir: string; ds: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-edit-'));
  const ds = join(dir, 'library.ds');
  copyFileSync(LIBRARY, ds);
  return { dir, ds };
}

function cli(args: string[], cwd: string): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = editCli(args, { stdout: (t) => (out += t), stderr: (t) => (err += t) }, cwd);
  return { code, out, err };
}

function treeHashes(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${relative(dir, p)} ${sha(readFileSync(p))}`);
    }
  };
  walk(dir);
  return out;
}

test('c2c edit is a dry run by default and --apply records the op that plan and deploy replay', () => {
  const { dir, ds } = workdir();
  try {
    const dry = cli([ds, 'rename-field', 'Book', 'Isbn_Number', 'ISBN', '--dc', DC], dir);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /rename column Book\.Isbn_Number -> ISBN \(keeps rows where the store can rename; the live deploy refuses a column rename\)/);
    assert.match(dry.out, /dry run: nothing recorded/);
    assert.equal(existsSync(editsPathFor(ds)), false);

    const applied = cli([ds, 'rename-field', 'Book', 'Isbn_Number', 'ISBN', '--dc', DC, '--apply'], dir);
    assert.equal(applied.code, 0, applied.err);
    assert.equal(editsPathFor(ds), join(dir, 'library.edits.json'));
    assert.equal(readFileSync(editsPathFor(ds), 'utf8'), editsJson({ version: 1, edits: [OPS[1]!.edits[0]!] }));
    assert.ok(loadApp(ds).forms.find((f) => f.name === 'Book')!.fields.some((f) => f.name === 'ISBN'), 'loadApp replays the edits log');

    // The next edit builds on the recorded one.
    const again = cli([ds, 'rename-field', 'Book', 'Isbn_Number', 'Code', '--dc', DC], dir);
    assert.equal(again.code, 1);
    assert.match(again.err, /refused: renameField: form "Book" has no field "Isbn_Number"/);
    const role = cli([ds, 'add-role', 'Auditor', '--parent', 'CEO', '--dc', DC, '--apply'], dir);
    assert.equal(role.code, 0, role.err);
    assert.equal(readEdits(editsPathFor(ds)).edits.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('c2c edit --apply of a drop needs --confirm; a refused edit exits 1 and records nothing', () => {
  const { dir, ds } = workdir();
  try {
    assert.equal(cli([ds, 'add-field', 'Book', 'Shelf', '--type', 'text', '--dc', DC, '--apply'], dir).code, 0);
    const noConfirm = cli([ds, 'remove-field', 'Book', 'Shelf', '--dc', DC, '--apply'], dir);
    assert.equal(noConfirm.code, 1);
    assert.match(noConfirm.err, /pass --confirm with --apply/);
    assert.equal(readEdits(editsPathFor(ds)).edits.length, 1);
    assert.equal(cli([ds, 'remove-field', 'Book', 'Shelf', '--dc', DC, '--apply', '--confirm'], dir).code, 0);
    assert.equal(readEdits(editsPathFor(ds)).edits.length, 2);

    const blocked = cli([ds, 'remove-field', 'Book', 'Title', '--dc', DC, '--apply', '--confirm'], dir);
    assert.equal(blocked.code, 1);
    assert.match(blocked.err, /still used in report "Book_Report"/);
    assert.equal(readEdits(editsPathFor(ds)).edits.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('c2c edit usage errors exit 2: missing words, unknown option, no data centre', () => {
  const { dir, ds } = workdir();
  try {
    assert.equal(cli([ds, 'rename-field', 'Book', 'Isbn_Number', '--dc', DC], dir).code, 2);
    assert.equal(cli([ds, 'rename-field', 'Book', 'A', 'B', '--dc', DC, '--force'], dir).code, 2);
    const noDc = cli([ds, 'add-role', 'Auditor'], dir);
    assert.equal(noDc.code, 2);
    assert.match(noDc.err, /no data centre set/);
    assert.equal(cli([ds, 'set-picklist', 'Book', 'Genre', '--dc', DC], dir).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('c2c edit --out writes the same delta tree on two runs, holding only touched files', () => {
  const { dir, ds } = workdir();
  try {
    const args = [ds, 'set-picklist', 'Book', 'Genre', '--choices', 'Sci-Fi,Biography,Non-Fiction,Fiction,Poetry', '--dc', DC];
    assert.equal(cli([...args, '--out', join(dir, 'a')], dir).code, 0);
    assert.equal(cli([...args, '--out', join(dir, 'b')], dir).code, 0);
    assert.deepEqual(treeHashes(join(dir, 'b')), treeHashes(join(dir, 'a')));
    const delta = JSON.parse(readFileSync(join(dir, 'a', 'delta.json'), 'utf8')) as PlanDelta;
    const written = treeHashes(join(dir, 'a')).map((l) => l.split(' ')[0]!).filter((p) => p.startsWith('files/'));
    assert.deepEqual(written, delta.files.filter((f) => f.op !== 'remove').map((f) => `files/${f.path}`).sort());
    assert.ok(written.length < 20, 'only the touched files are emitted');
    assert.deepEqual(delta.edits, [OPS[3]!.edits[0]!], 'the delta lists every recorded op, not only the newest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('c2c edit lists the whole edits log in the delta, not only the newest op', () => {
  const { dir, ds } = workdir();
  try {
    assert.equal(cli([ds, 'add-field', 'Book', 'Shelf', '--type', 'text', '--dc', DC, '--apply'], dir).code, 0);
    assert.equal(cli([ds, 'add-field', 'Book', 'Aisle', '--type', 'text', '--dc', DC, '--out', join(dir, 'd')], dir).code, 0);
    const delta = JSON.parse(readFileSync(join(dir, 'd', 'delta.json'), 'utf8')) as PlanDelta;
    assert.deepEqual(delta.edits, [
      { op: 'addField', form: 'Book', field: 'Shelf', type: 'text' },
      { op: 'addField', form: 'Book', field: 'Aisle', type: 'text' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cross-form references: reports and workflows on other forms

const SPAN = { start: 0, end: 0 };

/** A report shape: All_Book_Transactions reaches Book fields through the Book lookup. */
function crossRefs(app: App, text: boolean): App {
  const report = app.reports.find((r) => r.name === 'All_Book_Transactions')!;
  report.columns.push({ field: 'Book.Rating', properties: [], subcolumns: [], span: SPAN });
  report.sortBy.push({ field: 'Book.Rating' });
  report.groupBy.push({ field: 'Book.Rating', order: 'descending' });
  report.filters.push({ field: 'Book.Rating', span: SPAN });
  report.views[0]!.blocks[0]!.fields.push({ field: 'Book.Rating', properties: [], subcolumns: [], span: SPAN });
  app.workflows.push({
    name: 'Rate_check',
    form: 'Book_Transaction',
    event: 'on validate',
    fieldRules: [{ actions: [{ action: 'show', fields: ['Book.Rating'] }], span: SPAN }],
    deluge: null,
    properties: [],
    span: SPAN,
  });
  if (text) {
    report.criteria = 'Book.Rating > 3';
    report.filters[0]!.criteria = 'Book.Rating > 3';
    report.conditionalFormats.push({ name: 'high', condition: 'Book.Rating > 3', fields: '[Book.Rating]', properties: [], span: SPAN });
    app.workflows.push({
      name: 'Rate_condition',
      form: 'Book_Transaction',
      event: 'on success',
      actionCondition: 'Book.Rating > 3',
      recordEvent: 'on add of Book.Rating',
      fieldRules: [{ condition: 'Book.Rating > 3', actions: [], span: SPAN }],
      deluge: null,
      properties: [],
      span: SPAN,
    });
  }
  return app;
}

test('a rename rewrites Lookup.field references on another form\'s report and workflow', () => {
  const app = crossRefs(library(), false);
  const wheres = fieldUsages(app, 'Book', 'Rating').map((u) => u.where);
  for (const wanted of [
    'report "All_Book_Transactions" column Book.Rating',
    'report "All_Book_Transactions" sort/group Book.Rating',
    'report "All_Book_Transactions" filter Book.Rating',
    'report "All_Book_Transactions" quickview datablock1 column Book.Rating',
    'workflow "Rate_check" field rule show',
  ]) {
    assert.ok(wheres.includes(wanted), `missing usage: ${wanted} (got ${wheres.join('; ')})`);
  }
  const after = applyEdit(app, { op: 'renameField', form: 'Book', from: 'Rating', to: 'Stars' }).app;
  const report = after.reports.find((r) => r.name === 'All_Book_Transactions')!;
  assert.deepEqual(report.sortBy.map((s) => s.field), ['Book.Stars']);
  assert.deepEqual(report.groupBy.map((s) => s.field), ['Book.Stars']);
  assert.deepEqual(report.filters.map((f) => f.field), ['Book.Stars']);
  assert.ok(report.columns.some((c) => c.field === 'Book.Stars'));
  assert.ok(report.views[0]!.blocks[0]!.fields.some((c) => c.field === 'Book.Stars'));
  assert.deepEqual(after.workflows.find((w) => w.name === 'Rate_check')!.fieldRules![0]!.actions[0]!.fields, ['Book.Stars']);
});

test('cross-form criteria and workflow conditions block a rename and list each use on remove', () => {
  const app = crossRefs(library(), true);
  refused(
    () => applyEdit(app, { op: 'renameField', form: 'Book', from: 'Rating', to: 'Stars' }),
    /report "All_Book_Transactions" criteria.*workflow "Rate_condition" condition.*field rule condition/s,
  );
  refused(
    () => applyEdit(app, { op: 'removeField', form: 'Book', field: 'Rating' }),
    /report "All_Book_Transactions" criteria.*conditional format "high".*workflow "Rate_condition" condition.*field rule condition/s,
  );
});

// ---------------------------------------------------------------------------
// derived-column name collisions

test('refuses a name that lands on a column another field generates', () => {
  const app = library();
  refused(() => applyEdit(app, { op: 'renameField', form: 'Member_Info', from: 'Phone_Number', to: 'Name_first_name' }), /collides with Name's generated column "Name_first_name"/);
  refused(() => applyEdit(app, { op: 'addField', form: 'Member_Info', field: 'Max_Books_Allowed__n', type: 'text' }), /collides with Max_Books_Allowed's generated column "Max_Books_Allowed__n"/);
  refused(() => applyEdit(app, { op: 'addField', form: 'Member_Info', field: 'Name_last_name', type: 'text' }), /collides with Name's generated column "Name_last_name"/);
});

// ---------------------------------------------------------------------------
// deploy refuses edits the live store cannot apply

function deployIo(): { io: Io; out: () => string; err: () => string; spawned: () => number; fetched: () => number } {
  let out = '';
  let err = '';
  let spawned = 0;
  let fetched = 0;
  const io: Io = {
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    env: {},
    spawn: async () => {
      spawned++;
      return { code: 1, stdout: '', stderr: '' };
    },
    fetch: async () => {
      fetched++;
      throw new Error('no network in test');
    },
  };
  return { io, out: () => out, err: () => err, spawned: () => spawned, fetched: () => fetched };
}

test('c2c deploy refuses a recorded rename before any write, in a plan and under --confirm', async () => {
  const { dir, ds } = workdir();
  try {
    assert.equal(cli([ds, 'rename-field', 'Book', 'Rating', 'Stars', '--dc', DC, '--apply'], dir).code, 0);
    const plan = deployIo();
    assert.equal(await deployCli([ds, '--dc', DC], plan.io), 1);
    assert.match(plan.err(), /rename column Book\.Rating -> Stars/);
    assert.match(plan.err(), /not yet supported on the live store/);
    assert.match(plan.err(), /nothing was changed/);
    const confirm = deployIo();
    assert.equal(await deployCli([ds, '--dc', DC, '--confirm', '--function-env', 'new', '--project', '1001', '--org', '10000000000'], confirm.io), 1);
    assert.match(confirm.err(), /nothing was changed/);
    assert.equal(confirm.spawned(), 0);
    assert.equal(confirm.fetched(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('c2c deploy refuses a recorded remove before any write', async () => {
  const { dir, ds } = workdir();
  try {
    assert.equal(cli([ds, 'remove-field', 'Book', 'Book_ID', '--dc', DC, '--apply', '--confirm'], dir).code, 0);
    const cap = deployIo();
    assert.equal(await deployCli([ds, '--dc', DC, '--confirm', '--function-env', 'new', '--project', '1001', '--org', '10000000000'], cap.io), 1);
    assert.match(cap.err(), /drop column Book\.Book_ID/);
    assert.match(cap.err(), /nothing was changed/);
    assert.equal(cap.spawned(), 0);
    assert.equal(cap.fetched(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('c2c deploy still deploys a recorded add-field, and --edits reads a custom log path', async () => {
  const { dir, ds } = workdir();
  try {
    const custom = join(dir, 'custom.edits.json');
    assert.equal(cli([ds, 'add-field', 'Book', 'Shelf', '--type', 'text', '--dc', DC, '--edits', custom, '--apply'], dir).code, 0);
    assert.ok(existsSync(custom));
    const cap = deployIo();
    assert.equal(await deployCli([ds, '--dc', DC, '--edits', custom], cap.io), 0, cap.err());
    assert.match(cap.out(), /create column Book\.Shelf/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
