import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';
import { deriveIr, parse } from '../../core/src/index.js';
import { emptyApp, type App, type Workflow } from '../../core/src/ir.js';
import { buildMigrationReport, loadIr as loadIrForTest, migrationReportForDir, type MigrationReport } from '../../cli/src/migration-report.js';
import {
  builtinTodoCount,
  canonicalStatusJson,
  computeDeterminismStatus,
  main,
  parseStatusDoc,
  IDENTIFIER_INTRODUCERS,
  publicConstruct,
  statusDocLayout,
  renderStatusDoc,
  resolveSitesPath,
  resolveStatusDir,
  siteAttributionForDir,
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
    noTodoApps: 2,
    deterministicApps: 1,
    todoTotal: 4,
    kinds: [
      { construct: 'task:if', count: 3 },
      { construct: 'method:select', count: 1 },
    ],
    perAppConstructSets: [
      { constructs: [], items: 0 },
      { constructs: ['task:if'], items: 3 },
    ],
    deterministicWithUiTodos: { apps: 1, uiTodos: 2 },
    silentDropTotal: 5,
    silentDropKinds: [
      { construct: 'field', count: 3 },
      { construct: 'report', count: 2 },
    ],
  };
  const doc = renderStatusDoc(status);
  assert.match(doc, /^\| apps with no residual todos \| 2\/3 \|$/m);
  assert.match(doc, /^\| apps with no residual todos and no silent drops \(deterministic\) \| 1\/3 \(33\.3%\) \|$/m);
  assert.match(doc, /^\| silent drops \(total\) \| 5 \|$/m);
  assert.match(doc, /## Top 2 silent-drop kinds\n\n\| construct \| count \|\n\|---\|---:\|\n\| `field` \| 3 \|\n\| `report` \| 2 \|\n/);
  assert.equal(statusDocLayout(doc), 'current');
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

test('publicConstruct redacts both names in a map-report-as-list sentence', () => {
  assert.equal(
    publicConstruct('Map report Some_Map is shown as a list because Some_Form has no address field to plot.'),
    'Map report (app identifier) is shown as a list because (app identifier) has no address field to plot.',
  );
});

test('publicConstruct keeps a UI TODO reason sentence whole when its own content has a colon', () => {
  // A reason sentence is not a `prefix:name` key: a colon inside a quoted property
  // value (`timedisplayoptions = hh:mm:ss`) must not be mistaken for that separator.
  // The field name itself is still an app identifier and is redacted even though
  // the sentence never puts it in quotes.
  const timeDisplay =
    'Field Date_Time sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.';
  assert.equal(
    publicConstruct(timeDisplay),
    'Field (app identifier) sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.',
  );

  const staticStyle = 'Static <style> CSS not carried over: the page sanitizer drops 2 static style rules';
  assert.equal(publicConstruct(staticStyle), staticStyle);

  const reportFilter =
    'Filter not migrated on report Holidays_Employee: manually translate the source criterion for Employee in the new app; until then this report returns no rows.';
  assert.equal(
    publicConstruct(reportFilter),
    'Filter not migrated on report (app identifier):(app identifier)',
  );
  // The quoted form model.ts writes lands in the same bucket.
  assert.equal(publicConstruct(reportFilter.replace('Holidays_Employee', '"Holidays_Employee"')), publicConstruct(reportFilter));
  for (const name of ['Ünï_Rep', '9lives']) {
    assert.ok(!publicConstruct(reportFilter.replace('Holidays_Employee', name)).includes(name), `${name} must not survive`);
  }
});

test('publicConstruct redacts an unquoted field or report name naming model.ts builds its reason sentences with', () => {
  // packages/ui/src/model.ts interpolates `field.name`/`report.name` straight into
  // `reason` without quotes, so none of these are caught by the quoted-name redaction.
  // They are still app identifiers and must not reach the public kinds table.
  assert.equal(
    publicConstruct('Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.'),
    'Field (app identifier) is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.',
  );
  assert.equal(
    publicConstruct('Report All_Book_Transactions has an `options` setting (icon = travel-world) that Catalyst does not carry into the generated list report.'),
    'Report (app identifier) has an `options` setting (icon = (app identifier)) that Catalyst does not carry into the generated list report.',
  );
  // The field's own name can repeat later in the same sentence (the bidirectional-lookup
  // reason names it twice); every occurrence of that name is redacted, not just the first.
  assert.equal(
    publicConstruct(
      'Field Member_Link is flagged `bidirectional = true`; Catalyst only creates the reverse column from a linked grid side, and neither Member_Link nor its target is one.',
    ),
    'Field (app identifier) is flagged `bidirectional = true`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor its target is one.',
  );
});

const QUOTED_IDENTIFIER = /"[A-Za-z_][A-Za-z0-9_]*"/;

/** No quoted identifier remains in any public construct string. */
test('unquoted non-ASCII and digit-leading app names never reach the status doc or JSON', () => {
  const names = ['Ünï_Rep', '9lives', '9Ünï_Mix'];
  const sentences = [
    `Map report ${names[0]} is shown as a list because ${names[1]} has no address field to plot.`,
    `Map report ${names[2]} is shown as a list because Plain_Form has no address field to plot.`,
    `Field ${names[0]} is flagged \`personal data = true\`; Catalyst generates no privacy or access control for this field.`,
    `Field ${names[1]} is flagged \`personal data = true\`; Catalyst generates no privacy or access control for this field.`,
    `Report ${names[2]} has an \`options\` setting (icon = travel-world) that Catalyst does not carry into the generated list report.`,
    `Report ${names[2]} lists ${names[2]} twice.`,
  ];
  for (const sentence of sentences) {
    const out = publicConstruct(sentence);
    for (const name of names) assert.equal(out.includes(name), false, out);
  }
  const apps = sentences.map((construct, i) => ({
    app: `folder-${i}`,
    deterministic: false,
    todoCount: 1,
    fillLockEntries: 0,
    todoKinds: [{ construct, count: 1 }],
    uiTodoCount: 0,
    readiness: 0,
    band: 'blocked',
  }));
  const report = {
    schema: 'c2c-migration-report/1',
    label: 'unit',
    apps,
    aggregate: {
      totalApps: apps.length,
      deterministicApps: 0,
      deterministicShare: 0,
      targets: { p95: { required: apps.length, met: false }, p100: { required: apps.length, met: false } },
      todoTotal: apps.length,
      distinctTodoKinds: sentences.length,
      todoKinds: sentences.map((construct) => ({ construct, count: 1 })),
      deterministicWithUiTodos: { apps: 0, uiTodos: 0 },
      noTodoApps: 0,
      silentDrops: 0,
      silentDropKinds: [],
    },
  } as unknown as MigrationReport;
  const status = statusFromReport(report);
  const text = renderStatusDoc(status) + canonicalStatusJson(status);
  for (const name of names) assert.equal(text.includes(name), false, name);
});

function assertNoQuotedIdentifiers(status: DeterminismStatus): void {
  for (const kind of status.kinds) assert.equal(QUOTED_IDENTIFIER.test(kind.construct), false, kind.construct);
  for (const set of status.perAppConstructSets) {
    for (const name of set.constructs) assert.equal(QUOTED_IDENTIFIER.test(name), false, name);
  }
  for (const kind of status.silentDropKinds) assert.equal(QUOTED_IDENTIFIER.test(kind.construct), false, kind.construct);
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
      noTodoApps: 0,
      silentDrops: 0,
      silentDropKinds: [],
    },
  } as unknown as MigrationReport;
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
      { name: 'two', ir: app('x = unknownCall().getDay();') },
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
      noTodoApps: 1,
      silentDrops: 0,
      silentDropKinds: [],
    },
  } as unknown as MigrationReport;
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
  assert.equal(resolveSitesPath(join(dir, 'sites.json')), resolve(dir, 'sites.json'));
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
  assert.equal(resolveSitesPath(join(dir, 'sites.json')), resolve(dir, 'sites.json'));
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
  assert.equal(statSync(sites).mode & 0o777, 0o600);
  const report = migrationReportForDir(fixtures, 'gallery');
  assert.equal(attribution.apps.length, report.apps.length);
  for (const app of attribution.apps) {
    const entry = report.apps.find((candidate) => candidate.app === app.app);
    assert.ok(entry, app.app);
    assert.equal(app.deterministic, entry.deterministic);
    assert.equal(app.fillLockEntries, entry.fillLockEntries);
    assert.equal(app.todos.length, entry.todoCount, app.app);
    for (const todo of app.todos) {
      assert.equal(todo.signature, publicConstruct(todo.construct, entry.identifiers));
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

test('--sites refuses hard links to repo files without changing their contents', () => {
  const fixtures = join(root, 'fixtures/redistributable');
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-sites-'));
  const doc = join(tmp, 'doc.md');
  const source = join(root, 'docs/sites-hardlink-probe.json');
  const hardlink = join(tmp, 'sites.json');
  const original = '{"unchanged":true}\n';
  writeFileSync(source, original);
  try {
    linkSync(source, hardlink);
    assert.equal(main(['--dir', fixtures, '--out', doc, '--sites', hardlink]), 2);
    assert.equal(readFileSync(source, 'utf8'), original);
    assert.equal(existsSync(doc), false);
  } finally {
    // The probe is outside version control and is removed even on assertion failure.
    try { unlinkSync(hardlink); } catch { /* absent */ }
    try { unlinkSync(source); } catch { /* absent */ }
  }
});

test('--sites atomically replaces a destination swapped to a repo symlink after validation', () => {
  const fixtures = join(root, 'fixtures/redistributable');
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-sites-'));
  const doc = join(tmp, 'doc.md');
  const sites = join(tmp, 'sites.json');
  const protectedFile = join(root, 'docs/sites-toctou-probe.json');
  const original = '{"unchanged":true}\n';
  writeFileSync(protectedFile, original);
  const hookHost = globalThis as typeof globalThis & { __c2cBeforeSitesWrite?: (path: string) => void };
  hookHost.__c2cBeforeSitesWrite = (path) => {
    assert.equal(path, sites);
    symlinkSync(protectedFile, path);
  };
  try {
    assert.equal(main(['--dir', fixtures, '--out', doc, '--sites', sites]), 0);
    assert.equal(readFileSync(protectedFile, 'utf8'), original);
    assert.equal(JSON.parse(readFileSync(sites, 'utf8')).schema, 'c2c-determinism-sites/1');
  } finally {
    delete hookHost.__c2cBeforeSitesWrite;
    try { unlinkSync(sites); } catch { /* absent */ }
    try { unlinkSync(protectedFile); } catch { /* absent */ }
  }
});

test('--sites refuses a parent directory replaced by a repo symlink during the scan', () => {
  const fixtures = join(root, 'fixtures/redistributable');
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-sites-'));
  const doc = join(tmp, 'doc.md');
  const out = join(tmp, 'out');
  mkdirSync(out);
  const sites = join(out, 'sites-parent-swap-probe.json');
  const leaked = join(root, 'docs/sites-parent-swap-probe.json');
  const hookHost = globalThis as typeof globalThis & { __c2cBeforeSitesWrite?: (path: string) => void };
  hookHost.__c2cBeforeSitesWrite = (path) => {
    assert.equal(path, sites);
    renameSync(out, join(tmp, 'out.old'));
    symlinkSync(join(root, 'docs'), out);
  };
  try {
    assert.equal(main(['--dir', fixtures, '--out', doc, '--sites', sites]), 2);
    assert.equal(existsSync(doc), true, 'the scan finished before the write was refused');
    assert.equal(existsSync(leaked), false);
    assert.equal(existsSync(join(tmp, 'out.old', 'sites-parent-swap-probe.json')), false);
  } finally {
    delete hookHost.__c2cBeforeSitesWrite;
    try { unlinkSync(leaked); } catch { /* absent */ }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--sites refuses an ancestor directory replaced by a repo symlink during the scan', () => {
  const fixtures = join(root, 'fixtures/redistributable');
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-sites-'));
  const doc = join(tmp, 'doc.md');
  const probeName = 'sites-ancestor-swap-probe';
  const probe = join(root, 'docs', probeName);
  mkdirSync(probe);
  const ancestor = join(tmp, 'a');
  const parent = join(ancestor, probeName);
  mkdirSync(parent, { recursive: true });
  const sites = join(parent, 'r2-anc.json');
  const leaked = join(probe, 'r2-anc.json');
  const hookHost = globalThis as typeof globalThis & { __c2cBeforeSitesWrite?: (path: string) => void };
  hookHost.__c2cBeforeSitesWrite = () => {
    renameSync(ancestor, join(tmp, 'a.old'));
    symlinkSync(join(root, 'docs'), ancestor);
  };
  try {
    assert.equal(main(['--dir', fixtures, '--out', doc, '--sites', sites]), 2);
    assert.equal(existsSync(doc), true, 'the scan finished before the write was refused');
    assert.equal(existsSync(leaked), false);
    assert.equal(existsSync(join(tmp, 'a.old', probeName, 'r2-anc.json')), false);
  } finally {
    delete hookHost.__c2cBeforeSitesWrite;
    try { unlinkSync(leaked); } catch { /* absent */ }
    rmSync(probe, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--sites refuses an intermediate symlink that resolves back to the pinned directory', () => {
  const fixtures = join(root, 'fixtures/redistributable');
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-sites-'));
  const doc = join(tmp, 'doc.md');
  const mid = join(tmp, 'mid');
  const parent = join(mid, 'leaf');
  mkdirSync(parent, { recursive: true });
  const sites = join(parent, 'sites.json');
  // `decoy` sits outside the repo. Once `mid` is swapped to a link at it,
  // `mid/leaf` still names the pinned directory: without the no-follow
  // component guard the re-walk lands on the same inode and the write
  // proceeds, so the refusal has to come from the walk itself.
  const decoy = join(tmp, 'decoy');
  mkdirSync(decoy);
  const hookHost = globalThis as typeof globalThis & { __c2cBeforeSitesWrite?: (path: string) => void };
  hookHost.__c2cBeforeSitesWrite = (path) => {
    assert.equal(path, sites);
    symlinkSync(join(tmp, 'mid.old', 'leaf'), join(decoy, 'leaf'));
    renameSync(mid, join(tmp, 'mid.old'));
    symlinkSync(decoy, mid);
  };
  try {
    assert.equal(main(['--dir', fixtures, '--out', doc, '--sites', sites]), 2);
    assert.equal(existsSync(doc), true, 'the scan finished before the write was refused');
    assert.equal(existsSync(sites), false);
  } finally {
    delete hookHost.__c2cBeforeSitesWrite;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--sites refuses an intermediate symlink into the repo that resolves back to the pinned directory', () => {
  const fixtures = join(root, 'fixtures/redistributable');
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-sites-'));
  const doc = join(tmp, 'doc.md');
  const mid = join(tmp, 'mid');
  const parent = join(mid, 'leaf');
  mkdirSync(parent, { recursive: true });
  const sites = join(parent, 'sites.json');
  // Same shape as the outside case, but the swapped component points inside
  // this checkout: the final component links back to the pinned directory,
  // so only the component-level no-follow guard refuses the walk.
  const decoy = join(root, 'docs', 'sites-component-probe');
  mkdirSync(decoy);
  const hookHost = globalThis as typeof globalThis & { __c2cBeforeSitesWrite?: (path: string) => void };
  hookHost.__c2cBeforeSitesWrite = (path) => {
    assert.equal(path, sites);
    symlinkSync(join(tmp, 'mid.old', 'leaf'), join(decoy, 'leaf'));
    renameSync(mid, join(tmp, 'mid.old'));
    symlinkSync(decoy, mid);
  };
  try {
    assert.equal(main(['--dir', fixtures, '--out', doc, '--sites', sites]), 2);
    assert.equal(existsSync(doc), true, 'the scan finished before the write was refused');
    assert.equal(existsSync(sites), false);
  } finally {
    delete hookHost.__c2cBeforeSitesWrite;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
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
      noTodoApps: 0,
      silentDropTotal: 0,
      silentDropKinds: [],
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

/** Invariants every rendered status holds, whichever layout the doc has. */
function assertStatusInvariants(status: DeterminismStatus): void {
  assert.equal(status.totalApps, status.deterministicApps + status.perAppConstructSets.length);
  assert.equal(status.todoTotal, status.perAppConstructSets.reduce((sum, row) => sum + row.items, 0));
  assert.equal(status.todoTotal, status.kinds.reduce((sum, kind) => sum + kind.count, 0));
  assert.equal(status.deterministicApps >= status.deterministicWithUiTodos.apps, true);
  assert.equal(status.noTodoApps >= status.deterministicApps && status.noTodoApps <= status.totalApps, true);
  assert.equal(status.silentDropTotal, status.silentDropKinds.reduce((sum, kind) => sum + kind.count, 0));
  assertNoQuotedIdentifiers(status);
}

test('committed status doc is structurally canonical without gallery fixtures', () => {
  const doc = readFileSync(docPath, 'utf8');
  const status = parseStatusDoc(doc);
  assertStatusInvariants(status);
  // A doc written before the silent-drop numbers existed is accepted until the
  // next regeneration; once it carries them it must render byte-identically.
  if (statusDocLayout(doc) === 'legacy') {
    assert.match(doc, /^\| deterministic apps \| \d+ \([\d.]+%\) \|$/m);
    assert.equal(doc.includes('silent drops'), false, 'a legacy status doc cannot mention silent drops');
    return;
  }
  assert.equal(doc, renderStatusDoc(status), 'status doc has duplicated, missing, or inconsistent generated rows');
  assert.equal(status.totalApps, status.deterministicApps + status.perAppConstructSets.length);
});

test('an app with no todos is deterministic only when it also has no silent drops', () => {
  // A field annotation of an unhandled type (anything but help_text, tooltip,
  // or none) has no workflow todos but is still a silent drop: no generator
  // consumer carries it and no UI todo names it (packages/quality/src/
  // no-silent-drop.ts annotationProved). A time field's seconds-showing
  // `timedisplayoptions` and an address field's `adjust_using_map=true` used
  // to serve this role; both now carry their own counted manual-step todos,
  // so neither has zero residual todos any more.
  const dropSource =
    'application "Demo"\n{\n\tform Profile\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t\t[\n\t\t\t\ttype = reminder\n\t\t\t\tmessage = "Follow up"\n\t\t\t]\n\t\t)\n\t}\n}\n';
  const library = deriveIr(parse(dropSource));
  const clean: App = {
    ...emptyApp('empty'),
    name: 'T',
    workflows: [{ name: 'On add', form: 'Orders', event: 'on success', deluge: { text: 'info "ok";', span: { start: 0, end: 10 } }, properties: [], span: { start: 0, end: 0 } } as Workflow],
  };
  const report = buildMigrationReport(
    [
      { name: 'clean', ir: clean },
      { name: 'drops', ir: library },
    ],
    'unit',
  );
  const byName = new Map(report.apps.map((app) => [app.app, app]));
  const drops = byName.get('drops');
  assert.ok(drops);
  assert.equal(drops.todoCount, 0);
  assert.ok(drops.silentDrops > 0, 'fixture must keep silent drops or this test checks nothing');
  assert.equal(drops.deterministic, false);
  assert.equal(byName.get('clean')?.deterministic, true);
  assert.equal(byName.get('clean')?.silentDrops, 0);

  const status = statusFromReport(report);
  assert.equal(status.noTodoApps, 2, 'the drop-only app counts in the first number');
  assert.equal(status.deterministicApps, 1, 'the drop-only app does not count as deterministic');
  assert.equal(status.silentDropTotal, drops.silentDrops);
  assertStatusInvariants(status);
  const doc = renderStatusDoc(status);
  assert.match(doc, /^\| apps with no residual todos \| 2\/2 \|$/m);
  assert.match(doc, /^\| apps with no residual todos and no silent drops \(deterministic\) \| 1\/2 \(50%\) \|$/m);
  assert.match(doc, new RegExp(`^\\| silent drops \\(total\\) \\| ${drops.silentDrops} \\|$`, 'm'));
  assert.equal(statusDocLayout(doc), 'current');
  assert.equal(doc, renderStatusDoc(parseStatusDoc(doc)));
});

test('status doc renders the top 10 silent-drop kinds by count, bucketed and name-free', () => {
  const kinds = ['approval', 'field', 'field-property', 'form', 'function', 'integration', 'page', 'permission', 'report', 'report-feature', 'statement', 'translation'];
  const silentDropKinds = kinds.map((construct, index) => ({ construct, count: kinds.length - index }));
  const status: DeterminismStatus = {
    totalApps: 2,
    noTodoApps: 1,
    deterministicApps: 0,
    todoTotal: 1,
    kinds: [{ construct: 'task:if', count: 1 }],
    perAppConstructSets: [
      { constructs: [], items: 0 },
      { constructs: ['task:if'], items: 1 },
    ],
    deterministicWithUiTodos: { apps: 0, uiTodos: 0 },
    silentDropTotal: silentDropKinds.reduce((sum, kind) => sum + kind.count, 0),
    silentDropKinds,
  };
  const doc = renderStatusDoc(status);
  const section = /## Top (\d+) silent-drop kinds\n\n\| construct \| count \|\n\|---\|---:\|\n((?:\|.*\|\n)*)/.exec(doc);
  assert.ok(section?.[2]);
  assert.equal(section[1], '10');
  assert.deepEqual(
    section[2].trim().split('\n'),
    silentDropKinds.slice(0, 10).map((kind) => `| \`${kind.construct}\` | ${kind.count} |`),
  );
  assert.equal(doc.includes('`statement`'), false, 'the 11th kind is only in the JSON block');
  assert.match(doc, /^\| silent drops \(total\) \| 78 \|$/m);
  assert.deepEqual(parseStatusDoc(doc), status);
  assertStatusInvariants(status);

  // Bucketing: drop kinds go through the same public-name rules as TODO kinds.
  const report = buildMigrationReport([{ name: 'secret_app_name', ir: loadIrForTest(join(root, 'fixtures/redistributable/library-application-system')) }], 'unit');
  const fromReport = statusFromReport(report);
  assert.deepEqual(fromReport.silentDropKinds.map((kind) => kind.construct), report.aggregate.silentDropKinds.map((kind) => publicConstruct(kind.construct)));
  assert.equal(renderStatusDoc(fromReport).includes('secret_app_name'), false);
});

test('parseStatusDoc rejects a doc without a json block or with a malformed payload', () => {
  const legacy = {
    totalApps: 1,
    deterministicApps: 1,
    todoTotal: 0,
    kinds: [],
    perAppConstructSets: [{ constructs: ['a'], items: 1 }],
    deterministicWithUiTodos: { apps: 0, uiTodos: 0 },
  };
  const good = { ...legacy, noTodoApps: 1, silentDropTotal: 2, silentDropKinds: [{ construct: 'form', count: 2 }] };
  const doc = (payload: unknown) => `# status\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`;
  assert.deepEqual(parseStatusDoc(doc(good)), good);
  assert.equal(statusDocLayout(doc(good)), 'current');
  assert.equal(statusDocLayout(doc(legacy)), 'legacy');
  assert.deepEqual(parseStatusDoc(doc(legacy)), { ...legacy, noTodoApps: 1, silentDropTotal: 0, silentDropKinds: [] });
  for (const key of ['noTodoApps', 'silentDropTotal', 'silentDropKinds'] as const) {
    const partial: Record<string, unknown> = { ...good };
    delete partial[key];
    assert.throws(() => parseStatusDoc(doc(partial)), /some but not all silent-drop fields/, key);
  }
  assert.throws(() => parseStatusDoc('# status\nno block\n'), /no ```json block found/);
  const broken: unknown[] = [
    { ...good, totalApps: '1' },
    { ...good, kinds: {} },
    { ...good, perAppConstructSets: {} },
    { ...good, perAppConstructSets: [null] },
    { ...good, perAppConstructSets: [{ constructs: [1], items: 1 }] },
    { ...good, perAppConstructSets: [{ constructs: ['a'], items: '1' }] },
    { ...good, deterministicWithUiTodos: undefined },
    { ...good, deterministicWithUiTodos: { apps: 0 } },
    { ...good, noTodoApps: '1' },
    { ...good, silentDropTotal: null },
    { ...good, silentDropKinds: {} },
    { ...good, silentDropKinds: [{ construct: 1, count: 1 }] },
    { ...good, silentDropKinds: [{ construct: 'form', count: '1' }] },
  ];
  for (const payload of broken) assert.throws(() => parseStatusDoc(doc(payload)), /is not a status payload/, JSON.stringify(payload));
});

test('determinism:status refuses --help, a --sites parent that does not exist, and a missing or empty gallery', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-status-main-'));
  try {
    const doc = join(tmp, 'doc.md');
    const fixtures = join(root, 'fixtures/redistributable');
    assert.equal(main(['--help']), 2);
    assert.equal(main(['--dir', fixtures, '--out', doc, '--sites', join(tmp, 'absent', 'sites.json')]), 2);
    assert.equal(main(['--dir', join(tmp, 'absent'), '--out', doc]), 1);
    mkdirSync(join(tmp, 'empty'));
    assert.equal(main(['--dir', join(tmp, 'empty'), '--out', doc]), 1);
    assert.equal(existsSync(doc), false, 'no doc written on a refusal');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- name-aware redaction (fail closed) ----------

const HOSTILE_NAMES = ['Salary_Form', 'Gehalt_Ünï', '9Secret_Form', '日本語フォーム', 'Ünï_Rep', '9lives_Rep'];

/** The exact model.ts reason templates that interpolate a form name without quotes (named filter, chart click, sort). */
const formSentences = (form: string, report: string): string[] => [
  `Named filter "Broken" on report "${report}" is not migrated: manually translate its source criterion for ${form || 'the report form'} in the new app; selecting it returns no rows.`,
  `Clicking a chart segment to view its underlying records is not generated: wire up a click handler that filters ${form} to the clicked category manually.`,
  `Sort by "Missing_Col" is not migrated; the field is not a plain column of ${form}, so rows render in default (ROWID) order.`,
  `Map report ${report} is shown as a list because ${form} has no address field to plot.`,
];

test('publicConstruct with the app identifiers redacts a form name in the named-filter, chart-click and sort sentences', () => {
  for (const form of HOSTILE_NAMES) {
    for (const sentence of formSentences(form, 'Rep_Q3')) {
      const out = publicConstruct(sentence, [form, 'Rep_Q3']);
      assert.equal(out.includes(form), false, `${form} must not survive in: ${out}`);
      assert.equal(out.includes('Rep_Q3'), false, out);
    }
  }
  assert.equal(
    publicConstruct(formSentences('Salary_Form', 'R')[0]!, ['Salary_Form', 'R']),
    'Named filter (app identifier) on report (app identifier) is not migrated: manually translate its source criterion for (app identifier) in the new app; selecting it returns no rows.',
  );
});

test('publicConstruct redacts a name whole-token only: a name that is a substring of a public word is left alone', () => {
  assert.equal(publicConstruct('criteria-dynamic', ['criteria']), 'criteria-dynamic');
  const sort = 'Sort by "x" is not migrated; the field is not a plain column of Gehalt_Form, so rows render in default (ROWID) order.';
  assert.equal(publicConstruct(sort, ['Gehalt_Form', 'ehalt', 'lain']).includes('Gehalt_Form'), false);
  assert.ok(publicConstruct(sort, ['ehalt', 'lain']).includes('plain column of Gehalt_Form'), 'a substring of another token is not a match');
});

test('publicConstruct: an app identifier equal to a public word keeps the public buckets intact', () => {
  // Capitalised template words are text only at position 0; the lowercase ones cannot be told apart, so they fail closed (see the collision tests).
  const words = ['Report', 'Field', 'Map', 'Named', 'Sort'];
  const sentence = formSentences('Salary_Form', 'Rep_Q3')[0]!;
  const expected = publicConstruct(sentence, ['Salary_Form', 'Rep_Q3']);
  assert.equal(publicConstruct(sentence, ['Salary_Form', 'Rep_Q3', ...words]), expected);
  assert.equal(publicConstruct('task:if', []), 'task:if');
  assert.equal(publicConstruct('criteria-dynamic', ['criteria', 'dynamic']), 'criteria-dynamic');
  // The slot-based layer still redacts the colliding name where the sentence names it.
  assert.equal(
    publicConstruct('Field Report has an `options` setting', ['Report']).startsWith('Field (app identifier)'),
    true,
  );
});

test('statusFromReport: a real app with non-ASCII, digit-leading and CJK form, report and field names leaks none of them', () => {
  for (const form of ['Gehalt_Ünï', '9Secret_Form', '日本語フォーム']) {
    const field = form === '日本語フォーム' ? '名前' : form === '9Secret_Form' ? '9Field' : 'Straße_Ünï';
    const report = form === '日本語フォーム' ? '報告書' : form === '9Secret_Form' ? '9lives' : 'Ünï_Rep';
    const src = `application "X"\n{\n\tforms\n\t{\n\t\tform ${form}\n\t\t{\n\t\t\t${field}\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t}\n\t}\n\treports\n\t{\n\t\tlist ${report}\n\t\t{\n\t\t\tshow all rows from ${form}\n\t\t\t(\n\t\t\t\t${field}\n\t\t\t)\n\t\t\tfilters\n\t\t\t{\n\t\t\t\t"Broken" : Lookup.Field\n\t\t\t}\n\t\t}\n\t}\n}\n`;
    const ir = deriveIr(parse(src));
    const report0 = buildMigrationReport([{ name: 'a', ir }], 'x');
    assert.ok(report0.apps[0]!.todoKinds.some((k) => k.construct.startsWith('Named filter')), 'the app must produce the named-filter sentence');
    const status = statusFromReport(report0);
    const text = renderStatusDoc(status) + canonicalStatusJson(status) + JSON.stringify(status);
    for (const name of [form, field, report]) assert.equal(text.includes(name), false, `${name} leaked into the status doc`);
    assert.ok(text.includes('Named filter (app identifier) on report (app identifier)'), 'the bucket stays a readable public sentence');
  }
});

test('siteAttributionForDir signatures carry no app identifier of the attributed app', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-sites-names-'));
  try {
    const form = 'Gehalt_Ünï';
    const src = `application "X"\n{\n\tforms\n\t{\n\t\tform ${form}\n\t\t{\n\t\t\tTitle\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t}\n\t}\n\treports\n\t{\n\t\tlist Rep\n\t\t{\n\t\t\tshow all rows from ${form}\n\t\t\t(\n\t\t\t\tTitle\n\t\t\t)\n\t\t\tfilters\n\t\t\t{\n\t\t\t\t"Broken" : Lookup.Field\n\t\t\t}\n\t\t}\n\t}\n}\n`;
    writeFileSync(join(dir, 'app.ds'), src);
    const out = siteAttributionForDir(dir, 'x');
    const sigs = out.apps.flatMap((a) => a.todos.map((t) => t.signature));
    assert.ok(sigs.some((s) => s.startsWith('Named filter')), JSON.stringify(sigs));
    for (const sig of sigs) assert.equal(sig.includes(form), false, sig);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- public-word collisions (v3b): a private identifier that equals a template word still never survives ----------

const COLLIDING = ['Report', 'Payments', 'Partner', 'Task', 'Address', 'Status', 'Field', 'If', 'Criteria', 'Form', 'Map', 'Named', 'Sort', 'Filter', 'Target', 'Value'];
const LOWER_COLLIDING = ['target', 'value', 'if', 'criteria', 'status', 'report', 'payments', 'field', 'form'];

/** Every reason sentence model.ts builds that places an identifier in a slot. */
const slotSentences = (name: string): string[] => [
  `Named filter ${name} is not migrated: selecting it returns no rows.`,
  `Named filter "Broken" on report "Rep_Q3" is not migrated: manually translate its source criterion for ${name} in the new app; selecting it returns no rows.`,
  `Clicking a chart segment to view its underlying records is not generated: wire up a click handler that filters ${name} to the clicked category manually.`,
  `Sort by "Missing_Col" is not migrated; the field is not a plain column of ${name}, so rows render in default (ROWID) order.`,
  `Map report Rep_Q3 is shown as a list because ${name} has no address field to plot.`,
  `Field ${name} requests a live character counter; the generated field does not show one.`,
  `Field Zq_Other sets \`target = ${name}\`; the generated image field has no clickable link, so there is no window to open it in.`,
  `Field Zq_Other is flagged \`bidirectional = ${name}\`; Catalyst only creates the reverse column from a linked grid side or a partner field that looks back and names this field, and neither Zq_Other nor its target is one.`,
  `Report ${name} has an \`options\` setting (x) that Catalyst does not carry into the generated list report.`,
];

/** The whole-token occurrences of `name` that are not the sentence's own first word. */
const slotLeak = (out: string, name: string): boolean => {
  if (/^[a-z]+$/.test(name)) return new RegExp(`(?:^|\\s)(?:${IDENTIFIER_INTRODUCERS.join('|')})\\s${name}(?![\\p{L}\\p{N}_-])`, 'iu').test(out);
  const re = new RegExp(`(?<![\\p{L}\\p{N}_-])${name}(?![\\p{L}\\p{N}_-])`, 'gu');
  return [...out.matchAll(re)].some((m) => !(m.index === 0 && /^[A-Z]/.test(name)));
};

test('publicConstruct: a capitalised or app-looking identifier equal to a template word is redacted in every slot', () => {
  assert.equal(
    publicConstruct('Named filter Report is not migrated: selecting it returns no rows.', ['Report']),
    'Named filter (app identifier) is not migrated: selecting it returns no rows.',
  );
  for (const name of COLLIDING) {
    for (const sentence of slotSentences(name)) {
      const out = publicConstruct(sentence, [name]);
      assert.equal(slotLeak(out, name), false, `${name} survived in: ${out}`);
      // Same bucket as a name that does not collide.
      assert.equal(out, publicConstruct(sentence.replace(new RegExp(name, 'g'), (m, off: number) => (off === 0 ? m : 'Zq_Name')), ['Zq_Name']), `${name} bucket differs`);
    }
  }
});

test('publicConstruct: a sentence-initial template word at position 0 stays; the same word as an identifier does not', () => {
  assert.equal(publicConstruct('Field Field requests a live character counter; the generated field does not show one.', ['Field']), 'Field (app identifier) requests a live character counter; the generated field does not show one.');
  assert.equal(publicConstruct('Sort by "x" is not migrated; the field is not a plain column of Sort, so rows render in default (ROWID) order.', ['Sort']), 'Sort by (app identifier) is not migrated; the field is not a plain column of (app identifier), so rows render in default (ROWID) order.');
});

test('publicConstruct: an all-lowercase identifier equal to a template word is redacted wherever a template slot holds it', () => {
  const introduced = (out: string, name: string) => new RegExp(`(?:^|\\s)(?:${IDENTIFIER_INTRODUCERS.join('|')})\\s${name}(?![\\p{L}\\p{N}_-])`, 'iu').test(out);
  for (const name of LOWER_COLLIDING) {
    for (const sentence of slotSentences(name)) {
      const out = publicConstruct(sentence, [name]);
      assert.equal(introduced(out, name), false, `${name} survived in a slot of: ${out}`);
      // Same bucket as a name that does not collide: the template's own lowercase words are untouched.
      if (/^(Field|Report) /.test(sentence)) continue; // the Field/Report slot rule redacts the name globally, template words included
      assert.equal(out, publicConstruct(sentence.replace(new RegExp(`(?<=(?:^|\\s)(?:${IDENTIFIER_INTRODUCERS.join('|')})\\s)${name}\\b`, 'gi'), 'Zq_Name'), ['Zq_Name']), out);
    }
  }
  assert.equal(
    publicConstruct('Clicking a chart segment to view its underlying records is not generated: wire up a click handler that filters target to the clicked category manually.', ['target']),
    'Clicking a chart segment to view its underlying records is not generated: wire up a click handler that filters (app identifier) to the clicked category manually.',
  );
  assert.equal(publicConstruct('Named filter value is not migrated: selecting it returns no rows.', ['value']), 'Named filter (app identifier) is not migrated: selecting it returns no rows.');
  assert.equal(
    publicConstruct('Field Zq_Other sets `target = target`; the generated image field has no clickable link.', ['target']),
    'Field (app identifier) sets `target = (app identifier)`; the generated image field has no clickable link.',
  );
  // Buckets of an app without such names do not change, and the placeholder's own words never matter.
  const plain = formSentences('Salary_Form', 'Rep_Q3')[0]!;
  assert.equal(publicConstruct(plain, ['Salary_Form', 'Rep_Q3', 'app', 'identifier', 'style']), publicConstruct(plain, ['Salary_Form', 'Rep_Q3']));
  assert.equal(publicConstruct('Report (app identifier) lists column Added_Location, a Creator built-in record column.', ['Added_Location']), 'Report (app identifier) lists column Added_Location, a Creator built-in record column.');
  assert.equal(publicConstruct('a navigation (openUrl) inside it', ['openUrl']), 'a navigation (openUrl) inside it');
});

test('every identifier slot in the model.ts reason templates is introduced by a known word (guards the lowercase-collision rule)', () => {
  const src = readFileSync(join(root, 'packages/ui/src/model.ts'), 'utf8');
  // Words that precede an interpolation which is a widget, view, value or count, not an app identifier.
  const NOT_A_SLOT = new Set(['the', 'generated', 'plain', 'type', 'to', 'when', 'so', 'its', 'native', 'open', 'Recreate', 'Format', 'Crop', 'Compute', 'View:', 'TODO:', ':', '-', '${location}:', "''}", 'Field', 'in', 'a', 'and', 'with', 'report.name}:']);
  const seen = new Set<string>();
  for (const line of src.split('\n')) {
    if (!/reason|manualStep|todo/.test(line)) continue;
    for (const m of line.matchAll(/(\S+) \$\{/g)) seen.add(m[1]!.replace(/^`/, ''));
  }
  const known = new Set([...IDENTIFIER_INTRODUCERS, ...NOT_A_SLOT]);
  assert.deepEqual([...seen].filter((word) => !known.has(word)), [], 'a new interpolation introducer: add it to IDENTIFIER_INTRODUCERS (a slot) or to NOT_A_SLOT (not an identifier)');
});

test('statusFromReport: a form, report or field named like a template word never reaches the status doc', () => {
  const NAMES = ['Report', 'Payments', 'Partner', 'Task', 'Address', 'Status', 'Field', 'if', 'criteria', 'target', 'value', 'If', 'Criteria'];
  const source = (form: string, field: string, report: string) =>
    `application "X"\n{\n\tforms\n\t{\n\t\tform ${form}\n\t\t{\n\t\t\t${field}\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t}\n\t}\n\treports\n\t{\n\t\tlist ${report}\n\t\t{\n\t\t\tshow all rows from ${form}\n\t\t\t(\n\t\t\t\t${field}\n\t\t\t)\n\t\t\tfilters\n\t\t\t{\n\t\t\t\t"Broken" : Lookup.Field\n\t\t\t}\n\t\t}\n\t}\n}\n`;
  const constructsOf = (form: string, field: string, report: string): string[] => {
    const rep = buildMigrationReport([{ name: 'a', ir: deriveIr(parse(source(form, field, report))) }], 'x');
    assert.ok(rep.apps[0]!.todoKinds.some((k) => k.construct.startsWith('Named filter')), 'the app must produce the named-filter sentence');
    const status = statusFromReport(rep);
    return [...status.kinds.map((k) => k.construct), ...status.perAppConstructSets.flatMap((s) => s.constructs)];
  };
  for (const name of NAMES) {
    for (const slot of ['form', 'report', 'field'] as const) {
      const got = constructsOf(slot === 'form' ? name : 'Zq_Form', slot === 'field' ? name : 'Zq_Field', slot === 'report' ? name : 'Zq_Rep');
      for (const construct of got) assert.equal(slotLeak(construct, name) && !construct.endsWith('(app identifier)'), false, `${name} as ${slot} survived: ${construct}`);
      if (/[A-Z]/.test(name) && !/^(If|Criteria)$/.test(name)) {
        // App-looking names land in exactly the bucket a non-colliding name gets.
        const ref = constructsOf(slot === 'form' ? 'Zq_Name' : 'Zq_Form', slot === 'field' ? 'Zq_Name' : 'Zq_Field', slot === 'report' ? 'Zq_Name' : 'Zq_Rep');
        assert.deepEqual(got, ref, `${name} as ${slot}`);
      }
    }
  }
});

// v3c: list joins, blueprint-* constructs and free-text setting values (claude review of v3b, F1-F3).
const tokenLeaks = (construct: string, name: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u').test(construct);
const allConstructs = (rep: MigrationReport): string[] => {
  const status = statusFromReport(rep);
  return [...status.kinds.map((k) => k.construct), ...status.perAppConstructSets.flatMap((s) => s.constructs)];
};

test('statusFromReport F1: every option-group label of a real radio field is redacted, not only the first', () => {
  const source = (l1: string, l2: string, l3: string) =>
    `application "X"\n{\n\tforms\n\t{\n\t\tform Zq_F\n\t\t{\n\t\t\tPick\n\t\t\t(\n\t\t\t\ttype = radiobuttons\n\t\t\t\tvalues = {"${l1}" : {"a1","a2"}, "${l2}" : {"b1"}, "${l3}" : {"c1"}}\n\t\t\t)\n\t\t}\n\t}\n}\n`;
  const expected = 'Field (app identifier) groups its options under (app identifier), (app identifier), (app identifier) in `values`; the generated radio control has no grouping element, so every option lists flat.';
  for (const name of ['if', 'criteria', 'target', 'value', 'record', 'status', 'payments', 'report', 'field', 'form', 'other', 'options', 'first', 'Payments', 'Report', 'Acme_Secret', 'Ünï_Lbl']) {
    for (const [l1, l2, l3] of [['Zq_L1', name, 'Zq_L3'], [name, 'Zq_L2', 'Zq_L3'], ['Zq_L1', 'Zq_L2', name]]) {
      const rep = buildMigrationReport([{ name: 'a', ir: deriveIr(parse(source(l1!, l2!, l3!))) }], 'x');
      const got = allConstructs(rep).filter((c) => c.includes('groups its options'));
      assert.ok(got.length, `the groups sentence must be produced for ${name}`);
      for (const c of got) assert.equal(c.replace(/Field [^ ]+ groups/, 'Field (app identifier) groups'), expected, `${name} in ${l1}/${l2}/${l3}`);
    }
  }
});

const PUBLIC_KEYS = new Set(['status', 'if', 'target']);
test('statusFromReport F2: blueprint stage/start/phase block and property names never reach the status', () => {
  const source = (blk: string, prop: string, phase: string) =>
    `application "B"\n{\n\tforms { form Item { Title ( type = text ) } }\n\tworkflow { form { Flow as "Flow" { type = blueprint\n\t\tform = Item\n\t\tstart { start stage = Draft\n\t\t\t${prop} = dark\n\t\t\t${blk} { x = 1 } }\n\t\tstages { Draft { displayname = "Draft"\n\t\t\t${blk} { y = 2 } }\n\t\t\tReview { displayname = "Review" } }\n\t\ttransitions { Send { from stage = Draft\n\t\t\tto stage = Review\n\t\t\tduring { ${phase} = left } } }\n\t} } }\n}\n`;
  for (const [blk, prop, phase] of [['Acme_Secret', 'acme_theme', 'acme_port'], ['value', 'target', 'status'], ['Report', 'Contacts', 'if'], ['Ünï_Blk', 'ünï_key', 'zq9']] as const) {
    const rep = buildMigrationReport([{ name: 'a', ir: deriveIr(parse(source(blk, prop, phase))) }], 'x');
    const got = allConstructs(rep).filter((c) => c.startsWith('blueprint-'));
    assert.ok(got.some((c) => c.startsWith('blueprint-stage-block-') || c.startsWith('blueprint-start-block-')), 'the blueprint block sentence must be produced');
    // A property key that is itself a public word and undeclared is vocabulary, not a name; block names are always checked.
    for (const c of got) for (const name of [blk, ...[prop, phase].filter((key) => !PUBLIC_KEYS.has(key))]) assert.equal(tokenLeaks(c, name), false, `${name} survived: ${c}`);
  }
});

test('statusFromReport F2: public blueprint suffixes stay in their stable buckets', () => {
  assert.equal(publicConstruct('blueprint-transition-block-chart data', ['Acme_Secret']), 'blueprint-transition-block-chart data');
  assert.equal(publicConstruct('blueprint-transition-property-Acme_Secret', ['Acme_Secret']), 'blueprint-transition-property-(app identifier)');
  assert.equal(publicConstruct('blueprint-phase-property-acme_port'), 'blueprint-phase-property-(app identifier)');
  assert.equal(publicConstruct('blueprint-stage-block-Ünï_Blk', []), 'blueprint-stage-block-(app identifier)');
  assert.equal(publicConstruct('blueprint-start-block-value', ['value']), 'blueprint-start-block-(app identifier)');
});

test('statusFromReport F3: the value side of every report option setting is redacted, only the setting name survives', () => {
  const source = (dang: string) =>
    `application "X"\n{\n\tforms\n\t{\n\t\tform Zq_F\n\t\t{\n\t\t\tZq_Fd\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t}\n\t}\n\treports\n\t{\n\t\tlist Zq_R\n\t\t{\n\t\t\tshow all rows from Zq_F\n\t\t\t(\n\t\t\t\tZq_Fd\n\t\t\t)\n\t\t\toptions\n\t\t\t(\n\t\t\t\tdisplay field = ${dang}\n\t\t\t)\n\t\t}\n\t}\n}\n`;
  for (const dang of ['Zq_Dang', 'Nowhere', 'Payments', 'target', 'value', 'Ünï_Dang', 'Acme_Secret']) {
    const rep = buildMigrationReport([{ name: 'a', ir: deriveIr(parse(source(dang))) }], 'x');
    const got = allConstructs(rep).filter((c) => c.includes('`options` setting'));
    assert.ok(got.length, `the options sentence must be produced for ${dang}`);
    for (const c of got) {
      assert.equal(tokenLeaks(c, dang), false, `${dang} survived: ${c}`);
      assert.match(c, /\(display field = \(app identifier\)\)/);
    }
  }
});

test('publicConstruct F1/F4: lowercase colliders in list joins and backticked block names are redacted', () => {
  const ids = ['target', 'value', 'status'];
  assert.equal(
    publicConstruct('Field Zq groups its options under Zq_L1, value, target in `values`; no grouping.', [...ids, 'Zq', 'Zq_L1']),
    'Field (app identifier) groups its options under (app identifier), (app identifier), (app identifier) in `values`; no grouping.',
  );
  assert.equal(
    publicConstruct('Report "R" has a `Block` settings block (template Zq, target block, value block) that Catalyst generates no equivalent for.', [...ids, 'template', 'Zq']),
    'Report (app identifier) has a `Block` settings block (template (app identifier), (app identifier) block, (app identifier) block) that Catalyst generates no equivalent for.',
  );
  assert.equal(
    publicConstruct('Report "R" has a `customlayouts` settings block (template Zq) that Catalyst generates no equivalent for.', ['customlayouts', 'template', 'Zq']),
    'Report (app identifier) has a `customlayouts` settings block (template (app identifier)) that Catalyst generates no equivalent for.',
  );
  assert.equal(publicConstruct('Static <style> CSS drops 7 rules (CSS built by a tag x7)', ['css']), 'Static <style> CSS drops 7 rules (CSS built by a tag x7)');
  // Template words elsewhere stay.
  assert.equal(publicConstruct('Static <style> CSS not carried over: the page sanitizer drops 1 static style rule', ['style']), 'Static <style> CSS not carried over: the page sanitizer drops 1 static style rule');
});
