import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import {
  EXTENSION_KEY,
  generateSchema,
  planFormRead,
  planZcql,
  selectListOf,
} from '../src/index.js';

/**
 * Fake ZCQL. The WHERE shapes are the ones planZcql emits: one comparison,
 * or `col IN (:bind)`. A page cap is the 300-row ZCQL page.
 */
function exec(
  store: Record<string, Record<string, unknown>[]>,
  sql: string,
  binds: Record<string, unknown[]>,
  pageCap = Infinity,
): Record<string, unknown>[] {
  const match = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY .+)?$/.exec(sql);
  assert.ok(match, `unparsed ${sql}`);
  const columns = match[1]!.split(', ');
  let rows = store[match[2]!]!.slice();
  const where = match[3];
  if (where) {
    const inn = /^(\w+) IN \(:(\w+)\)$/.exec(where);
    if (inn) {
      const set = new Set((binds[inn[2]!] ?? []).map((value) => String(value)));
      rows = rows.filter((row) => set.has(String(row[inn[1]!])));
    } else {
      const eq = /^(\w+) = '(.*)'$/.exec(where);
      assert.ok(eq, where);
      rows = rows.filter((row) => String(row[eq[1]!]) === eq[2]);
    }
  }
  rows.sort((left, right) => Number(left.ROWID) - Number(right.ROWID));
  rows = rows.slice(0, pageCap);
  return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
}

/** Stitch the way a paged executor must: later base chunks bind the first chunk's ROWIDs. */
function runStaged(
  store: Record<string, Record<string, unknown>[]>,
  queries: readonly string[],
  from: string,
  pageCap = Infinity,
): Record<string, unknown>[] {
  const binds: Record<string, unknown[]> = {};
  const byId = new Map<unknown, Record<string, unknown>>();
  let first = true;
  for (const sql of queries) {
    const table = / FROM (\w+)/.exec(sql)![1]!;
    const rows = exec(store, sql, binds, pageCap);
    if (table === from) {
      for (const row of rows) {
        if (first) byId.set(row.ROWID, { ...row });
        else if (byId.has(row.ROWID)) Object.assign(byId.get(row.ROWID)!, row);
      }
      if (first) binds[`${from}_ROWID`] = [...byId.keys()];
      first = false;
    } else {
      for (const row of rows) {
        const key = row[EXTENSION_KEY] ?? row.ROWID;
        const target = byId.get(key);
        if (!target) continue;
        for (const [column, value] of Object.entries(row)) {
          if (column === EXTENSION_KEY || column === 'ROWID') continue;
          target[column] = value;
        }
      }
    }
  }
  return [...byId.values()];
}

test('later base chunks bind the first chunk ROWIDs and page the same rows', () => {
  const columns = Array.from({ length: 35 }, (_, index) => `C${index}`);
  const store: Record<string, Record<string, unknown>[]> = { T: [] };
  for (let id = 1; id <= 700; id++) {
    const row: Record<string, unknown> = { ROWID: id, Status: id % 2 ? 'open' : 'closed' };
    for (const column of columns) row[column] = `${column}_${id}`;
    store.T!.push(row);
  }
  const plan = planZcql({
    from: 'T',
    columns: columns.map((column) => ({ table: 'T', column })),
    where: "Status = 'open'",
    orderBy: 'ORDER BY ROWID',
  });
  assert.ok(plan.queries.length >= 2);
  assert.match(plan.queries[0]!, /WHERE Status = 'open'/);
  for (const sql of plan.queries.slice(1)) {
    assert.match(sql, /WHERE ROWID IN \(:T_ROWID\)/, sql);
    assert.match(sql, /ORDER BY ROWID$/, sql);
  }
  const unsplit = `SELECT ROWID, ${columns.join(', ')} FROM T WHERE Status = 'open' ORDER BY ROWID`;
  assert.deepEqual(runStaged(store, plan.queries, 'T'), exec(store, unsplit, {}));
  const paged = runStaged(store, plan.queries, 'T', 300);
  const expectPaged = exec(store, unsplit, {}, 300);
  assert.equal(paged.length, expectPaged.length);
  assert.equal(paged.filter((row) => row.C34 === undefined).length, 0);
  assert.deepEqual(paged, expectPaged);
});

test('a dotted lookup selects the foreign key and stitches the target row', () => {
  const fields = [
    '\t\tCustomer\n\t\t(\n\t\t\ttype = picklist\n\t\t\tvalues = Customer.Name\n\t\t)',
    ...Array.from({ length: 32 }, (_, index) => `\t\tO${index}\n\t\t(\n\t\t\ttype = text\n\t\t)`),
  ];
  const source = `application "D"\n{\n\tform Customer\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n\tform Ord\n\t{\n${fields.join('\n')}\n\t}\n}\n`;
  const plan = generateSchema(deriveIr(parse(source)));
  const read = planFormRead(plan, 'Ord', ['Customer.Name', ...Array.from({ length: 32 }, (_, index) => `O${index}`)]);
  const base = read.queries.filter((sql) => sql.includes(' FROM Ord'));
  const lookup = read.queries.find((sql) => sql.includes(' FROM Customer'));
  assert.ok(lookup, read.queries.join('\n'));
  assert.equal(base.some((sql) => selectListOf(sql).includes('Customer')), true);
  assert.match(lookup!, /WHERE ROWID IN \(:Ord_Customer\)/);
  assert.equal(/:Ord_ROWID/.test(lookup!), false);

  const store: Record<string, Record<string, unknown>[]> = {
    Ord: [],
    Customer: [
      { ROWID: 1, Name: 'Alice' },
      { ROWID: 2, Name: 'Bob' },
      { ROWID: 3, Name: 'Carol' },
    ],
  };
  const fk: Record<number, number> = { 1: 3, 2: 1 };
  for (const id of [1, 2]) {
    const row: Record<string, unknown> = { ROWID: id, Customer: fk[id] };
    for (let index = 0; index < 32; index++) row[`O${index}`] = 'o';
    store.Ord!.push(row);
  }
  const stitched = runStaged(store, base, 'Ord');
  const binds: Record<string, unknown[]> = { Ord_Customer: stitched.map((row) => row.Customer) };
  const customers = exec(store, lookup!, binds);
  const byFk = new Map(customers.map((row) => [String(row.ROWID), row.Name]));
  const names = stitched.map((row) => byFk.get(String(row.Customer)));
  assert.deepEqual(names, ['Carol', 'Alice']);
});
