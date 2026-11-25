/**
 * The store keeps a composite field (a name, an address) as one column per
 * part. A live read of a form the runtime knows the composites of carries each
 * as one value: it prints as its non-empty parts joined by spaces, and a part
 * reads through `Name.first_name`. A grant on the composite covers its parts;
 * a profile without that grant reads neither.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordAccessError, type AccessPolicy } from '../src/access.js';
import { createRuntime } from '../src/runtime.js';

const access: AccessPolicy = {
  roles: [],
  profiles: {
    Reader: { People: { fields: ['Name1', 'Email'] } },
    Mailer: { People: { fields: ['Email'] } },
  },
};

const composites = { People: { Name1: ['prefix', 'first_name', 'last_name', 'suffix'] } };

const rows = [
  { ROWID: '1', Name1_prefix: '', Name1_first_name: 'John', Name1_last_name: 'Doe', Name1_suffix: null, Email: 'john-mail' },
  { ROWID: '2', Name1_first_name: null, Name1_last_name: '', Email: 'blank-mail' },
];

function open(profile: string, withComposites = true) {
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    ...(withComposites ? { composites } : {}),
    datastore: {
      async query(_form, where) {
        return rows.filter((row) => !where.includes('ROWID') || where.includes(`'${row.ROWID}'`)).map((row) => ({ ...row }));
      },
    },
  });
  const ctx = runtime.context({ principal: { profile } });
  const one = (id: string) => runtime.shim.datastore.query(ctx, 'People', { op: '==', field: 'ID', value: id });
  return { shim: runtime.shim, ctx, one };
}

test('a composite reads as its parts joined by spaces and a part reads by its path', async () => {
  const { shim, ctx, one } = open('Reader');
  const whole = await shim.datastore.field(ctx, one('1'), 'Name1');
  assert.equal(String(whole), 'John Doe');
  assert.deepEqual({ ...(whole as Record<string, unknown>) }, { prefix: '', first_name: 'John', last_name: 'Doe', suffix: null });
  assert.equal(JSON.stringify(whole), '{"prefix":"","first_name":"John","last_name":"Doe","suffix":null}');
  assert.equal(await shim.datastore.field(ctx, one('1'), 'Name1.first_name'), 'John');
  assert.equal(await shim.datastore.field(ctx, one('1'), 'Name1.last_name'), 'Doe');
  assert.equal(await shim.datastore.field(ctx, one('1'), 'Name1.middle'), undefined);
  assert.deepEqual(await shim.datastore.column(ctx, one('1'), 'Name1.first_name'), ['John']);
});

test('a composite whose every part is blank reads as absent', async () => {
  const { shim, ctx, one } = open('Reader');
  assert.equal(await shim.datastore.field(ctx, one('2'), 'Name1'), undefined);
  assert.equal(await shim.datastore.field(ctx, one('2'), 'Name1.first_name'), undefined);
});

test('a runtime that does not know the composites reads no part, as before', async () => {
  const { shim, ctx, one } = open('Reader', false);
  assert.equal(await shim.datastore.field(ctx, one('1'), 'Name1'), undefined);
  assert.equal(await shim.datastore.field(ctx, one('1'), 'Name1.first_name'), undefined);
});

test('a profile without the composite in its grant is refused the whole and every part', async () => {
  const { shim, ctx, one } = open('Mailer');
  for (const field of ['Name1', 'Name1.first_name']) {
    await assert.rejects(
      () => shim.datastore.field(ctx, one('1'), field),
      (err: unknown) => err instanceof RecordAccessError && err.code === 'RECORD_ACCESS_DENIED',
      field,
    );
  }
  assert.equal(await shim.datastore.field(ctx, one('1'), 'Email'), 'john-mail');
});

test('a column the row already holds under the composite name is kept', async () => {
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    composites,
    datastore: { async query() { return [{ ROWID: '1', Name1: 'plain', Name1_first_name: 'John' }]; } },
  });
  const ctx = runtime.context({ principal: { profile: 'Reader' } });
  assert.equal(await runtime.shim.datastore.field(ctx, runtime.shim.datastore.query(ctx, 'People', { op: 'true' }), 'Name1'), 'plain');
});
