import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { WriteRuleError, type WriteRuleColumn } from '../src/write-rules.js';

const ORDERS: readonly WriteRuleColumn[] = [
  { name: 'ID', dataType: 'BigInt' },
  { name: 'c2c_source_id', dataType: 'VarChar', length: 40 },
  { name: 'Name', dataType: 'VarChar', length: 5, required: true },
  { name: 'Amount', dataType: 'Decimal', scale: 2 },
  { name: 'When', dataType: 'Date' },
];

function live(writeRules: Record<string, readonly WriteRuleColumn[]> = { Orders: ORDERS }) {
  const calls: { op: string; form: string; rows?: Record<string, unknown>[] }[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    writeRules,
    datastore: {
      async insert(form, rows) {
        calls.push({ op: 'insert', form, rows });
        return rows;
      },
      async query(form, where) {
        calls.push({ op: 'query', form });
        return [{ ROWID: '9', ID: '9', Name: 'ok', c2c_source_id: 's9' }];
      },
      async update(form, rows) {
        calls.push({ op: 'update', form, rows });
        return { updated: rows.length };
      },
      async delete(form, rowIds) {
        calls.push({ op: 'delete', form });
        return { deleted: rowIds.length };
      },
    },
  });
  return { runtime, calls };
}

async function refused(promise: Promise<unknown>): Promise<WriteRuleError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof WriteRuleError, `expected a WriteRuleError, got ${String(thrown)}`);
  return thrown;
}

test('insert refuses an overlong text and the adapter never runs', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({});
  const err = await refused(runtime.shim.datastore.insert(ctx, 'Orders', { Name: 'toolong' }));
  assert.equal(err.code, 'INVALID_INPUT');
  assert.equal(err.field, 'Name');
  assert.equal(err.rule, 'text-length');
  assert.equal(calls.some((c) => c.op === 'insert'), false);
  assert.ok(runtime.transcript.find((e) => e.op === 'error' && e.code === 'INVALID_INPUT'));
});

test('insert without a required column refuses MANDATORY_MISSING before the write', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({});
  const err = await refused(runtime.shim.datastore.insert(ctx, 'Orders', { Amount: '2.50' }));
  assert.equal(err.code, 'MANDATORY_MISSING');
  assert.equal(err.field, 'Name');
  assert.equal(calls.some((c) => c.op === 'insert'), false);
});

test('insert normalizes a Creator date before the adapter sees it', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({});
  await runtime.shim.datastore.insert(ctx, 'Orders', { Name: 'ok', When: '05-Jan-2024' });
  const insert = calls.find((c) => c.op === 'insert');
  assert.equal(insert?.rows?.[0]?.When, '2024-01-05');
});

test('update rounds a computed decimal to the column scale but tolerates a partial row without the required column', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({});
  await runtime.shim.datastore.update(ctx, 'Orders', { op: '==', field: 'ID', value: 9 }, { Amount: '1.234' });
  const rounded = calls.find((c) => c.op === 'update');
  assert.equal(rounded?.rows?.[0]?.Amount, '1.23');
  await runtime.shim.datastore.update(ctx, 'Orders', { op: '==', field: 'ID', value: 9 }, { Amount: '1.23' });
  assert.ok(calls.some((c) => c.op === 'update'));
  const blanked = await refused(runtime.shim.datastore.update(ctx, 'Orders', { op: '==', field: 'ID', value: 9 }, { Name: '' }));
  assert.equal(blanked.code, 'MANDATORY_MISSING');
});

test('setField refuses before the row is even fetched', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({});
  const query = runtime.shim.datastore.query(ctx, 'Orders', { op: '==', field: 'ID', value: 9 });
  const err = await refused(runtime.shim.datastore.setField(ctx, query, 'Name', 'toolong'));
  assert.equal(err.field, 'Name');
  assert.equal(calls.some((c) => c.op === 'update'), false);
});

test('writeRow and insertRow share the same rules', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({});
  await runtime.shim.datastore.writeRow(ctx, 'Orders', '9', { Amount: '9.999' });
  assert.equal(calls.find((c) => c.op === 'update')?.rows?.[0]?.Amount, '10.00');
  await runtime.shim.datastore.writeRow(ctx, 'Orders', '9', { Amount: '9.99' });
  assert.ok(calls.some((c) => c.op === 'update'));
  const missing = await refused(runtime.shim.datastore.insertRow(ctx, 'Orders', { Amount: '1' }));
  assert.equal(missing.code, 'MANDATORY_MISSING');
  await runtime.shim.datastore.insertRow(ctx, 'Orders', { ID: '1', Name: 'n' });
  assert.ok(calls.filter((c) => c.op === 'insert').length >= 1);
});

test('a form without rules keeps writing unchecked', async () => {
  const { runtime, calls } = live({ Other: ORDERS });
  const ctx = runtime.context({});
  await runtime.shim.datastore.insert(ctx, 'Orders', { Name: 'x'.repeat(100) });
  assert.ok(calls.some((c) => c.op === 'insert'));
});

const FORGED = '1999-01-01T00:00:00';

/** Keys a caller may add that the store itself must own. `c2c_source_id` is not in this list on insert: a split-write retry reconciles on it. */
const PLATFORM_KEYS = ['CREATORID', 'creatorid', 'ROWID', 'rowid'];

function forgedSystem(): Record<string, unknown> {
  return {
    Added_Time: FORGED,
    added_time: FORGED,
    Added_User: 'mallory',
    added_user: 'mallory',
    CREATEDTIME: FORGED,
    Modified_Time: FORGED,
    Modified_User: 'mallory',
    modified_time: FORGED,
    CREATORID: '4',
    creatorid: '5',
    ROWID: '777',
    rowid: '888',
    c2c_source_id: 'src',
  };
}

test('insert ignores caller system columns and stores the server stamp', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({ principal: { profile: 'Administrator', loginUser: 'app.owner' } });
  await runtime.shim.datastore.insert(ctx, 'Orders', { ID: '1', Name: 'ok', ...forgedSystem() });
  const row = calls.find((c) => c.op === 'insert')?.rows?.[0] ?? {};
  assert.equal(row.Name, 'ok');
  assert.equal(row.Added_User, 'app.owner');
  assert.equal(typeof row.Added_Time, 'string');
  assert.notEqual(row.Added_Time, FORGED);
  // A split-write retry reconciles the base row on this id, so an insert keeps it.
  assert.equal(row.c2c_source_id, 'src');
  for (const key of ['added_time', 'added_user', 'CREATEDTIME', 'Modified_Time', 'Modified_User', 'modified_time', ...PLATFORM_KEYS]) {
    assert.equal(row[key], undefined, `caller ${key} persisted`);
  }
});

test('writeRow ignores caller system columns and stores the server stamp', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({ principal: { profile: 'Administrator', loginUser: 'app.owner' } });
  await runtime.shim.datastore.writeRow(ctx, 'Orders', '9', { Amount: '1.00', ...forgedSystem() });
  const row = calls.find((c) => c.op === 'update')?.rows?.[0] ?? {};
  assert.equal(row.ROWID, '9');
  assert.equal(row.Modified_User, 'app.owner');
  assert.equal(typeof row.Modified_Time, 'string');
  assert.notEqual(row.Modified_Time, FORGED);
  for (const key of ['Added_Time', 'added_time', 'Added_User', 'added_user', 'CREATEDTIME', 'modified_time', 'creatorid', 'rowid', 'c2c_source_id']) {
    assert.equal(row[key], undefined, `caller ${key} persisted`);
  }
});

test('insertRow drops caller system columns the same way', async () => {
  const { runtime, calls } = live();
  const ctx = runtime.context({ principal: { profile: 'Administrator', loginUser: 'app.owner' } });
  await runtime.shim.datastore.insertRow(ctx, 'Orders', { ID: '1', Name: 'ok', ...forgedSystem() });
  const row = calls.find((c) => c.op === 'insert')?.rows?.[0] ?? {};
  assert.equal(row.Added_User, 'app.owner');
  assert.equal(row.c2c_source_id, 'src');
  for (const key of ['Modified_Time', 'Modified_User', ...PLATFORM_KEYS]) {
    assert.equal(row[key], undefined, `caller ${key} persisted`);
  }
});
