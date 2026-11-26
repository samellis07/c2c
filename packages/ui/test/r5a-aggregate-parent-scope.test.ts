/**
 * R5-A F3b: an aggregate grouped by (or measuring) a lookup field keys its buckets by the stored parent ROWID. A parent row
 * outside the caller's recordFilter must not surface its ROWID, the way a plain read blanks that cell.
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

test('an aggregate grouped by a lookup does not key buckets by a parent outside the recordFilter', async () => {
  const { files } = generateUi(app());
  const file = files.find((item) => item.path === 'functions/access-policy.json')!;
  const parsed = JSON.parse(String(file.data)) as { profiles: Record<string, unknown> };
  Object.assign(parsed.profiles, {
    Clerk: { Calls: { read: true }, People: { fields: ['Name'], recordFilter: { op: '==', field: 'Name', value: 'John' } } },
  });
  file.data = JSON.stringify(parsed);
  const dir = loadTree(files);
  const { datastore, restore } = liveDatastore();
  try {
    await datastore.insert('People', [{ Name: 'John' }, { Name: 'Jane' }]);
    const people = await datastore.query('People', 'true', 10);
    const [john, jane] = people.map((p) => String(p.ROWID));
    await datastore.insert('Calls', [
      { Subject_field: 'a', Person: john },
      { Subject_field: 'b', Person: jane },
    ]);
    const group = { op: 'aggregate', group: 'Person', measures: [{ fn: 'count', field: '' }] };
    const out = await invoke(dir, REPORT, CLERK, group);
    const keys = ((out.body.buckets as { key: string }[] | undefined) ?? []).map((g) => g.key);
    assert.ok(!keys.includes(jane!), `out-of-scope parent ROWID became a bucket key: ${JSON.stringify(out.body)}`);
    assert.ok(keys.includes(john!), `in-scope parent bucket is kept: ${JSON.stringify(out.body)}`);
    const admin = await invoke(dir, REPORT, ADMIN, group);
    const adminKeys = ((admin.body.buckets as { key: string }[] | undefined) ?? []).map((g) => g.key);
    assert.ok(adminKeys.includes(jane!), `Administrator still sees every parent: ${JSON.stringify(admin.body)}`);
  } finally {
    restore();
  }
});

test('an aggregate over more parents than one ZCQL read returns keeps every in-scope bucket', async () => {
  const { files } = generateUi(app());
  const dir = loadTree(files);
  const { datastore, restore } = liveDatastore();
  try {
    const total = 500;
    for (let at = 0; at < total; at += 100) {
      await datastore.insert('People', Array.from({ length: 100 }, (_, i) => ({ Name: 'P' + (at + i) })));
    }
    const ids: string[] = [];
    for (let at = 0; ids.length < total; at += 300) {
      const page = await datastore.query('People', 'true', 300, at);
      if (!page.length) break;
      ids.push(...page.map((p) => String(p.ROWID)));
    }
    for (let at = 0; at < ids.length; at += 100) {
      await datastore.insert('Calls', ids.slice(at, at + 100).map((id, i) => ({ Subject_field: 's' + (at + i), Person: id })));
    }
    const out = await invoke(dir, REPORT, ADMIN, { op: 'aggregate', group: 'Person', measures: [{ fn: 'count', field: '' }] });
    const keys = ((out.body.buckets as { key: string }[] | undefined) ?? []).map((g) => g.key);
    assert.equal(new Set(keys).size, total, `buckets collapsed: ${keys.length} keys, ${JSON.stringify(out.body).slice(0, 200)}`);
  } finally {
    restore();
  }
});
