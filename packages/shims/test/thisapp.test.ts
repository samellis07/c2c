import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DelugeRuntimeError } from '../src/errors.js';
import { createRuntime, LIMITS, type ThisappFunction } from '../src/runtime.js';

const zone = { settingsTimeZone: 'Asia/Kolkata' };

function live(functions: Readonly<Record<string, ThisappFunction>>, extra = {}) {
  const runtime = createRuntime({ dryRun: false, ...zone, functions, ...extra });
  return { runtime, ctx: runtime.context({ record: {}, old: {} }) };
}

function dry(functions: Readonly<Record<string, ThisappFunction>>) {
  const runtime = createRuntime({ dryRun: true, ...zone, functions });
  return { runtime, ctx: runtime.context({ record: {}, old: {} }) };
}

test('thisapp.call dispatches a registered function with its arguments', async () => {
  const { ctx } = live({
    'Math.add': { call: async (_ctx, a, b) => Number(a) + Number(b), params: ['a', 'b'] },
  });
  assert.equal(await ctx.shim.thisapp.call(ctx, ['Math', 'add'], [2, 3]), 5);
});

test('thisapp.call binds declared params so input.<param> resolves inside the callee', async () => {
  const { ctx } = live({
    'Helpers.twice': {
      call: async (c) => Number(c.shim.input.get(c, 'num')) * 2,
      params: ['num'],
    },
  });
  assert.equal(await ctx.shim.thisapp.call(ctx, ['Helpers', 'twice'], [21]), 42);
});

test('thisapp.call resolves function names case-insensitively', async () => {
  const { ctx } = live({ 'Helpers.Ping': { call: async () => 'pong' } });
  assert.equal(await ctx.shim.thisapp.call(ctx, ['helpers', 'PING'], []), 'pong');
});

test('thisapp.call unwraps a form-typed RowMeta param; callee mutations reach the row', async () => {
  const meta = { __row: true, form: 'Request', values: { Status: 'Open' } };
  const { ctx } = live({
    'Actions.close': {
      call: async (c, rec) => {
        assert.deepEqual(rec, { Status: 'Open' });
        (rec as Record<string, unknown>).Status = 'Closed';
        // The declared param is bound in record for input.<param> reads.
        assert.equal(c.shim.input.get(c, 'rec'), (c.record as Record<string, unknown>).rec);
        return 'done';
      },
      params: ['rec'],
      recordParams: { rec: 'Request' },
    },
  });
  assert.equal(await ctx.shim.thisapp.call(ctx, ['Actions', 'close'], [meta]), 'done');
  assert.equal(meta.values.Status, 'Closed');
});

test('thisapp.call passes collection arguments by reference', async () => {
  const mylist: unknown[] = [];
  const { ctx } = live({
    'ListGen.push': {
      call: async (_c, n, list) => {
        (list as unknown[]).push(n);
        return list;
      },
      params: ['n', 'list'],
    },
  });
  const result = await ctx.shim.thisapp.call(ctx, ['ListGen', 'push'], [7, mylist]);
  assert.equal(result, mylist);
  assert.deepEqual(mylist, [7]);
});

test('thisapp.call binds ctx.row for for-each-record functions', async () => {
  const meta = { __row: true, form: 'Log', rowId: '1', values: { Note: 'x' } };
  const { ctx } = live({
    'OnLog': {
      call: async (c) => c.shim.record.get(c.row, 'Note'),
      rowForm: 'Log',
    },
  });
  assert.equal(await ctx.shim.thisapp.call(ctx, ['OnLog'], [meta]), 'x');
});

test('input.<field> in a for-each-record function writes the clicked record only where the profile has the field grant', async () => {
  const access = { roles: [], profiles: { Clerk: { Log: { write: true, fields: ['Note', 'Secret'], writable: ['Note'] } } } };
  const meta = { __row: true as const, form: 'Log', rowId: '1', values: { Note: 'x', Secret: 's' } };
  const functions = {
    OnLog: {
      call: async (c: { shim: { input: { set(c: unknown, path: string[], value: unknown): unknown } } }) => {
        c.shim.input.set(c, ['Note'], 'changed');
        return meta.values.Note;
      },
      rowForm: 'Log',
    },
    OnSecret: {
      call: async (c: { shim: { input: { set(c: unknown, path: string[], value: unknown): unknown } } }) => c.shim.input.set(c, ['Secret'], 'stolen'),
      rowForm: 'Log',
    },
  };
  const runtime = createRuntime({ dryRun: false, ...zone, functions: functions as never, access } as never);
  const ctx = runtime.context({ record: {}, old: {}, principal: { profile: 'Clerk' } });
  assert.equal(await ctx.shim.thisapp.call(ctx, ['OnLog'], [meta]), 'changed');
  await assert.rejects(() => ctx.shim.thisapp.call(ctx, ['OnSecret'], [meta]), /cannot write Log\.Secret/);
  assert.equal(meta.values.Secret, 's', 'an ungranted field is never written');
  assert.equal(
    runtime.transcript.some((entry) => entry.op === 'error' && entry.code === 'RECORD_ACCESS_DENIED' && entry.form === 'Log' && entry.field === 'Secret'),
    true,
  );
});

test('thisapp.call refuses a record of another form for a for-each-record function', async () => {
  const other = { __row: true, form: 'Payroll', rowId: '9', values: { Amount: '1' } };
  const { ctx } = live({ OnLog: { call: async (c) => c.shim.record.get(c.row, 'Amount'), rowForm: 'Log' } });
  await assert.rejects(() => ctx.shim.thisapp.call(ctx, ['OnLog'], [other]), /is a Payroll record but the function runs on Log/);
});

test('thisapp.call records a transcript entry in live mode', async () => {
  const { runtime, ctx } = live({ 'F.g': { call: async () => 1 } });
  await ctx.shim.thisapp.call(ctx, ['F', 'g'], []);
  const entry = runtime.transcript.at(-1) as Record<string, unknown>;
  assert.equal(entry.op, 'thisapp');
  assert.equal(entry.performed, true);
  assert.equal(entry.dryRun, false);
  assert.equal(entry.depth, 0);
});

test('thisapp.call with a registry in dry-run records but does not invoke', async () => {
  let invoked = false;
  const { runtime, ctx } = dry({
    'F.g': { call: async () => { invoked = true; return 1; } },
  });
  const result = await ctx.shim.thisapp.call(ctx, ['F', 'g'], ['x']);
  assert.equal(invoked, false);
  assert.equal((result as Record<string, unknown>).dryRun, true);
  assert.deepEqual((result as Record<string, unknown>).path, ['F', 'g']);
  assert.equal((runtime.transcript.at(-1) as Record<string, unknown>).performed, false);
});

test('thisapp.call without a registry keeps the legacy placeholder in both modes', async () => {
  for (const dryRun of [true, false]) {
    const runtime = createRuntime({ dryRun, ...zone });
    const ctx = runtime.context({ record: {}, old: {} });
    const result = await ctx.shim.thisapp.call(ctx, ['F', 'g'], []);
    assert.deepEqual(result, { dryRun: true, path: ['F', 'g'] });
    assert.equal((runtime.transcript.at(-1) as Record<string, unknown>).performed, false);
  }
});

test('thisapp.call with a registry refuses an unknown function name', async () => {
  const { ctx } = live({ 'F.g': { call: async () => 1 } });
  await assert.rejects(
    ctx.shim.thisapp.call(ctx, ['F', 'missing'], []),
    (err: unknown) => err instanceof DelugeRuntimeError && /no such function/.test((err as Error).message),
  );
});

test('thisapp.call recursion reaches the depth cap instead of running away', async () => {
  const { runtime, ctx } = live({
    'F.rec': {
      call: async (c) => c.shim.thisapp.call(c, ['F', 'rec'], []),
    },
  });
  await assert.rejects(
    ctx.shim.thisapp.call(ctx, ['F', 'rec'], []),
    (err: unknown) => err instanceof DelugeRuntimeError && /maximum call depth 75/.test((err as Error).message),
  );
  const entries = runtime.transcript.filter((e) => (e as { op?: string }).op === 'thisapp');
  assert.equal(entries.filter((e) => (e as { performed?: boolean }).performed === true).length, LIMITS.thisappMaxDepth);
  const last = entries.at(-1) as Record<string, unknown>;
  assert.equal(last.performed, false);
  assert.match(String(last.error), /maximum call depth/);
  // Depth is tracked on the child context, not the caller's.
  assert.equal((ctx as { __thisappDepth?: number }).__thisappDepth, undefined);
});

test('thisappMaxDepth option overrides the default cap', async () => {
  const { ctx } = live(
    { 'F.rec': { call: async (c) => c.shim.thisapp.call(c, ['F', 'rec'], []) } },
    { thisappMaxDepth: 4 },
  );
  await assert.rejects(
    ctx.shim.thisapp.call(ctx, ['F', 'rec'], []),
    /maximum call depth 4/,
  );
});

test('thisapp.call bounded recursion returns the nested result', async () => {
  const { ctx } = live({
    'F.count': {
      call: async (c, n) =>
        Number(n) <= 0 ? 0 : 1 + Number(await c.shim.thisapp.call(c, ['F', 'count'], [Number(n) - 1])),
      params: ['n'],
    },
  });
  assert.equal(await ctx.shim.thisapp.call(ctx, ['F', 'count'], [5]), 5);
});

test('thisapp.permissions.* is a recorded manual step, not a failure of the script that calls it', async () => {
  const { runtime, ctx } = live({ 'F.g': { call: async () => 1 } });
  // The call answers null and the script carries on: a throw here would abort an
  // on-success script after the row is saved and answer every submit with a warning.
  assert.equal(await ctx.shim.thisapp.call(ctx, ['permissions', 'assignUserInProfile'], ['user@example.test', 'Employee']), null);
  const entry = runtime.transcript.find((e) => e.op === 'thisapp') as unknown as Record<string, unknown>;
  assert.equal(entry.performed, false);
  assert.match(String(entry.manualStep), /Creator built-in not run by c2c/);
  assert.match(String(entry.manualStep), /Catalyst Authentication/);
  // An app function that happens to be called "permissions" with one segment is still a missing function.
  await assert.rejects(
    ctx.shim.thisapp.call(ctx, ['permissions'], []),
    (err: unknown) => err instanceof DelugeRuntimeError && /no such function/.test((err as Error).message),
  );
});
