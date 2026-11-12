import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import type { FetchLike, MigrateResponse } from '../../data/src/migrate.js';
import { generateSchema } from '../../schema/src/generator.js';
import { deployCli, type Io } from '../src/cli.js';
import { postDeploySteps } from '../src/post-deploy.js';
import type { ProjectRegistry } from '../src/registry.js';
import { backfillPageQuery, backfillShadows, shadowColumns, staleShadowCountQuery, type ShadowColumn } from '../src/shadows.js';
import { applyTablePlan, tableCreatePlan, type RestFn } from '../src/tables.js';

const SCOPE = { org: '10000000000', projectId: '1001', token: 'test-cli-token' };
const RATE: ShadowColumn = { table: 'Item', column: 'Rate', shadow: 'Rate__n' };

const DS = `application "Widget"
{
	form Item
	{
		Rate
		(
			type = decimal
			decimalplace = 2
		)
	}
}
`;

type Row = Record<string, string | number | null>;

/**
 * Data Store stand-in for the backfill: the keyset page query, the stale count, and the row update.
 * Answers are wrapped by table name, as ZCQL REST returns them.
 */
function fakeStore(rows: Row[], opts: { throttle?: { times: number; retryAfter?: string } } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let throttled = 0;
  const res = (body: unknown, status = 200, headers: Record<string, string> = {}): MigrateResponse => ({
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  });
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init?.body ?? 'null') as unknown;
    calls.push({ method: init?.method ?? 'GET', path, body });
    assert.equal(init?.headers?.Authorization, `Bearer ${SCOPE.token}`);
    if (opts.throttle && throttled < opts.throttle.times) {
      throttled += 1;
      return res({}, 429, opts.throttle.retryAfter === undefined ? {} : { 'retry-after': opts.throttle.retryAfter });
    }
    if (path.endsWith('/query')) {
      const sql = (body as { query: string }).query;
      if (sql.startsWith('SELECT COUNT(ROWID)')) {
        return res({ data: [{ Item: { 'COUNT(ROWID)': String(rows.filter((r) => r.Rate__n == null && r.Rate != null).length) } }] });
      }
      const m = /^SELECT ROWID, Rate FROM Item WHERE Rate__n IS NULL(?: AND ROWID > (\d+))? ORDER BY ROWID LIMIT (\d+)$/.exec(sql);
      assert.ok(m, sql);
      const after = m[1] === undefined ? -1n : BigInt(m[1]);
      const page = rows
        .filter((r) => r.Rate__n == null && BigInt(String(r.ROWID)) > after)
        .sort((a, b) => (BigInt(String(a.ROWID)) < BigInt(String(b.ROWID)) ? -1 : 1))
        .slice(0, Number(m[2]));
      return res({ status: 'success', data: page.map((r) => ({ Item: { ROWID: String(r.ROWID), Rate: r.Rate } })) });
    }
    assert.equal(init?.method, 'PUT');
    assert.match(path, /\/baas\/v1\/project\/1001\/table\/Item\/row$/);
    const updates = body as Row[];
    assert.ok(updates.length <= 200);
    for (const update of updates) {
      const row = rows.find((r) => String(r.ROWID) === String(update.ROWID));
      assert.ok(row);
      Object.assign(row, update);
    }
    return res({ status: 'success', data: updates });
  };
  return { fetch, calls };
}

function staleRows(n: number): Row[] {
  // 9007199254740993 is past MAX_SAFE_INTEGER: the ROWID stays a string.
  const rows: Row[] = Array.from({ length: n }, (_, i) => ({ ROWID: String(9007199254740993n + BigInt(i)), Rate: `${i}.25`, Rate__n: null }));
  rows.push({ ROWID: '1', Rate: '', Rate__n: null }, { ROWID: '2', Rate: 'n/a', Rate__n: null }, { ROWID: '3', Rate: '5.00', Rate__n: 5 });
  return rows;
}

test('shadowColumns and the backfill queries', () => {
  const plan = generateSchema(deriveIr(parse(DS)));
  assert.deepEqual(shadowColumns(plan), [RATE]);
  assert.equal(staleShadowCountQuery(RATE), 'SELECT COUNT(ROWID) FROM Item WHERE Rate__n IS NULL AND Rate IS NOT NULL');
  assert.equal(backfillPageQuery(RATE, undefined, 200), 'SELECT ROWID, Rate FROM Item WHERE Rate__n IS NULL ORDER BY ROWID LIMIT 200');
  assert.equal(backfillPageQuery(RATE, '42', 200), 'SELECT ROWID, Rate FROM Item WHERE Rate__n IS NULL AND ROWID > 42 ORDER BY ROWID LIMIT 200');
  assert.throws(() => backfillPageQuery(RATE, '1 OR 1=1', 200), /not an integer/);
  assert.throws(() => staleShadowCountQuery({ ...RATE, table: 'Item; DROP' }), /identifier/);
});

test('backfillShadows fills NULL shadows from the varchar, 200 rows a page, by ROWID keyset', async () => {
  const rows = staleRows(450);
  const store = fakeStore(rows);
  const sleeps: number[] = [];
  const [result] = await backfillShadows({ fetch: store.fetch, catalystBase: 'https://api.catalyst.zoho.in', dc: 'in', scope: SCOPE, columns: [RATE], sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(result, { ...RATE, scanned: 452, filled: 450, skipped: 2 });
  assert.equal(rows.find((r) => r.ROWID === '9007199254740993')?.Rate__n, 0.25);
  assert.equal(rows.find((r) => r.ROWID === String(9007199254740993n + 449n))?.Rate__n, 449.25);
  // Blank and non-numeric varchars have no shadow; the row that had one is untouched.
  assert.equal(rows.find((r) => r.ROWID === '1')?.Rate__n, null);
  assert.equal(rows.find((r) => r.ROWID === '2')?.Rate__n, null);
  assert.equal(rows.find((r) => r.ROWID === '3')?.Rate__n, 5);
  const queries = store.calls.filter((c) => c.path.endsWith('/query')).map((c) => (c.body as { query: string }).query);
  assert.deepEqual(queries.map((q) => /ROWID > (\d+)/.exec(q)?.[1] ?? 'first'), ['first', String(9007199254740993n + 197n), String(9007199254740993n + 397n)]);
  assert.deepEqual(store.calls.filter((c) => c.method === 'PUT').map((c) => (c.body as unknown[]).length), [198, 200, 52]);
  // Paced: one pause between pages, none before the first.
  assert.deepEqual(sleeps, [250, 250]);
  // Idempotent: a second run reads only the rows that have no shadow.
  const again = fakeStore(rows);
  const [second] = await backfillShadows({ fetch: again.fetch, catalystBase: 'https://api.catalyst.zoho.in', dc: 'in', scope: SCOPE, columns: [RATE], pauseMs: 0 });
  assert.deepEqual(second, { ...RATE, scanned: 2, filled: 0, skipped: 2 });
  assert.equal(again.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('backfillShadows waits Retry-After on 429 and stops on a wait it will not take', async () => {
  const rows = staleRows(3);
  const sleeps: number[] = [];
  const store = fakeStore(rows, { throttle: { times: 2, retryAfter: '3' } });
  const [ok] = await backfillShadows({ fetch: store.fetch, catalystBase: 'https://api.catalyst.zoho.in', dc: 'in', scope: SCOPE, columns: [RATE], sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(ok, { ...RATE, scanned: 5, filled: 3, skipped: 2 });
  assert.deepEqual(sleeps, [3000, 3000]);
  // No header: exponential backoff, then give up after the retry cap with the counts so far.
  const noHeader: number[] = [];
  const stuck = fakeStore(staleRows(3), { throttle: { times: 99 } });
  const [failed] = await backfillShadows({ fetch: stuck.fetch, catalystBase: 'https://api.catalyst.zoho.in', dc: 'in', scope: SCOPE, columns: [RATE], sleep: async (ms) => void noHeader.push(ms) });
  assert.deepEqual(noHeader, [500, 1000, 2000, 4000]);
  assert.equal(failed?.filled, 0);
  assert.match(failed?.error ?? '', /rate limited \(429\) 5 times/);
  const long = fakeStore(staleRows(3), { throttle: { times: 1, retryAfter: '120' } });
  const [refused] = await backfillShadows({ fetch: long.fetch, catalystBase: 'https://api.catalyst.zoho.in', dc: 'in', scope: SCOPE, columns: [RATE], sleep: async () => assert.fail('must not wait') });
  assert.match(refused?.error ?? '', /Retry-After asks for 120s, more than the 60s max wait/);
  // Only the DC's Catalyst hosts.
  const [offHost] = await backfillShadows({ fetch: store.fetch, catalystBase: 'https://evil.example.test.com', dc: 'in', scope: SCOPE, columns: [RATE] });
  assert.match(offHost?.error ?? '', /allow-list/);
});

function tableRest(existing: { table: string; columns: string[]; rows: number | 'error' }[]): { rest: RestFn; queries: string[] } {
  const queries: string[] = [];
  const rest: RestFn = async (call) => {
    if (call.method === 'GET' && call.path.endsWith('/table')) {
      return { status: 200, body: { data: existing.map((t, i) => ({ table_name: t.table, table_id: `t${i}`, column_details: t.columns.map((column_name) => ({ column_name })) })) } };
    }
    if (call.method === 'POST' && call.path.endsWith('/query')) {
      const sql = (call.body as { query: string }).query;
      queries.push(sql);
      const table = existing.find((t) => sql === `SELECT COUNT(ROWID) FROM ${t.table}`);
      if (!table || table.rows === 'error') return { status: 500, body: {} };
      return { status: 200, body: { data: [{ [table.table]: { 'COUNT(ROWID)': String(table.rows) } }] } };
    }
    if (call.method === 'POST' && call.path.endsWith('/table')) return { status: 200, body: { data: { table_id: 'new' } } };
    if (call.method === 'POST' && call.path.endsWith('/column')) return { status: 200, body: { status: 'success' } };
    return { status: 404, body: {} };
  };
  return { rest, queries };
}

test('a shadow column created on a table that has rows is a backfill post-deploy step', async () => {
  const steps = tableCreatePlan(generateSchema(deriveIr(parse(DS))));
  const before = steps[0]!.columns.map((c) => c.column_name).filter((name) => name !== 'Rate__n');
  // The table exists from a deploy before the shadow column: Rate__n is created now, on 12 rows.
  const old = tableRest([{ table: 'Item', columns: before, rows: 12 }]);
  const diff = await applyTablePlan('1001', steps, old.rest);
  assert.deepEqual(diff.createdColumns, ['Item.Rate__n']);
  assert.deepEqual(diff.shadowsOnExistingRows, [{ table: 'Item', column: 'Rate', shadow: 'Rate__n', rows: 12 }]);
  const post = postDeploySteps('1001', ['Data Store'], { shadowsOnExistingRows: diff.shadowsOnExistingRows, org: SCOPE.org });
  const backfill = post.find((step) => step.kind === 'backfill');
  assert.equal(
    backfill?.text,
    'Data Store: shadow columns were added to tables that already have rows: Item.Rate__n (12 rows). Those rows have a NULL shadow, so every decimal criteria on them reads them all and checks the varchar. Run: c2c deploy <app> --project 1001 --org 10000000000 --backfill-shadows --confirm',
  );
  // Empty table: nothing to backfill. A failed count still warns.
  const empty = await applyTablePlan('1001', steps, tableRest([{ table: 'Item', columns: before, rows: 0 }]).rest);
  assert.equal(empty.shadowsOnExistingRows, undefined);
  const unknown = await applyTablePlan('1001', steps, tableRest([{ table: 'Item', columns: before, rows: 'error' }]).rest);
  assert.deepEqual(unknown.shadowsOnExistingRows, [{ table: 'Item', column: 'Rate', shadow: 'Rate__n' }]);
  assert.match(postDeploySteps('1001', ['Data Store'], { shadowsOnExistingRows: unknown.shadowsOnExistingRows }).at(-1)!.text, /Item\.Rate__n \(row count unknown\)/);
  // A new table has no old rows, and is not counted.
  const fresh = tableRest([]);
  const created = await applyTablePlan('1001', steps, fresh.rest);
  assert.equal(created.shadowsOnExistingRows, undefined);
  assert.deepEqual(fresh.queries, []);
});

test('c2c deploy --backfill-shadows plans without --confirm and backfills with it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backfill-'));
  const ds = join(dir, 'widget.ds');
  writeFileSync(ds, DS);
  const registry: ProjectRegistry = { org: SCOPE.org, dc: 'in', env: 'Development', projects: { 'c2c-widget': '1001' }, never_touch: {} };
  const projects = join(dir, 'projects.json');
  writeFileSync(projects, JSON.stringify(registry));
  const rows = staleRows(2);
  const store = fakeStore(rows);
  let out = '';
  const io: Io = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (out += text),
    env: { X_ZC_CREDENTIAL_PATH: '/tmp/cred-DO-NOT-PRINT' },
    cliDc: () => undefined,
    spawn: async () => assert.fail('backfill does not spawn the catalyst CLI'),
    fetch: store.fetch,
    rest: async (call) => {
      if (call.method === 'GET' && call.path === `/baas/v1/project/${SCOPE.projectId}`) {
        return { status: 200, body: { data: { id: SCOPE.projectId, org_id: SCOPE.org } } };
      }
      assert.fail(`backfill uses admin REST only for the project-details check, not ${call.method} ${call.path}`);
    },
    accessToken: async () => SCOPE.token,
    sleep: async () => {},
  };
  const args = [ds, '--project', '1001', '--org', SCOPE.org, '--projects', projects, '--backfill-shadows'];
  assert.equal(await deployCli(args, io), 0);
  assert.match(out, /c2c backfill-shadows plan v1[\s\S]*- Item\.Rate__n from Rate where Rate__n IS NULL[\s\S]*writes: no/);
  assert.equal(store.calls.length, 0);
  out = '';
  assert.equal(await deployCli([...args, '--confirm'], io), 0);
  assert.equal(out, 'backfill Item.Rate__n from Rate: scanned 4 filled 2 skipped 2\n');
  assert.deepEqual(rows.map((r) => r.Rate__n), [0.25, 1.25, null, null, 5]);
});
