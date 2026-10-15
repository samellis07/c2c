import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { emptyApp, type App, type Workflow } from '../../core/src/ir.js';
import { acceptTodo, collectTasks } from '../../deluge/src/index.js';
import {
  buildMigrationReport,
  listReportApps,
  migrationReportAsText,
  migrationReportForDir,
} from '../src/migration-report.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtures = join(root, 'fixtures/redistributable');

const Z = { start: 0, end: 0 };

function workflowWith(text: string): Workflow {
  return {
    name: 'On add',
    form: 'Orders',
    event: 'on success',
    deluge: { text, span: { start: 0, end: text.length } },
    properties: [],
    span: Z,
  } as Workflow;
}

function appWith(text: string): App {
  return { ...emptyApp('empty'), name: 'Report_App', workflows: [workflowWith(text)] };
}

/** One expression hole on a vector-covered method: an unknown receiver leaves `getDay` untranslated. */
function coveredApp(): App {
  return appWith('x = unknownCall().getDay();');
}

test('committed fixtures carry the deterministic flag', () => {
  const report = migrationReportForDir(fixtures, 'redistributable');
  assert.equal(report.schema, 'c2c-migration-report/1');
  assert.equal(report.aggregate.totalApps, 2);
  const ff = report.apps.find((app) => app.app === 'freight-forwarding');
  const lib = report.apps.find((app) => app.app === 'library-application-system');
  assert.ok(ff && lib);
  assert.equal(ff.deterministic, false);
  assert.equal(ff.todoCount, 14);
  assert.equal(ff.fillLockEntries, 0);
  assert.equal(ff.uiTodoCount, 1);
  assert.equal(
    ff.todoKinds.reduce((sum, kind) => sum + kind.count, 0),
    14,
  );
  assert.equal(lib.deterministic, true);
  assert.equal(lib.todoCount, 0);
  assert.deepEqual(lib.todoKinds, []);
  assert.equal(report.aggregate.deterministicApps, 1);
  assert.equal(report.aggregate.todoTotal, 14);
});

test('aggregate counts only deterministic apps toward the 95%/100% targets', () => {
  const entries = [];
  for (let i = 0; i < 19; i++) entries.push({ name: `clean-${i}`, ir: { ...emptyApp('empty'), name: `Clean ${i}` } });
  entries.push({ name: 'dirty', ir: coveredApp() });
  const report = buildMigrationReport(entries, 'synthetic');
  assert.equal(report.aggregate.totalApps, 20);
  assert.equal(report.aggregate.deterministicApps, 19);
  assert.equal(report.aggregate.deterministicShare, 95);
  assert.deepEqual(report.aggregate.targets.p95, { required: 19, met: true });
  assert.deepEqual(report.aggregate.targets.p100, { required: 20, met: false });
  const text = migrationReportAsText(report);
  assert.match(text, /apps 20  deterministic 19/);
  assert.match(text, /95% needs 19 — met/);
  assert.match(text, /100% needs 20 — NOT met/);
});

test('an applied lock fill disqualifies the deterministic flag', async () => {
  const app = coveredApp();
  const task = collectTasks(app).find((item) => item.role !== 'note');
  assert.ok(task);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-report-lock-'));
  try {
    const lockPath = join(dir, 'c2c.lock.json');
    const lock = await acceptTodo({ app, taskId: task.id, fill: 'shim.input.get(ctx, "A")', lockPath });
    const withLock = buildMigrationReport([{ name: 'filled', ir: app, lock }], 'synthetic');
    // Two TODO items (unknownCall call, getDay method) collapse into the one accepted hole.
    assert.equal(withLock.apps[0]!.todoCount, 2);
    assert.ok(withLock.apps[0]!.todoKinds.some((kind) => kind.construct === 'method:getDay'));
    assert.equal(withLock.apps[0]!.fillLockEntries, 1);
    assert.equal(withLock.apps[0]!.deterministic, false);
    assert.equal(withLock.aggregate.deterministicApps, 0);
    // The same lock names no task of a todo-free app, so it stays deterministic.
    const foreign = buildMigrationReport([{ name: 'clean', ir: { ...emptyApp('empty'), name: 'Clean' }, lock }], 'synthetic');
    assert.equal(foreign.apps[0]!.fillLockEntries, 0);
    assert.equal(foreign.apps[0]!.deterministic, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listReportApps skips dotfiles and files without .ds', () => {
  const apps = listReportApps(fixtures);
  assert.deepEqual(
    apps.map((app) => app.name),
    ['freight-forwarding', 'library-application-system'],
  );
});

test('c2c migration-report and analyze --json print the flag from the CLI', () => {
  const cli = join(root, 'dist/cli/src/c2c.js');
  const report = spawnSync(process.execPath, [cli, 'migration-report', fixtures, '--json'], { encoding: 'utf8' });
  assert.equal(report.status, 0, report.stderr);
  const parsed = JSON.parse(report.stdout) as { aggregate: { totalApps: number; deterministicApps: number } };
  assert.deepEqual([parsed.aggregate.totalApps, parsed.aggregate.deterministicApps], [2, 1]);
  const text = spawnSync(process.execPath, [cli, 'migration-report', fixtures], { encoding: 'utf8' });
  assert.match(text.stdout, /apps 2  deterministic 1 \(50%\)/);
  const analyzed = spawnSync(process.execPath, [cli, 'analyze', join(fixtures, 'library-application-system'), '--json'], { encoding: 'utf8' });
  assert.equal(analyzed.status, 0, analyzed.stderr);
  assert.equal((JSON.parse(analyzed.stdout) as { determinism: { deterministic: boolean } }).determinism.deterministic, true);
  const notDir = spawnSync(process.execPath, [cli, 'migration-report', join(fixtures, 'missing')], { encoding: 'utf8' });
  assert.equal(notDir.status, 2);
});
