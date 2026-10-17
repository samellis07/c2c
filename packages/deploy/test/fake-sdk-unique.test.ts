/**
 * The offline fake SDK enforces the unique columns the table plan creates,
 * answering a repeat the way Data Store does (409 DUPLICATE_VALUE,
 * "Duplicate value for <column>. Please give a different value",
 * plugin/references/facts/errors.md), on insert and on update, and storing
 * nothing on a refusal. Distinct and empty values are accepted. The offline
 * verify-behavior backend declares those columns from the generated schema,
 * so a duplicate submit is refused end to end.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { generateSchema } from '../../schema/src/generator.js';
import { generateUi } from '../../ui/src/index.js';
import { tableCreatePlan } from '../src/tables.js';
import { foreignKeysByTable, startOfflineBackend, uniqueByTable } from '../src/verify-behavior.js';

interface FakeTable {
  insertRows(rows: Record<string, unknown>[]): Promise<Record<string, string>[]>;
  updateRows(rows: Record<string, unknown>[]): Promise<Record<string, string>[]>;
}
interface Fake {
  setUnique(declared: Record<string, string[]>): void;
  setForeignKeys(declared: Record<string, string[]>): void;
  state(): { tables: Record<string, Record<string, string>[]> };
  initialize(req: unknown): { datastore(): { table(name: string): FakeTable } };
}

const fake = createRequire(import.meta.url)(join(repoRoot(), 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs')) as Fake;
const tableOf = (name: string) => fake.initialize({}).datastore().table(name);
const rows = (name: string) => fake.state().tables[name] ?? [];

const DUPLICATE = { statusCode: 409, code: 'DUPLICATE_VALUE', message: 'Duplicate value for Email. Please give a different value' };

const APP = `application "unique-sample"
{
	time zone = "Asia/Kolkata"
	share_settings
	{
		"Administrator"
		{
			name = "Administrator"
			type = Users_Permissions
			description = "This profile will have all the permissions."
		}
	}
	section S
	{
		form Contact
		{
			must have unique Email
			(
				type = text
			)
			Name
			(
				type = text
			)
		}
		list All_Contacts
		{
			show all rows from Contact
		}
	}
}
`;

test('a duplicate insert is refused with the Data Store shape and stores nothing', async (t) => {
  fake.setUnique({ U_Insert: ['Email'] });
  t.after(() => fake.setUnique({}));
  const table = tableOf('U_Insert');
  await table.insertRows([{ Email: 'a@example.test', Name: 'A' }]);
  await assert.rejects(table.insertRows([{ Email: 'a@example.test', Name: 'B' }]), DUPLICATE);
  assert.deepEqual(rows('U_Insert').map((row) => row.Name), ['A']);
  // A repeat inside one call is refused as a whole.
  await assert.rejects(table.insertRows([{ Email: 'c@example.test' }, { Email: 'c@example.test' }]), DUPLICATE);
  assert.equal(rows('U_Insert').length, 1);
});

test('distinct and empty values are accepted', async (t) => {
  fake.setUnique({ U_Distinct: ['Email'] });
  t.after(() => fake.setUnique({}));
  const table = tableOf('U_Distinct');
  await table.insertRows([{ Email: 'a@example.test' }, { Email: 'b@example.test' }]);
  await table.insertRows([{ Email: null }, { Email: '' }, { Name: 'no email' }, { Email: null }]);
  assert.equal(rows('U_Distinct').length, 6);
});

test('an update to a duplicate is refused and leaves the row unchanged; keeping its own value is accepted', async (t) => {
  fake.setUnique({ U_Update: ['Email'] });
  t.after(() => fake.setUnique({}));
  const table = tableOf('U_Update');
  const [a, b] = await table.insertRows([{ Email: 'a@example.test', Name: 'A' }, { Email: 'b@example.test', Name: 'B' }]);
  await assert.rejects(table.updateRows([{ ROWID: b!.ROWID, Email: 'a@example.test' }]), DUPLICATE);
  assert.deepEqual(rows('U_Update').map((row) => row.Email), ['a@example.test', 'b@example.test']);
  const [same] = await table.updateRows([{ ROWID: a!.ROWID, Email: 'a@example.test', Name: 'A2' }]);
  assert.equal(same!.Name, 'A2');
  // Two rows moved onto one value in one call: refused, nothing written.
  await assert.rejects(
    table.updateRows([
      { ROWID: a!.ROWID, Email: 'z@example.test' },
      { ROWID: b!.ROWID, Email: 'z@example.test' },
    ]),
    { code: 'DUPLICATE_VALUE' },
  );
  assert.deepEqual(rows('U_Update').map((row) => row.Email), ['a@example.test', 'b@example.test']);
  // A swap to a free value is accepted.
  await table.updateRows([{ ROWID: b!.ROWID, Email: 'c@example.test' }]);
  assert.deepEqual(rows('U_Update').map((row) => row.Email), ['a@example.test', 'c@example.test']);
});

test('MUST-FAIL guard: a column not declared unique keeps accepting repeats', async () => {
  fake.setUnique({ U_Other: ['Email'] });
  try {
    const table = tableOf('U_Plain');
    await table.insertRows([{ Email: 'a@example.test' }]);
    await table.insertRows([{ Email: 'a@example.test' }]);
    assert.equal(rows('U_Plain').length, 2);
  } finally {
    fake.setUnique({});
  }
});

test('uniqueByTable lists exactly the is_unique columns of the table plan', () => {
  const app = deriveIr(parse(APP));
  assert.deepEqual(uniqueByTable(tableCreatePlan(generateSchema(app))), { Contact: ['Email'] });
});

test('offline verify-behavior refuses a duplicate submit on a schema-unique column', async () => {
  const app = deriveIr(parse(APP));
  const form = generateUi(app).model.forms.find((f) => f.name === 'Contact')!;
  const backend = await startOfflineBackend(app);
  try {
    const first = await backend.call('POST', form.submitEndpoint, { record: { Email: 'a@example.test', Name: 'A' } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const repeat = await backend.call('POST', form.submitEndpoint, { record: { Email: 'a@example.test', Name: 'B' } });
    assert.equal(repeat.status, 409, JSON.stringify(repeat.body));
    assert.equal((repeat.body as { code?: string }).code, 'DUPLICATE_VALUE');
    assert.equal((repeat.body as { field?: string }).field, 'Email');
    const other = await backend.call('POST', form.submitEndpoint, { record: { Email: 'b@example.test', Name: 'C' } });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.deepEqual((await backend.tableRows('Contact')).map((row) => row.Name), ['A', 'C']);
  } finally {
    await backend.close();
  }
});

test('a foreign-key column refuses a value that is not a whole-number id, on insert and update, storing nothing', async () => {
  fake.setUnique({});
  fake.setForeignKeys({ Link_Rows: ['Parent'] });
  const t = tableOf('Link_Rows');
  const before = rows('Link_Rows').length;
  const INVALID = { statusCode: 400, code: 'INVALID_INPUT', message: 'Invalid input value for Parent. bigint value expected' };
  await assert.rejects(t.insertRows([{ Parent: 'Title juniper 739' }]), INVALID);
  assert.equal(rows('Link_Rows').length, before);
  const [ok] = await t.insertRows([{ Parent: '10000000000000005' }, { Parent: null }]);
  await assert.rejects(t.updateRows([{ ROWID: ok!.ROWID, Parent: 'x1' }]), INVALID);
  assert.equal(rows('Link_Rows').find((row) => row.ROWID === ok!.ROWID)?.Parent, '10000000000000005');
  fake.setForeignKeys({});
});

test('foreignKeysByTable lists the columns the table plan types as foreign key', () => {
  const steps = [
    { table: 'Child', columns: [{ column_name: 'Parent', data_type: 'foreign key' }, { column_name: 'Name', data_type: 'varchar' }] },
    { table: 'Plain', columns: [{ column_name: 'Name', data_type: 'varchar' }] },
  ] as unknown as Parameters<typeof foreignKeysByTable>[0];
  assert.deepEqual(foreignKeysByTable(steps), { Child: ['Parent'] });
});
