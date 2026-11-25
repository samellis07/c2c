/**
 * A live read whose criteria compares a field of a linked record
 * (`Submitted_By.Email == x`) is answered from the linked rows the caller may
 * read, and a render can read the linked record's fields through the lookup.
 * The lookup and its linked form are named to the runtime; a path it was not
 * told about stays as written.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordAccessError, type AccessPolicy } from '../src/access.js';
import { createRuntime, type RuntimeOptions } from '../src/runtime.js';
import { mockDatastore } from './zcql-mock.js';

const access: AccessPolicy = {
  roles: [],
  profiles: {
    Reader: { Logs: {}, People: {}, Jobs: {} },
    Blind: { Logs: {} },
    Narrow: { Logs: {}, People: { fields: ['Email'] }, Jobs: {} },
  },
};

const lookupForms = { Logs: { Person: 'People' }, Jobs: { Assignees: 'People' } };

async function store(extra: Partial<RuntimeOptions> = {}, profile = 'Reader') {
  const { datastore } = mockDatastore({});
  await datastore.insert('People', [
    { Email: 'ann-mail', Name_first_name: 'Ann', Name_last_name: 'Lee' },
    { Email: 'bob-mail', Name_first_name: 'Bob', Name_last_name: 'Ray' },
    { Email: 'ann-mail', Name_first_name: 'Anna', Name_last_name: 'Lee' },
  ]);
  const [ann, bob, anna] = (await datastore.query('People', 'true', 10)).map((row) => String(row.ROWID));
  await datastore.insert('Logs', [
    { Note: 'by ann', Person: ann },
    { Note: 'by bob', Person: bob },
    { Note: 'by anna', Person: anna },
    { Note: 'nobody', Person: null },
  ]);
  await datastore.insert('Jobs', [{ Title: 'one' }, { Title: 'two' }, { Title: 'three' }]);
  const [one, two, three] = (await datastore.query('Jobs', 'true', 10)).map((row) => String(row.ROWID));
  await datastore.insert('Jobs__Assignees', [
    { parent_id: one, Assignees: ann, row_order: '0' },
    { parent_id: two, Assignees: bob, row_order: '0' },
    { parent_id: three, Assignees: bob, row_order: '0' },
    { parent_id: three, Assignees: anna, row_order: '1' },
  ]);
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    datastore,
    lookupForms,
    multiLookups: { Jobs: { Assignees: { table: 'Jobs__Assignees', parentColumn: 'parent_id', valueColumn: 'Assignees', orderColumn: 'row_order' } } },
    composites: { People: { Name: ['first_name', 'last_name'] } },
    ...extra,
  });
  const ctx = runtime.context({ principal: { profile } });
  const column = (form: string, criteria: unknown, field: string) => runtime.shim.datastore.column(ctx, runtime.shim.datastore.query(ctx, form, criteria as never), field);
  return { runtime, ctx, column, ids: { ann: ann!, bob: bob!, anna: anna! } };
}

test('a single lookup path keeps the records linked to a row that matches', async () => {
  const { column } = await store();
  assert.deepEqual((await column('Logs', { op: '==', field: 'Person.Email', value: 'ann-mail' }, 'Note')).sort(), ['by ann', 'by anna']);
  assert.deepEqual(await column('Logs', { op: '==', field: 'Person.Email', value: 'nobody-mail' }, 'Note'), [], 'an empty match is no match, not the unlinked records');
});

test('a not-equal path drops the records linked to a matching row', async () => {
  const { column } = await store();
  assert.deepEqual((await column('Logs', { op: '!=', field: 'Person.Email', value: 'ann-mail' }, 'Note')).sort(), ['by bob']);
});

test('a path inside and or keeps the other conditions', async () => {
  const { column } = await store();
  const both = { op: 'and', args: [{ op: '==', field: 'Person.Email', value: 'ann-mail' }, { op: '==', field: 'Note', value: 'by anna' }] };
  assert.deepEqual(await column('Logs', both, 'Note'), ['by anna']);
  const either = { op: 'or', args: [{ op: '==', field: 'Person.Email', value: 'bob-mail' }, { op: '==', field: 'Note', value: 'nobody' }] };
  assert.deepEqual((await column('Logs', either, 'Note')).sort(), ['by bob', 'nobody']);
});

test('a multi lookup path matches the records any of whose links matches', async () => {
  const { column } = await store();
  assert.deepEqual((await column('Jobs', { op: '==', field: 'Assignees.Email', value: 'bob-mail' }, 'Title')).sort(), ['three', 'two']);
  assert.deepEqual((await column('Jobs', { op: '==', field: 'Assignees.Email', value: 'ann-mail' }, 'Title')).sort(), ['one', 'three']);
  assert.deepEqual(await column('Jobs', { op: '!=', field: 'Assignees.Email', value: 'bob-mail' }, 'Title'), ['one']);
});

test('a part of a linked composite reads through its stored column', async () => {
  const { column } = await store();
  assert.deepEqual(await column('Logs', { op: '==', field: 'Person.Name.first_name', value: 'Bob' }, 'Note'), ['by bob']);
});

test('the linked rows are read under the caller\'s grant', async () => {
  const blind = await store({}, 'Blind');
  await assert.rejects(
    () => blind.column('Logs', { op: '==', field: 'Person.Email', value: 'ann-mail' }, 'Note'),
    (err: unknown) => err instanceof RecordAccessError && err.code === 'RECORD_ACCESS_DENIED',
  );
  const narrow = await store({}, 'Narrow');
  assert.deepEqual((await narrow.column('Logs', { op: '==', field: 'Person.Email', value: 'bob-mail' }, 'Note')), ['by bob']);
  await assert.rejects(
    () => narrow.column('Logs', { op: '==', field: 'Person.Name.first_name', value: 'Bob' }, 'Note'),
    (err: unknown) => err instanceof RecordAccessError,
    'a field outside the grant never matches',
  );
});

test('a path the runtime was not told about stays as written', async () => {
  const unknown = await store({ lookupForms: { Logs: {} } });
  await assert.rejects(() => unknown.column('Logs', { op: '==', field: 'Person.Email', value: 'ann-mail' }, 'Note'));
});

test('a path that matches more linked rows than one read answers is refused', async () => {
  const many = Array.from({ length: 1001 }, (_, index) => ({ Email: 'crowd-mail', Name_first_name: `n${index}` }));
  const { datastore } = mockDatastore({});
  await datastore.insert('People', many);
  await datastore.insert('Logs', [{ Note: 'x', Person: '1' }]);
  const crowded = createRuntime({ dryRun: false, appTimeZone: 'UTC', access, datastore, lookupForms });
  const crowdCtx = crowded.context({ principal: { profile: 'Reader' } });
  await assert.rejects(
    () => crowded.shim.datastore.column(crowdCtx, crowded.shim.datastore.query(crowdCtx, 'Logs', { op: '==', field: 'Person.Email', value: 'crowd-mail' }), 'Note'),
    /more than 1000 People records/,
  );
});

test('a lookup read through carries the linked record\'s readable fields, and an id stays an id without the grant', async () => {
  const reads = { Logs: { Person: ['Email', 'Name.first_name'] } };
  const { runtime, ctx, ids } = await store({ lookupReads: reads });
  const rows = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Logs', { op: '==', field: 'Note', value: 'by bob' }));
  const row = rows[0]!;
  const person = runtime.shim.record.get(row, 'Person') as Record<string, unknown>;
  assert.equal(runtime.shim.record.get(row, 'Person', 'Email'), 'bob-mail');
  assert.equal(person.id, ids.bob);
  assert.equal(String(person), ids.bob, 'printed on its own it is its id, as before');
  const blind = await store({ lookupReads: reads }, 'Blind');
  const blindRows = await blind.runtime.shim.datastore.rows(blind.ctx, blind.runtime.shim.datastore.query(blind.ctx, 'Logs', { op: '==', field: 'Note', value: 'by bob' }));
  assert.equal(blind.runtime.shim.record.get(blindRows[0]!, 'Person'), blind.ids.bob);
  assert.equal(blind.runtime.shim.record.get(blindRows[0]!, 'Person', 'Email') ?? null, null);
  const narrow = await store({ lookupReads: { Logs: { Person: ['Email', 'Name'] } } }, 'Narrow');
  const narrowRows = await narrow.runtime.shim.datastore.rows(narrow.ctx, narrow.runtime.shim.datastore.query(narrow.ctx, 'Logs', { op: '==', field: 'Note', value: 'by bob' }));
  assert.equal(narrow.runtime.shim.record.get(narrowRows[0]!, 'Person', 'Email'), 'bob-mail');
  assert.equal(narrow.runtime.shim.record.get(narrowRows[0]!, 'Person', 'Name') ?? null, null, 'a field outside the grant stays unread');
});
