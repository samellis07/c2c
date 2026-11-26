/**
 * An aggregate grouped by a path that ends in a lookup field of the parent form (Notes -> Call.Person) would key its buckets by
 * the grandparent ROWID. The plain read blanks that cell for a caller who cannot read the grandparent's display, so the aggregate
 * must refuse the path for every caller rather than show the ROWID as a bucket key.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';
import { ADMIN, CLERK, invoke, liveDatastore, loadTree } from './page-endpoint.js';

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
form Notes
{
  Body
  (
    type = text
  )
  Call
  (
    type = picklist
    values = Calls.ID
    displayformat = [Subject]
  )
}
report All_Notes
{
  show all rows from Notes
  (
    Body
    Call
  )
}
	}
}
`));
  a.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } });
  return a;
}

const REPORT = 'functions/reports/all-notes.mjs';
const STAFF = { Clerk: { Notes: { read: true }, Calls: { read: true }, People: { fields: ['Email'] } } };

async function setup(policy: Record<string, unknown>) {
  const { files } = generateUi(app());
  const file = files.find((item) => item.path === 'functions/access-policy.json')!;
  const parsed = JSON.parse(String(file.data)) as { profiles: Record<string, unknown> };
  Object.assign(parsed.profiles, policy);
  file.data = JSON.stringify(parsed);
  const dir = loadTree(files);
  const { datastore, restore } = liveDatastore();
  await datastore.insert('People', [{ Name: 'John', Email: 'john-mail' }, { Name: 'Jane', Email: 'jane-mail' }]);
  const people = await datastore.query('People', 'true', 10);
  await datastore.insert('Calls', [
    { Subject_field: 'call John', Person: String(people[0]!.ROWID) },
    { Subject_field: 'call Jane', Person: String(people[1]!.ROWID) },
  ]);
  const calls = await datastore.query('Calls', 'true', 10);
  await datastore.insert('Notes', [
    { Body: 'n1', Call: String(calls[0]!.ROWID) },
    { Body: 'n2', Call: String(calls[1]!.ROWID) },
  ]);
  return { dir, restore };
}

test('an aggregate grouped by a path that ends in a lookup field is refused, so no grandparent ROWID becomes a bucket key', async () => {
  const run = await setup(STAFF);
  try {
    for (const user of [CLERK, ADMIN]) {
      const body = { op: 'aggregate', group: 'Call.Person', measures: [{ fn: 'count', field: '' }] };
      const out = await invoke(run.dir, REPORT, user as Record<string, string>, body);
      const keys = ((out.body.buckets as { key: string }[] | undefined) ?? []).map((g) => g.key);
      assert.deepEqual(keys, [], `grandparent ROWIDs became bucket keys: ${JSON.stringify(out.body)}`);
      assert.equal(out.status, 400, JSON.stringify(out.body));
    }
    // A path to a plain field of the parent form still folds.
    const plain = await invoke(run.dir, REPORT, ADMIN, { op: 'aggregate', group: 'Call.Subject', measures: [{ fn: 'count', field: '' }] });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.ok(((plain.body.buckets as unknown[]) ?? []).length >= 1, 'the plain path still produces buckets');
  } finally {
    run.restore();
  }
});
