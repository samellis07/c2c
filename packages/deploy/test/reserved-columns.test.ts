/**
 * Reserved Data Store column names. A column create that names one is refused
 * with 403 INVALID_OPERATION "Column name cannot contain reserved keywords" and
 * the whole column batch is lost. The schema stores such a field under another
 * column; the table plan, the loaders, the seed loader, the smoke plan and the
 * datastore adapter all use that column, and generated code keeps the field name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse, parseProject, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { emptyCheckpoint } from '../../data/src/migrate.js';
import { quirkRowServer } from '../../data/test/catalyst-row-fake.js';
import { columnRenamesOf, generateSchema, schemaAsReport } from '../../schema/src/generator.js';
import { isReservedColumnName } from '../../schema/src/mapping.js';
import { appUniqueColumnsOf, writeRulesOf } from '../../deluge/src/generate.js';
import { migrateCsv, readSourceCsv } from '../src/csv.js';
import { seedMigrateCli, type Io } from '../src/cli.js';
import { seedStoreColumns } from '../src/seed.js';
import { applyTablePlan, tableCreatePlan, type RestFn } from '../src/tables.js';
import { deployFiles } from '../src/plan.js';
import { planSmoke } from '../src/smoke.js';
import { buildUi } from '../../ui/src/generate.js';
import { FUNCTION_DIR, routeTable } from '../src/function-dir.js';
import type { GuardOk } from '../src/guards.js';

const SCOPE = { org: '10000000000', projectId: '1001', token: 'test-cli-token' };

const REFUSAL = 'You cannot perform this operation. Column name cannot contain reserved keywords';

const DS = `application "Diner"
{
	date format = "dd-MMM-yyyy"
	time zone = "Asia/Kolkata"
	form New_Table
	{
		must have unique Table_Name
		(
			type = text
			displayname = "Table Name"
		)
	}
	form New_Order
	{
		Table
		(
			type = picklist
			values = New_Table.ID
			displayformat = [Table_Name]
		)
		Time
		(
			type = datetime
		)
		Priority
		(
			type = picklist
			values = {"High", "Low"}
		)
		Table_col
		(
			type = text
		)
		must have Status
		(
			type = text
		)
	}
	list All_Tables
	{
		show all rows from New_Table
		(
			Table_Name as "Table Name"
		)
	}
	list All_Orders
	{
		show all rows from New_Order
		(
			Table as "Table"
			Time as "Time"
			Priority as "Priority"
			Table_col as "Table col"
			Status as "Status"
		)
	}
}
`;

function app(): App {
  return deriveIr(parse(DS));
}

/** Data Store's refusal: any column batch that names a reserved word fails as a whole. */
function refusingStore(words: readonly string[] = ['table', 'time', 'priority']): { rest: RestFn; columns: Map<string, Set<string>> } {
  const tables = new Map<string, { id: string; columns: Set<string> }>();
  const columns = new Map<string, Set<string>>();
  let seq = 1;
  const rest: RestFn = async (call) => {
    if (call.method === 'GET' && call.path.endsWith('/table')) {
      return { status: 200, body: { data: [...tables].map(([name, table]) => ({ table_name: name, table_id: table.id, column_details: [...table.columns].map((column_name) => ({ column_name })) })) } };
    }
    if (call.method === 'POST' && call.path.endsWith('/table')) {
      const name = (call.body as { table_name: string }).table_name;
      const id = `t${seq++}`;
      tables.set(name, { id, columns: new Set() });
      columns.set(name, tables.get(name)!.columns);
      return { status: 200, body: { data: { table_id: id } } };
    }
    if (call.method === 'GET' && /\/table\/[^/]+$/.test(call.path)) {
      const id = call.path.split('/table/')[1]?.split('/')[0];
      const found = [...tables.values()].find((table) => table.id === id);
      return found ? { status: 200, body: { data: { column_details: [...found.columns].map((column_name) => ({ column_name })) } } } : { status: 404, body: {} };
    }
    if (call.method === 'POST' && call.path.includes('/column')) {
      const id = call.path.split('/table/')[1]?.split('/')[0];
      const found = [...tables.values()].find((table) => table.id === id);
      const batch = call.body as { column_name: string }[];
      if (batch.some((column) => words.includes(column.column_name.toLowerCase()))) {
        return { status: 403, body: { status: 'failure', data: { error_code: 'INVALID_OPERATION', message: REFUSAL } } };
      }
      for (const column of batch) found?.columns.add(column.column_name);
      return { status: 200, body: { status: 'success' } };
    }
    return { status: 404, body: {} };
  };
  return { rest, columns };
}

test('reserved column names match the whole name in any case', () => {
  for (const name of ['Table', 'TIME', 'priority', 'From', 'Order', 'Limit']) assert.equal(isReservedColumnName(name), true, name);
  for (const name of ['Table_Number', 'task_priority', 'Time_Of_Attending', 'Status', 'Comments', 'Type', 'To']) assert.equal(isReservedColumnName(name), false, name);
});

test('the schema stores a reserved field under a suffixed column and records the rename', () => {
  const plan = generateSchema(app());
  const order = plan.tables.find((table) => table.name === 'New_Order')!;
  for (const column of order.columns) assert.equal(isReservedColumnName(column.name), false, column.name);
  const table = order.columns.find((column) => column.field === 'Table')!;
  // Table_col is a field of the form, so the rename skips it.
  assert.equal(table.name, 'Table_col_2');
  assert.deepEqual(table.relation, { table: 'New_Table', column: 'ROWID', onDelete: 'ON-DELETE-SET-NULL' });
  assert.equal(order.columns.find((column) => column.name === 'Table_col')?.field, undefined);
  assert.deepEqual(plan.renames, [
    { table: 'New_Order', form: 'New_Order', field: 'Table', column: 'Table_col_2' },
    { table: 'New_Order', form: 'New_Order', field: 'Time', column: 'Time_col' },
    { table: 'New_Order', form: 'New_Order', field: 'Priority', column: 'Priority_col' },
  ]);
  assert.deepEqual(columnRenamesOf(plan), { New_Order: { Priority: 'Priority_col', Table: 'Table_col_2', Time: 'Time_col' } });
  assert.ok(plan.issues.some((issue) => issue.field === 'Time' && /reserved Data Store column name\. New_Order stores it as Time_col/.test(issue.message)));
  const report = schemaAsReport(plan);
  assert.match(report, /## Renamed columns\n\n.*\n\n- New_Order\.Table → New_Order\.Table_col_2\n- New_Order\.Time → New_Order\.Time_col\n- New_Order\.Priority → New_Order\.Priority_col\n/);
  // An app with no reserved names carries no renames key.
  assert.equal('renames' in generateSchema(deriveIr(parse(DS.replace(/\bTable\b(?=\n\t\t\()/, 'Place').replace(/\bTime\b(?=\n\t\t\()/, 'At').replace(/\bPriority\b(?=\n\t\t\()/, 'Rank')))), false);
});

test('a store that refuses reserved names creates every table from the plan', async () => {
  const store = refusingStore();
  const diff = await applyTablePlan('1001', tableCreatePlan(generateSchema(app())), store.rest);
  assert.ok(diff.createdColumns.includes('New_Order.Table_col_2'));
  assert.ok(diff.createdColumns.includes('New_Order.Time_col'));
  assert.ok(diff.createdColumns.includes('New_Order.Priority_col'));
  assert.ok(store.columns.get('New_Order')!.has('Status'));
});

test('a hand-edited step with a reserved column name is refused before any column POST', async () => {
  const store = refusingStore();
  const step = { table: 'New_Order', form: 'New_Order', nosql: false, columns: [{ table: 'New_Order', column_name: 'Table', data_type: 'varchar', max_length: 255, is_unique: false, is_mandatory: false }] };
  await assert.rejects(() => applyTablePlan('1001', [step], store.rest), /refusing to create New_Order: reserved column name\(s\) Table/);
  assert.equal(store.columns.size, 0);
});

const fixtures = process.env.C2C_FIXTURES_DIR;
const restaurants = fixtures ? join(fixtures, 'gallery', 'restaurants') : '';

test('restaurants: New_Order is planned without a reserved column name and creates against a refusing store', { skip: fixtures && existsSync(restaurants) ? false : 'C2C_FIXTURES_DIR/gallery/restaurants is not available' }, async () => {
  const plan = generateSchema(parseProject(restaurants).ir);
  const order = plan.tables.find((table) => table.name === 'New_Order')!;
  for (const column of order.columns) assert.equal(isReservedColumnName(column.name), false, column.name);
  assert.deepEqual(columnRenamesOf(plan).New_Order, { Table: 'Table_col', Time: 'Time_col' });
  assert.equal(order.columns.find((column) => column.name === 'Table_col')?.relation?.table, 'New_Table');
  const store = refusingStore();
  const diff = await applyTablePlan('1001', tableCreatePlan(plan), store.rest);
  assert.ok(diff.createdColumns.includes('New_Order.Table_col'));
  assert.ok(diff.createdColumns.includes('New_Order.Time_col'));
});

test('generated runtime options name the field; the function bundle maps it to the column', () => {
  const a = app();
  const rules = writeRulesOf(a).New_Order!;
  assert.ok(rules.some((rule) => rule.name === 'Time'));
  assert.ok(!rules.some((rule) => rule.name === 'Time_col'));
  assert.deepEqual(appUniqueColumnsOf(a), {});
  const guard = { projectName: 'c2c-diner', projectId: '1001', org: '10000000000', environment: 'Development', dc: 'in' } as GuardOk;
  const { files } = deployFiles(a, guard, false);
  const read = (name: string) => JSON.parse(String(files.find((file) => file.path === `${FUNCTION_DIR}/${name}`)!.data)) as Record<string, unknown>;
  assert.deepEqual(read('c2c-renames.json'), { New_Order: { Priority: 'Priority_col', Table: 'Table_col_2', Time: 'Time_col' } });
  assert.deepEqual((read('c2c-columns.json').New_Order as Record<string, string>).Time_col, 'DateTime');
  assert.ok((read('c2c-schema.json').New_Order as string[]).includes('Time_col'));
  assert.ok(((read('c2c-rules.json').New_Order as { name: string }[]).map((rule) => rule.name)).includes('Time'));
  assert.match(String(files.find((file) => file.path === `${FUNCTION_DIR}/index.js`)!.data), /renames: RENAMES/);
});

test('the smoke plan reads a renamed marker back from its column', () => {
  const a = app();
  const schema = generateSchema(a);
  const ui = buildUi(a, { dc: 'in', schema });
  const steps = planSmoke(a, { routes: routeTable(ui.files.filter((file) => file.path.startsWith('functions/'))), model: ui.model, schema });
  const expects = steps.filter((step) => step.form === 'New_Order' && step.expect).map((step) => step.expect!);
  assert.ok(expects.some((expect) => expect.field === 'Time' && expect.column === 'Time_col'), JSON.stringify(expects));
  for (const expect of expects) assert.equal(expect.column, schema.renames?.find((item) => item.field === expect.field)?.column);
  const tableSteps = steps.filter((step) => step.form === 'New_Table' && step.expect).map((step) => step.expect!);
  assert.ok(tableSteps.every((expect) => !('column' in expect)));
});

interface Adapter {
  insert(form: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
  update(form: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
  query(form: string, where: string, limit: number, offset?: number, orderBy?: string, columns?: unknown): Promise<Record<string, unknown>[]>;
}

test('the datastore adapter writes and reads a renamed field through its column', async () => {
  const mod = (await import(pathToFileURL(join(repoRoot(), 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href)) as {
    createSdkDatastore(app: unknown, opts: Record<string, unknown>): Adapter;
    renameIdentifiers(text: string, map: Record<string, string>): string;
  };
  const known = new Set(['ROWID', 'Table_col', 'Time_col', 'Status']);
  const stored: Record<string, unknown>[] = [];
  const sql: string[] = [];
  const checked: Record<string, unknown>[] = [];
  const sdk = {
    datastore: () => ({
      table: () => ({
        insertRows: async (rows: Record<string, unknown>[]) => {
          for (const row of rows) for (const key of Object.keys(row)) if (!known.has(key)) throw new Error(`no column ${key}`);
          const out = rows.map((row, i) => ({ ...row, ROWID: String(10000000000000001n + BigInt(stored.length + i)) }));
          stored.push(...out);
          return out;
        },
        updateRows: async (rows: Record<string, unknown>[]) => rows,
        deleteRows: async () => [],
      }),
    }),
    zcql: () => ({
      executeZCQLQuery: async (text: string) => {
        sql.push(text);
        return stored.map((row) => ({ New_Order: row }));
      },
    }),
  };
  const datastore = mod.createSdkDatastore(sdk, {
    columns: { New_Order: { Time_col: 'DateTime', Table_col: 'Foreign Key' } },
    projections: { New_Order: ['ROWID', 'Table_col', 'Time_col', 'Status'] },
    renames: { New_Order: { Table: 'Table_col', Time: 'Time_col' } },
    checkWrite: (_form: string, row: Record<string, unknown>) => {
      checked.push(row);
      return row;
    },
  });
  const inserted = await datastore.insert('New_Order', [{ Table: '10000000000000007', Time: '2026-10-06T15:50:58', Status: 'Table' }]);
  assert.deepEqual(stored[0], { Table_col: '10000000000000007', Time_col: '2026-10-06 15:50:58', Status: 'Table', ROWID: '10000000000000001' });
  assert.deepEqual(Object.keys(checked[0]!).sort(), ['Status', 'Table', 'Time']);
  assert.equal(inserted[0]!.Table, '10000000000000007');
  const rows = await datastore.query('New_Order', "(Table = '10000000000000007' AND Status = 'Table')", 10, 0, 'ORDER BY Time DESC, ROWID');
  assert.equal(sql[0], "SELECT ROWID, Table_col, Time_col, Status FROM New_Order WHERE (Table_col = '10000000000000007' AND Status = 'Table') ORDER BY Time_col DESC, ROWID LIMIT 1, 10");
  assert.deepEqual(rows[0], { ROWID: '10000000000000001', Table: '10000000000000007', Time: '2026-10-06T15:50:58', Status: 'Table' });
  await datastore.query('New_Order', 'Time IS NULL', 1, 0, '', ['Time']);
  assert.equal(sql[1], 'SELECT ROWID, Time_col FROM New_Order WHERE Time_col IS NULL ORDER BY ROWID LIMIT 1, 1');
  assert.equal(mod.renameIdentifiers("Table = 'it''s Table' AND Tables = 1 AND x.Table = 2", { Table: 'Table_col' }), "Table_col = 'it''s Table' AND Tables = 1 AND x.Table_col = 2");
});

function dirOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-reserved-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test('a report export loads a reserved field into its column and reads it back', async () => {
  const a = app();
  const dir = dirOf({
    'All_Tables.csv': 'Table Name\nT1\n',
    'All_Orders.csv': 'Table,Time,Priority,Table col,Status\nT1,06-Oct-2026 15:50:58,High,plain,Open\n',
  });
  const loaded = readSourceCsv(dir, a);
  const row = loaded.tables.find((table) => table.table === 'New_Order')!.rows[0]!;
  assert.equal(row.columns.Priority_col, 'High');
  assert.equal(row.columns.Table_col, 'plain');
  assert.equal(row.columns.Table, undefined);
  assert.equal(row.columns.Priority, undefined);
  assert.ok(row.columns.Time_col);
  assert.ok(row.columns.Table_col_2 !== undefined);
  const store = quirkRowServer();
  const result = await migrateCsv({ app: a, dir, dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch: store.fetch, checkpoint: emptyCheckpoint(), scope: SCOPE });
  assert.equal(result.ok, true, JSON.stringify(result.tables));
  const posted = store.posts.flat().filter((item) => 'Priority_col' in item);
  assert.equal(posted.length, 1);
  assert.ok(!('Priority' in posted[0]!) && !('Time' in posted[0]!) && !('Table' in posted[0]!));
  const order = result.tables.find((table) => table.table === 'New_Order')!;
  assert.equal(order.writtenCount, 1);
  assert.equal(order.mismatch, false);
});

test('seed rows move a reserved field to its column', () => {
  const renames = columnRenamesOf(generateSchema(app()));
  const [order] = seedStoreColumns([{ table: 'New_Order', rows: [{ id: '1', columns: { Time: '2026-10-06 15:50:58', Status: 'Open' } }] }], renames);
  assert.deepEqual(order!.rows[0]!.columns, { Time_col: '2026-10-06 15:50:58', Status: 'Open' });
  assert.throws(() => seedStoreColumns([{ table: 'New_Order', rows: [{ id: '2', columns: { Time: 'a', Time_col: 'b' } }] }], renames), /sets Time_col twice/);
  const untouched = [{ table: 'New_Table', rows: [{ id: '3', columns: { Table_Name: 'T1' } }] }];
  assert.deepEqual(seedStoreColumns(untouched, renames), untouched);
});

/**
 * The seed loader honours the renames end to end: `migrate-data --seed` resolves
 * the app from --ds (no --app needed) and a reserved field name is written under
 * its stored column exactly as on the csv/json paths. Without the --ds app the
 * run exits on usage; without the rename the posted row would carry Table,
 * Time and Priority instead of Table_col_2, Time_col and Priority_col.
 */
test('migrate-data --seed --confirm writes a reserved field to its stored column', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-seed-reserved-'));
  const ds = join(dir, 'diner.ds');
  writeFileSync(ds, DS);
  const seed = join(dir, 'seed.json');
  writeFileSync(
    seed,
    JSON.stringify({
      version: 1,
      tables: [
        { table: 'New_Table', rows: [{ c2c_source_id: 't1', Table_Name: 'Window' }] },
        {
          table: 'New_Order',
          rows: [{ c2c_source_id: 'o1', Table: 't1', Time: '2026-10-06 15:50:58', Priority: 'High', Table_col: 'plain', Status: 'Open' }],
        },
      ],
    }),
  );
  const projects = join(dir, 'projects.json');
  writeFileSync(projects, JSON.stringify({ org: '10000000000', dc: 'in', env: 'Development', projects: { 'c2c-diner': '1001' } }));
  const store = quirkRowServer();
  let out = '';
  let err = '';
  const rest: RestFn = async (call) => {
    if (call.method === 'GET' && call.path === '/baas/v1/project/1001') {
      return {
        status: 200,
        body: {
          status: 'success',
          data: {
            id: '1001',
            project_name: 'c2c-diner',
            project_type: 'Live',
            timezone: 'Asia/Kolkata',
            project_domain_details: { project_domain_id: '10', project_domain_name: 'c2c-diner' },
            env_details: [
              {
                env_name: 'Development',
                env_type: 1,
                env_zgid: '10000000000',
                id: '10000000000',
                is_default: true,
                project_details: { id: '1001', project_name: 'c2c-diner' },
              },
            ],
          },
        },
      };
    }
    if (call.method === 'GET' && call.path === '/baas/v1/project/1001/table') return { status: 200, body: { data: [] } };
    return { status: 404, body: {} };
  };
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env: { X_ZC_CREDENTIAL_PATH: join(dir, 'credential') },
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: store.fetch,
    rest,
    accessToken: async () => 'test-cli-token',
  };
  const code = await seedMigrateCli(['--seed', seed, '--ds', ds, '--project', '1001', '--org', '10000000000', '--projects', projects, '--confirm'], io);
  assert.equal(err, '');
  assert.equal(code, 0);
  assert.match(out, /New_Order: source 1 written 1 mismatch false/);
  const sent = [...store.posts.flat(), ...store.puts.flat()];
  const orders = sent.filter((row) => 'Status' in row);
  assert.equal(orders.length, 1);
  const order = orders[0]!;
  assert.ok(!('Table' in order) && !('Time' in order) && !('Priority' in order), JSON.stringify(order));
  assert.equal(order.Status, 'Open');
  assert.equal(order.Priority_col, 'High');
  assert.equal(order.Table_col, 'plain');
  assert.equal(order.Time_col, '2026-10-06 15:50:58');
  // The lookup cell carries the parent row's stored ROWID through the renamed column.
  assert.match(String(order.Table_col_2), /^[0-9]{17}$/);
});
