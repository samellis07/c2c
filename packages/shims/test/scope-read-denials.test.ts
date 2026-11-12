/**
 * Read entry points check the caller's profile before any datastore read.
 * A profile with no grant on the form is refused. A profile with a grant
 * performs one read.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordAccessError, type AccessPolicy } from '../src/access.js';
import { createRuntime } from '../src/runtime.js';

const access: AccessPolicy = {
  roles: [],
  profiles: {
    Clerk: { Notes: { fields: ['Body'] } },
    Reader: { Orders: { fields: ['Status'] } },
  },
};

const criteria = { op: '==' as const, field: 'Status', value: 'Open' };

function open(profile: string) {
  let reads = 0;
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    datastore: {
      async query() {
        reads += 1;
        return [{ ROWID: '1', Status: 'Open', Secret: 'hidden' }];
      },
    },
  });
  const ctx = runtime.context({ principal: { profile } });
  const spec = runtime.shim.datastore.query(ctx, 'Orders', criteria);
  return { runtime, shim: runtime.shim, ctx, spec, reads: () => reads };
}

function deniedShape(err: unknown): boolean {
  assert.ok(err instanceof RecordAccessError);
  assert.equal(err.code, 'RECORD_ACCESS_DENIED');
  assert.equal(err.name, 'RecordAccessError');
  assert.equal(err.message, 'record access: profile Clerk cannot read Orders');
  return true;
}

function assertUntouched(runtime: ReturnType<typeof createRuntime>, reads: () => number): void {
  assert.equal(reads(), 0);
  assert.equal(
    runtime.transcript.some((entry) => entry.op === 'error' && entry.code === 'RECORD_ACCESS_DENIED' && entry.form === 'Orders'),
    true,
  );
  assert.equal(
    runtime.transcript.some((entry) => entry.op === 'fetch' || entry.op === 'aggregate' || entry.op === 'column' || entry.op === 'field'),
    false,
  );
}

test('query: a profile with no read grant on the form is denied before any datastore read', async () => {
  const h = open('Clerk');
  assert.equal(h.reads(), 0);
  assert.equal(h.spec.form, 'Orders');
  await assert.rejects(() => h.shim.datastore.rows(h.ctx, h.spec), deniedShape);
  assertUntouched(h.runtime, h.reads);
});

test('aggregate: a profile with no read grant on the form is denied before any datastore read', async () => {
  const h = open('Clerk');
  await assert.rejects(() => h.shim.datastore.aggregate(h.ctx, h.spec, 'count'), deniedShape);
  assertUntouched(h.runtime, h.reads);
});

test('field: a profile with no read grant on the form is denied before any datastore read', async () => {
  const h = open('Clerk');
  await assert.rejects(() => h.shim.datastore.field(h.ctx, h.spec, 'Status'), deniedShape);
  assertUntouched(h.runtime, h.reads);
});

test('column: a profile with no read grant on the form is denied before any datastore read', async () => {
  const h = open('Clerk');
  await assert.rejects(() => h.shim.datastore.column(h.ctx, h.spec, 'Status'), deniedShape);
  assertUntouched(h.runtime, h.reads);
});

test('rows: a profile with no read grant on the form is denied before any datastore read', async () => {
  const h = open('Clerk');
  const spec = h.shim.datastore.query(h.ctx, 'Orders', { op: 'true' });
  await assert.rejects(() => h.shim.datastore.rows(h.ctx, spec), deniedShape);
  assertUntouched(h.runtime, h.reads);
});

test('a profile with a read grant on the form performs one datastore read', async () => {
  const query = open('Reader');
  const queried = await query.shim.datastore.rows(query.ctx, query.spec);
  assert.equal(queried.length, 1);
  assert.equal(queried[0]?.values.Status, 'Open');
  assert.equal(Object.hasOwn(queried[0]?.values ?? {}, 'Secret'), false);
  assert.equal(query.reads(), 1);

  const aggregate = open('Reader');
  assert.equal(await aggregate.shim.datastore.aggregate(aggregate.ctx, aggregate.spec, 'count'), 1);
  assert.equal(aggregate.reads(), 1);

  const field = open('Reader');
  assert.equal(await field.shim.datastore.field(field.ctx, field.spec, 'Status'), 'Open');
  assert.equal(field.reads(), 1);

  const column = open('Reader');
  assert.deepEqual(await column.shim.datastore.column(column.ctx, column.spec, 'Status'), ['Open']);
  assert.equal(column.reads(), 1);

  const rows = open('Reader');
  const got = await rows.shim.datastore.rows(rows.ctx, rows.spec);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.values.Status, 'Open');
  assert.equal(rows.reads(), 1);
});
