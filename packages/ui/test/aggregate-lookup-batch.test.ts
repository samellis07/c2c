/**
 * D11: an aggregate over a report with lookup columns resolves each parent form with ROWID IN reads of at most
 * ZCQL's 300-row cap (one per chunk, not one per page or group), and a parent id is read once per request.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';
import { ADMIN, invoke, liveDatastore, loadTree } from './page-endpoint.js';

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
  Backup
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
    Backup
  )
}
	}
}
`));
  a.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } });
  return a;
}

test('an aggregate reads each lookup parent form in chunks of 300 ids, never one read per row page', async () => {
  const dir = loadTree(generateUi(app()).files);
  const { datastore, restore } = liveDatastore();
  try {
    const total = 600;
    for (let at = 0; at < total; at += 100) await datastore.insert('People', Array.from({ length: 100 }, (_, i) => ({ Name: `P${at + i}` })));
    const ids: string[] = [];
    for (let at = 0; ids.length < total; at += 300) {
      const page = await datastore.query('People', 'true', 300, at);
      if (!page.length) break;
      ids.push(...page.map((p) => String(p.ROWID)));
    }
    for (let at = 0; at < ids.length; at += 100) {
      await datastore.insert('Calls', ids.slice(at, at + 100).map((id, i) => ({ Subject_field: `s${(at + i) % 5}`, Person: id, Backup: ids[(at + i + 1) % ids.length] })));
    }
    const reads: { form: string; limit: number }[] = [];
    const query = datastore.query.bind(datastore) as (form: string, ...rest: any[]) => Promise<unknown>;
    (datastore as any).query = (form: string, where: string, limit: number, ...rest: unknown[]) => {
      reads.push({ form, limit });
      return query(form, where, limit, ...rest);
    };
    const out = await invoke(dir, 'functions/reports/all-calls.mjs', ADMIN, { op: 'aggregate', group: 'Person', measures: [{ fn: 'count', field: '' }] });
    assert.equal(out.status, 200, JSON.stringify(out.body).slice(0, 200));
    const people = reads.filter((r) => r.form === 'People');
    assert.ok(people.every((r) => r.limit <= 300), `a parent read asked for more than the 300-row cap: ${JSON.stringify(people.map((r) => r.limit))}`);
    // Two lookup columns share one parent form: ceil(600 / 300) = 2 chunks, read once for the request.
    assert.ok(people.length <= 2, `parent reads: ${people.length} (${JSON.stringify(people.map((r) => r.limit))})`);
    const buckets = (out.body.buckets as { key: string; count?: number }[]) ?? [];
    assert.equal(buckets.length, total);
  } finally {
    restore();
  }
});
