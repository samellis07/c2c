/**
 * A report whose rows reference more distinct parents than one ZCQL read returns still resolves every in-scope display;
 * a parent outside the caller's recordFilter stays blank.
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
const TOTAL = 500;

async function seed(datastore: ReturnType<typeof liveDatastore>['datastore']): Promise<string[]> {
  for (let at = 0; at < TOTAL; at += 100) {
    await datastore.insert('People', Array.from({ length: 100 }, (_, i) => ({ Name: 'P' + (at + i) })));
  }
  const ids: string[] = [];
  for (let at = 0; ids.length < TOTAL; at += 300) {
    const page = await datastore.query('People', 'true', 300, at);
    if (!page.length) break;
    ids.push(...page.map((p) => String(p.ROWID)));
  }
  for (let at = 0; at < ids.length; at += 100) {
    await datastore.insert('Calls', ids.slice(at, at + 100).map((id, i) => ({ Subject: 's' + (at + i), Person: id })));
  }
  return ids;
}

// Counting the Person measure counts the cells whose display resolved: a blank display is not counted.
const COUNT = { op: 'aggregate', group: 'Subject', measures: [{ fn: 'count', field: 'Person' }] };

function resolved(body: Record<string, unknown>): number {
  const buckets = (body.buckets as { values: number[] }[] | undefined) ?? [];
  return buckets.reduce((sum, b) => sum + (b.values[0] ?? 0), 0);
}

test('every display beyond one ZCQL read resolves', async () => {
  const { files } = generateUi(app());
  const dir = loadTree(files);
  const { datastore, restore } = liveDatastore();
  try {
    await seed(datastore);
    const out = await invoke(dir, REPORT, ADMIN, COUNT);
    assert.equal(resolved(out.body), TOTAL, `resolved displays: ${JSON.stringify(out.body).slice(0, 300)}`);
  } finally {
    restore();
  }
});

test('parents outside the recordFilter stay blank across chunks', async () => {
  const { files } = generateUi(app());
  const file = files.find((item) => item.path === 'functions/access-policy.json')!;
  const parsed = JSON.parse(String(file.data)) as { profiles: Record<string, unknown> };
  Object.assign(parsed.profiles, {
    Clerk: { Calls: { read: true }, People: { fields: ['Name'], recordFilter: { op: 'contains', field: 'Name', value: '7' } } },
  });
  file.data = JSON.stringify(parsed);
  const dir = loadTree(files);
  const { datastore, restore } = liveDatastore();
  try {
    await seed(datastore);
    const admin = await invoke(dir, REPORT, ADMIN, COUNT);
    const clerk = await invoke(dir, REPORT, CLERK, COUNT);
    const expected = Array.from({ length: TOTAL }, (_, i) => 'P' + i).filter((n) => n.includes('7')).length;
    assert.equal(resolved(admin.body), TOTAL);
    assert.equal(resolved(clerk.body), expected, `clerk: ${JSON.stringify(clerk.body).slice(0, 300)}`);
  } finally {
    restore();
  }
});
