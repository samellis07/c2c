import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { EXTENSION_KEY, generateSchema, limitValue, planZcql } from '../../schema/src/index.js';
import { createRuntime, type TableSplitLayout as RuntimeSplit } from '../src/runtime.js';

function splitLayout(form: string, count: number): { layout: RuntimeSplit; ext: string } {
  const fields = Array.from({ length: count }, (_, index) => `\t\tT${index}\n\t\t(\n\t\t\ttype = text\n\t\t)`).join('\n');
  const plan = generateSchema(deriveIr(parse(`application "D"\n{\n\tform ${form}\n\t{\n${fields}\n\t}\n}\n`)));
  const split = plan.splits?.find((item) => item.form === form);
  assert.ok(split, 'expected a split');
  const base = plan.tables.find((table) => table.name === split!.base);
  assert.ok(base);
  const layout: RuntimeSplit = {
    base: split.base,
    baseColumns: base!.columns.filter((column) => column.name !== EXTENSION_KEY).map((column) => column.name),
    extensions: split.extensions.map((ext) => ({
      table: ext.name,
      columns: ext.columns.filter((name) => name !== EXTENSION_KEY),
    })),
  };
  return { layout, ext: split.extensions[0]!.name };
}

test('a query without staged zcql does not grow a zcql field', () => {
  const runtime = createRuntime({ dryRun: true });
  const query = runtime.shim.datastore.query(runtime.context({}), 'Item', { op: 'true' });
  assert.equal(Object.hasOwn(query, 'zcql'), false);
});

test('dry-run still returns no rows when zcql stages are attached', async () => {
  const runtime = createRuntime({ dryRun: true });
  const query = runtime.shim.datastore.query(runtime.context({}), 'Item', { op: 'true' }, { zcql: ['SELECT ROWID FROM Item'] });
  assert.deepEqual(await runtime.shim.datastore.rows(runtime.context({}), query), []);
});

test('a live staged read applies the criteria on every base stage and stitches', async () => {
  const columns = Array.from({ length: 35 }, (_, index) => `C${index}`);
  const plan = planZcql({
    from: 'Item',
    columns: columns.map((column) => ({ table: 'Item', column })),
    orderBy: 'ORDER BY ROWID',
  });
  const rows: Record<string, unknown>[] = [];
  for (let id = 1; id <= 400; id++) {
    const row: Record<string, unknown> = { ROWID: String(id), Status: id <= 350 ? 'open' : 'closed' };
    for (const column of columns) row[column] = `${column}_${id}`;
    rows.push(row);
  }
  const calls: string[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query(_form, where, limit, offset = 0) {
        calls.push(where);
        let matched = rows;
        const parts = where.split(' AND ').map((part) => part.replace(/^\(/, '').replace(/\)$/, ''));
        for (const part of parts) {
          if (part === 'true') continue;
          const eq = /^(\w+) = '(.*)'$/.exec(part);
          const inn = /^(\w+) IN \((.*)\)$/.exec(part);
          if (eq) matched = matched.filter((row) => String(row[eq[1]!]) === eq[2]);
          else if (inn) {
            const set = new Set(inn[2]!.split(', ').map((item) => item.replace(/^'/, '').replace(/'$/, '')));
            matched = matched.filter((row) => set.has(String(row[inn[1]!])));
          } else throw new Error(`test where ${part}`);
        }
        matched = matched.slice().sort((left, right) => Number(left.ROWID) - Number(right.ROWID));
        const page = matched.slice(offset, offset + limit);
        // The first stage returns only its selected columns. Later stages fill the rest.
        if (!where.includes(' IN (')) {
          return page.map((row) => ({ ROWID: row.ROWID, Status: row.Status, C0: row.C0 }));
        }
        return page;
      },
    },
  });
  const query = runtime.shim.datastore.query(runtime.context({}), 'Item', { op: '==', field: 'Status', value: 'open' }, {
    zcql: plan.queries,
  });
  const got = await runtime.shim.datastore.rows(runtime.context({}), query);
  assert.equal(got.length, 350);
  assert.equal(
    got.every((row) => row.values.Status === 'open' && row.values.C34 === `C34_${row.values.ROWID}`),
    true,
  );
  assert.ok(calls.every((where) => where.includes("Status = 'open'")), calls.join('\n'));
  assert.ok(calls.some((where) => where.includes('ROWID IN (')));
  assert.equal(calls.some((where) => where === 'true'), false);
});

test('an aggregate over a staged read computes over the stitched rows', async () => {
  const columns = Array.from({ length: 35 }, (_, index) => `C${index}`);
  const plan = planZcql({
    from: 'Item',
    columns: [...columns, 'Qty'].map((column) => ({ table: 'Item', column })),
    orderBy: 'ORDER BY ROWID',
  });
  const rows: Record<string, unknown>[] = [];
  for (let id = 1; id <= 400; id++) {
    const row: Record<string, unknown> = { ROWID: String(id), Status: id <= 350 ? 'open' : 'closed', Qty: id };
    for (const column of columns) row[column] = `${column}_${id}`;
    rows.push(row);
  }
  const calls: string[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query(_form, where, limit, offset = 0) {
        calls.push(where);
        let matched = rows;
        const parts = where.split(' AND ').map((part) => part.replace(/^\(/, '').replace(/\)$/, ''));
        for (const part of parts) {
          if (part === 'true') continue;
          const eq = /^(\w+) = '(.*)'$/.exec(part);
          const inn = /^(\w+) IN \((.*)\)$/.exec(part);
          if (eq) matched = matched.filter((row) => String(row[eq[1]!]) === eq[2]);
          else if (inn) {
            const set = new Set(inn[2]!.split(', ').map((item) => item.replace(/^'/, '').replace(/'$/, '')));
            matched = matched.filter((row) => set.has(String(row[inn[1]!])));
          } else throw new Error(`test where ${part}`);
        }
        matched = matched.slice().sort((left, right) => Number(left.ROWID) - Number(right.ROWID));
        const page = matched.slice(offset, offset + limit);
        if (!where.includes(' IN (')) {
          return page.map((row) => ({ ROWID: row.ROWID, Status: row.Status, C0: row.C0 }));
        }
        return page;
      },
    },
  });
  const ctx = runtime.context({});
  const query = runtime.shim.datastore.query(ctx, 'Item', { op: '==', field: 'Status', value: 'open' }, {
    zcql: plan.queries,
  });
  // The criteria apply on every stage, then the aggregate runs over all
  // stitched rows: sum(Qty) over ids 1..350, not null and not a stage subset.
  assert.equal(await runtime.shim.datastore.aggregate(ctx, query, 'sum', 'Qty'), 61425);
  assert.equal(await runtime.shim.datastore.aggregate(ctx, query, 'count'), 350);
  assert.ok(calls.every((where) => where.includes("Status = 'open'")), calls.join('\n'));
  assert.ok(calls.some((where) => where.includes('ROWID IN (')));
});

test('a live write wider than the column cap is refused before any adapter call', async () => {
  const calls: string[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async insert(form) {
        calls.push(form);
        return { ROWID: '1' };
      },
    },
  });
  const values: Record<string, string> = {};
  for (let index = 0; index < 300; index++) values[`T${index}`] = 'x';
  await assert.rejects(
    () => runtime.shim.datastore.insert(runtime.context({}), 'Wide', values),
    new RegExp(`write refused for Wide: 300 columns exceed the Data Store column cap ${limitValue('datastore.columns_per_table')}`),
  );
  assert.deepEqual(calls, []);
});

test('a split insert writes base then extension and drops no column', async () => {
  const { layout, ext } = splitLayout('Wide', 300);
  const calls: { form: string; row: Record<string, unknown> }[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    splits: { Wide: layout },
    datastore: {
      async insert(form, rows) {
        calls.push({ form, row: rows[0]! });
        return { ROWID: '42' };
      },
    },
  });
  const values: Record<string, string> = {};
  for (let index = 0; index < 300; index++) values[`T${index}`] = 'x';
  await runtime.shim.datastore.insert(runtime.context({}), 'Wide', values);
  assert.equal(calls[0]?.form, layout.base);
  assert.equal(calls[1]?.form, ext);
  assert.equal(calls[1]?.row[EXTENSION_KEY], '42');
  const written = new Map<string, number>();
  for (const call of calls) {
    for (const key of Object.keys(call.row)) {
      if (key === EXTENSION_KEY) continue;
      written.set(key, (written.get(key) ?? 0) + 1);
    }
  }
  for (let index = 0; index < 300; index++) assert.equal(written.get(`T${index}`), 1, `T${index}`);
  assert.equal(calls[0]?.row.Added_User != null, true);
  assert.equal(Object.hasOwn(calls[1]!.row, 'Added_User'), false);
});

test('a split update writes each side and refuses an unknown column before writing', async () => {
  const { layout, ext } = splitLayout('Wide', 300);
  const baseField = layout.baseColumns.find((name) => name.startsWith('T'));
  const extField = layout.extensions[0]!.columns.find((name) => name.startsWith('T'));
  assert.ok(baseField && extField);
  const calls: { op: string; form: string; row?: Record<string, unknown>; where?: string }[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    splits: { Wide: layout },
    datastore: {
      async query(form, where) {
        calls.push({ op: 'query', form, where });
        if (form === ext) return [{ ROWID: '70', [EXTENSION_KEY]: '7' }];
        return [{ ROWID: '7' }];
      },
      async update(form, rows) {
        calls.push({ op: 'update', form, row: rows[0] });
      },
      async insert() {
        calls.push({ op: 'insert', form: 'no' });
      },
    },
  });
  const ctx = runtime.context({});
  await runtime.shim.datastore.update(ctx, 'Wide', { op: 'true' }, { [baseField!]: 'a', [extField!]: 'b' });
  const updates = calls.filter((call) => call.op === 'update');
  assert.equal(updates[0]?.form, layout.base);
  assert.equal(updates[0]?.row?.ROWID, '7');
  assert.equal(updates[0]?.row?.[baseField!], 'a');
  assert.equal(Object.hasOwn(updates[0]!.row!, extField!), false);
  assert.equal(updates[1]?.form, ext);
  assert.equal(updates[1]?.row?.ROWID, '70');
  assert.equal(updates[1]?.row?.[extField!], 'b');
  assert.equal(updates[1]?.row?.[EXTENSION_KEY], undefined);
  const before = calls.length;
  await assert.rejects(
    () => runtime.shim.datastore.update(ctx, 'Wide', { op: 'true' }, { Not_A_Column: 'z' }),
    /split write refused for Wide/,
  );
  assert.equal(calls.length, before);
});

/** Two extension tables so a failure can land on either one. */
function wideSplit(): RuntimeSplit {
  return {
    base: 'Wide',
    baseColumns: ['Title'],
    extensions: [
      { table: 'Wide__e1', columns: ['A'] },
      { table: 'Wide__e2', columns: ['B'] },
    ],
  };
}

function componentLimit(status: number): Error {
  const message = status === 429 ? 'Concurrency limit reached for the feature COMPONENT' : 'INTERNAL_SERVER_ERROR';
  return Object.assign(new Error(message), { status });
}

test('a failed extension insert deletes the new base and extension rows, and a retry does not add a second base', async () => {
  const layout = wideSplit();
  const tables: Record<string, Record<string, unknown>[]> = { Wide: [], Wide__e1: [], Wide__e2: [] };
  let next = 0;
  const failAt = new Map<string, Error>();
  const baseInserts: Record<string, unknown>[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    splits: { Wide: layout },
    datastore: {
      async insert(table, rows) {
        const error = failAt.get(table);
        // Persist first, then fail: a 429 can land after the row is stored.
        const stored = rows.map((row) => ({ ...row, ROWID: String(++next) }));
        tables[table]!.push(...stored);
        if (table === layout.base) baseInserts.push(stored[0]!);
        if (error) throw error;
        return { rows: stored };
      },
      async query(table, where) {
        const eq = /^(\w+) = '(.*)'$/.exec(where);
        if (!eq) return tables[table]!.slice();
        const value = eq[2]!.replace(/''/g, "'");
        return tables[table]!.filter((row) => String(row[eq[1]!]) === value);
      },
      async delete(table, ids) {
        const drop = new Set(ids.map(String));
        tables[table] = tables[table]!.filter((row) => !drop.has(String(row.ROWID)));
      },
    },
  });
  const ctx = runtime.context({});
  const values = { Title: 't', A: 'a', B: 'b', c2c_source_id: 'src-1' };

  failAt.set('Wide__e1', componentLimit(429));
  await assert.rejects(() => runtime.shim.datastore.insert(ctx, 'Wide', values), /Concurrency limit reached for the feature COMPONENT/);
  assert.equal(tables.Wide!.length, 0, '429 on the first extension left a base row');
  assert.equal(tables.Wide__e1!.length, 0);
  assert.equal(tables.Wide__e2!.length, 0);

  failAt.delete('Wide__e1');
  failAt.set('Wide__e2', componentLimit(500));
  await assert.rejects(() => runtime.shim.datastore.insert(ctx, 'Wide', values), /INTERNAL_SERVER_ERROR/);
  assert.equal(tables.Wide!.length, 0, '500 on the second extension left a base row');
  assert.equal(tables.Wide__e1!.length, 0, '500 on the second extension left the first extension row');
  assert.equal(tables.Wide__e2!.length, 0);

  failAt.delete('Wide__e2');
  await runtime.shim.datastore.insert(ctx, 'Wide', values);
  assert.equal(tables.Wide!.length, 1);
  assert.equal(tables.Wide__e1!.length, 1);
  assert.equal(tables.Wide__e2!.length, 1);
  assert.equal(tables.Wide__e1![0]!.parent_rowid, tables.Wide![0]!.ROWID);
  assert.equal(baseInserts.length, 3, 'each attempt inserted one base; the failed ones were removed');
});

test('a retry reuses the base row when rollback cannot delete it', async () => {
  const layout = wideSplit();
  const tables: Record<string, Record<string, unknown>[]> = { Wide: [], Wide__e1: [], Wide__e2: [] };
  let next = 0;
  let failExt = true;
  let baseInserts = 0;
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    splits: { Wide: layout },
    datastore: {
      async insert(table, rows) {
        if (table !== layout.base) {
          if (failExt) throw componentLimit(429);
        } else baseInserts += 1;
        const stored = rows.map((row) => ({ ...row, ROWID: String(++next) }));
        tables[table]!.push(...stored);
        return { rows: stored };
      },
      async query(table, where) {
        const eq = /^(\w+) = '(.*)'$/.exec(where);
        if (!eq) return tables[table]!.slice();
        return tables[table]!.filter((row) => String(row[eq[1]!]) === eq[2]);
      },
      async delete() {
        throw new Error('delete failed');
      },
    },
  });
  const ctx = runtime.context({});
  const values = { Title: 't', A: 'a', B: 'b', c2c_source_id: 'src-retry' };
  await assert.rejects(() => runtime.shim.datastore.insert(ctx, 'Wide', values), /Concurrency limit reached for the feature COMPONENT/);
  assert.equal(tables.Wide!.length, 1);
  failExt = false;
  await runtime.shim.datastore.insert(ctx, 'Wide', values);
  assert.equal(baseInserts, 1, 'the retry inserted a second base row');
  assert.equal(tables.Wide!.length, 1);
  assert.equal(tables.Wide__e1!.length, 1);
  assert.equal(String(tables.Wide__e1![0]!.parent_rowid), String(tables.Wide![0]!.ROWID));
});

test('staged zcql refuses an unparsed stage, an unbound stage, and a foreign bind before reading', async () => {
  const calls: string[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query(form, where) {
        calls.push(`${form}: ${where}`);
        return [{ ROWID: '1', C0: 'a', C1: 'b' }];
      },
    },
  });
  const ctx = runtime.context({});
  const read = (zcql: string[]) => runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Item', { op: 'true' }, { zcql }));

  await assert.rejects(read(['DELETE FROM Item']), /staged zcql could not be parsed, so it was not run as SELECT \*/);
  assert.deepEqual(calls, []);

  await assert.rejects(
    read(['SELECT ROWID, C0 FROM Item ORDER BY ROWID', 'SELECT ROWID, C1 FROM Item ORDER BY ROWID']),
    /staged zcql for Item has no row bind \(verified: false\)\. Refusing an unfiltered read/,
  );
  assert.equal(calls.length, 1, 'only the driving stage ran');

  calls.length = 0;
  await assert.rejects(
    read(['SELECT ROWID, C0 FROM Item ORDER BY ROWID', 'SELECT ROWID, C1 FROM Other WHERE ROWID IN (:Other_ROWID) ORDER BY ROWID']),
    /staged zcql bind :Other_ROWID is not a column of Item\. The stage was not run\./,
  );
  assert.equal(calls.join('\n').includes('Other:'), false);
});

test('a split insert whose base insert returns no ROWID writes no extension row', async () => {
  const { layout } = splitLayout('Wide', 300);
  const calls: string[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    splits: { Wide: layout },
    datastore: {
      async insert(form) {
        calls.push(form);
        return {};
      },
    },
  });
  const values: Record<string, string> = {};
  for (let index = 0; index < 300; index++) values[`T${index}`] = 'x';
  await assert.rejects(
    () => runtime.shim.datastore.insert(runtime.context({}), 'Wide', values),
    /split write refused for Wide: the base insert returned no ROWID, so no extension row was written/,
  );
  assert.deepEqual(calls, [layout.base]);
});
