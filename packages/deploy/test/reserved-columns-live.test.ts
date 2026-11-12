/**
 * Live defect: the it-asset-tracker deploy died at "create columns on addlicense failed: 403
 * INVALID_OPERATION: Column name cannot contain reserved keywords" for the Creator field `Key`
 * (bug-tracker hit the same refusal for `User`). The plan renames such a field at PLAN time to
 * `<Name>_col` (deterministic, collision-free), counts the renames in the migration report, and
 * every consumer reads the stored column. A deploy that aborted mid-way is finished by a re-run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse } from '../../core/src/index.js';
import { columnRenamesOf, generateSchema, schemaAsReport } from '../../schema/src/generator.js';
import { isReservedColumnName } from '../../schema/src/mapping.js';
import { applyTablePlan, tableCreatePlan, type RestFn } from '../src/tables.js';
import { deployFiles } from '../src/plan.js';
import { FUNCTION_DIR } from '../src/function-dir.js';
import type { GuardOk } from '../src/guards.js';

/** The 98 words a live Create_Column probe refused (12 Nov 2026). */
const REFUSED = [
  'all', 'alter', 'and', 'any', 'as', 'between', 'binary', 'blob', 'by', 'call',
  'case', 'char', 'check', 'column', 'constraint', 'create', 'cross', 'database', 'date', 'decimal',
  'default', 'delete', 'describe', 'distinct', 'double', 'drop', 'else', 'end', 'exists', 'float',
  'foreign', 'from', 'grant', 'group', 'having', 'hour', 'in', 'index', 'inner', 'insert',
  'int', 'interval', 'into', 'is', 'join', 'key', 'keys', 'left', 'like', 'limit',
  'lock', 'long', 'minute', 'month', 'natural', 'not', 'null', 'offset', 'on', 'option',
  'or', 'order', 'outer', 'primary', 'priority', 'procedure', 'read', 'references', 'replace', 'result',
  'revoke', 'right', 'rules', 'schema', 'second', 'select', 'set', 'show', 'some', 'table',
  'then', 'time', 'timestamp', 'to', 'trigger', 'union', 'unique', 'unlock', 'update', 'use',
  'user', 'using', 'values', 'varchar', 'when', 'where', 'with', 'write',
];

const REFUSAL = 'You cannot perform this operation. Column name cannot contain reserved keywords';

test('every one of the 98 live-refused words is reserved, in any case', () => {
  assert.equal(REFUSED.length, 98);
  for (const word of REFUSED) {
    assert.equal(isReservedColumnName(word), true, word);
    assert.equal(isReservedColumnName(word.toUpperCase()), true, word.toUpperCase());
    assert.equal(isReservedColumnName(word[0]!.toUpperCase() + word.slice(1)), true, word);
    assert.equal(isReservedColumnName(`${word}_x`), false, `${word}_x`);
  }
});

// Fixture-shaped: it-asset-tracker `addlicense` (Key) and bug-tracker `Comments` (User, plus a lookup named User).
const DS = `application "Assets"
{
	form Staff
	{
		Name
		(
			type = text
		)
	}
	form addlicense
	{
		Key
		(
			type = text
			must have
		)
		Places
		(
			type = number
		)
	}
	form Comments
	{
		User
		(
			type = picklist
			values = Staff.ID
			displayformat = [Name]
		)
		Body
		(
			type = text
		)
	}
	list All_Licenses
	{
		show all rows from addlicense
		(
			Key as "Key"
			Places as "Places"
		)
	}
	list All_Comments
	{
		show all rows from Comments
		(
			User as "User"
			Body as "Body"
		)
	}
}
`;

function refusing(words: readonly string[] = REFUSED, outage = false): { rest: RestFn; heal: () => void } {
  const tables = new Map<string, { id: string; columns: Set<string> }>();
  let seq = 1;
  let down = outage;
  const rest: RestFn = async (call) => {
    const list = () => [...tables].map(([name, t]) => ({ table_name: name, table_id: t.id, column_details: [...t.columns].map((column_name) => ({ column_name })) }));
    if (call.method === 'GET' && call.path.endsWith('/table')) return { status: 200, body: { data: list() } };
    if (call.method === 'POST' && call.path.endsWith('/table')) {
      const name = (call.body as { table_name: string }).table_name;
      tables.set(name, { id: `t${seq++}`, columns: new Set() });
      return { status: 200, body: { data: { table_id: tables.get(name)!.id } } };
    }
    const id = call.path.split('/table/')[1]?.split('/')[0];
    const found = [...tables.values()].find((t) => t.id === id);
    if (call.method === 'GET') return found ? { status: 200, body: { data: { column_details: [...found.columns].map((column_name) => ({ column_name })) } } } : { status: 404, body: {} };
    if (call.method === 'POST' && call.path.includes('/column')) {
      const batch = call.body as { column_name: string }[];
      if (batch.some((column) => words.includes(column.column_name.toLowerCase()))) return { status: 403, body: { status: 'failure', data: { error_code: 'INVALID_OPERATION', message: REFUSAL } } };
      if (down) {
        return { status: 500, body: { status: 'failure', data: { message: 'transient' } } };
      }
      for (const column of batch) found?.columns.add(column.column_name);
      return { status: 200, body: { status: 'success' } };
    }
    return { status: 404, body: {} };
  };
  return { rest, heal: () => void (down = false) };
}

test('Key and User are renamed at plan time, counted in the report, and the store accepts the plan', async () => {
  const plan = generateSchema(deriveIr(parse(DS)));
  assert.deepEqual(columnRenamesOf(plan), { addlicense: { Key: 'Key_col' }, Comments: { User: 'User_col' } });
  assert.equal(plan.renames?.length, 2);
  for (const table of plan.tables) for (const column of table.columns) assert.equal(isReservedColumnName(column.name), false, `${table.name}.${column.name}`);
  const user = plan.tables.find((t) => t.name === 'Comments')!.columns.find((c) => c.field === 'User')!;
  assert.equal(user.name, 'User_col');
  assert.equal(user.relation?.table, 'Staff', 'the lookup keeps its foreign key under the new name');
  const report = schemaAsReport(plan);
  assert.match(report, /\(2 fields renamed\)/);
  assert.match(report, /- addlicense\.Key → addlicense\.Key_col/);
  assert.match(report, /- Comments\.User → Comments\.User_col/);
  // Deterministic: a second plan names the same columns.
  assert.deepEqual(columnRenamesOf(generateSchema(deriveIr(parse(DS)))), columnRenamesOf(plan));
  const store = refusing();
  const diff = await applyTablePlan('1001', tableCreatePlan(plan), store.rest);
  assert.ok(diff.createdColumns.includes('addlicense.Key_col'));
  assert.ok(diff.createdColumns.includes('Comments.User_col'));
});

test('a collision with an existing Key_col field skips to the next free name', () => {
  const plan = generateSchema(deriveIr(parse('application "A"\n{\n\tform F\n\t{\n\t\tKey\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t\tkey_col\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n}\n')));
  assert.deepEqual(columnRenamesOf(plan), { F: { Key: 'Key_col_2' } });
});

test('generated functions and UI bindings keep the field name and map to the stored column', () => {
  const app = deriveIr(parse(DS));
  const guard = { projectName: 'c2c-assets', projectId: '1001', org: '10000000000', environment: 'Development', dc: 'in' } as GuardOk;
  const { files } = deployFiles(app, guard, false);
  const read = (name: string) => JSON.parse(String(files.find((file) => file.path === `${FUNCTION_DIR}/${name}`)!.data)) as Record<string, unknown>;
  assert.deepEqual(read('c2c-renames.json'), { Comments: { User: 'User_col' }, addlicense: { Key: 'Key_col' } });
  assert.ok((read('c2c-schema.json').addlicense as string[]).includes('Key_col'));
  assert.ok(!(read('c2c-schema.json').addlicense as string[]).includes('Key'));
  assert.ok(((read('c2c-rules.json').addlicense as { name: string }[]).map((r) => r.name)).includes('Key'));
  const ui = files.filter((file) => !file.path.startsWith(`${FUNCTION_DIR}/`) && /\.(js|html)$/.test(file.path)).map((file) => String(file.data)).join('\n');
  assert.doesNotMatch(ui, /\bKey_col\b|\bUser_col\b/, 'UI bindings use the Creator field name, never the stored column');
});

test('a deploy aborted mid-way is completed by a re-run: tables exist, the missing columns are created', async () => {
  const plan = tableCreatePlan(generateSchema(deriveIr(parse(DS))));
  const store = refusing(REFUSED, true);
  // First run: tables are created, the first column batch fails (the live abort), the run throws.
  await assert.rejects(() => applyTablePlan('1001', plan, store.rest), /create columns on/);
  store.heal();
  // Second run (deploy --resume re-checks the table plan against the store) creates only what is missing.
  const diff = await applyTablePlan('1001', plan, store.rest);
  assert.ok(diff.createdColumns.includes('addlicense.Key_col'), JSON.stringify(diff.createdColumns));
  assert.ok(diff.createdColumns.includes('Comments.User_col'));
  const third = await applyTablePlan('1001', plan, store.rest);
  assert.deepEqual(third.createdColumns, [], 'a finished project is a no-op');
});
