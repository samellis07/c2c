import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BulkDmlError, deleteAllWhere, updateAllWhere, zcqlCount, ZCQL_DML_ROW_CAP } from '../src/bulk-dml.js';

/**
 * A table behind ZCQL with the statement cap: UPDATE and DELETE touch at most
 * 300 matching rows and return no error. WHERE is one `Column = 'value'` test.
 */
function fakeZcql(rows: Record<string, string>[]) {
  const statements: string[] = [];
  const match = (where: string) => {
    const m = /^(\w+) = '([^']*)'$/.exec(where.trim());
    if (!m) throw new Error(`fake ZCQL cannot read ${where}`);
    return (row: Record<string, string>) => row[m[1]!] === m[2];
  };
  const zcql = async (sql: string): Promise<unknown> => {
    statements.push(sql);
    let m = /^SELECT COUNT\(ROWID\) FROM (\w+) WHERE (.+)$/.exec(sql);
    if (m) return [{ [m[1]!]: { 'COUNT(ROWID)': String(rows.filter(match(m[2]!)).length) } }];
    m = /^UPDATE (\w+) SET (\w+) = '([^']*)' WHERE (.+)$/.exec(sql);
    if (m) {
      const hits = rows.filter(match(m[4]!)).slice(0, 300);
      for (const row of hits) row[m[2]!] = m[3]!;
      return [];
    }
    m = /^DELETE FROM (\w+) WHERE (.+)$/.exec(sql);
    if (m) {
      const hits = new Set(rows.filter(match(m[2]!)).slice(0, 300));
      for (let i = rows.length - 1; i >= 0; i--) if (hits.has(rows[i]!)) rows.splice(i, 1);
      return [];
    }
    throw new Error(`fake ZCQL cannot run ${sql}`);
  };
  return { zcql, statements };
}

const table = (n: number, status = 'Open') => Array.from({ length: n }, (_, i) => ({ ROWID: String(i + 1), Status: status }));

test('one ZCQL UPDATE stops at 300 rows without an error (the cap this module works around)', async () => {
  const rows = table(1000);
  const { zcql } = fakeZcql(rows);
  await zcql(`UPDATE Tasks SET Status = 'Closed' WHERE Status = 'Open'`);
  assert.equal(rows.filter((row) => row.Status === 'Closed').length, ZCQL_DML_ROW_CAP);
});

test('updateAllWhere repeats until no row matches: 1000 rows in 4 rounds', async () => {
  const rows = table(1000);
  const { zcql, statements } = fakeZcql(rows);
  const result = await updateAllWhere({ zcql, table: 'Tasks', set: `Status = 'Closed'`, where: `Status = 'Open'`, expected: 1000 });
  assert.deepEqual(result, { matched: 1000, rounds: 4 });
  assert.equal(rows.filter((row) => row.Status === 'Closed').length, 1000);
  assert.equal(statements.filter((sql) => sql.startsWith('UPDATE')).length, 4);
});

test('deleteAllWhere removes every match past 300 and leaves the rest', async () => {
  const rows = [...table(750), ...table(20, 'Keep')];
  const { zcql } = fakeZcql(rows);
  const result = await deleteAllWhere({ zcql, table: 'Tasks', where: `Status = 'Open'` });
  assert.deepEqual(result, { matched: 750, rounds: 3 });
  assert.equal(rows.length, 20);
  assert.ok(rows.every((row) => row.Status === 'Keep'));
});

test('an UPDATE that does not leave its WHERE is stopped after one round, not looped', async () => {
  const rows = table(400);
  const { zcql, statements } = fakeZcql(rows);
  await assert.rejects(
    updateAllWhere({ zcql, table: 'Tasks', set: `Status = 'Open'`, where: `Status = 'Open'` }),
    (err: unknown) => err instanceof BulkDmlError && err.remaining === 400 && /does not take rows out of its WHERE/.test(err.message),
  );
  assert.equal(statements.filter((sql) => sql.startsWith('UPDATE')).length, 1);
});

test('the hard bound stops a run that needs more rounds than allowed', async () => {
  const rows = table(1000);
  const { zcql } = fakeZcql(rows);
  await assert.rejects(deleteAllWhere({ zcql, table: 'Tasks', where: `Status = 'Open'`, maxRounds: 2 }), (err: unknown) => err instanceof BulkDmlError && err.remaining === 400);
});

test('a count different from expected changes nothing', async () => {
  const rows = table(10);
  const { zcql, statements } = fakeZcql(rows);
  await assert.rejects(deleteAllWhere({ zcql, table: 'Tasks', where: `Status = 'Open'`, expected: 9 }), /10 row\(s\) match, expected 9/);
  assert.equal(statements.length, 1);
  assert.equal(rows.length, 10);
});

test('statements need a table identifier and a WHERE clause', async () => {
  const { zcql } = fakeZcql([]);
  await assert.rejects(deleteAllWhere({ zcql, table: 'Tasks; DROP', where: `Status = 'Open'` }), /not a ZCQL identifier/);
  await assert.rejects(deleteAllWhere({ zcql, table: 'Tasks', where: ' ' }), /needs a WHERE clause/);
  assert.equal(zcqlCount({ data: [{ Tasks: { 'COUNT(ROWID)': '7' } }] }), 7);
  assert.throws(() => zcqlCount([{ Tasks: {} }]), /no count/);
});
