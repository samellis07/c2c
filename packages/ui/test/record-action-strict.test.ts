/**
 * A report custom action dispatches only when its `workflow =` names, exactly,
 * a Creator `type = functions` workflow with a record execution type — the
 * binding the custom-action precheck accepts. A standalone Deluge function of
 * the same name, a case-different name, or a Creator function with no record
 * execution type is a stub: the button is turned off, the action is a counted
 * todo in the model and migration-report.json, and a live call is a 422.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);

const action = (label: string, workflow: string) =>
  `${tab(3)}custom action "${label}"\n${tab(3)}(\n${tab(4)}workflow = ${workflow}\n${tab(4)}column header = "${label}"\n${tab(3)})`;

const creatorFn = (name: string, exec: string | null) =>
  `${tab(2)}${name} as "${name}"\n${tab(2)}{\n${tab(3)}type = functions\n${tab(3)}form = Item\n${
    exec ? `${tab(3)}execution type = ${exec}\n` : ''
  }${tab(3)}on start\n${tab(3)}{\n${tab(4)}actions\n${tab(4)}{\n${tab(5)}rec.Status = "Lost";\n${tab(4)}}\n${tab(3)}}\n${tab(2)}}`;

const SOURCE = `application "Demo"
{
${tab(1)}form Item
${tab(1)}{
${tab(2)}Name
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}Status
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(1)}}
${tab(1)}list All_Items
${tab(1)}{
${tab(2)}show all rows from Item
${tab(2)}(
${tab(3)}Name
${tab(3)}Status
${action('Mark as Lost', 'Mark_Lost')}
${action('Mark All', 'Mark_All')}
${action('Do It', 'do_one')}
${action('Near Name', 'mark_lost')}
${action('No Exec', 'No_Exec')}
${tab(2)})
${tab(1)}}
${tab(1)}workflow
${tab(1)}{
${tab(1)}functions
${tab(1)}{
${creatorFn('Mark_Lost', 'for each record')}
${creatorFn('Mark_All', 'collection of records')}
${creatorFn('No_Exec', null)}
${tab(1)}}
${tab(1)}}
${tab(1)}functions
${tab(1)}{
${tab(2)}Deluge
${tab(2)}{
${tab(3)}void do_one(int id)
${tab(3)}{
${tab(4)}info id;
${tab(3)}}
${tab(2)}}
${tab(1)}}
${tab(1)}share_settings
${tab(1)}{
${tab(2)}"Staff"
${tab(2)}{
${tab(3)}name = "Staff"
${tab(3)}type = Users_Permissions
${tab(3)}ModulePermissions
${tab(3)}{
${tab(4)}Item
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}All_Items = {"View","Edit"}
${tab(5)}}
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
}
`;

const LIVE = ['Mark as Lost', 'Mark All'];
const STUBS = ['Do It', 'Near Name', 'No Exec'];
const endpointFile = (name: string) => `functions/reports/all-items-action-${name.toLowerCase().replace(/\s+/g, '-')}.mjs`;

test('only an exact Creator record or collection workflow dispatches; wrong-kind, near-name and no-execution-type actions are counted stubs', () => {
  const ir = deriveIr(parse(SOURCE));
  // The fixture really declares a same-named standalone Deluge function and
  // Creator workflows, so the stubs are not stubs for lack of a function.
  assert.equal(ir.functions.find((fn) => fn.name === 'do_one')?.kind, 'deluge');
  assert.equal(ir.functions.find((fn) => fn.name === 'Mark_Lost')?.kind, 'creator');
  assert.equal(ir.functions.find((fn) => fn.name === 'No_Exec')?.kind, 'creator');
  const built = buildUi(ir);
  assert.ok(built.files.some((file) => file.path === 'functions/custom/do-one.mjs'), 'the Deluge function module was generated');
  const report = built.model.reports.find((item) => item.name === 'All_Items')!;
  const byName = new Map(report.customActions.map((item) => [item.name, item]));
  for (const name of LIVE) assert.equal(byName.get(name)?.preview, undefined, `${name} dispatches`);
  for (const name of STUBS) assert.equal(byName.get(name)?.preview, true, `${name} is a stub`);
  const actionTodos = built.model.todos.filter((todo) => todo.area === 'report' && /^Custom action /.test(todo.reason));
  assert.deepEqual(
    actionTodos.map((todo) => todo.reason),
    STUBS.map((name) => `Custom action "${name}" is not migrated; its button is turned off.`),
  );
  const migration = built.files.find((file) => file.path.endsWith('migration-report.json'));
  assert.ok(migration, 'migration-report.json was generated');
  assert.equal((JSON.parse(String(migration.data)) as { uiTodoCount: number }).uiTodoCount, built.model.todos.length);
  for (const name of LIVE) {
    const data = String(built.files.find((file) => file.path === endpointFile(name))?.data);
    assert.match(data, /ctx\.shim\.thisapp\.call/, `${name} endpoint dispatches`);
  }
  for (const name of STUBS) {
    const data = String(built.files.find((file) => file.path === endpointFile(name))?.data);
    assert.doesNotMatch(data, /thisapp/, `${name} endpoint does not dispatch`);
    assert.match(data, /has no generated function to run/, `${name} endpoint refuses`);
  }
});

test('a live call to a wrong-kind or near-name action is refused with 422', async () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-record-action-strict-'));
  const prevMode = process.env.C2C_DEPLOY_MODE;
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
    for (const file of built.files) {
      const full = join(dir, file.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.data);
    }
    process.env.C2C_DEPLOY_MODE = 'live';
    for (const name of STUBS) {
      const mod = (await import(pathToFileURL(join(dir, endpointFile(name))).href)) as { default: (req: unknown, res: unknown) => unknown };
      let status = 0;
      let raw = '';
      await mod.default(
        { user: { profile: 'Staff', loginUser: 'ada@example.test' }, body: { ROWID: '1' } },
        { writeHead: (code: number) => (status = code), end: (body: string) => (raw = body) },
      );
      assert.equal(status, 422, `${name}: ${raw}`);
      const body = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(body.dryRun, false);
      assert.equal(body.wrote, false);
      assert.equal(body.refused, true);
    }
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every custom action in the redistributable fixtures is a genuine Creator binding and stays dispatchable', () => {
  const sources = [
    'fixtures/redistributable/library-application-system/library_application.ds',
    'fixtures/redistributable/freight-forwarding/Creator_app_source_code.ds',
  ];
  const seen: string[] = [];
  for (const path of sources) {
    const built = buildUi(deriveIr(parse(readFileSync(join(repoRoot(), path), 'utf8'))));
    for (const report of built.model.reports) {
      for (const item of report.customActions) {
        seen.push(`${report.name}:${item.workflow}`);
        assert.equal(item.preview, undefined, `${report.name} action ${item.name} (workflow ${item.workflow}) dispatches`);
      }
    }
  }
  assert.equal(seen.length, 7, seen.join(', '));
});
