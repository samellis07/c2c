/**
 * R5-A adversarial probe: a caller whose profile reads only some fields of a
 * lookup parent must not be able to learn a hidden parent field through a
 * report read (body.filters on a Parent.Field path, body.q, aggregate group).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';
import { ADMIN, CLERK, invoke, liveDatastore, loadTree, type Reply } from './page-endpoint.js';

function app() {
  const a = deriveIr(parse(`application "Demo"
{
	section Front
	{
form People
{
  Name
  (
    type = text
  )
  Salary
  (
    type = text
  )
  Email
  (
    type = email
  )
}
form Calls
{
  Subject
  (
    type = text
  )
  Person
  (
    type = picklist
    values = People.ID
    displayformat = [Name]
  )
}
report All_Calls
{
  show all rows from Calls
  (
    Subject
    Person
  )
}
	}
}
`));
  a.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } });
  return a;
}
const REPORT = 'functions/reports/all-calls.mjs';
const subjects = (r: Reply) => ((r.body.rows as { Subject_field?: string }[] | undefined) ?? []).map((x) => x.Subject_field);

async function setup(policy: Record<string, unknown>) {
  const { files } = generateUi(app());
  const file = files.find((item) => item.path === 'functions/access-policy.json')!;
  const parsed = JSON.parse(String(file.data)) as { profiles: Record<string, unknown> };
  Object.assign(parsed.profiles, policy);
  file.data = JSON.stringify(parsed);
  const dir = loadTree(files);
  const { datastore, restore } = liveDatastore();
  await datastore.insert('People', [
    { Name: 'John', Salary: '100', Email: 'john-mail' },
    { Name: 'Jane', Salary: '900', Email: 'jane-mail' },
  ]);
  const people = await datastore.query('People', 'true', 10);
  await datastore.insert('Calls', [
    { Subject_field: 'call John', Person: String(people[0]!.ROWID) },
    { Subject_field: 'call Jane', Person: String(people[1]!.ROWID) },
  ]);
  return { dir, restore, ids: people.map((p) => String(p.ROWID)) };
}

const STAFF = { Clerk: { Calls: { read: true }, People: { fields: ['Email'] } } };

test('probe: Staff filter on a hidden parent field (Person.Salary / Person.Name) leaks nothing; Admin can', async () => {
  const run = await setup(STAFF);
  try {
    const out: Record<string, unknown> = {};
    for (const [label, user, body] of [
      ['admin Person.Salary==100', ADMIN, { op: 'query', filters: [{ field: 'Person.Salary', op: '==', value: '100' }] }],
      ['staff Person.Salary==100', CLERK, { op: 'query', filters: [{ field: 'Person.Salary', op: '==', value: '100' }] }],
      ['staff Person.Salary!=100', CLERK, { op: 'query', filters: [{ field: 'Person.Salary', op: '!=', value: '100' }] }],
      ['staff Person.Salary>=500', CLERK, { op: 'query', filters: [{ field: 'Person.Salary', op: '>=', value: '500' }] }],
      ['staff Person.Name==John', CLERK, { op: 'query', filters: [{ field: 'Person.Name', op: '==', value: 'John' }] }],
      ['staff Person.Email==john-mail (granted)', CLERK, { op: 'query', filters: [{ field: 'Person.Email', op: '==', value: 'john-mail' }] }],
      ['staff Person:display John', CLERK, { op: 'query', filters: [{ field: 'Person', op: 'display', value: 'John' }] }],
      ['staff q=John', CLERK, { op: 'query', q: 'John' }],
      ['staff body.filter obj Person.Salary', CLERK, { op: 'query', filter: { field: 'Person.Salary', op: '==', value: '100' } }],
      ['staff Person.__proto__', CLERK, { op: 'query', filters: [{ field: 'Person.__proto__', op: '==', value: 'x' }] }],
      ['staff Person.Salary contains (op)', CLERK, { op: 'query', filters: [{ field: 'Person.Salary', op: 'contains', value: '1' }] }],
      ['staff aggregate group Person.Salary', CLERK, { op: 'aggregate', group: 'Person.Salary', measures: [{ fn: 'count', field: '' }] }],
      ['staff aggregate group Person', CLERK, { op: 'aggregate', group: 'Person', measures: [{ fn: 'count', field: '' }] }],
      ['staff sort Salary', CLERK, { op: 'query', sort: [{ field: 'Person.Salary', order: 'desc' }] }],
    ] as const) {
      const r = await invoke(run.dir, REPORT, user as Record<string, string>, body);
      out[label] = { status: r.status, subjects: subjects(r), rows: (r.body.rows as unknown[] | undefined)?.length, groups: r.body.groups ?? r.body.buckets, err: r.body.error };
    }
    const plain = await invoke(run.dir, REPORT, CLERK, { op: 'query' });
    out['staff plain rows'] = plain.body.rows;
    const none = await setup({ Clerk: { Calls: { read: true } } });
    try {
      const r = await invoke(none.dir, REPORT, CLERK, { op: 'query' });
      out['staff no People grant rows'] = r.body.rows;
      const g = await invoke(none.dir, REPORT, CLERK, { op: 'aggregate', group: 'Person', measures: [{ fn: 'count', field: '' }] });
      out['staff no People grant aggregate'] = { status: g.status, groups: g.body.groups };
    } finally { none.restore(); }
    console.log(JSON.stringify(out, null, 1));
  } finally {
    run.restore();
  }
});

test('R5A-F3: an aggregate grouped by a lookup whose display the caller cannot read returns no parent ROWID bucket keys', async () => {
  const run = await setup(STAFF);
  try {
    const body = { op: 'aggregate', group: 'Person', measures: [{ fn: 'count', field: '' }] };
    const clerk = await invoke(run.dir, REPORT, CLERK, body);
    const leaked = ((clerk.body.buckets as { key: string }[] | undefined) ?? []).map((g) => g.key);
    assert.deepEqual(leaked, [], `parent ROWIDs reached a caller who reads no People display: ${JSON.stringify(clerk.body)}`);
    assert.equal(clerk.status, 400);
    const admin = await invoke(run.dir, REPORT, ADMIN, body);
    assert.equal(admin.status, 200);
    assert.equal(((admin.body.buckets as unknown[]) ?? []).length, 2, `Administrator keeps the fold: ${JSON.stringify(admin.body)}`);
  } finally {
    run.restore();
  }
});
