import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { emptyApp, type App, type Workflow } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { generate } from '../src/generate.js';
import { lintFill } from '../src/fill-check.js';
import {
  SHIM_API,
  FILL_LIMITS,
  acceptTodo,
  applyFillLock,
  canonicalJson,
  collectTasks,
  emitTodoFiles,
  extractTodoCalls,
  fillHash,
  fillLimitRefusal,
  loadApp,
  readLock,
  reportLock,
  shimAllowlist,
  vectorCoverage,
  writeLock,
  type FillLock,
  type FillTask,
  type LockEntry,
  type StaleFill,
} from '../src/fill-todos.js';

const Z = { start: 0, end: 0 };

function stripComments(s: string) { return (s || '').replace(/^\s*\/\/ Deluge: .*\n?/gm, ''); }

function workflow(partial: Partial<Workflow> & Pick<Workflow, 'name' | 'event'>): Workflow {
  return { deluge: null, properties: [], span: Z, ...partial };
}

function app(partial: Partial<App> = {}): App {
  return { ...emptyApp('empty'), name: 'Demo_App', ...partial };
}

function sources(result: { files: { path: string; source: string }[] }): string {
  return result.files.map((file) => `${file.path}\n${file.source}`).join('\n---\n');
}

/**
 * One expression hole on a vector-covered builtin: method:getDay (covering
 * call:subBusinessDay) has Creator vectors and they pass, so fills are acceptable.
 * task:shareTo / call:unknownFunc holes have no coverage and are rejected.
 */
function coveredApp(text = 'x = subBusinessDay(Calendar,0).getDay();'): App {
  return app({
    workflows: [
      workflow({
        name: 'On add',
        form: 'Orders',
        event: 'on success',
        deluge: { text, span: { start: 0, end: text.length } },
      }),
    ],
  });
}

function shareApp(text = 'shareTo unknownThing;'): App {
  return app({
    workflows: [
      workflow({
        name: 'On add',
        form: 'Orders',
        event: 'on success',
        deluge: { text, span: { start: 30, end: 30 + text.length } },
      }),
    ],
  });
}

test('canonical JSON sorts keys with compareEnUs and is byte-stable', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: true, c: 'x' } }), '{"a":{"c":"x","d":true},"b":1}');
  const keys = ['b', 'a', 'B'].sort((left, right) => compareEnUs(left, right));
  // en-US collator with caseFirst 'false' orders lowercase before uppercase.
  assert.deepEqual(keys, ['a', 'b', 'B']);
});

test('emit is byte-stable and ordered by task id', () => {
  const demo = app({
    workflows: [
      workflow({
        name: 'On add',
        form: 'Orders',
        event: 'on success',
        deluge: { text: 'unknownFunc();\nunknownFunc();', span: { start: 4, end: 40 } },
        fieldRules: [
          {
            condition: 'unknownFunc()',
            actions: [{ action: 'hide', fields: ['Secret'] }],
            span: { start: 80, end: 96 },
          },
        ],
      }),
    ],
  });
  const left = mkdtempSync(join(tmpdir(), 'c2c-emit-a-'));
  const right = mkdtempSync(join(tmpdir(), 'c2c-emit-b-'));
  try {
    const tasks = emitTodoFiles(demo, left);
    emitTodoFiles(demo, right);
    const names = readdirSync(left).sort((a, b) => compareEnUs(a, b));
    assert.deepEqual(readdirSync(right).sort((a, b) => compareEnUs(a, b)), names);
    assert.deepEqual(
      names,
      tasks.map((task) => `${task.id}.json`),
    );
    for (const name of names) {
      const body = readFileSync(join(left, name), 'utf8');
      assert.equal(readFileSync(join(right, name), 'utf8'), body);
      assert.equal(body.endsWith('\n'), true);
      const parsed = JSON.parse(body) as { id: string; shimApi: string[]; acceptanceTests: { id: string }[] };
      assert.equal(parsed.id, name.slice(0, -'.json'.length));
      assert.deepEqual(
        parsed.shimApi,
        [...parsed.shimApi].sort((a, b) => compareEnUs(a, b)),
      );
      assert.deepEqual(
        parsed.acceptanceTests.map((item) => item.id),
        [...parsed.acceptanceTests.map((item) => item.id)].sort((a, b) => compareEnUs(a, b)),
      );
    }
    assert.ok(tasks.some((task) => task.role === 'statement' || task.role === 'expression'));
    assert.ok(tasks.some((task) => task.ir.kind === 'field-rule'));
  } finally {
    rmSync(left, { recursive: true, force: true });
    rmSync(right, { recursive: true, force: true });
  }
});

test('accept rejects forbidden constructs and a non-shim call', async () => {
  const demo = shareApp();
  const task = collectTasks(demo).find((item) => item.construct.startsWith('task:'));
  assert.ok(task);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-lock-'));
  const lockPath = join(dir, 'c2c.lock.json');
  const rejected = [
    'Date.now()',
    'Math.random()',
    'eval("1")',
    'fetch("https://example.test")',
    'require("fs")',
    'process.exit(1)',
    'new Function("return 1")()',
    'shim.notReal(ctx)',
    'globalThis.foo',
  ];
  try {
    for (const fill of rejected) {
      await assert.rejects(() => acceptTodo({ app: demo, taskId: task.id, fill, lockPath }), /forbidden|not a shim API|codegen-lint|parse:/);
    }
    await assert.rejects(
      () => acceptTodo({ app: demo, taskId: task.id, fill: 'shim.log.info(ctx, "x")', lockPath: join(dir, 'missing', 'c2c.lock.json') }),
      // expression form is fine to parse; this statement hole wants a statement body, which an expression still is
      // A trailing semicolon is included below. A note id is refused before any write.
      /./,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vectorCoverage unions the construct and covered constructs', () => {
  assert.deepEqual(vectorCoverage('task:shareTo', []), []);
  assert.deepEqual(vectorCoverage('call:unknownFunc', ['method:missingMethod']), []);
  const covered = vectorCoverage('method:getDay', ['call:subBusinessDay']);
  assert.ok(covered.length > 0);
  assert.deepEqual(
    covered,
    [...covered].sort((a, b) => compareEnUs(a, b)),
  );
});

test('accept rejects a fill whose constructs have no vector coverage', async () => {
  const demo = shareApp();
  const task = collectTasks(demo).find((item) => item.construct.startsWith('task:'));
  assert.ok(task);
  assert.deepEqual(vectorCoverage(task.construct, task.coveredConstructs), []);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-nocoverage-'));
  const lockPath = join(dir, 'c2c.lock.json');
  try {
    await assert.rejects(
      () => acceptTodo({ app: demo, taskId: task.id, fill: 'shim.log.info(ctx, "filled");', lockPath }),
      /no Creator vector coverage/,
    );
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replay refuses a hand-built lock entry with no vector coverage, like accept does', () => {
  const demo = shareApp();
  const task = collectTasks(demo).find((item) => item.construct === 'task:shareTo');
  assert.ok(task?.placeholder);
  assert.ok(task.role === 'expression' || task.role === 'statement');
  assert.deepEqual(vectorCoverage(task.construct, task.coveredConstructs), []);
  const fill = 'shim.log.info(ctx, "filled");';
  const lock: FillLock = {
    version: 1,
    entries: {
      [task.id]: {
        construct: task.construct,
        coveredConstructs: task.coveredConstructs,
        fill,
        fillHash: fillHash(fill),
        id: task.id,
        ir: task.ir,
        note: task.note,
        ordinal: task.ordinal,
        role: task.role,
        sourceSpan: task.sourceSpan,
        translatorVersion: task.translatorVersion,
      },
    },
  };
  const stale: StaleFill[] = [];
  const out = sources(generate(demo, { lock, stale }));
  assert.match(stripComments(out), /shim\.todo\(ctx, "task:shareTo"/);
  assert.doesNotMatch(stripComments(out), /"filled"/);
  assert.deepEqual(stale.map((item) => [item.id, item.reason]), [[task.id, 'uncovered']]);
  assert.match(stripComments(stale[0]!.detail), /no Creator vector coverage/);
  assert.deepEqual(reportLock(demo, lock).matched, []);
  const embedded = generate(demo, { lock }).files.find((file) => file.path === 'migration-report.json');
  assert.ok(embedded);
  assert.equal((JSON.parse(embedded.source) as { fillLockEntries: number }).fillLockEntries, 0);
});

test('accept takes a fill whose construct has vector coverage and replays it', async () => {
  const demo = coveredApp();
  const task = collectTasks(demo).find((item) => item.role !== 'note');
  assert.ok(task);
  assert.ok(vectorCoverage(task.construct, task.coveredConstructs).length > 0);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-covered-'));
  const lockPath = join(dir, 'c2c.lock.json');
  try {
    await acceptTodo({ app: demo, taskId: task.id, fill: 'shim.input.get(ctx, "A")', lockPath });
    const filled = sources(generate(demo, { lock: readLock(lockPath), stale: [] }));
    assert.match(stripComments(filled), /shim\.input\.get\(ctx, "A"\)/);
    assert.equal(filled.includes('shim.todo'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an accepted fill replays byte-identically and a missing lock leaves output unchanged', async () => {
  const demo = coveredApp();
  const plain = generate(demo);
  const task = collectTasks(demo).find((item) => item.role !== 'note');
  assert.ok(task);
  assert.match(stripComments(task.sourceSpan.text), /subBusinessDay/);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-replay-'));
  const lockPath = join(dir, 'c2c.lock.json');
  try {
    await acceptTodo({ app: demo, taskId: task.id, fill: 'shim.input.get(ctx, "A")', lockPath });
    const lock = readLock(lockPath);
    assert.equal(readFileSync(lockPath, 'utf8'), `${canonicalJson(lock)}\n`);
    const staleA: StaleFill[] = [];
    const staleB: StaleFill[] = [];
    const once = generate(demo, { lock, stale: staleA });
    const twice = generate(demo, { lock, stale: staleB });
    assert.equal(sources(once), sources(twice));
    assert.equal(staleA.length, 0);
    assert.equal(staleB.length, 0);
    assert.match(stripComments(sources(once)), /shim\.input\.get\(ctx, "A"\)/);
    assert.equal(sources(once).includes('shim.todo'), false);
    assert.equal(sources(plain), sources(generate(demo)));
    assert.match(stripComments(sources(plain)), /shim\.todo/);
    const untouched = generate(demo, { lock: { version: 1, entries: {} }, stale: [] });
    assert.equal(sources(untouched), sources(plain));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed span is stale and a tampered key is an integrity failure', async () => {
  const demo = coveredApp();
  const task = collectTasks(demo).find((item) => item.role !== 'note');
  assert.ok(task);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-stale-'));
  const lockPath = join(dir, 'c2c.lock.json');
  try {
    await acceptTodo({ app: demo, taskId: task.id, fill: 'shim.input.get(ctx, "A")', lockPath });
    const lock = readLock(lockPath);
    const moved = coveredApp('x = subBusinessDay(Other,1).getDay();');
    const stale: StaleFill[] = [];
    const out = generate(moved, { lock, stale });
    assert.equal(stale.length, 1);
    assert.equal(stale[0]!.reason, 'stale');
    assert.match(stripComments(sources(out)), /shim\.todo/);
    assert.equal(sources(out).includes('shim.input.get'), false);
    assert.equal(sources(out), sources(generate(moved)));

    const tampered: FillLock = {
      version: 1,
      entries: {
        [task.id]: { ...lock.entries[task.id]!, sourceSpan: { ...task.sourceSpan, text: 'tampered' } },
      },
    };
    const integrity: StaleFill[] = [];
    const kept = generate(demo, { lock: tampered, stale: integrity });
    assert.equal(integrity[0]?.reason, 'integrity');
    assert.equal(sources(kept), sources(generate(demo)));
    writeLock(lockPath, tampered);
    const report = reportLock(demo, readLock(lockPath));
    assert.equal(report.stale[0]?.reason, 'integrity');
    assert.deepEqual(report.matched, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dual emissions of one TODO take the same fill, and a note cannot be accepted', async () => {
  const demo = app({
    workflows: [
      workflow({
        name: 'Approve',
        form: 'Orders',
        event: 'on approve',
        deluge: { text: 'x = subBusinessDay(A,0).getDay();\ny = subBusinessDay(B,1).getDay();', span: { start: 8, end: 60 } },
        approvers: [{ key: 'Approver Field', value: 'Owner', span: { start: 1, end: 5 } }],
      }),
    ],
  });
  const tasks = collectTasks(demo);
  const holes = tasks.filter((item) => item.construct === 'method:getDay' && item.role !== 'note');
  assert.equal(holes.length, 2);
  assert.ok(holes.every((item) => item.sites.length >= 1));
  const note = tasks.find((item) => item.note === 'approver');
  assert.ok(note);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-dual-'));
  try {
    await assert.rejects(() => acceptTodo({ app: demo, taskId: note.id, fill: 'shim.log.info(ctx, "no");', lockPath: join(dir, 'no.json') }), /no placeholder/);
    const lockPath = join(dir, 'c2c.lock.json');
    await acceptTodo({ app: demo, taskId: holes[0]!.id, fill: 'shim.input.get(ctx, "A")', lockPath });
    await acceptTodo({ app: demo, taskId: holes[1]!.id, fill: 'shim.input.get(ctx, "B")', lockPath });
    const filled = sources(generate(demo, { lock: readLock(lockPath), stale: [] }));
    assert.match(stripComments(filled), /shim\.input\.get\(ctx, "A"\)/);
    assert.match(stripComments(filled), /shim\.input\.get\(ctx, "B"\)/);
    const lockText = readFileSync(lockPath, 'utf8');
    const ids = Object.keys(JSON.parse(lockText).entries as Record<string, unknown>).sort((a, b) => compareEnUs(a, b));
    assert.match(stripComments(lockText), new RegExp(`"${ids[0]}"[\\s\\S]*"${ids[1]}"`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every translator TODO construct is represented and fixtures walk', () => {
  const demo = app({
    workflows: [
      workflow({
        name: 'On add',
        form: 'Orders',
        event: 'on success',
        deluge: { text: 'n = unknownCall().missingMethod();\nshareTo unknownThing;', span: { start: 2, end: 80 } },
      }),
    ],
  });
  const todos = generate(demo).todos;
  const tasks = collectTasks(demo);
  const tally: Record<string, number> = {};
  for (const task of tasks) {
    tally[task.construct] = (tally[task.construct] ?? 0) + 1;
    for (const covered of task.coveredConstructs) tally[covered] = (tally[covered] ?? 0) + 1;
  }
  const expected: Record<string, number> = {};
  for (const todo of todos) expected[todo.construct] = (expected[todo.construct] ?? 0) + 1;
  for (const construct of Object.keys(expected).sort((a, b) => compareEnUs(a, b))) {
    assert.equal(tally[construct] ?? 0, expected[construct], construct);
  }
  const collapsed = tasks.find((task) => task.construct === 'method:missingMethod');
  assert.ok(collapsed);
  assert.ok(collapsed.coveredConstructs.includes('call:unknownCall'));
  assert.equal(collapsed.coveredConstructs.includes('method:get'), false);

  for (const name of ['freight-forwarding', 'library-application-system']) {
    const loaded = loadApp(join(repoRoot(), 'fixtures/redistributable', name));
    const first = collectTasks(loaded).map((task) => task.id);
    const second = collectTasks(loaded).map((task) => task.id);
    assert.deepEqual(second, first);
    const fixtureTodos = generate(loaded).todos;
    const counts: Record<string, number> = {};
    for (const task of collectTasks(loaded)) {
      counts[task.construct] = (counts[task.construct] ?? 0) + 1;
      for (const covered of task.coveredConstructs) counts[covered] = (counts[covered] ?? 0) + 1;
    }
    const want: Record<string, number> = {};
    for (const todo of fixtureTodos) want[todo.construct] = (want[todo.construct] ?? 0) + 1;
    for (const construct of Object.keys(want)) assert.equal(counts[construct] ?? 0, want[construct], `${name} ${construct}`);
  }
});

test('the walk passes every translate option the generator passes', () => {
  // Every drift class the review reported: a decimal field rule (the
  // generator's fieldRuleSource dropped decimalFields), an approval machine
  // (the walk translated without approval: true and walked members
  // out of level order), a schedule whose form[Criteria] cannot migrate (the
  // generator substitutes the gap call), an unverified alert, and a report
  // criteria hole the walk never counted.
  const demo = deriveIr(
    parse(`application "Demo"
{
\tform Orders
\t{
\t\tPaid_Amount
\t\t(
\t\t\ttype = decimal
\t\t)
\t\tAccount
\t\t(
\t\t\ttype = text
\t\t)
\t\tApprover
\t\t(
\t\t\ttype = users
\t\t)
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tOrd_Rules as "Ord Rules"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Orders
\t\t\t\ton load
\t\t\t\t{
\t\t\t\t\tactions (Paid_Amount > 0)
\t\t\t\t\t{
\t\t\t\t\t\tshow Account;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\tapproval
\t\t{
\t\t\tOrd_Approval as "Ord Approval"
\t\t\t{
\t\t\t\ttype = approval
\t\t\t\tform = Orders
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t}
\t\t\t\ton level 1
\t\t\t\t{
\t\t\t\t\tapprovers
\t\t\t\t\t(
\t\t\t\t\t\tfield = Approver
\t\t\t\t\t)
\t\t\t\t\ton approve
\t\t\t\t\t{
\t\t\t\t\t\tactions
\t\t\t\t\t\t{
\t\t\t\t\t\t\tsendmail
\t\t\t\t\t\t\t(
\t\t\t\t\t\t\t\tfrom : "zoho.loginuserid"
\t\t\t\t\t\t\t\tto : approver.submitter
\t\t\t\t\t\t\t\tsubject : "s"
\t\t\t\t\t\t\t\tmessage : "m"
\t\t\t\t\t\t\t)
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\ton level 2
\t\t\t\t{
\t\t\t\t\tapprovers
\t\t\t\t\t(
\t\t\t\t\t\tfield = Account
\t\t\t\t\t)
\t\t\t\t\ton approve
\t\t\t\t\t{
\t\t\t\t\t\tactions
\t\t\t\t\t\t{
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t\ton reject
\t\t\t\t\t{
\t\t\t\t\t\tactions
\t\t\t\t\t\t{
\t\t\t\t\t\ton load
\t\t\t\t\t\t(
\t\t\t\t\t\t\tx = 1;
\t\t\t\t\t\t)
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\tschedule
\t\t{
\t\t\tOrd_Reminder as "Ord Reminder"
\t\t\t{
\t\t\t\ttype = schedule
\t\t\t\tform = Orders[Total > Paid_Amount * 2]
\t\t\t\tstart = "2024-01-01 00:00:00"
\t\t\t\tfrequency = daily
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\ton load
\t\t\t\t\t\t(
\t\t\t\t\t\t\tshareTo unknownThing;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\tfunctions
\t\t{
\t\t\tHelper as "Helper"
\t\t\t{
\t\t\t\ttype = functions
\t\t\t\tform = Orders
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\talert "hi";
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\treports
\t{
\t\tRep as "Rep"
\t\t{
\t\t\ttype = report
\t\t\treport type = list
\t\t\tshow all rows from Orders [Total > Paid_Amount * 2]
\t\t}
\t}
}
`),
  );
  // The decimal field rule lands in the client file through the exact-decimal
  // shim, which is also what fill-todos' walk sees.
  const client = generate(demo).files.find((item) => item.path === 'client/handlers/orders/on-load.mjs');
  assert.ok(client);
  assert.match(client.source, /shim\.decimal\.cmp\(shim\.input\.get\(ctx, "Paid_Amount"\), 0, ">"\)/);

  const tasks = collectTasks(demo);
  const expected: Record<string, number> = {};
  for (const todo of generate(demo).todos) expected[todo.construct] = (expected[todo.construct] ?? 0) + 1;
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.construct] = (counts[task.construct] ?? 0) + 1;
  assert.equal(tasks.length, generate(demo).todos.length);
  assert.deepEqual(counts, expected);
  assert.ok(tasks.some((task) => task.ir.kind === 'report' && task.construct === 'report-criteria'));
  assert.deepEqual(
    collectTasks(demo).map((task) => task.id),
    tasks.map((task) => task.id),
  );
});

test('the walk folds Form[Flag] to a field query like the generator', () => {
  // A bare field name in fetch brackets is `field == true` criteria shorthand;
  // without the app's form fields the walk mis-reads it as an index into the
  // full collection and reports a spurious TODO the generator never emitted.
  const demo = deriveIr(
    parse(`application "Demo"
{
\tform Orders
\t{
\t\tFlag
\t\t(
\t\t\ttype = decision_box
\t\t)
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tGuard as "Guard"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Orders
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\ton success
\t\t\t\t\t\t(
\t\t\t\t\t\t\trecs = Orders[Flag];
\t\t\t\t\t\t\tcount = recs.count();
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`),
  );
  const file = generate(demo).files.find((item) => item.path === 'functions/aio/orders/on-success.mjs');
  assert.ok(file);
  assert.match(stripComments(file.source), /shim\.datastore\.query\(ctx, "Orders", \{ op: "==", field: "Flag", value: true \}\)/);
  assert.doesNotThrow(() => collectTasks(demo));
  assert.deepEqual(collectTasks(demo), []);
});

test('the walk counts the schedule form-criteria gap with or without a script', () => {
  // A schedule `form = Name[criteria]` that cannot translate emits the
  // workflow-action-condition gap call even when the schedule has no body:
  // scheduleBody substitutes the call on an empty body too, so the walk must
  // visit the criteria whether or not a deluge script exists.
  const bodies: Record<string, string> = {
    'no script': '',
    'empty on start': '\t\t\t\ton start\n\t\t\t\t{\n\t\t\t\t\tactions\n\t\t\t\t\t{\n\t\t\t\t\t}\n\t\t\t\t}\n',
    'with body': '\t\t\t\ton start\n\t\t\t\t{\n\t\t\t\t\tactions\n\t\t\t\t\t{\n\t\t\t\t\t\tshareTo unknownThing;\n\t\t\t\t\t}\n\t\t\t\t}\n',
  };
  for (const [label, body] of Object.entries(bodies)) {
    const demo = deriveIr(
      parse(`application "Demo"
{
\tform Orders
\t{
\t\tTotal
\t\t(
\t\t\ttype = decimal
\t\t)
\t\tPaid_Amount
\t\t(
\t\t\ttype = decimal
\t\t)
\t}
\tworkflow
\t{
\t\tschedule
\t\t{
\t\t\tOrd_Reminder as "Ord Reminder"
\t\t\t{
\t\t\t\ttype = schedule
\t\t\t\tform = Orders[Total > Paid_Amount * 2]
\t\t\t\tstart = "2024-01-01 00:00:00"
\t\t\t\tfrequency = daily
${body}\t\t\t}
\t\t}
\t}
}
`),
    );
    const todos = generate(demo).todos;
    const tasks = collectTasks(demo);
    assert.equal(tasks.length, todos.length, label);
    const expected: Record<string, number> = {};
    for (const todo of todos) expected[todo.construct] = (expected[todo.construct] ?? 0) + 1;
    const counts: Record<string, number> = {};
    for (const task of tasks) counts[task.construct] = (counts[task.construct] ?? 0) + 1;
    assert.deepEqual(counts, expected, label);
    assert.ok(
      tasks.some((task) => task.construct === 'workflow-action-condition'),
      label,
    );
  }
});

test('shim allowlist follows the construct, not the full shim surface', () => {
  const share = shimAllowlist('task:shareTo');
  const banned = [
    'shim.datastore.delete',
    'shim.datastore.update',
    'shim.datastore.insert',
    'shim.datastore.setField',
    'shim.datastore.flush',
    'shim.datastore.query',
    'shim.mail.send',
    'shim.http.invokeurl',
    'shim.thisapp.call',
    'shim.input.set',
    'shim.record.set',
    'shim.date.getYear',
  ];
  for (const name of banned) assert.equal(share.includes(name), false, name);
  for (const name of ['shim.log.info', 'shim.input.get', 'shim.old.get', 'shim.record.get', 'shim.isBlank', 'shim.list', 'shim.map', 'shim.each', 'shim.math.round', 'shim.convert.toLong', 'shim.string.replaceFirst', 'shim.decimal.add']) {
    assert.equal(share.includes(name), true, name);
  }
  assert.deepEqual(shimAllowlist('task:if').filter((name) => banned.includes(name)), []);
  assert.equal(shimAllowlist('task:sendmail').includes('shim.mail.send'), true);
  assert.equal(shimAllowlist('task:sendmail').includes('shim.datastore.delete'), false);
  assert.equal(shimAllowlist('task:invokeurl').includes('shim.http.invokeurl'), true);
  assert.equal(shimAllowlist('task:invokeurl').includes('shim.mail.send'), false);
  assert.equal(shimAllowlist('task:delete').includes('shim.datastore.delete'), true);
  assert.equal(shimAllowlist('task:delete').includes('shim.mail.send'), false);
  assert.equal(shimAllowlist('method:getYear').includes('shim.date.getYear'), true);
  assert.equal(shimAllowlist('method:getYear').includes('shim.datastore.delete'), false);
  assert.equal(shimAllowlist('method:count').includes('shim.datastore.aggregate'), true);
  assert.equal(shimAllowlist('method:count').includes('shim.datastore.query'), true);
  assert.equal(shimAllowlist('method:count').includes('shim.datastore.delete'), false);
  assert.equal(shimAllowlist('call:unknownFunc').includes('shim.thisapp.call'), false);
  assert.equal(shimAllowlist('call:delete').includes('shim.datastore.delete'), true);
  const covered = shimAllowlist('method:size', ['method:delete']);
  assert.equal(covered.includes('shim.datastore.delete'), true);
  assert.equal(covered.includes('shim.mail.send'), false);
  for (const name of shimAllowlist('task:sendmail', ['method:count', 'call:unknownFunc'])) {
    assert.equal(SHIM_API.includes(name), true, name);
  }
});

test('shareTo rejects side effects, aliases, computed members, and a wrapper escape', async () => {
  const demo = shareApp();
  const task = collectTasks(demo).find((item) => item.construct === 'task:shareTo');
  assert.ok(task);
  assert.equal(task.shimApi.includes('shim.datastore.delete'), false);
  assert.equal(task.shimApi.includes('shim.log.info'), true);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-attack-'));
  const lockPath = join(dir, 'c2c.lock.json');
  const marker = join(dir, 'escape-marker');
  const rejected: { fill: string; pattern: RegExp }[] = [
    { fill: 'shim.datastore.delete(ctx, "Item", { "op": "true" });', pattern: /not a shim API/ },
    { fill: 'shim.datastore.update(ctx, "Item", { "op": "true" }, {});', pattern: /not a shim API/ },
    { fill: 'shim.mail.send(ctx, { "to": "a@example.test" });', pattern: /not a shim API/ },
    { fill: 'shim.http.invokeurl(ctx, { "url": "https://example.test" });', pattern: /not a shim API/ },
    { fill: 'const d = shim.datastore;\nd.delete(ctx, "Item", { "op": "true" });', pattern: /forbidden shim alias|not a shim API/ },
    { fill: 'shim["datastore"]["delete"](ctx, "Item", { "op": "true" });', pattern: /forbidden computed member/ },
    { fill: "shim['mail'].send(ctx, { \"to\": \"a@example.test\" });", pattern: /forbidden computed member/ },
    { fill: 'const { datastore } = shim;', pattern: /forbidden destructuring/ },
    { fill: 'const { delete: del } = shim.datastore;', pattern: /forbidden destructuring/ },
    { fill: 'globalThis[\'ev\'+\'al\'](\'1\')', pattern: /forbidden|not a shim API/ },
    { fill: 'import("node:child_process")', pattern: /forbidden import/ },
    { fill: 'require("fs")', pattern: /forbidden require|not a shim API/ },
    { fill: 'process.exit(1)', pattern: /forbidden process|not a shim API/ },
    { fill: 'Reflect.apply(eval, null, [\'1\'])', pattern: /forbidden|not a shim API/ },
    { fill: 'new Function("return 1")()', pattern: /forbidden|not a shim API/ },
    { fill: "this.constructor.constructor('return 1')()", pattern: /forbidden|not a shim API/ },
    { fill: 'globalThis[`ev${""}al`]("1")', pattern: /forbidden|not a shim API/ },
    { fill: '\\u0065val("1")', pattern: /forbidden eval|not a shim API/ },
    { fill: '\\u{65}val("1")', pattern: /forbidden eval|not a shim API/ },
    { fill: '[].constructor.constructor("return 1")()', pattern: /forbidden|not a shim API/ },
    { fill: '(function(){ return 1 })()', pattern: /forbidden|not a shim API/ },
    {
      fill: `}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n{`,
      pattern: /escapes the __fill wrapper/,
    },
  ];
  try {
    for (const attack of rejected) {
      await assert.rejects(
        () => acceptTodo({ app: demo, taskId: task.id, fill: attack.fill, lockPath }),
        attack.pattern,
        attack.fill,
      );
    }
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replay refuses a lock whose fill or fill hash was edited', async () => {
  const demo = coveredApp();
  const task = collectTasks(demo).find((item) => item.role !== 'note');
  assert.ok(task);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-hash-'));
  const lockPath = join(dir, 'c2c.lock.json');
  try {
    await acceptTodo({ app: demo, taskId: task.id, fill: 'shim.input.get(ctx, "A")', lockPath });
    const lock = readLock(lockPath);
    const entry = lock.entries[task.id];
    assert.ok(entry);
    assert.equal(entry.fillHash, fillHash(entry.fill));
    const stale: StaleFill[] = [];
    const ok = generate(demo, { lock, stale });
    assert.equal(stale.length, 0);
    assert.match(stripComments(sources(ok)), /shim\.input\.get\(ctx, "A"\)/);

    const edited = 'eval("1"); process.stdout.write("spliced")';
    assert.throws(
      () => generate(demo, { lock: { version: 1, entries: { [task.id]: { ...entry, fill: edited } } }, stale: [] }),
      /fill hash does not match/,
    );
    assert.throws(
      () =>
        generate(demo, {
          lock: { version: 1, entries: { [task.id]: { ...entry, fill: edited, fillHash: fillHash(edited) } } },
          stale: [],
        }),
      /failed static validation/,
    );
    const escape = '}\nprocess.stdout.write("spliced");\n{';
    assert.throws(
      () =>
        generate(demo, {
          lock: { version: 1, entries: { [task.id]: { ...entry, fill: escape, fillHash: fillHash(escape) } } },
          stale: [],
        }),
      /escapes the __fill wrapper/,
    );
    const retarget = 'shim.log.info(ctx, "edited");';
    assert.throws(
      () => generate(demo, { lock: { version: 1, entries: { [task.id]: { ...entry, fill: retarget } } }, stale: [] }),
      /fill hash does not match/,
    );
    const kept = generate(demo, { lock, stale: [] });
    assert.equal(sources(kept), sources(ok));
    assert.equal(sources(kept).includes('spliced'), false);
    assert.equal(sources(kept).includes('eval'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emit is byte-stable under LANG=da_DK.UTF-8', () => {
  const ds = join(mkdtempSync(join(tmpdir(), 'c2c-locale-src-')), 'app.ds');
  writeFileSync(
    ds,
    [
      'application "T"',
      '{',
      '\tworkflow',
      '\t{',
      '\tform',
      '\t{',
      '\t\tOn_Add as "On add"',
      '\t\t{',
      '\t\t\ttype = form',
      '\t\t\tform = Item',
      '\t\t\ton add',
      '\t\t\t{',
      '\t\t\t\tactions',
      '\t\t\t\t{',
      '\t\t\t\ton success',
      '\t\t\t\t(',
      '\t\t\t\t\tunknownFunc();',
      '\t\t\t\t\tshareTo unknownThing;',
      '\t\t\t\t)',
      '\t\t\t\t}',
      '\t\t\t}',
      '\t\t}',
      '\t}',
      '\t}',
      '}',
      '',
    ].join('\n'),
  );
  const parentDir = mkdtempSync(join(tmpdir(), 'c2c-locale-a-'));
  const childDir = mkdtempSync(join(tmpdir(), 'c2c-locale-b-'));
  const script = join(parentDir, 'emit.mjs');
  writeFileSync(
    script,
    [
      `import { emitTodoFiles, loadApp } from ${JSON.stringify(join(repoRoot(), 'dist/deluge/src/fill-todos.js'))};`,
      'emitTodoFiles(loadApp(process.argv[2]), process.argv[3]);',
      '',
    ].join('\n'),
  );
  try {
    emitTodoFiles(loadApp(ds), parentDir);
    const env = { ...process.env, LANG: 'da_DK.UTF-8', LC_ALL: 'da_DK.UTF-8' };
    const child = spawnSync(process.execPath, [script, ds, childDir], { encoding: 'utf8', env, cwd: repoRoot() });
    assert.equal(child.status, 0, child.stderr);
    const names = readdirSync(parentDir).filter((name) => name.endsWith('.json')).sort((a, b) => compareEnUs(a, b));
    assert.deepEqual(
      readdirSync(childDir).filter((name) => name.endsWith('.json')).sort((a, b) => compareEnUs(a, b)),
      names,
    );
    assert.ok(names.length > 0);
    for (const name of names) {
      assert.equal(readFileSync(join(childDir, name), 'utf8'), readFileSync(join(parentDir, name), 'utf8'));
    }
  } finally {
    rmSync(parentDir, { recursive: true, force: true });
    rmSync(childDir, { recursive: true, force: true });
    rmSync(join(ds, '..'), { recursive: true, force: true });
  }
});

test('c2c fill-todos emit, accept, and report from the CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-cli-'));
  const ds = join(dir, 'app.ds');
  const emit = join(dir, 'tasks');
  const fill = join(dir, 'fill.mjs');
  const lock = join(dir, 'c2c.lock.json');
  writeFileSync(
    ds,
    [
      'application "T"',
      '{',
      '\tworkflow',
      '\t{',
      '\tform',
      '\t{',
      '\t\tOn_Add as "On add"',
      '\t\t{',
      '\t\t\ttype = form',
      '\t\t\tform = Item',
      '\t\t\ton add',
      '\t\t\t{',
      '\t\t\t\tactions',
      '\t\t\t\t{',
      '\t\t\t\ton success',
      '\t\t\t\t(',
      '\t\t\t\t\tx = subBusinessDay(zoho.currentdate,0).getDay();',
      '\t\t\t\t)',
      '\t\t\t\t}',
      '\t\t\t}',
      '\t\t}',
      '\t}',
      '\t}',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(fill, 'shim.input.get(ctx, "A")');
  const cli = join(repoRoot(), 'dist/cli/src/c2c.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  try {
    const emitted = run(['fill-todos', ds, '--emit', emit]);
    assert.equal(emitted.status, 0, emitted.stderr);
    assert.match(stripComments(emitted.stdout), /fill-todos emit \d+ /);
    const again = run(['fill-todos', ds, '--emit', join(dir, 'tasks-2')]);
    assert.equal(again.status, 0, again.stderr);
    const names = readdirSync(emit).sort((a, b) => compareEnUs(a, b));
    for (const name of names) {
      assert.equal(readFileSync(join(dir, 'tasks-2', name), 'utf8'), readFileSync(join(emit, name), 'utf8'));
    }
    const task = JSON.parse(readFileSync(join(emit, names[0]!), 'utf8')) as { id: string; role: string };
    const accepted = run(['fill-todos', ds, '--accept', task.id, fill, '--lock', lock]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(stripComments(accepted.stdout), new RegExp(`accepted ${task.id}`));
    const reported = run(['fill-todos', ds, '--lock', lock, '--report']);
    assert.equal(reported.status, 0, reported.stderr);
    assert.match(stripComments(reported.stdout), new RegExp(`ok ${task.id}`));
    const bad = run(['fill-todos', ds, '--accept', task.id, join(dir, 'nope'), '--lock', lock]);
    assert.notEqual(bad.status, 0);
    const parsed = JSON.parse(readFileSync(lock, 'utf8')) as { entries: Record<string, { fill: string }> };
    parsed.entries[task.id]!.fill = 'eval("1"); process.stdout.write("spliced")';
    writeFileSync(lock, `${JSON.stringify(parsed)}\n`);
    const refused = run(['fill-todos', ds, '--lock', lock, '--report']);
    assert.notEqual(refused.status, 0);
    assert.match(stripComments(refused.stderr), /fill hash does not match|failed static validation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('c2c fill-todos --accept rejects a fill with no Creator vector coverage and writes no lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-cli-nocov-'));
  const ds = join(dir, 'app.ds');
  const fill = join(dir, 'fill.mjs');
  const lock = join(dir, 'c2c.lock.json');
  writeFileSync(
    ds,
    [
      'application "T"',
      '{',
      '\tworkflow',
      '\t{',
      '\tform',
      '\t{',
      '\t\tOn_Add as "On add"',
      '\t\t{',
      '\t\t\ttype = form',
      '\t\t\tform = Item',
      '\t\t\ton add',
      '\t\t\t{',
      '\t\t\t\tactions',
      '\t\t\t\t{',
      '\t\t\t\ton success',
      '\t\t\t\t(',
      '\t\t\t\t\tshareTo unknownThing;',
      '\t\t\t\t)',
      '\t\t\t\t}',
      '\t\t\t}',
      '\t\t}',
      '\t}',
      '\t}',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(fill, 'shim.log.info(ctx, "filled");\n');
  const cli = join(repoRoot(), 'dist/cli/src/c2c.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  try {
    const emit = join(dir, 'tasks');
    assert.equal(run(['fill-todos', ds, '--emit', emit]).status, 0);
    const tasks = readdirSync(emit).map((name) => JSON.parse(readFileSync(join(emit, name), 'utf8')) as { id: string; construct: string });
    const task = tasks.find((item) => item.construct === 'task:shareTo');
    assert.ok(task);
    const rejected = run(['fill-todos', ds, '--accept', task.id, fill, '--lock', lock]);
    assert.notEqual(rejected.status, 0);
    assert.match(stripComments(rejected.stderr), /no Creator vector coverage/);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('call-shaped text inside a // comment line is not a call site', () => {
  const src = [
    '// Deluge: await shim.todo("***");',
    'await shim.todo(ctx, "task:real", { start: 0, end: 1 });',
    '  // Deluge: await shim.todo("x")',
  ].join('\n');
  const calls = extractTodoCalls(src);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.construct, 'task:real');
  assert.equal(calls[0]!.role, 'statement');
});

test('a statement call keeps its role and semicolon after a // comment line', () => {
  // The comment's last character is not a statement boundary.
  const src = '// Deluge: foo bar\nawait shim.todo(ctx, "task:foo", { start: 0, end: 7 });';
  const calls = extractTodoCalls(src);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.role, 'statement');
  assert.ok(calls[0]!.text.endsWith(';'));
});

test('a // inside a string literal does not turn real code into a comment', () => {
  const src = 'var u = "http://example.test/x";\nawait shim.todo(ctx, "task:u", { start: 0, end: 1 });';
  const calls = extractTodoCalls(src);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.construct, 'task:u');
});

function bytesFill(bytes: number): string {
  const prefix = 'shim.input.get(ctx, "';
  const suffix = '");';
  const pad = bytes - Buffer.byteLength(prefix + suffix);
  assert.ok(pad >= 1);
  return prefix + 'A'.repeat(pad) + suffix;
}

function statementsFill(count: number): string {
  return Array.from({ length: count }, () => 'shim.input.get(ctx, "A");').join('\n');
}

function loopsFill(count: number): string {
  return Array.from(
    { length: count },
    (_, n) => `for (let i${n} = 0; i${n} < 1; i${n} = i${n} + 1) { shim.input.get(ctx, "A"); }`,
  ).join('\n');
}

function lockFor(task: FillTask, fill: string): FillLock {
  assert.ok(task.role === 'expression' || task.role === 'statement');
  return {
    version: 1,
    entries: {
      [task.id]: {
        construct: task.construct,
        coveredConstructs: task.coveredConstructs,
        fill,
        fillHash: fillHash(fill),
        id: task.id,
        ir: task.ir,
        note: task.note,
        ordinal: task.ordinal,
        role: task.role,
        sourceSpan: task.sourceSpan,
        translatorVersion: task.translatorVersion,
      },
    },
  };
}

test('fill limits name the cap and the measured value', () => {
  const overBytes = bytesFill(FILL_LIMITS.maxBytes + 1);
  assert.equal(
    fillLimitRefusal(overBytes),
    `fill limit maxBytes: measured ${Buffer.byteLength(overBytes)}, limit ${FILL_LIMITS.maxBytes}`,
  );
  assert.equal(fillLimitRefusal(bytesFill(FILL_LIMITS.maxBytes)), null);

  const overStatements = statementsFill(FILL_LIMITS.maxStatements + 1);
  assert.equal(
    fillLimitRefusal(overStatements),
    `fill limit maxStatements: measured ${FILL_LIMITS.maxStatements + 1}, limit ${FILL_LIMITS.maxStatements}`,
  );
  assert.equal(fillLimitRefusal(statementsFill(FILL_LIMITS.maxStatements)), null);

  const overLoops = loopsFill(FILL_LIMITS.maxLoops + 1);
  assert.equal(
    fillLimitRefusal(overLoops),
    `fill limit maxLoops: measured ${FILL_LIMITS.maxLoops + 1}, limit ${FILL_LIMITS.maxLoops}`,
  );
  assert.equal(fillLimitRefusal(loopsFill(FILL_LIMITS.maxLoops)), null);

  const eachKind = [
    'for (let i = 0; i < 1; i = i + 1) { shim.input.get(ctx, "A"); }',
    'for (const item in [1]) { shim.input.get(ctx, "A"); }',
    'for (const item of [1]) { shim.input.get(ctx, "A"); }',
    'while (false) { shim.input.get(ctx, "A"); }',
    'do { shim.input.get(ctx, "A"); } while (false);',
  ].join('\n');
  assert.equal(
    fillLimitRefusal(eachKind),
    `fill limit maxLoops: measured 5, limit ${FILL_LIMITS.maxLoops}`,
  );
});

test('accept refuses a fill over each cap and does not write the lock', async (t) => {
  const demo = coveredApp('subBusinessDay(Calendar,0).getDay();');
  const task = collectTasks(demo).find((item) => item.role === 'statement' && item.construct === 'method:getDay');
  assert.ok(task);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fill-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = [
    bytesFill(FILL_LIMITS.maxBytes + 1),
    statementsFill(FILL_LIMITS.maxStatements + 1),
    loopsFill(FILL_LIMITS.maxLoops + 1),
  ];
  for (const fill of cases) {
    const lockPath = join(dir, `lock-${Buffer.byteLength(fill)}.json`);
    const expected = fillLimitRefusal(fill);
    assert.ok(expected);
    await assert.rejects(() => acceptTodo({ app: demo, taskId: task.id, fill, lockPath }), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(existsSync(lockPath), false);
  }
});

test('replay of an over-cap lock entry fails closed and leaves the hole unchanged', () => {
  const demo = coveredApp('subBusinessDay(Calendar,0).getDay();');
  const task = collectTasks(demo).find((item) => item.role === 'statement' && item.construct === 'method:getDay');
  assert.ok(task);
  const fills = [
    bytesFill(FILL_LIMITS.maxBytes + 1),
    statementsFill(FILL_LIMITS.maxStatements + 1),
    loopsFill(FILL_LIMITS.maxLoops + 1),
  ];
  for (const fill of fills) {
    const generated = generate(demo);
    const before = generated.files.map((file) => file.source);
    const expected = fillLimitRefusal(fill);
    assert.ok(expected);
    assert.throws(() => applyFillLock(demo, generated.files, lockFor(task, fill)), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(generated.files.map((file) => file.source), before);
    assert.equal(before.some((source) => source.includes(fill)), false);
  }
});

test('accept takes a fill that meets each cap and replay splices it whole', async (t) => {
  const demo = coveredApp('subBusinessDay(Calendar,0).getDay();');
  const task = collectTasks(demo).find((item) => item.role === 'statement' && item.construct === 'method:getDay');
  assert.ok(task);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fill-at-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fills = [
    bytesFill(FILL_LIMITS.maxBytes),
    statementsFill(FILL_LIMITS.maxStatements),
    loopsFill(FILL_LIMITS.maxLoops),
  ];
  for (let index = 0; index < fills.length; index++) {
    const body = fills[index]!;
    assert.equal(fillLimitRefusal(body), null);
    const lockPath = join(dir, `at-${index}.json`);
    await acceptTodo({ app: demo, taskId: task.id, fill: body, lockPath });
    const stored: LockEntry | undefined = readLock(lockPath).entries[task.id];
    assert.ok(stored);
    assert.equal(stored.fill, body);
    const out = sources(generate(demo, { lock: readLock(lockPath), stale: [] }));
    assert.equal(stripComments(out).includes(body), true);
    assert.equal(stripComments(out).includes('shim.todo'), false);
  }
});

test('accept rejects fills containing Cf, Zs, and specific formatting code points', async () => {
  const demo = shareApp();
  const task = collectTasks(demo).find((item) => item.construct.startsWith('task:'));
  assert.ok(task);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-lock-'));
  const lockPath = join(dir, 'c2c.lock.json');
  const rejectedFills = [
    { fill: `shim.log.info(ctx, "\u200B")`, code: '200B', offset: 20 },
    { fill: `shim.log.info(ctx, "\u0085")`, code: '0085', offset: 20 },
    { fill: `shim.log.info(ctx, "\u00A0")`, code: '00A0', offset: 20 },
    { fill: `shim.log.info(ctx, "\u2028")`, code: '2028', offset: 20 },
    { fill: `shim.log.info(ctx, "\uFEFF")`, code: 'FEFF', offset: 20 },
  ];
  try {
    for (const { fill, code, offset } of rejectedFills) {
      await assert.rejects(
        () => acceptTodo({ app: demo, taskId: task.id, fill, lockPath }),
        new RegExp(`parse: invalid whitespace/format character U\\+${code} at offset ${offset}`)
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accept takes fills with ordinary non-ASCII letters, marks, and a tab', async () => {
  const demo = coveredApp();
  const task = collectTasks(demo).find((item) => item.role === 'expression' || item.role === 'statement');
  assert.ok(task);
  if (task.role !== 'expression' && task.role !== 'statement') assert.fail('expected a fillable task');
  assert.ok(vectorCoverage(task.construct, task.coveredConstructs).length > 0);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-unicode-ok-'));
  const lockPath = join(dir, 'c2c.lock.json');
  const acceptedFills = [
    { fill: 'shim.input.get(ctx, "é")', label: 'precomposed e-acute U+00E9' },
    { fill: 'shim.input.get(ctx, "é")', label: 'e + combining acute U+0301' },
    { fill: 'shim.input.get(ctx, "中")', label: 'CJK U+4E2D' },
    { fill: 'shim.input.get(ctx, "😀")', label: 'astral emoji U+1F600' },
    { fill: 'shim.input.get(ctx, "a\tb")', label: 'tab U+0009 inside a string literal' },
  ];
  try {
    for (const { fill, label } of acceptedFills) {
      assert.deepEqual(lintFill(fill, task.role, task.shimApi), [], label);
      await acceptTodo({ app: demo, taskId: task.id, fill, lockPath });
      const lock = readLock(lockPath);
      assert.equal(lock.entries[task.id]?.fill, fill, label);
    }
    await assert.rejects(
      () => acceptTodo({ app: demo, taskId: task.id, fill: 'shim.input.get(ctx, "​")', lockPath }),
      /parse: invalid whitespace\/format character U\+200B/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
