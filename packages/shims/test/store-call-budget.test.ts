import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { mockDatastore } from './zcql-mock.js';

const schema = { Account: { ID: 'bigint', Name: 'string', Liabilities: 'string', Balance: 'string' } } as const;

function seeded() {
  const mock = mockDatastore(schema);
  mock.tables.set('Account', [
    { ROWID: '1', ID: '7', Name: 'Cash', Liabilities: '5.00', Balance: '0.00' },
    { ROWID: '2', ID: '8', Name: 'Bank', Liabilities: '0.00', Balance: '9.00' },
  ]);
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore: mock.datastore });
  return { mock, runtime, ctx: runtime.context({}) };
}

/** `rec = Account[ID == 1]; rec.Liabilities = 0; rec.Balance = 3; rec.Name`, the way a generated script runs it. */
async function balanceScript(shared: boolean) {
  const { mock, runtime, ctx } = seeded();
  const set = () => runtime.shim.datastore.query(ctx, 'Account', { op: '==', field: 'ID', value: '1' });
  const rec = set();
  await runtime.shim.datastore.setField(ctx, shared ? rec : set(), 'Liabilities', '0.00');
  await runtime.shim.datastore.setField(ctx, shared ? rec : set(), 'Balance', '3.00');
  const name = await runtime.shim.datastore.field(ctx, shared ? rec : set(), 'Name');
  const balance = await runtime.shim.datastore.field(ctx, shared ? rec : set(), 'Balance');
  return { name, balance, rows: mock.tables.get('Account'), reads: mock.calls.length };
}

test('a record set reuses its setField rows for the next setField and an unwritten field: same values, fewer reads', async () => {
  const separate = await balanceScript(false);
  const shared = await balanceScript(true);
  assert.deepEqual({ ...shared, reads: 0 }, { ...separate, reads: 0 });
  assert.equal(shared.name, 'Cash');
  assert.equal(shared.balance, '3.00');
  // separate sets: 2 setField reads + 2 field reads; one set: 1 setField read + the re-read of the written Balance.
  assert.equal(separate.reads, 4);
  assert.equal(shared.reads, 2);
});

test('a field the set has written is read again from the store', async () => {
  const { mock, runtime, ctx } = seeded();
  const rec = runtime.shim.datastore.query(ctx, 'Account', { op: '==', field: 'ID', value: '1' });
  await runtime.shim.datastore.setField(ctx, rec, 'Balance', '4.50');
  assert.equal(await runtime.shim.datastore.field(ctx, rec, 'Balance'), '4.50');
  assert.equal(mock.calls.length, 2);
});

test('a store write after setField drops the kept rows: the next setField reads again and sees the new row', async () => {
  const { mock, runtime, ctx } = seeded();
  const rec = runtime.shim.datastore.query(ctx, 'Account', { op: '==', field: 'Name', value: 'Cash' });
  await runtime.shim.datastore.setField(ctx, rec, 'Balance', '1.00');
  await runtime.shim.datastore.insert(ctx, 'Account', { ID: 9, Name: 'Cash', Liabilities: '0.00', Balance: '0.00' });
  await runtime.shim.datastore.setField(ctx, rec, 'Liabilities', '2.00');
  assert.equal(mock.calls.length, 2, 'the insert forced a second read');
  const cash = mock.tables.get('Account')!.filter((row) => row.Name === 'Cash');
  assert.equal(cash.length, 2);
  assert.deepEqual(cash.map((row) => row.Liabilities), ['2.00', '2.00']);
});

const STAGES = [
  'SELECT ROWID, Name FROM Account ORDER BY ROWID',
  'SELECT ROWID, Liabilities, Balance FROM Account WHERE ROWID IN (:Account_ROWID) ORDER BY ROWID',
];

/** A staged report read; `narrow` returns only the driving stage's columns, as an adapter without the full projection does. */
async function stagedRead(narrow: boolean) {
  const mock = mockDatastore(schema);
  mock.tables.set('Account', [
    { ROWID: '1', ID: '7', Name: 'Cash', Liabilities: '5.00', Balance: '0.00' },
    { ROWID: '2', ID: '8', Name: 'Bank', Liabilities: '0.00', Balance: '9.00' },
  ]);
  const datastore = {
    async query(form: string, where: string, limit: number, offset?: number, orderBy?: string) {
      const rows = await mock.datastore.query(form, where, limit, offset, orderBy);
      return narrow && !where.includes('ROWID IN') ? rows.map((row) => ({ ROWID: row.ROWID, Name: row.Name })) : rows;
    },
  };
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore });
  const ctx = runtime.context({});
  const rows = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Account', { op: 'true' }, { zcql: STAGES }));
  return { rows: rows.map((row) => row.values), reads: mock.calls.length };
}

test('a later base stage whose columns the driving read already returned is not read again: same rows, fewer reads', async () => {
  const narrow = await stagedRead(true);
  const full = await stagedRead(false);
  assert.deepEqual(full.rows, narrow.rows);
  assert.equal(full.rows[0]?.Balance, '0.00');
  assert.equal(narrow.reads, 2, 'missing columns: the ROWID IN stage runs');
  assert.equal(full.reads, 1);
});

const docSchema = { Doc: { ID: 'bigint', Region: 'string', Amount: 'string', Name: 'string' } } as const;

function docs(options: { access?: NonNullable<Parameters<typeof createRuntime>[0]>['access']; stamp?: boolean } = {}) {
  const mock = mockDatastore(docSchema);
  mock.tables.set('Doc', [
    { ROWID: '1', ID: '1', Region: 'north', Amount: '5', Name: 'A-row' },
    { ROWID: '2', ID: '2', Region: 'north', Amount: '7', Name: 'B-row' },
  ]);
  let stamps = 0;
  const datastore = options.stamp
    ? {
        ...mock.datastore,
        // The store stamps Modified_Time on every update, as Catalyst does.
        async update(form: string, rows: Record<string, unknown>[]) {
          stamps += 1;
          const done = await mock.datastore.update(form, rows);
          for (const row of rows) {
            const stored = mock.tables.get(form)!.find((one) => one.ROWID === row.ROWID);
            if (stored) stored.Modified_Time = `2026-01-01 00:00:0${stamps}`;
          }
          return done;
        },
      }
    : mock.datastore;
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore, ...(options.access ? { access: options.access } : {}) });
  return { mock, runtime };
}

test('a setField that moves the row out of the record access scope: the next setField reads and scopes again and writes nothing', async () => {
  const access = { roles: [], profiles: { P: { Doc: { recordFilter: { op: '==', field: 'Region', value: 'north' }, write: true } } } } as never;
  const { mock, runtime } = docs({ access });
  const ctx = runtime.context({ principal: { profile: 'P' } } as never);
  const rec = runtime.shim.datastore.query(ctx, 'Doc', { op: '==', field: 'ID', value: '1' });
  await runtime.shim.datastore.setField(ctx, rec, 'Region', 'south');
  await runtime.shim.datastore.setField(ctx, rec, 'Amount', '0');
  const row = mock.tables.get('Doc')!.find((one) => one.ROWID === '1');
  assert.equal(row?.Region, 'south');
  assert.equal(row?.Amount, '5', 'the row left the caller\'s scope: the second write must not land');
});

test('a setField on a criteria field: the next setField and field read see the set as the store now scopes it', async () => {
  const { mock, runtime } = docs();
  const ctx = runtime.context({});
  const rec = runtime.shim.datastore.query(ctx, 'Doc', { op: '==', field: 'Region', value: 'north' });
  await runtime.shim.datastore.setField(ctx, rec, 'Region', 'south');
  await runtime.shim.datastore.setField(ctx, rec, 'Amount', '0');
  assert.equal(await runtime.shim.datastore.field(ctx, rec, 'Name'), null);
  assert.deepEqual(mock.tables.get('Doc')!.map((one) => one.Amount), ['5', '7']);
});

test('a column the store stamps on update is read again after setField', async () => {
  const { runtime } = docs({ stamp: true });
  const ctx = runtime.context({});
  const rec = runtime.shim.datastore.query(ctx, 'Doc', { op: '==', field: 'ID', value: '1' });
  await runtime.shim.datastore.setField(ctx, rec, 'Amount', '3');
  assert.equal(await runtime.shim.datastore.field(ctx, rec, 'Modified_Time'), '2026-01-01 00:00:01');
  assert.equal(await runtime.shim.datastore.field(ctx, rec, 'Amount'), '3');
});
