import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateSchema, subformTablesOf } from '../../schema/src/index.js';
import {
  SUBFORM_READ_PAGE,
  SubformWriteError,
  attachSubforms,
  saveSubforms,
  splitSubforms,
  type SubformStore,
  type SubformTables,
} from '../src/index.js';

const TABLES: SubformTables = {
  Order: [
    { field: 'Lines', table: 'Order__Lines', parentColumn: 'parent_id', orderColumn: 'row_order' },
    { field: 'Notes', table: 'Order__Notes', parentColumn: 'parent_id', orderColumn: 'row_order' },
  ],
};

/** In-memory Data Store: string ROWIDs, ZCQL `col = 'x'` / `col IN ('x', …)` only. */
function memoryStore(failInsertOn?: string): SubformStore & { tables: Map<string, Record<string, unknown>[]>; calls: string[] } {
  const tables = new Map<string, Record<string, unknown>[]>();
  const calls: string[] = [];
  let next = 1000;
  const rowsOf = (table: string) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  const matches = (where: string, row: Record<string, unknown>): boolean => {
    const eq = /^(\w+) = '(\d+)'$/.exec(where);
    if (eq) return String(row[eq[1]]) === eq[2];
    const inList = /^(\w+) IN \((.*)\)$/.exec(where);
    if (inList) return inList[2].split(', ').map((v) => v.slice(1, -1)).includes(String(row[inList[1]]));
    throw new Error(`unexpected where ${where}`);
  };
  return {
    tables,
    calls,
    async insert(table, rows) {
      calls.push(`insert ${table} ${rows.length}`);
      if (table === failInsertOn) throw new Error('insert refused');
      const stored = rows.map((row) => ({ ...row, ROWID: String(next++) }));
      rowsOf(table).push(...stored);
      return stored;
    },
    async query(table, where, limit, offset = 0) {
      calls.push(`query ${table} ${where}`);
      return rowsOf(table).filter((row) => matches(where, row)).slice(offset, offset + limit);
    },
    async delete(table, ids) {
      calls.push(`delete ${table} ${ids.length}`);
      const keep = rowsOf(table).filter((row) => !ids.includes(String(row.ROWID)));
      tables.set(table, keep);
      return ids;
    },
  };
}

test('splitSubforms takes the subform arrays off the parent and keeps absent subforms untouched', () => {
  const record = { Customer: 'Ann', Lines: [{ Item: 'Bolt' }, { Item: 'Nut' }] };
  const split = splitSubforms(record, TABLES, 'Order');
  assert.deepEqual(split.parent, { Customer: 'Ann' });
  assert.deepEqual(record.Lines.length, 2, 'the input record is not mutated');
  assert.deepEqual(split.children.map((c) => [c.link.field, c.rows.length]), [['Lines', 2]]);
  assert.deepEqual(splitSubforms({ Lines: null }, TABLES, 'Order').children[0].rows, []);
  assert.throws(() => splitSubforms({ Lines: 'x' }, TABLES, 'Order'), /must be a list of rows/);
  assert.equal(splitSubforms(record, TABLES, 'Other').parent, record);
});

test('saveSubforms writes each row with the parent ROWID and its 0-based order; client ids are dropped', async () => {
  const store = memoryStore();
  const { children } = splitSubforms({ Lines: [{ Item: 'Bolt', ROWID: '9' }, { Item: 'Nut', row_order: 7 }], Notes: [{ Body: 'hi' }] }, TABLES, 'Order');
  const out = await saveSubforms(store, '4400000000000000123', children);
  assert.deepEqual(out, { inserted: 3, deleted: 0 });
  const lines = store.tables.get('Order__Lines')!;
  assert.deepEqual(
    lines.map((row) => [row.Item, row.parent_id, row.row_order]),
    [
      ['Bolt', '4400000000000000123', 0],
      ['Nut', '4400000000000000123', 1],
    ],
  );
  assert.notEqual(lines[0].ROWID, '9');
  await assert.rejects(saveSubforms(store, 1e20, children), /unsafe number|digit string/);
});

test('an update replaces the rows of the subforms it carries and leaves the others', async () => {
  const store = memoryStore();
  await saveSubforms(store, '7', splitSubforms({ Lines: [{ Item: 'A' }, { Item: 'B' }], Notes: [{ Body: 'keep' }] }, TABLES, 'Order').children);
  const out = await saveSubforms(store, '7', splitSubforms({ Lines: [{ Item: 'C' }] }, TABLES, 'Order').children, { replace: true });
  assert.deepEqual(out, { inserted: 1, deleted: 2 });
  assert.deepEqual(store.tables.get('Order__Lines')!.map((row) => row.Item), ['C']);
  assert.deepEqual(store.tables.get('Order__Notes')!.map((row) => row.Body), ['keep']);
});

test('a failed child insert deletes the rows already written and the new parent (no transactions)', async () => {
  const store = memoryStore('Order__Notes');
  store.tables.set('Order', [{ ROWID: '7', Customer: 'Ann' }]);
  const { children } = splitSubforms({ Lines: [{ Item: 'A' }, { Item: 'B' }], Notes: [{ Body: 'x' }] }, TABLES, 'Order');
  await assert.rejects(saveSubforms(store, '7', children, { parentTable: 'Order' }), (err: unknown) => {
    assert.ok(err instanceof SubformWriteError);
    assert.equal(err.field, 'Notes');
    assert.equal(err.compensated, 2);
    return true;
  });
  assert.deepEqual(store.tables.get('Order__Lines'), []);
  assert.deepEqual(store.tables.get('Order'), []);
});

test('attachSubforms reads each subform once per 300 parents, in row order then ROWID, without link columns', async () => {
  const store = memoryStore();
  store.tables.set('Order__Lines', [
    { ROWID: '20', parent_id: '1', row_order: '1', Item: 'second' },
    { ROWID: '10', parent_id: '1', row_order: '0', Item: 'first' },
    { ROWID: '30', parent_id: '2', row_order: null, Item: 'unordered' },
  ]);
  const parents: Record<string, unknown>[] = [{ ROWID: '1' }, { ROWID: '2' }, { ROWID: '3' }];
  await attachSubforms(store, TABLES, 'Order', parents);
  assert.deepEqual(parents[0], { ROWID: '1', Lines: [{ ROWID: '10', Item: 'first' }, { ROWID: '20', Item: 'second' }], Notes: [] });
  assert.deepEqual(parents[1].Lines, [{ ROWID: '30', Item: 'unordered' }]);
  assert.deepEqual(parents[2].Lines, []);
  assert.deepEqual(store.calls, ["query Order__Lines parent_id IN ('1', '2', '3')", "query Order__Notes parent_id IN ('1', '2', '3')"]);
  const many = Array.from({ length: SUBFORM_READ_PAGE + 1 }, (_, i) => ({ ROWID: String(i + 1) }));
  const counted = memoryStore();
  await attachSubforms(counted, { Order: [TABLES.Order[0]] }, 'Order', many);
  assert.equal(counted.calls.length, 2);
});

test('the schema plan names the child tables the runtime writes: every inline subform, parent_id and row_order', () => {
  const sub = (name: string) => `\t\t${name}\n\t\t(\n\t\t\ttype = grid\n\t\t\tItem\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t)`;
  const app = deriveIr(parse(`application "Demo"\n{\n\tform Order\n\t{\n${sub('Lines')}\n${sub('Notes')}\n\t}\n\tform Plain\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n}\n`));
  assert.deepEqual(subformTablesOf(generateSchema(app)), TABLES);
});

test('a constructed { __row } subform row writes its values, not the wrapper', async () => {
  // `Form.Subform()` rows carry fields under `values`; the child table gets
  // only the field columns, never __row / form / values.
  const store = memoryStore();
  const row = { __row: true, form: 'Order.Lines', values: { Item: 'Bolt', Qty: 3 } };
  const { children } = splitSubforms({ Lines: [row] }, TABLES, 'Order');
  assert.deepEqual(children[0].rows, [{ Item: 'Bolt', Qty: 3 }]);
  await saveSubforms(store, '7', children);
  const saved = store.tables.get('Order__Lines') ?? [];
  assert.deepEqual(saved.map((r) => [r.Item, r.Qty]), [['Bolt', 3]]);
  assert.ok(saved.every((r) => !('__row' in r) && !('values' in r) && !('form' in r)));
});
