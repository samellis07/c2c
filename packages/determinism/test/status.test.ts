import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';
import { emptyApp, type App, type Workflow } from '../../core/src/ir.js';
import { buildMigrationReport, migrationReportForDir, type MigrationReport } from '../../cli/src/migration-report.js';
import {
  builtinTodoCount,
  canonicalStatusJson,
  computeDeterminismStatus,
  main,
  parseStatusDoc,
  publicConstruct,
  renderStatusDoc,
  resolveSitesPath,
  resolveStatusDir,
  statusFromReport,
  type DeterminismStatus,
  type SiteAttribution,
} from '../src/status.js';

const root = repoRoot();
const docPath = join(root, 'docs/determinism-status.md');

function statusDir(): string | undefined {
  const dir = resolveStatusDir(process.env);
  return dir && existsSync(dir) ? dir : undefined;
}

test('status doc round-trips through its machine-readable block', () => {
  const status: DeterminismStatus = {
    totalApps: 3,
    deterministicApps: 1,
    todoTotal: 4,
    kinds: [
      { construct: 'task:if', count: 3 },
      { construct: 'method:select', count: 1 },
    ],
    perAppConstructSets: [{ constructs: ['task:if'], items: 3 }],
    deterministicWithUiTodos: { apps: 1, uiTodos: 2 },
  };
  const doc = renderStatusDoc(status);
  assert.match(doc, /\| deterministic apps \| 1 \(33\.3%\) \|/);
  assert.match(doc, /Each UI stub is included in the residual/);
  assert.match(doc, /1 of the 1 deterministic apps still have UI TODO stubs \(2 in total\)/);
  assert.equal(/\d{4}-\d{2}-\d{2}|\/Users\//.test(doc), false);
  assert.deepEqual(parseStatusDoc(doc), status);
  assert.equal(canonicalStatusJson(status), JSON.stringify(JSON.parse(canonicalStatusJson(status)), null, 2));
});

test('resolveStatusDir prefers argv, then C2C_FIXTURES_DIR, then C2C_GALLERY_DIR, else nothing', () => {
  assert.equal(resolveStatusDir({ C2C_FIXTURES_DIR: '/fx', C2C_GALLERY_DIR: '/gal' }, '/argv'), '/argv');
  assert.equal(resolveStatusDir({ C2C_FIXTURES_DIR: '/fx' }), join('/fx', 'gallery'));
  assert.equal(resolveStatusDir({ C2C_GALLERY_DIR: '/gal' }), '/gal');
  assert.equal(resolveStatusDir({}), undefined);
});

test('publicConstruct keeps builtins, keywords and translator kinds, and buckets app identifiers', () => {
  assert.equal(publicConstruct('criteria-dynamic'), 'criteria-dynamic');
  assert.equal(publicConstruct('method:getAll'), 'method:getAll');
  assert.equal(publicConstruct('task:if'), 'task:if');
  assert.equal(publicConstruct('sendmail-attachment:template'), 'sendmail-attachment:template');
  assert.equal(publicConstruct('task:my_private_list'), 'task:(app identifier)');
  assert.equal(publicConstruct('call:customerFunction'), 'call:(app identifier)');
  assert.equal(publicConstruct('method:Line_Items'), 'method:(app identifier)');
});

const QUOTED_IDENTIFIER = /"[A-Za-z_][A-Za-z0-9_]*"/;

/** No quoted identifier remains in any public construct string. */
function assertNoQuotedIdentifiers(status: DeterminismStatus): void {
  for (const kind of status.kinds) assert.equal(QUOTED_IDENTIFIER.test(kind.construct), false, kind.construct);
  for (const set of status.perAppConstructSets) {
    for (const name of set.constructs) assert.equal(QUOTED_IDENTIFIER.test(name), false, name);
  }
}

test('a quoted name in the construct prefix is absent from the doc and the JSON', () => {
  const prefix = 'Print template "prefix_secret_9f3c": Inline style declarations not carried over (unsafe or unsupported CSS): background';
  const other = 'Print template "other_secret_9f3c": Inline style declarations not carried over (unsafe or unsupported CSS): color';
  const bare = 'Named filter "prefix_secret_9f3c" is not migrated; selecting it returns no rows.';
  assert.equal(publicConstruct(prefix), publicConstruct(other));
  assert.equal(publicConstruct(prefix), 'Print template (app identifier):(app identifier)');
  assert.equal(publicConstruct(bare), 'Named filter (app identifier) is not migrated; selecting it returns no rows.');
  assert.equal(/prefix_secret_9f3c|other_secret_9f3c/.test(publicConstruct(prefix) + publicConstruct(bare)), false);
  const report = {
    schema: 'c2c-migration-report/1',
    label: 'unit',
    apps: [
      {
        app: 'folder-prefix-9f3c',
        deterministic: false,
        todoCount: 4,
        fillLockEntries: 0,
        todoKinds: [
          { construct: prefix, count: 3 },
          { construct: 'task:sort', count: 1 },
        ],
        uiTodoCount: 0,
        readiness: 0,
        band: 'blocked',
      },
      {
        app: 'folder-other-9f3c',
        deterministic: false,
        todoCount: 1,
        fillLockEntries: 0,
        todoKinds: [{ construct: other, count: 1 }],
        uiTodoCount: 0,
        readiness: 0,
        band: 'needs-work',
      },
    ],
    aggregate: {
      totalApps: 2,
      deterministicApps: 0,
      deterministicShare: 0,
      targets: { p95: { required: 2, met: false }, p100: { required: 2, met: false } },
      todoTotal: 5,
      distinctTodoKinds: 3,
      todoKinds: [
        { construct: prefix, count: 3 },
        { construct: other, count: 1 },
        { construct: 'task:sort', count: 1 },
      ],
      deterministicWithUiTodos: { apps: 0, uiTodos: 0 },
    },
  } as MigrationReport;
  const status = statusFromReport(report);
  const doc = renderStatusDoc(status);
  const json = canonicalStatusJson(status);
  assert.equal(/prefix_secret_9f3c|other_secret_9f3c/.test(doc + json), false);
  assert.equal(
    status.kinds.find((kind) => kind.construct.startsWith('Print template'))?.count,
    4,
  );
  assert.equal(status.kinds.length, 2);
  assertNoQuotedIdentifiers(status);
  assertNoQuotedIdentifiers(parseStatusDoc(doc));
});

test('status comes from the migration report and merges bucketed kinds', () => {
  const app = (text: string): App => ({
    ...emptyApp('empty'),
    name: 'T',
    workflows: [
      { name: 'On add', form: 'Orders', event: 'on success', deluge: { text, span: { start: 0, end: text.length } }, properties: [], span: { start: 0, end: 0 } } as Workflow,
    ],
  });
  const report = buildMigrationReport(
    [
      { name: 'clean', ir: app('info "ok";') },
      { name: 'one', ir: app('shareTo x;\nalpha_list.frobnicate();') },
      { name: 'two', ir: app('x = subBusinessDay(Calendar,0).getDay();') },
    ],
    'unit',
  );
  const status = statusFromReport(report);
  assert.equal(status.totalApps, 3);
  assert.equal(status.deterministicApps, 1);
  assert.ok(status.todoTotal >= 3);
  assert.equal(status.deterministicApps, report.aggregate.deterministicApps);
  assert.equal(status.todoTotal, report.aggregate.todoTotal);
  assert.equal(
    status.kinds.reduce((sum, kind) => sum + kind.count, 0),
    status.todoTotal,
  );
  assert.equal(/alpha_list|frobnicate|shareTo/.test(JSON.stringify(status)), false);
  assert.ok(status.kinds.some((kind) => kind.construct === 'method:getDay'));
});

test('status records one sorted name-free construct set per non-deterministic app', () => {
  const report = {
    schema: 'c2c-migration-report/1',
    label: 'unit',
    apps: [
      {
        app: 'folder-zebra-9f3c',
        deterministic: false,
        todoCount: 3,
        fillLockEntries: 0,
        todoKinds: [
          { construct: 'task:sort', count: 2 },
          { construct: 'task:zebra_widget_9f3c', count: 1 },
        ],
        uiTodoCount: 0,
        readiness: 0,
        band: 'blocked',
      },
      {
        app: 'folder-alpha-9f3c',
        deterministic: false,
        todoCount: 1,
        fillLockEntries: 0,
        todoKinds: [{ construct: 'task:sort', count: 1 }],
        uiTodoCount: 0,
        readiness: 0,
        band: 'needs-work',
      },
      {
        app: 'folder-clean-9f3c',
        deterministic: true,
        todoCount: 0,
        fillLockEntries: 0,
        todoKinds: [],
        uiTodoCount: 0,
        readiness: 100,
        band: 'ready',
      },
      {
        app: 'folder-mid-9f3c',
        deterministic: false,
        todoCount: 4,
        fillLockEntries: 0,
        todoKinds: [
          { construct: 'criteria-dynamic', count: 3 },
          { construct: 'method:alpha_secret_9f3c', count: 1 },
        ],
        uiTodoCount: 0,
        readiness: 0,
        band: 'blocked',
      },
      {
        app: 'folder-bucket-9f3c',
        deterministic: false,
        todoCount: 5,
        fillLockEntries: 0,
        todoKinds: [
          { construct: 'call:zebra_fn_9f3c', count: 3 },
          { construct: 'call:alpha_fn_9f3c', count: 2 },
        ],
        uiTodoCount: 0,
        readiness: 0,
        band: 'blocked',
      },
    ],
    aggregate: {
      totalApps: 5,
      deterministicApps: 1,
      deterministicShare: 20,
      targets: { p95: { required: 5, met: false }, p100: { required: 5, met: false } },
      todoTotal: 13,
      distinctTodoKinds: 6,
      todoKinds: [
        { construct: 'call:zebra_fn_9f3c', count: 3 },
        { construct: 'criteria-dynamic', count: 3 },
        { construct: 'task:sort', count: 3 },
        { construct: 'call:alpha_fn_9f3c', count: 2 },
        { construct: 'method:alpha_secret_9f3c', count: 1 },
        { construct: 'task:zebra_widget_9f3c', count: 1 },
      ],
      deterministicWithUiTodos: { apps: 0, uiTodos: 0 },
    },
  } as MigrationReport;
  const status = statusFromReport(report);
  assert.equal(status.totalApps, 5);
  assert.equal(status.deterministicApps, 1);
  assert.equal(status.todoTotal, 13);
  assert.deepEqual(status.deterministicWithUiTodos, { apps: 0, uiTodos: 0 });
  assert.deepEqual(
    status.kinds.map((kind) => `${kind.count} ${kind.construct}`),
    [
      '5 call:(app identifier)',
      '3 criteria-dynamic',
      '3 task:sort',
      '1 method:(app identifier)',
      '1 task:(app identifier)',
    ],
  );
  const parsed = JSON.parse(canonicalStatusJson(status)) as { perAppConstructSets?: { constructs: string[]; items: number }[] };
  assert.deepEqual(parsed.perAppConstructSets, [
    { constructs: ['call:(app identifier)'], items: 5 },
    { constructs: ['criteria-dynamic', 'method:(app identifier)'], items: 4 },
    { constructs: ['task:(app identifier)', 'task:sort'], items: 3 },
    { constructs: ['task:sort'], items: 1 },
  ]);
  const doc = renderStatusDoc(status);
  const sole = doc.slice(doc.indexOf('## Sole-kind unblocks'));
  assert.match(sole, /\| `call:\(app identifier\)` \| 1 \|/);
  assert.match(sole, /\| `task:sort` \| 1 \|/);
  assert.equal(/criteria-dynamic/.test(sole.split('## Machine-readable')[0] ?? ''), false);
  const blob = canonicalStatusJson(status) + doc;
  assert.equal(/9f3c|folder-|zebra_widget|alpha_secret|alpha_fn|zebra_fn/.test(blob), false);
  const again = canonicalStatusJson(statusFromReport(report));
  assert.equal(again, canonicalStatusJson(status));
  const reversed = { ...report, apps: [...report.apps].reverse() } as MigrationReport;
  assert.equal(canonicalStatusJson(statusFromReport(reversed)), again);
  assert.equal(renderStatusDoc(statusFromReport(reversed)), doc);
});

test('resolveSitesPath refuses in-repo paths and accepts outside paths', () => {
  assert.throws(() => resolveSitesPath(root), /outside the repo tree/);
  assert.throws(() => resolveSitesPath(join(root, 'sites.json')), /outside the repo tree/);
  assert.throws(() => resolveSitesPath(join(root, 'docs', 'sites.json')), /outside the repo tree/);
  assert.throws(() => resolveSitesPath(join(root, 'sub', '..', 'docs', 'sites.json')), /outside the repo tree/);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-sites-'));
  assert.equal(resolveSitesPath(join(dir, 'sites.json')), join(dir, 'sites.json'));
  // A path that escapes the root through .. is outside, not inside.
  assert.equal(resolveSitesPath(join(root, '..', 'outside-sites.json')), join(root, '..', 'outside-sites.json'));
});

test('resolveSitesPath refuses every worktree, aliases, and symlink escapes', () => {
  const git = (args: string[]): string =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  // The main checkout is a different worktree of this repository.
  const commonArg = git(['rev-parse', '--git-common-dir']);
  const common = commonArg.startsWith('/') ? commonArg : join(root, commonArg);
  const mainWorktree = common.endsWith('.git') ? dirname(common) : common;
  assert.throws(() => resolveSitesPath(join(mainWorktree, 'sites.json')), /outside the repo tree/);
  // Any other registered worktree of this repository, when one exists.
  const sibling = git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .find((worktree) => worktree !== root && worktree !== mainWorktree);
  if (sibling) assert.throws(() => resolveSitesPath(join(sibling, 'sites.json')), /outside the repo tree/);
  // Case-folded checkout path: the same directory on case-insensitive volumes.
  const upper = root.toUpperCase();
  if (upper !== root && existsSync(upper)) {
    assert.throws(() => resolveSitesPath(join(upper, 'sites.json')), /outside the repo tree/);
  }
  const dir = mkdtempSync(join(tmpdir(), 'c2c-sites-'));
  // A symlinked output file whose target sits inside the repo.
  const linkFile = join(dir, 'link-sites.json');
  symlinkSync(join(root, 'package.json'), linkFile);
  assert.throws(() => resolveSitesPath(linkFile), /outside the repo tree/);
  // A dangling link pointing inside the repo is refused the same way.
  const dangling = join(dir, 'dangling-sites.json');
  symlinkSync(join(root, 'no-such-dir', 'sites.json'), dangling);
  assert.throws(() => resolveSitesPath(dangling), /outside the repo tree/);
  // A symlinked parent directory into the repo.
  const linkDir = join(dir, 'linkroot');
  symlinkSync(root, linkDir);
  assert.throws(() => resolveSitesPath(join(linkDir, 'sites.json')), /outside the repo tree/);
  // Relative paths resolved from a repo subdirectory, including a .. escape.
  const previousCwd = process.cwd();
  process.chdir(join(root, 'docs'));
  try {
    assert.throws(() => resolveSitesPath('rel-sites.json'), /outside the repo tree/);
    assert.throws(() => resolveSitesPath(join('..', 'sites.json')), /outside the repo tree/);
  } finally {
    process.chdir(previousCwd);
  }
  // Outside every repo: accepted.
  assert.equal(resolveSitesPath(join(dir, 'sites.json')), join(dir, 'sites.json'));
});

test('--sites writes per-app attribution; the rendered doc is byte-identical without it', () => {
  const fixtures = join(root, 'fixtures/redistributable');
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-sites-'));
  const docWithout = join(tmp, 'without.md');
  const docWith = join(tmp, 'with.md');
  const sites = join(tmp, 'sites.json');
  assert.equal(main(['--dir', fixtures, '--out', docWithout]), 0);
  assert.equal(main(['--dir', fixtures, '--out', docWith, '--sites', sites]), 0);
  assert.equal(readFileSync(docWith, 'utf8'), readFileSync(docWithout, 'utf8'));
  const attribution = JSON.parse(readFileSync(sites, 'utf8')) as SiteAttribution;
  assert.equal(attribution.schema, 'c2c-determinism-sites/1');
  const report = migrationReportForDir(fixtures, 'gallery');
  assert.equal(attribution.apps.length, report.apps.length);
  for (const app of attribution.apps) {
    const entry = report.apps.find((candidate) => candidate.app === app.app);
    assert.ok(entry, app.app);
    assert.equal(app.deterministic, entry.deterministic);
    assert.equal(app.fillLockEntries, entry.fillLockEntries);
    assert.equal(app.todos.length, entry.todoCount, app.app);
    for (const todo of app.todos) {
      assert.equal(todo.signature, publicConstruct(todo.construct));
      assert.match(todo.location, /\S/);
      assert.ok(todo.scope === 'app' || todo.scope === 'unit' || todo.scope === 'ui', todo.scope);
    }
  }
});

test('--sites inside the repo tree is refused before the gallery is scanned', () => {
  const fixtures = join(root, 'fixtures/redistributable');
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-sites-'));
  const doc = join(tmp, 'doc.md');
  const inRepo = join(root, 'docs', 'sites-test-leak.json');
  assert.equal(main(['--dir', fixtures, '--out', doc, '--sites', inRepo]), 2);
  assert.equal(existsSync(doc), false, 'no doc written when --sites is refused');
  assert.equal(existsSync(inRepo), false);
});

test('committed status doc equals a fresh gallery computation', { skip: !statusDir() && 'needs C2C_FIXTURES_DIR or C2C_GALLERY_DIR' }, () => {
  const dir = statusDir();
  assert.ok(dir);
  const fresh = renderStatusDoc(computeDeterminismStatus(dir));
  assert.equal(readFileSync(docPath, 'utf8'), fresh, 'docs/determinism-status.md is stale: run npm run determinism:status');
  assertNoQuotedIdentifiers(parseStatusDoc(fresh));
});

test('status doc renders the builtin TODO count from the catalogue, not a hard-coded number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-builtin-catalogue-'));
  const fixturePath = join(dir, 'deluge-builtins.json');
  try {
    writeFileSync(
      fixturePath,
      JSON.stringify({ counts: { supported: 1, shimmed: 2, todo: 7, total: 10 }, entries: [] }),
    );
    assert.equal(builtinTodoCount(fixturePath), 7);
    const status: DeterminismStatus = {
      totalApps: 0,
      deterministicApps: 0,
      todoTotal: 0,
      kinds: [],
      perAppConstructSets: [],
      deterministicWithUiTodos: { apps: 0, uiTodos: 0 },
    };
    const doc = renderStatusDoc(status, fixturePath);
    assert.match(doc, /The builtin catalogue lists 7 TODO entries/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no doc quotes a builtin TODO count that differs from docs/deluge-builtins.json counts.todo', () => {
  const realTodo = builtinTodoCount();
  const quote = /builtin catalogue lists (\d+) `?todo`? entries/gi;
  const files: string[] = [join(root, 'README.md')];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) files.push(full);
    }
  };
  walk(join(root, 'docs'));
  let quotes = 0;
  for (const path of files) {
    if (!existsSync(path)) continue;
    for (const match of readFileSync(path, 'utf8').matchAll(quote)) {
      quotes += 1;
      assert.equal(Number(match[1]), realTodo, `${path} quotes a stale builtin TODO count`);
    }
  }
  // determinism-status.md must keep quoting the count, or this guard checks nothing.
  assert.ok(quotes >= 1, 'expected docs/determinism-status.md to quote counts.todo');
});
