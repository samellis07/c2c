import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { emptyApp, type App, type Workflow } from '../../core/src/index.js';
import { mockDatastore } from '../../shims/test/zcql-mock.js';
import {
  AsyncOnSuccessRefusedError,
  assertAsyncSuccessDeferrable,
  classifySuccessForAsync,
  DEAD_LETTER_ENVELOPE_VERSION,
  type AsyncCandidate,
} from '../src/events.js';
import { generate, type GeneratedFile } from '../src/generate.js';

const Z = { start: 0, end: 0 };

function workflow(partial: Partial<Workflow> & Pick<Workflow, 'name' | 'event'>): Workflow {
  return { deluge: null, properties: [], span: Z, ...partial };
}

function app(partial: Partial<App>): App {
  return { ...emptyApp('empty'), name: 'Demo_App', ...partial };
}

/** A response-sensitive app: Orders can cancel the submit, which changes the reply status. */
function sensitiveApp(): App {
  return app({
    workflows: [
      workflow({ name: 'Orders success', form: 'Orders', event: 'on success', deluge: { text: 'cancel submit;', span: Z } }),
      workflow({ name: 'Jobs success', form: 'Jobs', event: 'on success', deluge: { text: 'insert into Log[Note = "ok"];', span: Z } }),
    ],
  });
}

/** A deferrable app: the only on-success work is a fire-and-forget cross-form insert. */
function deferrableApp(): App {
  return app({
    workflows: [
      workflow({ name: 'Jobs success', form: 'Jobs', event: 'on success', deluge: { text: 'insert into Log[Note = "ok"];', span: Z } }),
    ],
  });
}

function twoModuleApp(): App {
  return app({
    workflows: [
      workflow({ name: 'Jobs A success', form: 'Jobs', event: 'on success', deluge: { text: 'insert into First_Log[Note = "A"];', span: Z } }),
      workflow({ name: 'Jobs B success', form: 'Jobs', event: 'on success', deluge: { text: 'insert into Second_Log[Note = "B"];', span: Z } }),
    ],
  });
}

/** An on-delete app: deletes stay synchronous, so the flag must not open the lane. */
function deleteApp(): App {
  return app({
    workflows: [
      workflow({ name: 'Jobs delete', form: 'Jobs', event: 'on delete', deluge: { text: 'insert into Log[Note = "gone"];', span: Z } }),
    ],
  });
}

const file = (g: { files: GeneratedFile[] }, path: string) => g.files.find((f) => f.path === path);

/** Write the generated tree, as the deploy lays it out, and import one module. */
async function materialize(g: ReturnType<typeof generate>, deploy?: object): Promise<{ root: string; load: (path: string) => Promise<Record<string, (...a: unknown[]) => Promise<any>>> }> {
  const root = mkdtempSync(join(tmpdir(), 'c2c-events-'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(root, 'node_modules/creator-to-catalyst'));
  for (const f of g.files) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.source);
  }
  if (deploy) writeFileSync(join(root, 'functions/c2c-deploy.json'), JSON.stringify(deploy));
  return { root, load: async (path) => import(pathToFileURL(join(root, path)).href) };
}

function recordEvent(table: string, action: string, row: Record<string, unknown>) {
  return {
    getData: () => [{ data: { row, table_details: { table_name: table }, action } }],
    getAction: () => action,
    getTime: () => '2026-10-12T03:31:00Z',
    getSourceEntityId: () => table,
  };
}

test('default output is byte-identical: no event files, no sweeper cron, no marker table', () => {
  const a = sensitiveApp();
  const plain = generate(a);
  const off = generate(a, { asyncOnSuccess: false });
  assert.deepEqual(
    off.files.map((f) => [f.path, f.source]),
    plain.files.map((f) => [f.path, f.source]),
    'asyncOnSuccess: false is the same bytes as no option',
  );
  assert.ok(!plain.files.some((f) => f.path.startsWith('functions/events/')), 'no event function by default');
  assert.ok(!file(plain, 'functions/c2c-deadletter.mjs'), 'no dead-letter store by default');
  const scheduling = file(plain, 'job-scheduling.json');
  assert.ok(!scheduling || !scheduling.source.includes('c2c_event_sweeper'), 'no event sweeper cron by default');
  const submit = file(plain, 'functions/aio/orders/on-success.mjs')!;
  assert.ok(!submit.source.includes('deferred: "after-commit event"'), 'the synchronous run is unchanged');
});

test('blocker 1: a response-sensitive on-success workflow refuses the flag with a named error', () => {
  assert.throws(
    () => generate(sensitiveApp(), { asyncOnSuccess: true }),
    (err) => {
      assert.ok(err instanceof AsyncOnSuccessRefusedError, 'a named refusal');
      assert.equal(err.code, 'ASYNC_ON_SUCCESS_RESPONSE_SENSITIVE');
      assert.deepEqual([...err.workflows], ['Orders success']);
      assert.match(err.message, /cancel the submit/);
      return true;
    },
  );
});

test('blocker 1: the classifier keeps response-affecting work synchronous', () => {
  const candidate = (partial: Partial<AsyncCandidate>): AsyncCandidate => ({
    name: 'w',
    server: 'await handle(ctx);',
    client: '',
    deluge: 'x = 1;',
    ...partial,
  });
  assert.deepEqual(classifySuccessForAsync(candidate({ server: 'if (x) shim.validate.cancelSubmit(ctx);' })), {
    deferrable: false,
    reason: 'it can cancel the submit, which changes the reply status',
  });
  const client = classifySuccessForAsync(candidate({ client: 'actions.push({ type: "info" });' }));
  assert.equal(client.deferrable, false);
  const valued = classifySuccessForAsync(candidate({ server: 'const r = await handle(ctx);\nreturn r;' }));
  assert.equal(valued.deferrable, false);
  const recordWrite = classifySuccessForAsync(candidate({ server: 'shim.input.set(ctx, "Title", "x");' }));
  assert.equal(recordWrite.deferrable, false);
  assert.deepEqual(classifySuccessForAsync(candidate({})), { deferrable: true });
  assert.throws(() => assertAsyncSuccessDeferrable([candidate({ name: 'a' }), candidate({ name: 'b', server: 'shim.record.set(ctx, "T", "x");' })]), /async on-success refused for 1 workflow: b/);
  assert.doesNotThrow(() => assertAsyncSuccessDeferrable([]));
});

test('blocker 1: deletes stay synchronous and never open the lane', () => {
  const g = generate(deleteApp(), { asyncOnSuccess: true });
  assert.ok(!g.files.some((f) => f.path.startsWith('functions/events/')), 'no event function for delete-only work');
  assert.ok(!file(g, 'migration-report.json')!.source.includes('event-async-onsuccess'), 'no trigger warning without the lane');
});

test('blocker 1: the event lane never serves deletes', async () => {
  const g = generate(deferrableApp(), { asyncOnSuccess: true });
  const { root, load } = await materialize(g);
  try {
    const listener = await load('functions/events/after-commit.mjs');
    const out = await listener.default!(recordEvent('Jobs', 'delete', { ROWID: '7' }), {
      closeWithSuccess: () => undefined,
      closeWithFailure: () => undefined,
    });
    assert.equal(out.skipped, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the opt-in emits the event function, the marker store, the sweeper and its cron', () => {
  const g = generate(deferrableApp(), { asyncOnSuccess: true });
  assert.ok(file(g, 'functions/events/after-commit.mjs'), 'after-commit event function');
  assert.ok(file(g, 'functions/c2c-deadletter.mjs'), 'dead-letter store');
  assert.ok(file(g, 'functions/job/c2c-event-sweeper.mjs'), 'sweep Job module');
  const scheduling = JSON.parse(file(g, 'job-scheduling.json')!.source) as { crons: { cron_name: string }[]; eventSweeper?: { deadLetterTable: { name: string } } };
  assert.ok(scheduling.crons.some((c) => c.cron_name === 'c2c_event_sweeper'), 'the 15-minute sweep cron is registered');
  assert.equal(scheduling.eventSweeper?.deadLetterTable.name, 'C2CEventDeadLetter');
  // Under the flag the live submit endpoint stores the row and replies without
  // running the script — the record trigger runs it once, asynchronously.
  const submit = file(g, 'functions/aio/jobs/on-success.mjs')!;
  assert.match(submit.source, /result = live \? \{ deferred: "after-commit event" \} : await handle\(ctx\)/);
  const report = JSON.parse(file(g, 'migration-report.json')!.source) as { warnings?: { construct: string }[] };
  assert.ok(report.warnings?.some((w) => w.construct === 'event-async-onsuccess'), 'the unwired-trigger warning is reported');
});

test('an opt-in app with no on-success module emits no event lane', () => {
  const g = generate(app({ workflows: [workflow({ name: 'load', form: 'Orders', event: 'on load', deluge: { text: 'x = 1;', span: Z } })] }), { asyncOnSuccess: true });
  assert.ok(!g.files.some((f) => f.path.startsWith('functions/events/')));
  assert.ok(!file(g, 'migration-report.json')!.source.includes('event-async-onsuccess'));
});

test('dry run: the event function runs the script inline and writes no marker', async () => {
  const g = generate(deferrableApp(), { asyncOnSuccess: true });
  const { datastore, tables } = mockDatastore({ Orders: ['ROWID'], Jobs: ['ROWID'] });
  const { root, load } = await materialize(g);
  try {
    const closed: string[] = [];
    const listener = await load('functions/events/after-commit.mjs');
    const out = await listener.default!(recordEvent('Jobs', 'insert', { ROWID: '7' }), {
      closeWithSuccess: () => closed.push('success'),
      closeWithFailure: () => closed.push('failure'),
    });
    assert.equal(out.dryRun, true);
    assert.deepEqual(closed, ['success']);
    assert.equal(tables.get('C2CEventDeadLetter') ?? null, null, 'dry run writes no marker');
    assert.equal(tables.get('C2CEventProcessed') ?? null, null, 'dry run writes no ledger row');
    void datastore;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blocker 4: the envelope carries identity only, never record data', async () => {
  const g = generate(deferrableApp(), { asyncOnSuccess: true });
  const { root, load } = await materialize(g);
  try {
    const listener = await load('functions/events/after-commit.mjs');
    const out = await listener.default!(
      recordEvent('Jobs', 'insert', { ROWID: '7', Email: 'secret-person@example.com', Notes: 'private free text' }),
      { closeWithSuccess: () => undefined, closeWithFailure: () => undefined },
    );
    const event = out.event as Record<string, unknown>;
    assert.deepEqual(Object.keys(event).sort(), ['action', 'eventTime', 'form', 'key', 'rowId', 'table', 'v']);
    assert.equal(event.v, DEAD_LETTER_ENVELOPE_VERSION);
    assert.equal(event.form, 'Jobs');
    assert.equal(event.action, 'add');
    assert.equal(event.rowId, '7');
    assert.ok(!('record' in event), 'no record payload');
    const text = JSON.stringify(event);
    assert.ok(!text.includes('secret-person@example.com'), 'no contact PII in the envelope');
    assert.ok(!text.includes('private free text'), 'no free-text PII in the envelope');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blocker 4: a live failure marker persists no PII beyond the row id', async () => {
  const g = generate(deferrableApp(), { asyncOnSuccess: true });
  const { datastore, tables } = mockDatastore({ Orders: ['ROWID'], Jobs: ['ROWID'] });
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = datastore;
  const { root, load } = await materialize(g, { mode: 'live', appTimeZone: 'UTC' });
  try {
    const closed: string[] = [];
    const listener = await load('functions/events/after-commit.mjs');
    // No committed row: the reload fails, so the trigger payload — PII
    // included — is never trusted and never persisted.
    await assert.rejects(
      listener.default!(
        recordEvent('Jobs', 'insert', { ROWID: '99999', Email: 'secret-person@example.com', Notes: 'private free text' }),
        {
          closeWithSuccess: () => closed.push('success'),
          closeWithFailure: () => closed.push('failure'),
        },
      ),
    );
    assert.deepEqual(closed, ['failure'], 'the event execution is still reported failed');
    const markers = tables.get('C2CEventDeadLetter') ?? [];
    assert.equal(markers.length, 1, 'one failure marker');
    assert.equal(markers[0]!.State, 'pending');
    const envelope = JSON.parse(String(markers[0]!.Envelope)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(envelope).sort(), ['action', 'eventTime', 'form', 'key', 'rowId', 'table', 'v']);
    assert.ok(!('record' in envelope), 'no record payload in the stored envelope');
    for (const marker of markers) {
      const text = JSON.stringify(marker);
      assert.ok(!text.includes('secret-person@example.com'), 'no contact PII in the marker');
      assert.ok(!text.includes('private free text'), 'no free-text PII in the marker');
    }
  } finally {
    delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    rmSync(root, { recursive: true, force: true });
  }
});

test('blocker 2: a redelivered event runs each module once', async () => {
  const g = generate(deferrableApp(), { asyncOnSuccess: true });
  const { datastore, tables } = mockDatastore({ Orders: ['ROWID'], Jobs: ['ROWID'], Log: ['ROWID'] });
  const [row] = await datastore.insert('Jobs', [{ Title: 'job-1' }]);
  const rowId = String(row!.ROWID);
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = datastore;
  const { root, load } = await materialize(g, { mode: 'live', appTimeZone: 'UTC' });
  try {
    const listener = await load('functions/events/after-commit.mjs');
    const deliver = () =>
      listener.default!(recordEvent('Jobs', 'insert', { ROWID: rowId }), {
        closeWithSuccess: () => undefined,
        closeWithFailure: () => undefined,
      });
    await deliver();
    assert.equal((tables.get('Log') ?? []).length, 1, 'the first delivery ran the module');
    assert.equal((tables.get('C2CEventProcessed') ?? []).length, 1, 'the completion ledger kept one row');
    await deliver();
    assert.equal((tables.get('Log') ?? []).length, 1, 'the redelivery skipped the completed module');
    assert.equal((tables.get('C2CEventProcessed') ?? []).length, 1, 'no duplicate ledger row');
  } finally {
    delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    rmSync(root, { recursive: true, force: true });
  }
});

test('blocker 2: replaying the same envelope twice runs its side effect once', async () => {
  const g = generate(deferrableApp(), { asyncOnSuccess: true });
  const { datastore, tables } = mockDatastore({ Orders: ['ROWID'], Jobs: ['ROWID'], Log: ['ROWID'] });
  const [row] = await datastore.insert('Jobs', [{ Title: 'job-1' }]);
  const rowId = String(row!.ROWID);
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = datastore;
  const { root, load } = await materialize(g, { mode: 'live', appTimeZone: 'UTC' });
  try {
    const listener = await load('functions/events/after-commit.mjs');
    const envelope = { v: DEAD_LETTER_ENVELOPE_VERSION, key: `jobs/add/${rowId}/replay`, form: 'Jobs', table: 'Jobs', action: 'add', rowId, eventTime: 'replay' };
    await listener.replay!(envelope, { datastore });
    await listener.replay!(envelope, { datastore });
    assert.equal((tables.get('Log') ?? []).length, 1, 'two replays of one envelope: one insert');
    assert.equal((tables.get('C2CEventProcessed') ?? []).length, 1, 'one completion row for the envelope key');
    // A different envelope key is a distinct firing and runs again.
    await listener.replay!({ ...envelope, key: `jobs/add/${rowId}/other` }, { datastore });
    assert.equal((tables.get('Log') ?? []).length, 2, 'a distinct key is not fenced');
  } finally {
    delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    rmSync(root, { recursive: true, force: true });
  }
});

test('blocker 2: replay after a mid-module failure resumes at the failed script', async () => {
  const g = generate(twoModuleApp(), { asyncOnSuccess: true });
  const { datastore, tables } = mockDatastore({ Orders: ['ROWID'], Jobs: ['ROWID'], First_Log: ['ROWID'], Second_Log: ['ROWID'] });
  const [row] = await datastore.insert('Jobs', [{ Title: 'job-1' }]);
  const rowId = String(row!.ROWID);
  const originalInsert = datastore.insert.bind(datastore);
  let failSecondOnce = true;
  datastore.insert = async (table: string, values: Record<string, unknown>[]) => {
    if (table === 'Second_Log' && failSecondOnce) {
      failSecondOnce = false;
      throw new Error('module B fails once');
    }
    return originalInsert(table, values);
  };
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = datastore;
  const { root, load } = await materialize(g, { mode: 'live', appTimeZone: 'UTC' });
  try {
    const listener = await load('functions/events/after-commit.mjs');
    const event = recordEvent('Jobs', 'insert', { ROWID: rowId });
    await assert.rejects(listener.default!(event, { closeWithSuccess: () => undefined, closeWithFailure: () => undefined }), /module B fails once/);
    assert.equal((tables.get('First_Log') ?? []).length, 1, 'script A ran before script B failed');
    assert.equal((tables.get('Second_Log') ?? []).length, 0, 'script B did not complete');
    const marker = (tables.get('C2CEventDeadLetter') ?? [])[0]!;
    const sweeper = await load('functions/job/c2c-event-sweeper.mjs');
    const result = await sweeper.sweep!({});
    assert.equal(result.resolved, 1, 'the sweep replay resolved the failure marker');
    assert.equal(marker.State, 'resolved');
    assert.equal((tables.get('First_Log') ?? []).length, 1, 'completed script A is not repeated on replay');
    assert.equal((tables.get('Second_Log') ?? []).length, 1, 'script B ran on replay');
  } finally {
    delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    rmSync(root, { recursive: true, force: true });
  }
});

test('form event cancellation stops later scripts in the merged module', async () => {
  const a = app({ workflows: [
    workflow({ name: 'Jobs A', form: 'Jobs', event: 'on success', deluge: { text: 'cancel submit "stop";', span: Z } }),
    workflow({ name: 'Jobs B', form: 'Jobs', event: 'on success', deluge: { text: 'insert into Second_Log[Note = "B"];', span: Z } }),
  ] });
  const g = generate(a, { asyncOnSuccess: false });
  const { datastore, tables } = mockDatastore({ Jobs: ['ROWID'], Second_Log: ['ROWID'] });
  const [row] = await datastore.insert('Jobs', [{ Title: 'job-1' }]);
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = datastore;
  const { root, load } = await materialize(g, { mode: 'live', appTimeZone: 'UTC' });
  try {
    const handler = await load('functions/aio/jobs/on-success.mjs');
    await assert.rejects(handler.handle!({ shim: { validate: { cancelSubmit: () => { throw Object.assign(new Error('stop'), { code: 'SUBMIT_REFUSED' }); } } }, rowId: String(row!.ROWID) }));
    assert.equal((tables.get('Second_Log') ?? []).length, 0, 'later script did not run after cancel submit');
  } finally {
    delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    rmSync(root, { recursive: true, force: true });
  }
});

test('live without a configured datastore refuses before any write', async () => {
  const g = generate(deferrableApp(), { asyncOnSuccess: true });
  const { root, load } = await materialize(g, { mode: 'live', appTimeZone: 'UTC' });
  try {
    const closed: string[] = [];
    const listener = await load('functions/events/after-commit.mjs');
    await assert.rejects(
      listener.default!(recordEvent('Jobs', 'insert', { ROWID: '1' }), { closeWithFailure: () => closed.push('failure') }),
      /live datastore is not configured/,
    );
    assert.deepEqual(closed, ['failure']);
    const sweeper = await load('functions/job/c2c-event-sweeper.mjs');
    await assert.rejects(sweeper.default!({}), /live datastore is not configured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the sweeper resolves a replayable marker, re-arms a failing one, and discards at five attempts', async () => {
  const g = generate(deferrableApp(), { asyncOnSuccess: true });
  const { datastore, tables } = mockDatastore({ Orders: ['ROWID'], Jobs: ['ROWID'], Log: ['ROWID'] });
  const [row] = await datastore.insert('Jobs', [{ Title: 'job-1' }]);
  const rowId = String(row!.ROWID);
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = datastore;
  const { root, load } = await materialize(g, { mode: 'live', appTimeZone: 'UTC' });
  try {
    const dead = await load('functions/c2c-deadletter.mjs');
    const sweeper = await load('functions/job/c2c-event-sweeper.mjs');
    const dry = await sweeper.sweep!({});
    assert.equal(dry.dryRun, false, 'live mode with a datastore sweeps for real');
    // A marker whose envelope replays cleanly resolves on the next sweep. The
    // envelope is identity-only; the sweep reloads the committed row by id.
    await dead.recordFailure!(datastore, {
      key: `jobs/add/${rowId}/t1`,
      form: 'Jobs',
      action: 'add',
      recordId: rowId,
      error: 'first failure',
      envelope: JSON.stringify({
        v: DEAD_LETTER_ENVELOPE_VERSION,
        key: `jobs/add/${rowId}/t1`,
        form: 'Jobs',
        table: 'Jobs',
        action: 'add',
        rowId,
        eventTime: '2026-10-12T03:31:00Z',
      }),
    });
    const first = await sweeper.sweep!({});
    assert.equal(first.resolved, 1);
    assert.equal((tables.get('C2CEventDeadLetter') ?? [])[0]!.State, 'resolved');
    assert.equal((tables.get('Log') ?? []).length, 1, 'the retry ran the deferred script once');
    // A legacy envelope still embeds its record: the replay ignores it and
    // reloads by id. The row is gone, so the marker re-arms, then discards.
    await dead.recordFailure!(datastore, {
      key: 'orders/add/99999/t2',
      form: 'Orders',
      action: 'add',
      recordId: '99999',
      error: 'first failure',
      envelope: JSON.stringify({ form: 'Orders', action: 'add', record: { ROWID: '99999' }, rowId: '99999' }),
    });
    let last: { retried: number; discarded: number } = { retried: 0, discarded: 0 };
    for (let i = 0; i < 5; i++) last = await sweeper.sweep!({});
    const marker = (tables.get('C2CEventDeadLetter') ?? [])[1]!;
    assert.equal(marker.State, 'discarded');
    assert.equal(marker.Attempts, '5');
    assert.equal(last.discarded, 1);
    // A discarded marker is never retried again.
    const after = await sweeper.sweep!({});
    assert.equal(after.swept, 0);
  } finally {
    delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    rmSync(root, { recursive: true, force: true });
  }
});
