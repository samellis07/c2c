import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTablePlan, TablePlanError, type RestCall, type TableCreateStep } from '../src/tables.js';

/** The reply a table create gets once the org has used its table limit. */
const TABLE_LIMIT = {
  status: 'failure',
  data: { message: 'You have reached the max limit of your current API Limit for table', error_code: 'API_LIMIT_REACHED' },
};

const step = (table: string): TableCreateStep => ({
  table,
  form: table,
  nosql: false,
  columns: [{ table, column_name: 'Name', data_type: 'varchar', max_length: 255, is_unique: false, is_mandatory: false }],
});

test('the org table limit stops the create with a named, actionable error; tables made before it are kept', async () => {
  const calls: RestCall[] = [];
  let made = 0;
  const rest = async (call: RestCall) => {
    calls.push(call);
    if (call.method === 'GET' && call.path.endsWith('/table')) return { status: 200, body: { data: [] } };
    if (call.method === 'POST' && call.path.endsWith('/table')) {
      if (made >= 1) return { status: 403, body: TABLE_LIMIT };
      made += 1;
      return { status: 200, body: { data: { table_id: `t${made}` } } };
    }
    if (call.method === 'POST' && call.path.includes('/column')) return { status: 200, body: { status: 'success' } };
    return { status: 404, body: {} };
  };
  await assert.rejects(
    () => applyTablePlan('<project-id>', [step('A'), step('B'), step('C')], rest, { sleep: async () => {} }),
    (err: unknown) => {
      assert.ok(err instanceof TablePlanError);
      assert.match(err.message, /create table B failed: 403 API_LIMIT_REACHED: You have reached the max limit of your current API Limit for table/);
      assert.match(err.message, /org-wide limit on table creates/);
      assert.match(err.message, /this app needs 3 table\(s\); 1 created before the limit/);
      assert.match(err.message, /stop creates, keep created tables, and retry after 30\/60\/120 minutes/);
      assert.match(err.message, /delete may not free capacity at once/);
      assert.doesNotMatch(err.message, /[Ff]ree tables elsewhere/);
      assert.deepEqual(err.diff.createdTables, ['A']);
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path.endsWith('/table')).length, 2, 'the limit is not retried');
  assert.equal(calls.filter((call) => call.method !== 'GET' && call.method !== 'POST').length, 0, 'no table is deleted');
});
