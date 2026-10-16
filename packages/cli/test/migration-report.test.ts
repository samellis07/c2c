import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { emptyApp, type App, type Workflow } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import { acceptTodo, collectTasks, readLock, type FillLock } from '../../deluge/src/index.js';
import {
  buildMigrationReport,
  listReportApps,
  loadIr,
  lockFor,
  migrationReportAsText,
  migrationReportForDir,
} from '../src/migration-report.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtures = join(root, 'fixtures/redistributable');
// The `node c2c.js` children below share a V8 compile cache so each e2e spawn
// does not recompile the whole CLI (ignored on runtimes without it).
process.env.NODE_COMPILE_CACHE ??= join(tmpdir(), 'c2c-node-compile-cache');

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
  assert.equal(ff.todoCount, 13);
  assert.equal(ff.fillLockEntries, 0);
  assert.equal(ff.uiTodoCount, 2);
  assert.equal(
    ff.todoKinds.reduce((sum, kind) => sum + kind.count, 0),
    13,
  );
  // Each report custom action is a dry-run stub endpoint: one counted UI todo apiece.
  assert.equal(lib.deterministic, false);
  assert.equal(lib.todoCount, 6);
  assert.equal(lib.uiTodoCount, 6);
  assert.ok(lib.todoKinds.every((kind) => /^Custom action ".+" is not migrated; its button is turned off\.$/.test(kind.construct)), JSON.stringify(lib.todoKinds));
  assert.equal(lib.silentDrops, 21);
  assert.equal(ff.silentDrops, 269);
  assert.equal(report.aggregate.deterministicApps, 0);
  assert.equal(report.aggregate.silentDrops, 290);
  assert.equal(report.aggregate.todoTotal, 19);
  // Both apps carry residual todos now that lib's stub custom actions are counted.
  assert.equal(report.aggregate.noTodoApps, 0);
  for (const app of [lib, ff]) assert.equal(app.silentDropKinds.reduce((sum, kind) => sum + kind.count, 0), app.silentDrops);
  assert.equal(report.aggregate.silentDropKinds.reduce((sum, kind) => sum + kind.count, 0), 290);
  const text = migrationReportAsText(report);
  assert.match(text, /^apps with no residual todos: 0\/2$/m);
  assert.match(text, /^apps with no residual todos and no silent drops \(deterministic\): 0\/2$/m);
  assert.match(text, /^silent drops \(total\): 290$/m);
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
  assert.deepEqual([parsed.aggregate.totalApps, parsed.aggregate.deterministicApps], [2, 0]);
  const text = spawnSync(process.execPath, [cli, 'migration-report', fixtures], { encoding: 'utf8' });
  assert.match(text.stdout, /apps 2  deterministic 0 \(0%\)/);
  const analyzed = spawnSync(process.execPath, [cli, 'analyze', join(fixtures, 'library-application-system'), '--json'], { encoding: 'utf8' });
  assert.equal(analyzed.status, 0, analyzed.stderr);
  assert.equal((JSON.parse(analyzed.stdout) as { determinism: { deterministic: boolean } }).determinism.deterministic, false);
  const notDir = spawnSync(process.execPath, [cli, 'migration-report', join(fixtures, 'missing')], { encoding: 'utf8' });
  assert.equal(notDir.status, 2);
});

// Oracles: the previous stat-based listing and lock lookup with lstat in
// place of stat, so symlinks are not followed: a link entry is skipped and a
// linked lock is no lock.
function lstatListDsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(d, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && name.toLowerCase().endsWith('.ds') && !name.toLowerCase().endsWith('.exported.ds')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function lstatListReportApps(dir: string): { name: string; target: string }[] {
  const names = readdirSync(dir).sort((a, b) => compareEnUs(a, b));
  const out: { name: string; target: string }[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const target = join(dir, name);
    const st = lstatSync(target, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (lstatListDsFiles(target).length) out.push({ name, target });
    } else if (name.toLowerCase().endsWith('.ds')) {
      out.push({ name: basename(name), target });
    }
  }
  return out;
}

function lstatLockFor(target: string): FillLock | undefined {
  const st = statSync(target, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return undefined;
  const candidate = join(target, 'c2c.lock.json');
  if (!lstatSync(candidate, { throwIfNoEntry: false })?.isFile()) return undefined;
  return readLock(candidate);
}

/** A Unix socket file at `dir/name`, bound by a child from `dir` (short sun_path) that exits without closing. */
const mksock = (dir: string, name: string) =>
  execFileSync(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(name)}, () => process.exit(0))`], { cwd: dir });

function withAppsDir(fn: (dir: string, ds: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-mig-fs-'));
  try {
    fn(dir, readFileSync(join(root, 'fixtures/dialects/d1-minimal.ds'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('listReportApps reads Dirent kinds, follows no link, and matches the lstat listing for directory, link, dangling and FIFO entries', () => {
  withAppsDir((dir, ds) => {
    mkdirSync(join(dir, 'app-a'));
    writeFileSync(join(dir, 'app-a', 'a.ds'), ds);
    mkdirSync(join(dir, 'empty'));
    writeFileSync(join(dir, 'b.ds'), ds);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, '.hidden', 'h.ds'), ds);
    symlinkSync(join(dir, 'app-a'), join(dir, 'linked-app'));
    symlinkSync(join(dir, 'b.ds'), join(dir, 'linked.ds'));
    symlinkSync(join(dir, 'gone.ds'), join(dir, 'dangling.ds'));
    execFileSync('mkfifo', [join(dir, 'pipe.ds')]);
    const got = listReportApps(dir);
    assert.deepEqual(got, lstatListReportApps(dir));
    assert.deepEqual(got.map((app) => app.name), ['app-a', 'b.ds', 'pipe.ds']);
    assert.throws(() => listReportApps(join(dir, 'missing')), { code: 'ENOENT' });
    assert.throws(() => listReportApps(join(dir, 'b.ds')), { code: 'ENOTDIR' });
  });
});

test('lockFor opens c2c.lock.json once; absent target, file target, directory, FIFO and linked lock are no lock', () => {
  withAppsDir((dir, ds) => {
    const app = join(dir, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'c2c.lock.json'), '{"version":1,"entries":{"a":{"id":"a"}}}\n');
    writeFileSync(join(dir, 'one.ds'), ds);
    mkdirSync(join(dir, 'dir-lock', 'c2c.lock.json'), { recursive: true });
    mkdirSync(join(dir, 'fifo-lock'));
    execFileSync('mkfifo', [join(dir, 'fifo-lock', 'c2c.lock.json')]);
    mkdirSync(join(dir, 'link-lock'));
    symlinkSync(join(app, 'c2c.lock.json'), join(dir, 'link-lock', 'c2c.lock.json'));
    const calls: string[] = [];
    const fsImpl = {
      openSync(p: string, flags: number) {
        calls.push(`open:${p.slice(dir.length + 1)}`);
        return openSync(p, flags);
      },
      fstatSync(fd: number) {
        calls.push('fstat');
        return fstatSync(fd);
      },
      readFileSync(fd: number, encoding: 'utf8') {
        calls.push('read-fd');
        return readFileSync(fd, encoding);
      },
      closeSync(fd: number) {
        calls.push('close');
        closeSync(fd);
      },
    };
    assert.deepEqual(lockFor(app, fsImpl), { version: 1, entries: { a: { id: 'a' } } });
    assert.deepEqual(calls, ['open:app/c2c.lock.json', 'fstat', 'read-fd', 'close']);
    calls.length = 0;
    assert.equal(lockFor(join(dir, 'no-such-app'), fsImpl), undefined);
    assert.deepEqual(calls, ['open:no-such-app/c2c.lock.json']);
    calls.length = 0;
    assert.equal(lockFor(join(dir, 'one.ds'), fsImpl), undefined);
    assert.deepEqual(calls, ['open:one.ds/c2c.lock.json']);
    assert.equal(lockFor(join(dir, 'dir-lock')), undefined);
    assert.equal(lockFor(join(dir, 'fifo-lock')), undefined);
    calls.length = 0;
    assert.equal(lockFor(join(dir, 'link-lock'), fsImpl), undefined);
    assert.deepEqual(calls, ['open:link-lock/c2c.lock.json']);
    assert.equal(lstatLockFor(join(dir, 'link-lock')), undefined);
    writeFileSync(join(app, 'c2c.lock.json'), '{');
    assert.throws(() => lockFor(app), { name: 'FillTodoError', message: 'lock file is not valid JSON' });
  });
});

test('loadIr classifies the opened target: project, file, absent (ENOENT) and FIFO (NotFileError)', () => {
  withAppsDir((dir, ds) => {
    mkdirSync(join(dir, 'proj'));
    writeFileSync(join(dir, 'proj', 'a.ds'), ds);
    writeFileSync(join(dir, 'one.ds'), ds);
    execFileSync('mkfifo', [join(dir, 'pipe.ds')]);
    assert.deepEqual(loadIr(join(dir, 'proj')).files, ['a.ds']);
    assert.equal(loadIr(join(dir, 'one.ds')).files, undefined);
    assert.throws(() => loadIr(join(dir, 'missing')), { code: 'ENOENT' });
    assert.throws(() => loadIr(join(dir, 'pipe.ds')), { name: 'NotFileError' });
  });
});

test('listReportApps and lockFor match the lstat oracles for links to a socket and to an unreadable file or directory', { skip: process.getuid?.() === 0 }, () => {
  withAppsDir((dir, ds) => {
    mkdirSync(join(dir, 'app-a'));
    writeFileSync(join(dir, 'app-a', 'a.ds'), ds);
    mksock(dir, 's.sock');
    symlinkSync(join(dir, 's.sock'), join(dir, 'sock-link.ds'));
    symlinkSync(join(dir, 's.sock'), join(dir, 'sock-link'));
    writeFileSync(join(dir, 'locked.ds'), ds);
    symlinkSync(join(dir, 'locked.ds'), join(dir, 'locked-link.ds'));
    mkdirSync(join(dir, 'sock-lock'));
    mksock(join(dir, 'sock-lock'), 'c2c.lock.json');
    chmodSync(join(dir, 'locked.ds'), 0o000);
    try {
      const got = listReportApps(dir);
      assert.deepEqual(got, lstatListReportApps(dir));
      assert.deepEqual(got.map((app) => app.name), ['app-a', 'locked.ds']);
      assert.equal(lstatLockFor(join(dir, 'sock-lock')), undefined);
      assert.equal(lockFor(join(dir, 'sock-lock')), undefined);
    } finally {
      chmodSync(join(dir, 'locked.ds'), 0o644);
    }
    // A link to an unreadable directory outside the apps dir is skipped, not walked.
    const apps = join(dir, 'apps');
    mkdirSync(join(apps, 'app-a'), { recursive: true });
    writeFileSync(join(apps, 'app-a', 'a.ds'), ds);
    mkdirSync(join(dir, 'locked-dir'));
    symlinkSync(join(dir, 'locked-dir'), join(apps, 'locked-dir-link'));
    chmodSync(join(dir, 'locked-dir'), 0o000);
    try {
      assert.deepEqual(listReportApps(apps), lstatListReportApps(apps));
      assert.deepEqual(listReportApps(apps).map((app) => app.name), ['app-a']);
    } finally {
      chmodSync(join(dir, 'locked-dir'), 0o755);
    }
    // An unreadable app directory itself still throws, as before.
    mkdirSync(join(apps, 'locked-app'));
    chmodSync(join(apps, 'locked-app'), 0o000);
    try {
      assert.throws(() => lstatListReportApps(apps), { code: 'EACCES' });
      assert.throws(() => listReportApps(apps), { code: 'EACCES' });
    } finally {
      chmodSync(join(apps, 'locked-app'), 0o755);
    }
  });
});
