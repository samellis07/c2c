import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EncryptedCriteriaError, compileCriteria, matchRow, type Criteria } from '../src/criteria.js';
import { DEFAULT_APP_TIMEZONE, TimeZoneRequired, parseLiteral, requireZone, resolveAppTimeZone } from '../src/date.js';
import { decimal } from '../src/decimal.js';
import { RecordAccessError, authorizeWrite, expandCompositeWrites, principalFromRequest, type AccessPolicy } from '../src/access.js';
import { DelugeRuntimeError, StaleWriteError, UntranslatedConstruct } from '../src/errors.js';
import {
  DRY_RUN_ADMIN_USER,
  DRY_RUN_LOGIN_USER,
  LIMITS,
  MissingRowIdError,
  RangeIndexError,
  ZcqlRowCapError,
  createRuntime,
  jobPoolName,
  needsExactRead,
  readMultiLookupValues,
} from '../src/runtime.js';
import { translate } from '../../deluge/src/translate.js';
import { mockDatastore } from './zcql-mock.js';

test('decimal division keeps 20 fractional digits and is not a JS float', () => {
  assert.equal(decimal.add('10.50', '0.25').toString(), '10.75');
  assert.equal(decimal.sub('1.0', '0.3').toString(), '0.7');
  // Product scale is the sum of the factors' scales (golden decimal.mul is "5.00").
  assert.equal(decimal.mul('1.25', '4').toString(), '5.00');
  const third = decimal.div('1', '3').toString();
  assert.equal(third, `0.${'3'.repeat(20)}`);
  assert.notEqual(String(1 / 3), third);
});

test('multi lookup junction rows read back in row_order', async () => {
  const calls: unknown[][] = [];
  const values = await readMultiLookupValues(async (form, where, limit, offset, orderBy) => {
    calls.push([form, where, limit, offset, orderBy]);
    return offset ? [] : [{ Members: '700', row_order: '0' }, { Members: '500', row_order: '1' }, { Members: '600', row_order: '2' }];
  }, { table: 'Team__Members', parentColumn: 'parent_id', valueColumn: 'Members', orderColumn: 'row_order' }, '900');
  assert.deepEqual(values, ['700', '500', '600']);
  assert.deepEqual(calls[0], ['Team__Members', "parent_id = '900'", 300, 0, 'ORDER BY row_order, ROWID']);
});

test('generated record reads hydrate multi lookups from ordered junction rows', async () => {
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    multiLookups: { Team: { Members: { table: 'Team__Members', parentColumn: 'parent_id', valueColumn: 'Members', orderColumn: 'row_order' } } },
    datastore: { query: async (form, where, _limit, offset) => form === 'Team'
      ? [{ ROWID: '900', Name: 'Core' }]
      : !offset && where.includes("'900'") ? [{ Members: '700', row_order: '0' }, { Members: '500', row_order: '1' }] : [] },
  });
  const ctx = runtime.context({});
  const rows = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Team', { op: 'true' }));
  assert.deepEqual(runtime.shim.record.get(rows[0]!, 'Members'), ['700', '500']);
});

test('dry-run record reads hydrate multi lookups from seeded junction rows without datastore calls', async () => {
  let calls = 0;
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    multiLookups: { Team: { Members: { table: 'Team__Members', parentColumn: 'parent_id', valueColumn: 'Members', orderColumn: 'row_order' } } },
    seed: {
      Team: [{ ROWID: '900', Name: 'Core' }],
      Team__Members: [
        { ROWID: '2', parent_id: '900', Members: '500', row_order: '1' },
        { ROWID: '1', parent_id: '900', Members: '700', row_order: '0' },
      ],
    },
    datastore: { query: async () => { calls++; return []; } },
  });
  const ctx = runtime.context({});
  const rows = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'Team', { op: 'true' }));
  assert.deepEqual(runtime.shim.record.get(rows[0]!, 'Members'), ['700', '500']);
  assert.equal(calls, 0);
});

test('app time zone: env, then IR setting; UTC is a labelled dry-run fallback only', () => {
  assert.throws(() => requireZone(undefined), TimeZoneRequired);
  assert.throws(() => requireZone('Not/AZone'), RangeError);
  assert.equal(resolveAppTimeZone(undefined, undefined), DEFAULT_APP_TIMEZONE);
  assert.throws(() => resolveAppTimeZone(undefined, undefined, false), TimeZoneRequired);
  assert.equal(resolveAppTimeZone('', 'Asia/Kolkata', false), 'Asia/Kolkata');
  assert.equal(resolveAppTimeZone('America/New_York', 'Asia/Kolkata'), 'America/New_York');
  const literal = parseLiteral('01-Jan-2020');
  assert.equal(literal.toString().includes('2020'), true);

  const prev = process.env.C2C_APP_TIMEZONE;
  delete process.env.C2C_APP_TIMEZONE;
  try {
    assert.throws(() => createRuntime({ dryRun: false }), TimeZoneRequired);
    assert.throws(() => createRuntime({ dryRun: false, appTimeZone: '  ', settingsTimeZone: '' }), TimeZoneRequired);
  } finally {
    if (prev === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = prev;
  }

  const fallback = createRuntime({ dryRun: true, now: new Date('2020-01-01T00:30:00Z') });
  const fallbackCtx = fallback.context({});
  const fallbackToday = fallback.shim.zoho.currentDate(fallbackCtx);
  assert.equal(fallbackCtx.appTimeZone, 'UTC');
  assert.match(String(fallbackToday), /2020|2019/);
  const label = fallback.transcript.find((e) => e.op === 'timezone');
  assert.equal(label?.fallback, true);
  assert.equal(label?.zone, 'UTC');
  assert.match(String(label?.label), /dry-run UTC fallback/);

  const fromSettings = createRuntime({ dryRun: true, settingsTimeZone: 'Asia/Kolkata', now: new Date('2020-01-01T00:30:00Z') });
  assert.equal(fromSettings.context({ appTimeZone: undefined }).appTimeZone, 'Asia/Kolkata');
  assert.equal(fromSettings.transcript.some((e) => e.op === 'timezone'), false);
  const settingsToday = fromSettings.shim.zoho.currentDate(fromSettings.context({}));
  assert.match(String(settingsToday), /2020/);

  const zoned = createRuntime({
    dryRun: true,
    appTimeZone: 'America/New_York',
    settingsTimeZone: 'Asia/Kolkata',
    now: new Date('2020-01-01T00:30:00Z'),
  });
  assert.equal(zoned.context({}).appTimeZone, 'America/New_York');

  const live = createRuntime({ dryRun: false, settingsTimeZone: 'Asia/Kolkata' });
  assert.equal(live.context({}).appTimeZone, 'Asia/Kolkata');
  assert.equal(live.transcript.some((e) => e.op === 'timezone'), false);
});


test('date methods accept bigint', () => {
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({});
  const d = runtime.shim.date.parse('01-Jan-2024', ctx);
  const result = runtime.shim.date.addDay(d, 3n, ctx);
  assert.equal(result?.d, 4);
});

test('a blank date is null for arithmetic, and toString is not the literal "null"', () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata' });
  const ctx = runtime.context({});
  // https://www.zoho.com/deluge/help/functions/common/tostring.html
  // Creator returns the given text when it does not recognize a date-time, not null.
  assert.equal(runtime.shim.date.format('', 'yyyy-MM-dd', ctx), '');
  assert.equal(runtime.shim.date.format(null, 'yyyy-MM-dd', ctx), '');
  assert.equal(runtime.shim.date.format(undefined, 'yyyy-MM-dd', ctx), '');
  assert.equal(runtime.shim.date.format('   ', 'yyyy-MM-dd', ctx), '   ');
  assert.equal(runtime.shim.date.format('not-a-date', 'yyyy-MM-dd', ctx), 'not-a-date');
  assert.throws(() => runtime.shim.date.format(new Date('invalid'), 'yyyy-MM-dd', ctx), /UnParsable date/);
  assert.equal(`Membership Start Date: ${runtime.shim.date.format(null, 'dd-MMM-yyyy', ctx)}`, 'Membership Start Date: ');
  assert.notEqual(`Membership Start Date: ${runtime.shim.date.format(null, 'dd-MMM-yyyy', ctx)}`, 'Membership Start Date: null');
  assert.equal(runtime.shim.date.text(null, ctx), '');
  assert.equal(runtime.shim.date.text(undefined, ctx), '');
  assert.equal(runtime.shim.date.text('', ctx), '');
  assert.equal(runtime.shim.date.text(new Date('invalid'), ctx), 'Invalid Date');
  assert.equal(runtime.shim.date.addDay(undefined, 3, ctx), null);
  assert.equal(runtime.shim.date.addDay('   ', 1, ctx), null);
  assert.equal(runtime.shim.date.cmp('', '01-Jan-2020', ctx), null);
  assert.equal(runtime.shim.date.getYear('', ctx), null);
  const parsed = runtime.shim.date.format('01-Jan-2020', 'yyyy-MM-dd', ctx);
  assert.equal(parsed, '2020-01-01');
  assert.equal(runtime.shim.date.rel('02-Jan-2020', '01-Jan-2020', '>', ctx), true);
  assert.equal(runtime.shim.date.rel(null, null, '==', ctx), true);
  assert.equal(runtime.shim.date.rel(null, '01-Jan-2020', '==', ctx), false);
  // JS coercion we must not follow: null <= 0 and null >= 0 are true.
  const jsNull = null as unknown as number;
  assert.equal(jsNull <= 0, true);
  assert.equal(jsNull >= 0, true);
  assert.equal(runtime.shim.date.rel(null, '01-Jan-2020', '<', ctx), false);
  assert.equal(runtime.shim.date.rel(null, '01-Jan-2020', '>', ctx), false);
  assert.equal(runtime.shim.date.rel(null, '01-Jan-2020', '<=', ctx), false);
  assert.equal(runtime.shim.date.rel(null, '01-Jan-2020', '>=', ctx), false);
  assert.throws(() => runtime.shim.date.rel('01-Jan-2020', null, '>', ctx), /UnParsable date/);
  assert.throws(() => runtime.shim.date.rel(null, null, '<', ctx), /UnParsable date/);
  assert.throws(() => runtime.shim.date.rel('', '01-Jan-2020', '>=', ctx), /UnParsable date/);
  assert.equal(runtime.shim.isNull(null), true);
  assert.equal(runtime.shim.isNull(''), true);
  assert.equal(runtime.shim.isNull(' '), false);
  assert.equal(runtime.shim.isNull(0), false);
  assert.equal(runtime.shim.isBlank(' '), true);
  assert.equal(runtime.shim.isBlank(''), true);
  assert.equal(runtime.shim.isBlank(0), false);
  assert.equal(runtime.shim.isNumber('1e2'), false);
  assert.equal(runtime.shim.isNumber(' 12'), true);
  assert.equal(runtime.transcript.some((e) => e.construct === 'blank-date-rel'), false);
});

test('dry-run insert warns on varchar 255 and does not truncate or perform the write', async () => {
  const runtime = createRuntime({ dryRun: true });
  const long = 'x'.repeat(256);
  const ctx = runtime.context({});
  const result = await runtime.shim.datastore.insert(ctx, 'Orders', { Name: long, Amount: '2' });
  assert.deepEqual(result, { dryRun: true, form: 'Orders' });
  const warn = runtime.transcript.find((e) => e.op === 'warn');
  assert.equal(warn?.code, 'VARCHAR_255');
  assert.equal(warn?.length, 256);
  const insert = runtime.transcript.find((e) => e.op === 'insert');
  assert.equal(insert?.performed, false);
  assert.equal(insert?.dryRun, true);
  assert.equal(insert?.batchSize, LIMITS.insertRowsPerCall);
  assert.equal(LIMITS.insertRowsPerCall, 200);
  assert.equal(LIMITS.updateRowsPerCall, 200);
  const stored = insert?.rows as { Name?: string };
  assert.equal(stored.Name?.length, 256);

  await runtime.shim.datastore.update(ctx, 'Orders', { op: 'true' }, { Name: 'A' });
  await runtime.shim.datastore.delete(ctx, 'Orders', { op: '==', field: 'ID', value: 1 });
  assert.equal(runtime.transcript.find((e) => e.op === 'update')?.performed, false);
  assert.equal(runtime.transcript.find((e) => e.op === 'delete')?.performed, false);
});

test('fetch pages at 300 rows and mail/http are not performed', async () => {
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({});
  const query = runtime.shim.datastore.query(ctx, 'Orders', { op: '==', field: 'Status', value: 'Open' });
  const rows = await runtime.shim.datastore.rows(ctx, query);
  assert.deepEqual(rows, []);
  const fetch = runtime.transcript.find((e) => e.op === 'fetch');
  assert.equal(fetch?.limit, 300);
  assert.equal(LIMITS.zcqlRowsPerQuery, 300);
  await runtime.shim.mail.send(ctx, { to: 'a@b.c', message: 'hi' });
  await runtime.shim.http.invokeurl(ctx, { url: 'https://example.test' });
  assert.equal(runtime.transcript.find((e) => e.op === 'sendmail')?.performed, false);
  assert.equal(runtime.transcript.find((e) => e.op === 'invokeurl')?.performed, false);
});

test('encrypted columns accept equality only and IN lists stay lists', () => {
  const encrypted = new Set(['Secret']);
  assert.equal(compileCriteria({ op: '==', field: 'Secret', value: 'a' }, encrypted), "Secret = 'a'");
  assert.throws(
    () => compileCriteria({ op: 'contains', field: 'Secret', value: 'a' }, encrypted),
    EncryptedCriteriaError,
  );
  assert.equal(
    compileCriteria({ op: 'in', field: 'Status', value: ['Open', 'Hold'] }),
    "Status IN ('Open', 'Hold')",
  );
  assert.equal(compileCriteria({ op: 'contains', field: 'Name', value: 'Ada' }), "Name LIKE '*Ada*'");
});

// The ZCQL wildcard is `*`, not `%`. `%`, `_`, and `\` are literal;
// a literal `*` or `?` in the value has no escape, so the LIKE is
// a segment superset and the exact in-memory pass decides (needsExactRead).
test('ZCQL LIKE uses *, keeps %, _, and \\ literal, and widens literal * or ? into a superset', () => {
  assert.equal(compileCriteria({ op: 'contains', field: 'Name', value: 'Ada' }), "Name LIKE '*Ada*'");
  assert.equal(compileCriteria({ op: 'startsWith', field: 'Name', value: 'Ada' }), "Name LIKE 'Ada*'");
  assert.equal(compileCriteria({ op: 'endsWith', field: 'Name', value: 'Ada' }), "Name LIKE '*Ada'");
  assert.equal(compileCriteria({ op: 'contains', field: 'Name', value: '10% off' }), "Name LIKE '*10% off*'");
  assert.equal(compileCriteria({ op: 'contains', field: 'Name', value: 'a_b' }), "Name LIKE '*a_b*'");
  assert.equal(compileCriteria({ op: 'contains', field: 'Name', value: 'a\\b' }), "Name LIKE '*a\\b*'");
  assert.equal(compileCriteria({ op: 'contains', field: 'Name', value: "o'clock" }), "Name LIKE '*o''clock*'");
  assert.equal(compileCriteria({ op: 'contains', field: 'Name', value: 'a*b' }), "Name LIKE '*a*b*'");
  assert.equal(compileCriteria({ op: 'startsWith', field: 'Name', value: '*a' }), "Name LIKE '*a*'");
  assert.equal(compileCriteria({ op: 'startsWith', field: 'Name', value: 'a?b' }), "Name LIKE 'a*b*'");
  assert.equal(compileCriteria({ op: 'endsWith', field: 'Name', value: 'b*' }), "Name LIKE '*b*'");
  assert.equal(compileCriteria({ op: 'endsWith', field: 'Name', value: '*' }), "Name LIKE '*'");
  assert.equal(needsExactRead({ op: 'contains', field: 'Name', value: 'a*b' }, undefined, {}), true);
  assert.equal(needsExactRead({ op: 'contains', field: 'Name', value: 'a%b' }, undefined, {}), false);
  assert.equal(compileCriteria({ op: 'not', arg: { op: 'contains', field: 'Name', value: 'a*b' } }), "(NOT (ROWID IS NULL))");
  assert.deepEqual(matchRow({ Name: 'xa*by' }, { op: 'contains', field: 'Name', value: 'a*b' }), true);
  assert.deepEqual(matchRow({ Name: 'xab' }, { op: 'contains', field: 'Name', value: 'a*b' }), false);
  assert.deepEqual(matchRow({ Name: '10% off' }, { op: 'contains', field: 'Name', value: '10% off' }), true);
  assert.deepEqual(matchRow({ Name: 'a?b' }, { op: 'startsWith', field: 'Name', value: 'a?b' }), true);
});

test('compileCriteria never emits a bare ZCQL true/false predicate', () => {
  // ZCQL has no boolean literal predicate: an all-rows operand carries no
  // clause. AND drops it, OR of it stays the always-true marker (callers strip
  // that to no WHERE), NOT of it matches nothing.
  const cases: [Criteria, string][] = [
    [{ op: 'and', args: [{ op: '==', field: 'ROWID', value: '42' }, { op: 'true' }] }, "(ROWID = '42')"],
    [{ op: 'and', args: [{ op: 'true' }, { op: 'true' }] }, 'true'],
    [{ op: 'or', args: [{ op: 'true' }, { op: '==', field: 'Status', value: 'Open' }] }, 'true'],
    [{ op: 'and', args: [{ op: '==', field: 'Status', value: 'Open' }, { op: 'or', args: [{ op: 'true' }, { op: '==', field: 'Kind', value: 'x' }] }] }, "(Status = 'Open')"],
    [{ op: 'not', arg: { op: 'true' } }, '(ROWID IS NULL)'],
    [{ op: 'and', args: [{ op: 'not', arg: { op: 'true' } }, { op: '==', field: 'Status', value: 'Open' }] }, "((ROWID IS NULL) AND Status = 'Open')"],
    // A boolean leaf compiles as `Field = true` (unquoted, [UNVERIFIED]: whether
    // live ZCQL wants `= true` or `= 'true'` on a Boolean column needs a live
    // probe; this keeps the pre-existing spelling until the fact lands).
    [{ op: '==', field: 'Active', value: true }, 'Active = true'],
    [{ op: '==', field: 'Active', value: false }, 'Active = false'],
  ];
  for (const [criteria, expected] of cases) {
    const where = compileCriteria(criteria);
    assert.equal(where, expected);
    // No bare boolean literal as a whole predicate operand anywhere in the
    // WHERE (`true` alone is the marker callers strip to no WHERE; a `= true`
    // leaf operand is the unverified pre-existing spelling, not a clause).
    const unquoted = where.replace(/'[^']*'/g, "''");
    if (where !== 'true') assert.doesNotMatch(unquoted, /(\(|\bAND\b|\bOR\b|\bNOT\b)\s*(true|false)\b|\b(true|false)\s*(\)|\bAND\b|\bOR\b)/, where);
  }
  // The always-true marker stays the marker callers strip to no WHERE.
  assert.equal(compileCriteria({ op: 'true' }), 'true');
});

test('record reads use the profile grant and the report filter, and never return a hidden field', async () => {
  const access = {
    profiles: {
      Staff: {
        Orders: {
          fields: ['Status'],
          recordFilter: { op: '==' as const, field: 'Owner', value: { __bind: 'loginUser' as const } },
        },
      },
    },
    roles: ['Librarian'],
  };
  let where = '';
  let queries = 0;
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    datastore: {
      async query(_form, zcql) {
        queries += 1;
        where = zcql;
        return [{ Status: 'Open', Secret: 'nope', Owner: 'ada@example.test' }];
      },
    },
  });
  const ctx = runtime.context({
    principal: { profile: 'Staff', role: 'Librarian', loginUser: 'ada@example.test' },
  });
  const query = runtime.shim.datastore.query(ctx, 'Orders', { op: '==', field: 'Status', value: 'Open' });
  const rows = await runtime.shim.datastore.rows(ctx, query);
  assert.equal(where.includes("Owner = 'ada@example.test'"), true);
  assert.equal(where.includes("Status = 'Open'"), true);
  assert.deepEqual(rows[0]?.values, { Status: 'Open' });
  assert.equal(Object.hasOwn(rows[0]?.values ?? {}, 'Secret'), false);

  const before = queries;
  await assert.rejects(() => runtime.shim.datastore.field(ctx, query, 'Secret'), RecordAccessError);
  assert.equal(queries, before);

  const invoices = runtime.shim.datastore.query(ctx, 'Invoices', { op: 'true' });
  await assert.rejects(() => runtime.shim.datastore.rows(ctx, invoices), RecordAccessError);

  const ghost = runtime.context({ principal: { profile: 'Staff', role: 'Ghost', loginUser: 'ada@example.test' } });
  await assert.rejects(() => runtime.shim.datastore.rows(ghost, query), RecordAccessError);

  const unbound = runtime.context({ principal: { profile: 'Staff', role: 'Librarian' } });
  await assert.rejects(() => runtime.shim.datastore.rows(unbound, query), RecordAccessError);
  // The email is zoho.loginuserid. It must not satisfy a zoho.loginuser filter.
  const emailOnly = runtime.context({ principal: { profile: 'Staff', role: 'Librarian', userId: 'ada@example.test' } });
  await assert.rejects(() => runtime.shim.datastore.rows(emailOnly, query), RecordAccessError);

  assert.equal(principalFromRequest({ body: { user: { profile: 'Staff', email: 'ada@example.test' } } }), null);
  // req.auth.user is not a trusted source: it must not become the principal.
  assert.equal(principalFromRequest({ auth: { user: { profile: 'Admin', email: 'eve@example.test' } } }), null);
  assert.equal(principalFromRequest({ headers: { user: { profile: 'Admin' } }, query: { user: { profile: 'Admin' } } }), null);
  const trusted = principalFromRequest({ user: { profile: 'Staff', role: 'Librarian', email: 'ada@example.test' } });
  assert.deepEqual(trusted, { profile: 'Staff', role: 'Librarian', userId: 'ada@example.test' });
  assert.deepEqual(
    principalFromRequest({ user: { profile: 'Staff', email: 'ada@example.test', id: '123', loginUser: 'ada' } }),
    { profile: 'Staff', loginUser: 'ada', userId: 'ada@example.test' },
  );
});

test('prepare copies stored Added_User through the read policy and does not stamp a hidden row', async () => {
  const access = {
    profiles: {
      Staff: {
        Item: { recordFilter: { op: '==' as const, field: 'Added_User', value: { __bind: 'loginUser' as const } } },
      },
    },
    roles: [] as string[],
  };
  let where = '';
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    datastore: {
      async query(_form, zcql) {
        where = zcql;
        if (!zcql.includes("Added_User = 'ada'") || !zcql.includes("ROWID = 'row-1'")) return [];
        return [{ ROWID: 'row-1', Added_User: 'ada', Added_Time: '13-Apr-2023 17:21:24', Secret: 'nope' }];
      },
    },
  });
  const ada = runtime.context({
    record: { Added_User: 'eve', Status: 'Open' },
    principal: { profile: 'Staff', loginUser: 'ada' },
    rowId: 'row-1',
  });
  await runtime.shim.record.prepare(ada, 'Item', 'update');
  assert.equal(where.includes("ROWID = 'row-1'"), true);
  assert.equal(where.includes("Added_User = 'ada'"), true);
  assert.equal(ada.record.Added_User, 'ada');
  assert.equal(ada.record.Added_Time, '13-Apr-2023 17:21:24');
  assert.equal(ada.record.Status, 'Open');
  assert.equal(Object.hasOwn(ada.record, 'Secret'), false);
  assert.equal(ada.record.Modified_User, 'ada');
  assert.equal(runtime.transcript.some((entry) => entry.op === 'system-fields' && entry.write === 'update'), true);

  where = '';
  const hidden = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    datastore: {
      async query(_form, zcql) {
        where = zcql;
        return [];
      },
    },
  });
  const bob = hidden.context({
    record: { Added_User: 'bob' },
    principal: { profile: 'Staff', loginUser: 'bob' },
    rowId: 'row-1',
  });
  await assert.rejects(() => hidden.shim.record.prepare(bob, 'Item', 'update'), RecordAccessError);
  assert.equal(where.includes("ROWID = 'row-1'"), true);
  assert.equal(where.includes("Added_User = 'bob'"), true);
  assert.equal(hidden.transcript.some((entry) => entry.op === 'system-fields'), false);
});

test('a live update drops the merged system columns and never writes Added_* back', async () => {
  const access = {
    profiles: {
      Staff: { Item: { fields: ['Status'], write: true, writable: ['Status'] } },
      Reader: { Item: { fields: ['Status'] } },
    },
    roles: [] as string[],
  };
  const table = [{ ROWID: 'row-1', Added_User: 'ada', Added_Time: '2023-04-13T17:21:24', Status: 'Open' }];
  const updates: Record<string, unknown>[][] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    now: new Date('2026-10-09T00:00:00Z'),
    datastore: {
      async query(_form, where, limit, offset = 0) {
        const id = /ROWID = '([^']+)'/.exec(where)?.[1];
        const rows = id === undefined ? table : table.filter((row) => row.ROWID === id);
        return rows.slice(offset, offset + limit).map((row) => ({ ...row }));
      },
      async update(_form, rows) {
        updates.push(rows);
        for (const change of rows) {
          const row = table.find((item) => item.ROWID === String(change.ROWID));
          if (row) Object.assign(row, change);
        }
        return { updated: rows.length };
      },
    },
  });
  // The generated edit path: prepare merges the stored system columns into
  // ctx.record for the script and the reply; the update must not write them back.
  const ctx = runtime.context({
    record: { Status: 'Closed' },
    principal: { profile: 'Staff', loginUser: 'staff.user' },
    rowId: 'row-1',
  });
  await runtime.shim.record.prepare(ctx, 'Item', 'update');
  assert.equal(ctx.record.Added_Time, '2023-04-13T17:21:24');
  const result = await runtime.shim.datastore.update(ctx, 'Item', { op: '==', field: 'ROWID', value: 'row-1' }, ctx.record);
  assert.deepEqual(result, { updated: 1 });
  assert.equal(updates.length, 1);
  const written = updates[0]![0]!;
  assert.equal(written.ROWID, 'row-1');
  assert.equal(written.Status, 'Closed');
  assert.equal(written.Modified_User, 'staff.user');
  assert.match(String(written.Modified_Time), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  const addedKeys = new Set(['added_user', 'added_time', 'createdtime']);
  for (const key of Object.keys(written)) {
    assert.equal(addedKeys.has(key.toLowerCase()), false, key);
  }
  assert.equal(table[0]!.Status, 'Closed');
  assert.equal(table[0]!.Added_Time, '2023-04-13T17:21:24');
  assert.equal(table[0]!.Added_User, 'ada');
  // ctx.record keeps the merged columns for the reply and on-success scripts.
  assert.equal(ctx.record.Added_Time, '2023-04-13T17:21:24');

  // A profile without the edit grant is refused even on a clean payload.
  const reader = runtime.context({ record: {}, principal: { profile: 'Reader' } });
  await assert.rejects(
    () => runtime.shim.datastore.update(reader, 'Item', { op: '==', field: 'ROWID', value: 'row-1' }, { Status: 'Open' }),
    RecordAccessError,
  );
  assert.equal(updates.length, 1);

  // A system column in the request values is refused at write screening.
  for (const key of ['Added_Time', 'Modified_Time', 'added_time', 'modified_time']) {
    assert.throws(() => authorizeWrite(access, { profile: 'Staff' }, 'Item', { [key]: 'x' }), RecordAccessError, key);
  }
  // The deny applies in an open policy too (no field list to match against).
  const openAccess = { profiles: { Staff: { Item: { write: true } } }, roles: [] as string[] };
  for (const key of ['Added_Time', 'Modified_Time']) {
    assert.throws(() => authorizeWrite(openAccess, { profile: 'Staff' }, 'Item', { [key]: 'x' }), RecordAccessError, key);
  }

  // A system column that still reaches the update payload (a script-built
  // update map) is dropped, not written — the same path ctx.record takes.
  const dropped = await runtime.shim.datastore.update(
    ctx,
    'Item',
    { op: '==', field: 'ROWID', value: 'row-1' },
    { Status: 'Open', Added_Time: '1999-01-01T00:00:00', modified_user: 'mallory' },
  );
  assert.deepEqual(dropped, { updated: 1 });
  const last = updates[updates.length - 1]![0]!;
  assert.equal(last.Status, 'Open');
  assert.equal(last.Added_Time, undefined);
  assert.equal(last.modified_user, undefined);
  assert.equal(last.Modified_User, 'staff.user');
});

test('stale-write guard skips MODIFIEDTIME absent on both reads and rejects availability changes or edits', async () => {
  const access = { profiles: { Staff: { Item: { write: true } } }, roles: [] as string[] };
  async function attempt(expectedTime: string | undefined, currentTime: string | undefined) {
    const table: Record<string, unknown>[] = [{ ROWID: '1', ...(expectedTime === undefined ? {} : { MODIFIEDTIME: expectedTime }) }];
    const runtime = createRuntime({
      dryRun: false,
      appTimeZone: 'UTC',
      access,
      datastore: {
        async query(_form, _where, limit, _offset = 0, _orderBy = '', columns?: readonly string[] | '*') {
          // The stale-check re-read is the only read projecting exactly
          // ROWID, MODIFIEDTIME; prepare and the update-target read see expectedTime.
          if (columns?.length === 2) {
            return [{ ROWID: '1', ...(currentTime === undefined ? {} : { MODIFIEDTIME: currentTime }) }];
          }
          return table.slice(0, limit).map((row) => ({ ...row }));
        },
        async update() { return { updated: 1 }; },
      },
    });
    const ctx = runtime.context({ record: { Status: 'Closed' }, principal: { profile: 'Staff' }, rowId: '1' });
    await runtime.shim.record.prepare(ctx, 'Item', 'update');
    return runtime.shim.datastore.update(ctx, 'Item', { op: '==', field: 'ROWID', value: '1' }, ctx.record);
  }

  assert.deepEqual(await attempt(undefined, undefined), { updated: 1 });
  await assert.rejects(() => attempt(undefined, '2026-10-14T00:00:00Z'), StaleWriteError);
  await assert.rejects(() => attempt('2026-10-14T00:00:00Z', undefined), StaleWriteError);
  await assert.rejects(() => attempt('before', 'after'), StaleWriteError);
});

test('authorizeWrite requires an editable form and rejects hidden or read-only fields', () => {
  const access = {
    profiles: {
      Staff: { Item: { fields: ['Status'], write: true, writable: ['Status'] } },
      Reader: { Item: { fields: ['Status'] } },
    },
    roles: [] as string[],
  };
  assert.deepEqual(authorizeWrite(access, { profile: 'Staff' }, 'Item', { Status: 'Open' }).values, { Status: 'Open' });
  assert.throws(() => authorizeWrite(access, { profile: 'Staff' }, 'Item', { Secret: 'x' }), RecordAccessError);
  assert.throws(
    () => authorizeWrite(access, { profile: 'Staff' }, 'Item', { Status: 'Open' }, { readonlyFields: ['Status'] }),
    RecordAccessError,
  );
  assert.throws(() => authorizeWrite(access, { profile: 'Reader' }, 'Item', { Status: 'Open' }), RecordAccessError);
  assert.throws(() => authorizeWrite(access, undefined, 'Item', { Status: 'Open' }), RecordAccessError);
});

test('authorizeWrite rejects a read-only or hidden field inside a subform row or nested map', () => {
  const access = {
    profiles: {
      Staff: {
        Item: {
          fields: ['Status', 'Owner', 'Lines', 'Qty', 'Address', 'City', 'Author'],
          write: true,
          writable: ['Status', 'Owner', 'Lines', 'Qty', 'Address', 'City', 'Author'],
        },
      },
    },
    roles: [] as string[],
  };
  const schema = {
    readonlyFields: ['Amount'],
    fieldNames: ['Status', 'Owner', 'Lines', 'Qty', 'Amount', 'Address', 'City', 'Author', 'Secret'],
    fields: [
      { name: 'Status' },
      { name: 'Owner' },
      { name: 'Lines', kind: 'subform' as const, fields: [{ name: 'Qty' }, { name: 'Amount', readOnly: true }] },
      { name: 'Address', kind: 'composite' as const, fields: [{ name: 'City' }] },
      { name: 'Author', kind: 'lookup' as const },
      { name: 'Secret' },
    ],
  };
  const staff = { profile: 'Staff' };
  assert.throws(() => authorizeWrite(access, staff, 'Item', { Lines: [{ Qty: 1, Amount: 999 }] }, schema), RecordAccessError);
  assert.throws(() => authorizeWrite(access, staff, 'Item', { Lines: [{ Qty: 1, amount: 999 }] }, schema), RecordAccessError);
  assert.throws(() => authorizeWrite(access, staff, 'Item', { Lines: [{ Qty: 1, AMOUNT: 999 }] }, schema), RecordAccessError);
  assert.throws(() => authorizeWrite(access, staff, 'Item', { Lines: [{ Qty: 1, Secret: 'x' }] }, schema), RecordAccessError);
  assert.throws(() => authorizeWrite(access, staff, 'Item', { Address: { City: 'Paris', Amount: 1 } }, schema), RecordAccessError);
  assert.deepEqual(authorizeWrite(access, staff, 'Item', { Lines: [{ Qty: 1 }] }, schema).values, { Lines: [{ Qty: 1 }] });
  assert.deepEqual(authorizeWrite(access, staff, 'Item', { Address: { City: 'Paris' } }, schema).values, {
    Address: { City: 'Paris' },
  });
  assert.deepEqual(authorizeWrite(access, staff, 'Item', { Author: { id: '1', label: 'Ada' } }, schema).values, {
    Author: { id: '1', label: 'Ada' },
  });
  assert.deepEqual(authorizeWrite(access, staff, 'Item', { Owner: 'ada' }, schema).values, { Owner: 'ada' });
  const withPhoto = {
    ...schema,
    fields: [...schema.fields, { name: 'Photo', kind: 'file' as const }],
  };
  const photoGrant = {
    ...access,
    profiles: {
      Staff: {
        Item: {
          ...access.profiles.Staff.Item,
          fields: [...access.profiles.Staff.Item.fields, 'Photo'],
          writable: [...access.profiles.Staff.Item.writable, 'Photo'],
        },
      },
    },
  };
  assert.deepEqual(authorizeWrite(photoGrant, staff, 'Item', { Photo: { key: 'dry-run/Item/Photo/a.png' } }, withPhoto).values, {
    Photo: { key: 'dry-run/Item/Photo/a.png' },
  });
  assert.throws(() => authorizeWrite(photoGrant, staff, 'Item', { Photo: {} }, withPhoto), RecordAccessError);
  assert.throws(() => authorizeWrite(photoGrant, staff, 'Item', { Photo: 'dry-run/Item/Photo/a.png' }, withPhoto), RecordAccessError);
  assert.throws(() => authorizeWrite(photoGrant, staff, 'Item', { Photo: { key: 'dry-run/Item/Photo/a.png', name: 'a.png' } }, withPhoto), RecordAccessError);
  assert.throws(() => authorizeWrite(access, staff, 'Item', { owner: 'ada' }, schema), RecordAccessError);
  assert.throws(() => authorizeWrite(access, staff, 'Item', { Lines: [{ Qty: 1, Owner: 'ada' }] }, schema), RecordAccessError);
});

test('a grant naming a composite field allows its sub-parts', () => {
  // Generated grants only ever name top-level fields, so Name.first_name can
  // never appear in grant.fields: the parent Name grant covers the parts.
  const access = {
    profiles: {
      Waiter: {
        Reserve_Table: {
          fields: ['Name', 'Time_Of_Attending'],
          write: true,
          writable: ['Name', 'Time_Of_Attending'],
        },
      },
    },
    roles: [] as string[],
  };
  const schema = {
    fields: [
      { name: 'Name', kind: 'composite' as const, fields: [{ name: 'first_name' }, { name: 'last_name' }] },
      { name: 'Time_Of_Attending' },
      { name: 'KOT_Status' },
    ],
  };
  const waiter = { profile: 'Waiter' };
  assert.deepEqual(
    authorizeWrite(access, waiter, 'Reserve_Table', { Name: { first_name: 'A', last_name: 'B' } }, schema).values,
    { Name: { first_name: 'A', last_name: 'B' } },
  );
  // Fail closed below the parent grant: unknown parts, read-only parts,
  // system columns and hidden top-level fields are still rejected.
  assert.throws(
    () => authorizeWrite(access, waiter, 'Reserve_Table', { Name: { first_name: 'A', Evil: 1 } }, schema),
    RecordAccessError,
  );
  assert.throws(
    () => authorizeWrite(access, waiter, 'Reserve_Table', { Name: { first_name: 'A', ROWID: 3 } }, schema),
    RecordAccessError,
  );
  assert.throws(
    () => authorizeWrite(access, waiter, 'Reserve_Table', { Name: { first_name: 'A', last_name: 'B' }, KOT_Status: 'x' }, schema),
    RecordAccessError,
  );
  const frozen = {
    ...schema,
    fields: [
      { name: 'Name', kind: 'composite' as const, fields: [{ name: 'first_name' }, { name: 'last_name', readOnly: true }] },
      { name: 'Time_Of_Attending' },
      { name: 'KOT_Status' },
    ],
  };
  assert.throws(
    () => authorizeWrite(access, waiter, 'Reserve_Table', { Name: { first_name: 'A', last_name: 'B' } }, frozen),
    RecordAccessError,
  );
});

test('composite writes expand nested parts into flat store columns', () => {
  // The store keeps one column per part; authorizeWrite keeps the nesting, so
  // the runtime expands Name.{first_name} to Name_first_name before its check.
  const rules = [
    { name: 'Name_first_name', dataType: 'VarChar' },
    { name: 'Name_last_name', dataType: 'VarChar' },
  ];
  const posted = { Name: { first_name: 'A', last_name: 'B' }, Email: 'a@b.c' };
  assert.deepEqual(expandCompositeWrites('Reserve_Table', posted, rules), {
    Email: 'a@b.c',
    Name_first_name: 'A',
    Name_last_name: 'B',
  });
  // The caller's object is never mutated.
  assert.deepEqual(posted, { Name: { first_name: 'A', last_name: 'B' }, Email: 'a@b.c' });
  // With no rules there is nothing to expand against: values pass through.
  assert.deepEqual(expandCompositeWrites('Reserve_Table', posted, undefined), posted);
});

test('composite expansion refuses an unknown sub-key instead of dropping it', () => {
  const rules = [
    { name: 'Name_first_name', dataType: 'VarChar' },
    { name: 'Name_last_name', dataType: 'VarChar' },
  ];
  assert.throws(
    () => expandCompositeWrites('Reserve_Table', { Name: { first_name: 'A', Evil: 1 } }, rules),
    RecordAccessError,
  );
  // A nested object with no flat column at all is not the composite case:
  // it passes through for the write-rule check, which still refuses a
  // missing mandatory column on insert.
  const otherRules = [{ name: 'Email', dataType: 'VarChar' }];
  assert.deepEqual(expandCompositeWrites('Reserve_Table', { Name: { first_name: 'A' } }, otherRules), {
    Name: { first_name: 'A' },
  });
});

test('composite expansion leaves lookup and file references alone', () => {
  const rules = [
    { name: 'Item_Name', dataType: 'VarChar' },
    { name: 'Photo', dataType: 'VarChar' },
    { name: 'Name_first_name', dataType: 'VarChar' },
    { name: 'Name_last_name', dataType: 'VarChar' },
  ];
  assert.deepEqual(
    expandCompositeWrites(
      'Order_Item',
      {
        Item_Name: { id: '7', label: 'Tea' },
        Photo: { key: 'dry-run/Order_Item/Photo/a.png' },
        Name: { first_name: 'A', last_name: 'B' },
      },
      rules,
    ),
    {
      Item_Name: { id: '7', label: 'Tea' },
      Photo: { key: 'dry-run/Order_Item/Photo/a.png' },
      Name_first_name: 'A',
      Name_last_name: 'B',
    },
  );
});

test('a granted composite update authorizes nested parts and writes flat columns', async () => {
  // The submit handler authorizes with the WriteSchema; datastore.update
  // re-authorizes the write payload and needs the same schema (the generated
  // stub passes it as writeSchemas), or a granted Name.{first_name} dies as a
  // nested scalar before expandCompositeWrites runs.
  const access = {
    profiles: {
      Waiter: {
        Reserve_Table: {
          fields: ['Name', 'Time_Of_Attending'],
          write: true,
          writable: ['Name', 'Time_Of_Attending'],
        },
      },
    },
    roles: [] as string[],
  };
  const schema = {
    fields: [
      { name: 'Name', kind: 'composite' as const, fields: [{ name: 'first_name' }, { name: 'last_name' }] },
      { name: 'Time_Of_Attending' },
      { name: 'KOT_Status' },
    ],
  };
  const rules = [
    { name: 'Name_first_name', dataType: 'VarChar' },
    { name: 'Name_last_name', dataType: 'VarChar' },
    { name: 'Time_Of_Attending', dataType: 'VarChar' },
  ];
  const table = [{ ROWID: 'row-1', Added_User: 'ada', Name_first_name: 'A', Name_last_name: 'B' }];
  const updates: Record<string, unknown>[][] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    ...({ writeSchemas: { Reserve_Table: schema } } as object),
    writeRules: { Reserve_Table: rules },
    datastore: {
      async query(_form, where, limit, offset = 0) {
        const id = /ROWID = '([^']+)'/.exec(where)?.[1];
        const rows = id === undefined ? table : table.filter((row) => row.ROWID === id);
        return rows.slice(offset, offset + limit).map((row) => ({ ...row }));
      },
      async update(_form, rows) {
        updates.push(rows);
        for (const change of rows) {
          const row = table.find((item) => item.ROWID === String(change.ROWID));
          if (row) Object.assign(row, change);
        }
        return { updated: rows.length };
      },
    },
  });
  const ctx = runtime.context({ record: {}, principal: { profile: 'Waiter', loginUser: 'ada' } });
  const result = await runtime.shim.datastore.update(
    ctx,
    'Reserve_Table',
    { op: '==', field: 'ROWID', value: 'row-1' },
    { Name: { first_name: 'C', last_name: 'D' } },
  );
  assert.deepEqual(result, { updated: 1 });
  const written = updates[0]![0]!;
  assert.equal(written.Name_first_name, 'C');
  assert.equal(written.Name_last_name, 'D');
  assert.equal(Object.hasOwn(written, 'Name'), false);
  assert.equal(table[0]!.Name_first_name, 'C');

  // Without the schema the update still fails closed on the nested object.
  const noSchema = createRuntime({ dryRun: false, appTimeZone: 'UTC', access, writeRules: { Reserve_Table: rules } });
  const denied = noSchema.context({ record: {}, principal: { profile: 'Waiter' } });
  await assert.rejects(
    () =>
      noSchema.shim.datastore.update(denied, 'Reserve_Table', { op: '==', field: 'ROWID', value: 'row-1' }, {
        Name: { first_name: 'C' },
      }),
    RecordAccessError,
  );
  assert.equal(updates.length, 1);

  // Every request-screening reject holds on update too: unknown sub-key,
  // prefix lookalikes, prototype keys and hidden fields never reach the store.
  for (const values of [
    { Name: { first_name: 'C', Evil: 1 } },
    { Name: { first_name: 'C', last_name: 'D' }, KOT_Status: 'x' },
    { Name_Evil: 'x' },
    { NameX_first: 'x' },
    { Name: JSON.parse('{"__proto__":{"x":1},"first_name":"C"}') },
    { Name: JSON.parse('{"constructor":"x","first_name":"C"}') },
  ]) {
    const probe = runtime.context({ record: {}, principal: { profile: 'Waiter' } });
    await assert.rejects(
      () =>
        runtime.shim.datastore.update(probe, 'Reserve_Table', { op: '==', field: 'ROWID', value: 'row-1' }, values),
      RecordAccessError,
      JSON.stringify(values),
    );
  }
  assert.equal(updates.length, 1);
});

test('mass-assignment probes are rejected and datastore.insert receives none of them', async () => {
  const access = {
    profiles: {
      Staff: {
        Item: {
          fields: ['Status', 'Owner', 'Lines', 'Qty', 'Address', 'City', 'Author'],
          write: true,
          writable: ['Status', 'Owner', 'Lines', 'Qty', 'Address', 'City', 'Author'],
        },
      },
    },
    roles: [] as string[],
  };
  const schema = {
    readonlyFields: ['Amount'],
    fields: [
      { name: 'Status' },
      { name: 'Owner' },
      { name: 'Lines', kind: 'subform' as const, fields: [{ name: 'Qty' }, { name: 'Amount', readOnly: true }] },
      { name: 'Address', kind: 'composite' as const, fields: [{ name: 'City' }] },
      { name: 'Author', kind: 'lookup' as const },
    ],
  };
  const staff = { profile: 'Staff', loginUser: 'staff.user' };
  const seen: Record<string, unknown>[][] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async insert(_form, rows) {
        seen.push(rows);
        return { ok: true };
      },
    },
  });
  const ctx = runtime.context({ principal: staff });
  const probes: Record<string, unknown>[] = [
    { Lines: [{ Qty: 1, ROWID: 9 }] },
    { Lines: [{ Qty: 1, rowid: 9 }] },
    { Lines: [{ Qty: 1, CREATORID: 4 }] },
    { Lines: [{ Qty: 1, c2c_source_id: 'src' }] },
    { Lines: [{ Qty: 1, added_user: 'a@example.test' }] },
    { Lines: [{ Qty: 1, Added_User: 'a@example.test' }] },
    { Lines: [{ Qty: 1, CREATEDTIME: 'now' }] },
    { Lines: [{ Qty: 1, MODIFIEDTIME: 'now' }] },
    { Lines: [{ Qty: 1, modified_user: 'a@example.test' }] },
    { Author: { id: '1', label: 'Ada', ROWID: 9 } },
    { Author: { id: '1', label: 'Ada', Added_User: 'a@example.test' } },
    { Author: { id: '1', Label: 'Ada' } },
    { Author: { ID: '1', label: 'Ada' } },
    { Address: { City: 'Paris', neighbour: 'x' } },
    { Address: { City: 'Paris', ROWID: 3 } },
    { Address: { City: 'Paris', c2c_source_id: 'src' } },
  ];
  for (const probe of probes) {
    assert.throws(() => authorizeWrite(access, staff, 'Item', probe, schema), RecordAccessError, JSON.stringify(probe));
    await assert.rejects(
      (async () => {
        const decision = authorizeWrite(access, staff, 'Item', probe, schema);
        await runtime.shim.datastore.insert(ctx, 'Item', decision.values);
      })(),
      RecordAccessError,
    );
  }
  assert.equal(seen.length, 0);
  const clean = { Owner: 'ada', Lines: [{ Qty: 1 }], Address: { City: 'Paris' }, Author: { id: '1', label: 'Ada' } };
  const decision = authorizeWrite(access, staff, 'Item', clean, schema);
  await runtime.shim.datastore.insert(ctx, 'Item', decision.values);
  assert.equal(seen.length, 1);
  const storedRow = seen[0]?.[0] as Record<string, unknown>;
  assert.equal(storedRow.Added_User, 'staff.user');
  assert.match(String(storedRow.Added_Time), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.equal(storedRow.added_user, undefined);
  const stored = JSON.stringify(storedRow);
  assert.equal(stored.includes('a@example.test'), false);
  for (const key of ['ROWID', 'rowid', 'CREATORID', 'c2c_source_id', 'added_user', 'CREATEDTIME', 'MODIFIEDTIME', 'modified_user', 'neighbour', 'Label', 'ID']) {
    assert.equal(stored.includes(`"${key}"`), false, key);
  }
  assert.equal(stored.includes('"Owner"'), true);
  assert.equal(stored.includes('"Qty"'), true);
  assert.equal(stored.includes('"id"'), true);
  assert.equal(stored.includes('"label"'), true);
});

test('live setField updates the row by ROWID; dry-run only records; a forbidden field is refused', async () => {
  const access = {
    profiles: {
      Staff: {
        Create_BOM: {
          fields: ['ID', 'BOM_Status'],
          write: true,
          writable: ['BOM_Status'],
        },
      },
      Reader: {
        Create_BOM: { fields: ['ID', 'BOM_Status'] },
      },
    },
    roles: [] as string[],
  };
  const queries: { form: string; where: string; limit: number }[] = [];
  const updates: { form: string; rows: Record<string, unknown>[] }[] = [];
  const runtime = createRuntime({
    dryRun: false,
    // Live runtimes require a zone. This test is not about dates; UTC is an explicit choice, not a fallback.
    appTimeZone: 'UTC',
    access,
    datastore: {
      async query(form, where, limit) {
        queries.push({ form, where, limit });
        return [{ ROWID: '42', ID: '7', BOM_Status: 'Active' }];
      },
      async update(form, rows) {
        updates.push({ form, rows });
        return { updated: rows.length };
      },
    },
  });
  const ctx = runtime.context({ principal: { profile: 'Staff' } });
  const query = runtime.shim.datastore.query(ctx, 'Create_BOM', { op: '==', field: 'ID', value: 7 });
  const result = await runtime.shim.datastore.setField(ctx, query, 'BOM_Status', 'Archive');
  assert.equal(result, 'Archive');
  assert.equal(queries.length, 1);
  assert.equal(queries[0]?.form, 'Create_BOM');
  assert.equal(queries[0]?.limit, LIMITS.zcqlRowsPerQuery);
  assert.match(String(queries[0]?.where), /c2c_source_id/);
  assert.match(String(queries[0]?.where), /ROWID/);
  assert.deepEqual(updates, [{ form: 'Create_BOM', rows: [{ ROWID: '42', BOM_Status: 'Archive' }] }]);
  const wrote = runtime.transcript.find((e) => e.op === 'setField');
  assert.equal(wrote?.performed, true);
  assert.equal(wrote?.field, 'BOM_Status');
  assert.equal(wrote?.value, 'Archive');

  await assert.rejects(() => runtime.shim.datastore.setField(ctx, query, 'Secret', 'x'), RecordAccessError);
  assert.equal(updates.length, 1);
  assert.equal(queries.length, 1);

  const reader = runtime.context({ principal: { profile: 'Reader' } });
  await assert.rejects(() => runtime.shim.datastore.setField(reader, query, 'BOM_Status', 'Archive'), RecordAccessError);
  assert.equal(updates.length, 1);
  assert.equal(queries.length, 1);

  let dryCalls = 0;
  const dry = createRuntime({
    dryRun: true,
    access,
    datastore: {
      async query() {
        dryCalls += 1;
        return [];
      },
      async update() {
        dryCalls += 1;
        return {};
      },
    },
  });
  const dryCtx = dry.context({ principal: { profile: 'Staff' } });
  const dryQuery = dry.shim.datastore.query(dryCtx, 'Create_BOM', { op: '==', field: 'ID', value: 7 });
  const dryResult = await dry.shim.datastore.setField(dryCtx, dryQuery, 'BOM_Status', 'Archive');
  assert.equal(dryResult, 'Archive');
  assert.equal(dryCalls, 0);
  const noted = dry.transcript.find((e) => e.op === 'setField');
  assert.equal(noted?.dryRun, true);
  assert.equal(noted?.performed, false);
  assert.equal(noted?.field, 'BOM_Status');
  assert.equal(noted?.value, 'Archive');
  assert.equal(noted?.form, 'Create_BOM');
  assert.equal(dry.transcript.some((e) => e.op === 'live-refused'), false);
});

test('setField refuses system columns with or without an access policy', async () => {
  const updates: Record<string, unknown>[][] = [];
  const makeRuntime = (access?: AccessPolicy) => createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    ...(access ? { access } : {}),
    datastore: {
      async query() { return [{ ROWID: '42', Name: 'before' }]; },
      async update(_form, rows) { updates.push(rows); return { updated: rows.length }; },
    },
  });
  const access = {
    profiles: { Staff: { Item: { fields: ['Name'], write: true, writable: ['Name'] } } },
    roles: [] as string[],
  };
  for (const runtime of [makeRuntime(), makeRuntime(access)]) {
    const ctx = runtime.context({ principal: { profile: 'Staff' } });
    const query = runtime.shim.datastore.query(ctx, 'Item', { op: '==', field: 'Name', value: 'before' });
    for (const field of ['ROWID', 'rowid', 'CREATORID', 'Added_User', 'added_time', 'Modified_User', 'MODIFIEDTIME', 'c2c_source_id']) {
      await assert.rejects(() => runtime.shim.datastore.setField(ctx, query, field, 'forged'), RecordAccessError);
    }
    await runtime.shim.datastore.setField(ctx, query, 'Name', 'after');
  }
  assert.deepEqual(updates, [
    [{ ROWID: '42', Name: 'after' }],
    [{ ROWID: '42', Name: 'after' }],
  ]);
});

function paged(rows: Record<string, unknown>[]) {
  const calls: { limit: number; offset: number }[] = [];
  return {
    calls,
    async query(_form: string, _where: string, limit: number, offset = 0) {
      calls.push({ limit, offset });
      return rows.slice(offset, offset + limit);
    },
  };
}

test('live reads page ZCQL at 300 and honour Deluge range indexes', async () => {
  const names = ['A', 'B', 'C', 'D', 'E'];
  const all = names.map((name, index) => ({ ROWID: String(index + 1), name }));
  const source = paged(all);
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: { query: source.query },
  });
  const ctx = runtime.context({});
  const open = runtime.shim.datastore.query(ctx, 'Employee', { op: 'true' });
  const rows = await runtime.shim.datastore.rows(ctx, open);
  assert.deepEqual(rows.map((row) => row.values.name), names);
  assert.deepEqual(source.calls, [{ limit: 300, offset: 0 }]);
  assert.equal(Object.hasOwn(rows[0] ?? {}, 'persist'), false);

  const window = (from: number, to: number) =>
    runtime.shim.datastore.query(ctx, 'Employee', { op: 'true' }, { range: { from, to } });
  // https://www.zoho.com/deluge/help/fetch-records/fetch-collection-records.html
  // 0..3 and 1..4 are A B C D. 2..4 is B C D. 0..0 is the first record.
  assert.deepEqual((await runtime.shim.datastore.rows(ctx, window(0, 3))).map((row) => row.values.name), ['A', 'B', 'C', 'D']);
  assert.deepEqual((await runtime.shim.datastore.rows(ctx, window(1, 4))).map((row) => row.values.name), ['A', 'B', 'C', 'D']);
  assert.deepEqual((await runtime.shim.datastore.rows(ctx, window(2, 4))).map((row) => row.values.name), ['B', 'C', 'D']);
  assert.deepEqual((await runtime.shim.datastore.column(ctx, window(0, 0), 'name')), ['A']);
  assert.equal(await runtime.shim.datastore.aggregate(ctx, window(2, 4), 'count'), 3);
  assert.equal(await runtime.shim.datastore.field(ctx, window(2, 4), 'name'), 'B');

  const firstOnly = paged(all);
  const one = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore: { query: firstOnly.query } });
  const oneCtx = one.context({});
  const oneQuery = one.shim.datastore.query(oneCtx, 'Employee', { op: 'true' });
  assert.equal(await one.shim.datastore.field(oneCtx, oneQuery, 'name'), 'A');
  assert.deepEqual(firstOnly.calls, [{ limit: 1, offset: 0 }]);

  let negativeCalls = 0;
  const negative = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query() {
        negativeCalls += 1;
        return [];
      },
    },
  });
  const negativeCtx = negative.context({});
  const bad = negative.shim.datastore.query(negativeCtx, 'Employee', { op: 'true' }, { range: { from: -1, to: 2 } });
  await assert.rejects(() => negative.shim.datastore.rows(negativeCtx, bad), RangeIndexError);
  assert.equal(negativeCalls, 0);

  const many = Array.from({ length: 301 }, (_, index) => ({ ROWID: String(index), name: `n${index}` }));
  const wide = paged(many);
  const counted = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore: { query: wide.query } });
  const countedCtx = counted.context({});
  const countedQuery = counted.shim.datastore.query(countedCtx, 'Employee', { op: 'true' });
  assert.equal(await counted.shim.datastore.aggregate(countedCtx, countedQuery, 'count'), 301);
  assert.equal((await counted.shim.datastore.column(countedCtx, countedQuery, 'name')).length, 301);
  assert.deepEqual(wide.calls.map((call) => call.offset), [0, 300, 0, 300]);
});

test('setField pages every match, batches updateRows at 200, and errors without ROWID', async () => {
  const all = Array.from({ length: 301 }, (_, index) => ({ ROWID: String(index), BOM_Status: 'Active' }));
  const source = paged(all);
  const updates: { form: string; rows: Record<string, unknown>[] }[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      query: source.query,
      async update(form, rows) {
        updates.push({ form, rows });
        return { updated: rows.length };
      },
    },
  });
  const ctx = runtime.context({});
  const query = runtime.shim.datastore.query(ctx, 'Create_BOM', { op: 'true' });
  await runtime.shim.datastore.setField(ctx, query, 'BOM_Status', 'Archive');
  assert.deepEqual(source.calls, [
    { limit: 300, offset: 0 },
    { limit: 300, offset: 300 },
  ]);
  assert.equal(updates.length, 2);
  assert.equal(updates[0]?.rows.length, 200);
  assert.equal(updates[1]?.rows.length, 101);
  assert.equal(updates[0]?.rows[0]?.ROWID, '0');
  assert.equal(updates[1]?.rows.at(-1)?.ROWID, '300');
  assert.equal(updates[0]?.rows.every((row) => row.BOM_Status === 'Archive'), true);

  const ranged = paged(
    ['A', 'B', 'C', 'D', 'E'].map((name, index) => ({ ROWID: String(index + 1), name })),
  );
  const rangeUpdates: Record<string, unknown>[][] = [];
  const rangeRuntime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      query: ranged.query,
      async update(_form, rows) {
        rangeUpdates.push(rows);
        return {};
      },
    },
  });
  const rangeCtx = rangeRuntime.context({});
  const rangeQuery = rangeRuntime.shim.datastore.query(rangeCtx, 'Employee', { op: 'true' }, { range: { from: 2, to: 4 } });
  await rangeRuntime.shim.datastore.setField(rangeCtx, rangeQuery, 'name', 'Z');
  assert.deepEqual(rangeUpdates, [[{ ROWID: '2', name: 'Z' }, { ROWID: '3', name: 'Z' }, { ROWID: '4', name: 'Z' }]]);

  let skippedWrites = 0;
  const missing = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query() {
        return [{ BOM_Status: 'Active' }, { ROWID: '2', BOM_Status: 'Active' }];
      },
      async update() {
        skippedWrites += 1;
        return {};
      },
    },
  });
  const missingCtx = missing.context({});
  const missingQuery = missing.shim.datastore.query(missingCtx, 'Create_BOM', { op: 'true' });
  await assert.rejects(() => missing.shim.datastore.setField(missingCtx, missingQuery, 'BOM_Status', 'Archive'), MissingRowIdError);
  assert.equal(skippedWrites, 0);
  assert.equal(missing.transcript.some((entry) => entry.op === 'error' && entry.code === 'MISSING_ROWID'), true);
});

test('live distinct fetches rows in ROWID order and keeps first-seen values', async () => {
  const calls: { limit: number; offset: number; orderBy?: string }[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query(_form, _where, limit, offset = 0, orderBy) {
        calls.push({ limit, offset, orderBy });
        const rows = [
          { ROWID: '1', Status: 'Open' },
          { ROWID: '2', Status: 'Hold' },
          { ROWID: '3', Status: 'Open' },
        ];
        return rows.slice(offset, offset + limit);
      },
    },
  });
  const ctx = runtime.context({});
  const query = runtime.shim.datastore.query(ctx, 'GoldenRow', { op: 'true' });
  assert.deepEqual(await runtime.shim.datastore.aggregate(ctx, query, 'distinct', 'Status'), ['Open', 'Hold']);
  assert.deepEqual(calls, [{ limit: LIMITS.zcqlRowsPerQuery, offset: 0, orderBy: 'ORDER BY ROWID' }]);

  let capped = 0;
  const capRuntime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query() {
        capped += 1;
        return [];
      },
    },
  });
  const capCtx = capRuntime.context({});
  const over = capRuntime.shim.datastore.query(capCtx, 'GoldenRow', { op: 'true' }, { range: { from: 0, to: LIMITS.zcqlMaxRows } });
  await assert.rejects(() => capRuntime.shim.datastore.aggregate(capCtx, over, 'distinct', 'Status'), ZcqlRowCapError);
  assert.equal(capped, 0);
});

test('a full ZCQL page at the cap is an error, not a silent prefix', async () => {
  let calls = 0;
  let updates = 0;
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query(_form, _where, limit) {
        calls += 1;
        assert.equal(limit, LIMITS.zcqlRowsPerQuery);
        return Array.from({ length: LIMITS.zcqlRowsPerQuery }, (_, index) => ({ ROWID: String(calls * 1000 + index) }));
      },
      async update() {
        updates += 1;
        return {};
      },
    },
  });
  const ctx = runtime.context({});
  const query = runtime.shim.datastore.query(ctx, 'Employee', { op: 'true' });
  await assert.rejects(() => runtime.shim.datastore.setField(ctx, query, 'name', 'Z'), ZcqlRowCapError);
  assert.equal(calls, LIMITS.zcqlMaxRows / LIMITS.zcqlRowsPerQuery + 1);
  assert.equal(updates, 0);
});

test('record.set on a fetched for-each queues one batched write and dry-run does not', async () => {
  const access = {
    profiles: {
      Staff: { Employee: { fields: ['name'], write: true, writable: ['name'] } },
      Reader: { Employee: { fields: ['name'] } },
    },
    roles: [] as string[],
  };
  const updates: { form: string; rows: Record<string, unknown>[] }[] = [];
  let queries = 0;
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    datastore: {
      async query() {
        queries += 1;
        return [
          { ROWID: '1', name: 'Jon' },
          { ROWID: '2', name: 'Jon', hidden: 'no' },
        ];
      },
      async update(form, rows) {
        updates.push({ form, rows });
        return {};
      },
    },
  });
  const script = translate('for each employee in Employee[name == "Jon"] { employee.name = "John"; }').server;
  const run = new Function('shim', 'ctx', `return (async () => {\n${script}\n})();`) as (
    shim: ReturnType<typeof createRuntime>['shim'],
    ctx: ReturnType<ReturnType<typeof createRuntime>['context']>,
  ) => Promise<unknown>;
  const ctx = runtime.context({ principal: { profile: 'Staff' } });
  await run(runtime.shim, ctx);
  assert.equal(queries, 1);
  assert.deepEqual(updates, [
    {
      form: 'Employee',
      rows: [
        { ROWID: '1', name: 'John' },
        { ROWID: '2', name: 'John' },
      ],
    },
  ]);
  assert.equal(runtime.transcript.some((entry) => entry.op === 'flush' && entry.performed === true), true);

  const reader = runtime.context({ principal: { profile: 'Reader' } });
  await assert.rejects(run(runtime.shim, reader), RecordAccessError);
  assert.equal(updates.length, 1);

  const local = runtime.shim.record.bind(ctx, { name: 'Ada' }, 'Employee');
  runtime.shim.record.set(local, ['name'], 'Bea');
  await runtime.shim.datastore.flush(ctx);
  assert.equal(updates.length, 1);
  assert.equal(local.values.name, 'Bea');

  const wide = Array.from({ length: 201 }, (_, index) => ({ ROWID: String(index), name: 'Jon' }));
  const batches: number[] = [];
  const many = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    datastore: {
      async query(_form, _where, limit, offset = 0) {
        return wide.slice(offset, offset + limit);
      },
      async update(_form, rows) {
        batches.push(rows.length);
        return {};
      },
    },
  });
  await run(many.shim, many.context({ principal: { profile: 'Staff' } }));
  assert.deepEqual(batches, [200, 1]);

  let dryCalls = 0;
  const dry = createRuntime({
    dryRun: true,
    access,
    datastore: {
      async query() {
        dryCalls += 1;
        return [{ ROWID: '1', name: 'Jon' }];
      },
      async update() {
        dryCalls += 1;
        return {};
      },
    },
  });
  await run(dry.shim, dry.context({ principal: { profile: 'Staff' } }));
  assert.equal(dryCalls, 0);
  assert.equal(dry.transcript.some((entry) => entry.op === 'record.set'), false);
  assert.equal(dry.transcript.some((entry) => entry.op === 'live-refused'), false);

  let missingWrites = 0;
  const missing = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    datastore: {
      async query() {
        return [{ name: 'Jon' }];
      },
      async update() {
        missingWrites += 1;
        return {};
      },
    },
  });
  await assert.rejects(run(missing.shim, missing.context({ principal: { profile: 'Staff' } })), MissingRowIdError);
  assert.equal(missingWrites, 0);
});

test('criteria update writes every match by ROWID and refuses a row without one', async () => {
  const all = Array.from({ length: 201 }, (_, index) => ({ ROWID: String(index), Name: 'Old' }));
  const source = paged(all);
  const updates: number[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      query: source.query,
      async update(_form, rows) {
        updates.push(rows.length);
        assert.equal(rows.every((row) => row.ROWID !== undefined && row.Name === 'New'), true);
        return {};
      },
    },
  });
  const ctx = runtime.context({});
  const result = await runtime.shim.datastore.update(ctx, 'Orders', { op: 'true' }, { Name: 'New' });
  assert.deepEqual(result, { updated: 201 });
  assert.deepEqual(updates, [200, 1]);
  assert.equal(runtime.transcript.find((entry) => entry.op === 'update')?.performed, true);

  let writes = 0;
  const missing = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query() {
        return [{ Name: 'Old' }];
      },
      async update() {
        writes += 1;
        return {};
      },
    },
  });
  await assert.rejects(
    () => missing.shim.datastore.update(missing.context({}), 'Orders', { op: 'true' }, { Name: 'New' }),
    MissingRowIdError,
  );
  assert.equal(writes, 0);
});

test("a filtered principal's criteria update touches only in-filter rows", async () => {
  const access = {
    profiles: {
      Staff: {
        Orders: {
          fields: ['Name', 'Owner', 'Status'],
          write: true,
          writable: ['Name'],
          recordFilter: { op: '==' as const, field: 'Owner', value: { __bind: 'loginUser' as const } },
        },
      },
    },
    roles: [] as string[],
  };
  const table = [
    { ROWID: '1', Name: 'In', Owner: 'ada@example.test', Status: 'Open' },
    { ROWID: '2', Name: 'Out', Owner: 'eve@example.test', Status: 'Open' },
  ];
  const seen: { where: string; orderBy: string | undefined }[] = [];
  const updates: Record<string, unknown>[][] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    datastore: {
      async query(_form, where, limit, offset = 0, orderBy) {
        seen.push({ where, orderBy });
        const visible = where.includes("Owner = 'ada@example.test'") ? table.filter((row) => row.Owner === 'ada@example.test') : table;
        return visible.slice(offset, offset + limit);
      },
      async update(_form, rows) {
        updates.push(rows);
        return {};
      },
    },
  });
  const ctx = runtime.context({ principal: { profile: 'Staff', loginUser: 'ada@example.test' } });
  const result = await runtime.shim.datastore.update(ctx, 'Orders', { op: '==', field: 'Status', value: 'Open' }, { Name: 'New' });
  assert.deepEqual(result, { updated: 1 });
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.where, /Status = 'Open'/);
  assert.match(seen[0]!.where, /Owner = 'ada@example.test'/);
  assert.equal(seen[0]!.orderBy, 'ORDER BY ROWID');
  assert.equal(updates.length, 1);
  const updated = updates[0]?.[0];
  assert.equal(updated?.ROWID, '1');
  assert.equal(updated?.Name, 'New');
  assert.equal(updated?.Modified_User, 'ada@example.test');
  assert.equal(updated?.Added_User, undefined);
  assert.match(String(updated?.Modified_Time), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

  seen.length = 0;
  updates.length = 0;
  const query = runtime.shim.datastore.query(ctx, 'Orders', { op: '==', field: 'Status', value: 'Open' });
  await runtime.shim.datastore.setField(ctx, query, 'Name', 'Newer');
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.where, /Owner = 'ada@example.test'/);
  assert.equal(seen[0]!.orderBy, 'ORDER BY ROWID');
  assert.deepEqual(updates, [[{ ROWID: '1', Name: 'Newer' }]]);

  const script = translate('for each employee in Employee[name == "Jon"] { employee.name = "John"; }').server;
  const run = new Function('shim', 'ctx', `return (async () => {\n${script}\n})();`) as (
    shim: ReturnType<typeof createRuntime>['shim'],
    ctx: ReturnType<ReturnType<typeof createRuntime>['context']>,
  ) => Promise<unknown>;
  const employeeAccess = {
    profiles: {
      Staff: {
        Employee: {
          fields: ['name', 'Owner'],
          write: true,
          writable: ['name'],
          recordFilter: { op: '==' as const, field: 'Owner', value: { __bind: 'loginUser' as const } },
        },
      },
    },
    roles: [] as string[],
  };
  const people = [
    { ROWID: '1', name: 'Jon', Owner: 'ada@example.test' },
    { ROWID: '2', name: 'Jon', Owner: 'eve@example.test' },
  ];
  const fetched: string[] = [];
  const flushed: Record<string, unknown>[][] = [];
  const eachRuntime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access: employeeAccess,
    datastore: {
      async query(_form, where, limit, offset = 0, orderBy) {
        fetched.push(`${where} ${orderBy ?? ''}`);
        assert.match(orderBy ?? '', /ORDER BY ROWID/);
        const visible = where.includes("Owner = 'ada@example.test'") ? people.filter((row) => row.Owner === 'ada@example.test') : people;
        return visible.slice(offset, offset + limit);
      },
      async update(_form, rows) {
        flushed.push(rows);
        return {};
      },
    },
  });
  await run(eachRuntime.shim, eachRuntime.context({ principal: { profile: 'Staff', loginUser: 'ada@example.test' } }));
  assert.equal(fetched.length, 1);
  assert.match(fetched[0]!, /name = 'Jon'/);
  assert.match(fetched[0]!, /Owner = 'ada@example.test'/);
  assert.deepEqual(flushed, [[{ ROWID: '1', name: 'John' }]]);
});

test('unfiltered live delete removes every match by ROWID and refuses a row without one', async () => {
  const all = Array.from({ length: 201 }, (_, index) => ({ ROWID: String(index), Name: 'Old' }));
  const source = paged(all);
  const deleted: unknown[][] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      query: source.query,
      async delete(_form, rowIds) {
        deleted.push([...rowIds]);
        return {};
      },
    },
  });
  const result = await runtime.shim.datastore.delete(runtime.context({}), 'Orders', { op: 'true' });
  assert.deepEqual(result, { deleted: 201 });
  assert.deepEqual(deleted.map((batch) => batch.length), [200, 1]);
  assert.deepEqual(
    deleted.flat(),
    all.map((row) => row.ROWID),
  );
  assert.equal(runtime.transcript.find((entry) => entry.op === 'delete')?.performed, true);
  assert.equal(source.calls.every((call) => call.limit === LIMITS.zcqlRowsPerQuery), true);

  let writes = 0;
  const missing = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query() {
        return [{ Name: 'Old' }];
      },
      async delete() {
        writes += 1;
        return {};
      },
    },
  });
  await assert.rejects(
    () => missing.shim.datastore.delete(missing.context({}), 'Orders', { op: 'true' }),
    MissingRowIdError,
  );
  assert.equal(writes, 0);
  assert.equal(missing.transcript.some((entry) => entry.op === 'error' && entry.code === 'MISSING_ROWID'), true);
});

test("a filtered principal's delete removes only in-filter rows", async () => {
  const access = {
    profiles: {
      Staff: {
        Orders: {
          fields: ['Name', 'Owner', 'Status'],
          write: true,
          delete: true,
          recordFilter: { op: '==' as const, field: 'Owner', value: { __bind: 'loginUser' as const } },
        },
      },
      Writer: {
        Orders: {
          fields: ['Name', 'Owner', 'Status'],
          write: true,
          delete: true,
        },
      },
    },
    roles: [] as string[],
  };
  const table = [
    { ROWID: '1', Name: 'In', Owner: 'ada@example.test', Status: 'Open' },
    { ROWID: '2', Name: 'Out', Owner: 'eve@example.test', Status: 'Open' },
  ];
  const seen: { where: string; orderBy: string | undefined }[] = [];
  const deleted: unknown[][] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    datastore: {
      async query(_form, where, limit, offset = 0, orderBy) {
        seen.push({ where, orderBy });
        const visible = where.includes("Owner = 'ada@example.test'") ? table.filter((row) => row.Owner === 'ada@example.test') : table;
        return visible.slice(offset, offset + limit);
      },
      async delete(_form, rowIds) {
        deleted.push([...rowIds]);
        return {};
      },
    },
  });
  const ctx = runtime.context({ principal: { profile: 'Staff', loginUser: 'ada@example.test' } });
  const result = await runtime.shim.datastore.delete(ctx, 'Orders', { op: '==', field: 'Status', value: 'Open' });
  assert.deepEqual(result, { deleted: 1 });
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.where, /Status = 'Open'/);
  assert.match(seen[0]!.where, /Owner = 'ada@example.test'/);
  assert.equal(seen[0]!.orderBy, 'ORDER BY ROWID');
  assert.deepEqual(deleted, [['1']]);

  seen.length = 0;
  deleted.length = 0;
  const open = runtime.context({ principal: { profile: 'Writer' } });
  const all = await runtime.shim.datastore.delete(open, 'Orders', { op: '==', field: 'Status', value: 'Open' });
  assert.deepEqual(all, { deleted: 2 });
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.where, /Status = 'Open'/);
  assert.doesNotMatch(seen[0]!.where, /Owner = /);
  assert.equal(seen[0]!.orderBy, 'ORDER BY ROWID');
  assert.deepEqual(deleted, [['1', '2']]);
});

test('unauthorized delete is refused before any read or delete', async () => {
  const access = {
    profiles: {
      Reader: { Orders: { fields: ['Status'] } },
      Staff: { Orders: { fields: ['Status'], write: true } },
      Purge: { Orders: { fields: ['Status'], delete: true } },
    },
    roles: [] as string[],
  };
  let calls = 0;
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access,
    datastore: {
      async query() {
        calls += 1;
        return [{ ROWID: '1', Status: 'Open' }];
      },
      async delete() {
        calls += 1;
        return {};
      },
    },
  });
  await assert.rejects(
    () => runtime.shim.datastore.delete(runtime.context({ principal: { profile: 'Reader' } }), 'Orders', { op: 'true' }),
    RecordAccessError,
  );
  await assert.rejects(
    () => runtime.shim.datastore.delete(runtime.context({ principal: { profile: 'Staff' } }), 'Orders', { op: 'true' }),
    RecordAccessError,
  );
  await assert.rejects(
    () => runtime.shim.datastore.delete(runtime.context({}), 'Orders', { op: 'true' }),
    RecordAccessError,
  );
  assert.equal(calls, 0);
  assert.equal(runtime.transcript.some((entry) => entry.op === 'delete'), false);
  assert.equal(runtime.transcript.some((entry) => entry.op === 'error' && entry.code === 'RECORD_ACCESS_DENIED'), true);
  const purged = await runtime.shim.datastore.delete(runtime.context({ principal: { profile: 'Purge' } }), 'Orders', { op: 'true' });
  assert.deepEqual(purged, { deleted: 1 });
  assert.equal(calls, 2);

  const dryCalls = { n: 0 };
  const dry = createRuntime({
    dryRun: true,
    access,
    datastore: {
      async query() {
        dryCalls.n += 1;
        return [{ ROWID: '1' }];
      },
      async delete() {
        dryCalls.n += 1;
        return {};
      },
    },
  });
  const dryResult = await dry.shim.datastore.delete(dry.context({ principal: { profile: 'Reader' } }), 'Orders', {
    op: '==',
    field: 'ID',
    value: 1,
  });
  assert.deepEqual(dryResult, { dryRun: true });
  assert.equal(dryCalls.n, 0);
  assert.equal(dry.transcript.find((entry) => entry.op === 'delete')?.performed, false);
  assert.equal(
    dry.transcript.find((entry) => entry.op === 'delete')?.where,
    "((c2c_source_id IS NOT NULL AND c2c_source_id = '1') OR ROWID = '1')",
  );
});

test('a live delete with no delete adapter throws instead of reporting a write it did not do', async () => {
  const none = createRuntime({ dryRun: false, appTimeZone: 'UTC' });
  await assert.rejects(() => none.shim.datastore.delete(none.context({}), 'Orders', { op: 'true' }), /no live adapter/);
  assert.equal(none.transcript.some((entry) => entry.op === 'delete'), false);
  assert.equal(none.transcript.some((entry) => entry.op === 'live-refused' && entry.call === 'delete'), true);

  const queryOnly = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      async query() {
        return [{ ROWID: '1' }];
      },
    },
  });
  await assert.rejects(() => queryOnly.shim.datastore.delete(queryOnly.context({}), 'Orders', { op: 'true' }), /no live adapter/);
});

test('paged reads order by the script sort and tie-break on ROWID', async () => {
  const rows = Array.from({ length: 301 }, (_, index) => ({
    ROWID: String(300 - index).padStart(4, '0'),
    name: index % 5 === 0 ? 'Alpha' : 'Tie',
  }));
  const calls: { limit: number; offset: number; orderBy: string }[] = [];

  function keysOf(orderBy: string): { field: string; dir: 'ASC' | 'DESC' }[] {
    assert.match(orderBy, /^ORDER BY\b.*\bROWID$/);
    return orderBy
      .replace(/^ORDER BY\s+/, '')
      .split(',')
      .map((part) => {
        const bits = part.trim().split(/\s+/);
        return { field: bits[0]!, dir: bits[1] === 'DESC' ? 'DESC' as const : 'ASC' as const };
      });
  }

  function compare(keys: { field: string; dir: 'ASC' | 'DESC' }[], a: Record<string, string>, b: Record<string, string>): number {
    for (const key of keys) {
      const av = a[key.field] ?? '';
      const bv = b[key.field] ?? '';
      if (av < bv) return key.dir === 'DESC' ? 1 : -1;
      if (av > bv) return key.dir === 'DESC' ? -1 : 1;
    }
    return 0;
  }

  async function query(_form: string, _where: string, limit: number, offset = 0, orderBy = '') {
    calls.push({ limit, offset, orderBy });
    const keys = keysOf(orderBy);
    const stable = keys.some((key) => key.field === 'ROWID');
    const sorted = [...rows].sort((a, b) => {
      const diff = compare(keys, a, b);
      if (diff !== 0 || stable) return diff;
      const flip = Math.floor(offset / Math.max(limit, 1)) % 2 === 0 ? 1 : -1;
      if (a.ROWID < b.ROWID) return -flip;
      if (a.ROWID > b.ROWID) return flip;
      return 0;
    });
    return sorted.slice(offset, offset + limit);
  }

  const updates: number[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: {
      query,
      async update(_form, written) {
        updates.push(written.length);
        return {};
      },
    },
  });
  const ctx = runtime.context({});
  const sortedQuery = runtime.shim.datastore.query(ctx, 'Employee', { op: 'true' }, { sort: { field: 'name', dir: 'asc' } });
  const got = await runtime.shim.datastore.rows(ctx, sortedQuery);
  const ids = got.map((row) => String(row.values.ROWID));
  const expected = [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.ROWID < b.ROWID ? -1 : a.ROWID > b.ROWID ? 1 : 0));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, expected.map((row) => row.ROWID));
  assert.deepEqual(
    calls.map((call) => call.orderBy),
    calls.map(() => 'ORDER BY name ASC, ROWID'),
  );
  assert.deepEqual(calls.map((call) => call.offset), [0, 300]);

  calls.length = 0;
  const plain = runtime.shim.datastore.query(ctx, 'Employee', { op: 'true' });
  await runtime.shim.datastore.rows(ctx, plain);
  await runtime.shim.datastore.column(ctx, plain, 'name');
  await runtime.shim.datastore.aggregate(ctx, plain, 'count');
  // A text column cannot be summed; the read is still ordered by ROWID.
  await assert.rejects(() => runtime.shim.datastore.aggregate(ctx, plain, 'sum', 'name'), /non numeric/);
  await runtime.shim.datastore.field(ctx, plain, 'name');
  const ranged = runtime.shim.datastore.query(ctx, 'Employee', { op: 'true' }, { range: { from: 1, to: 4 } });
  await runtime.shim.datastore.field(ctx, ranged, 'name');
  await runtime.shim.datastore.setField(ctx, plain, 'name', 'Z');
  await runtime.shim.datastore.update(ctx, 'Employee', { op: 'true' }, { name: 'Z' });
  assert.ok(calls.length > 1);
  assert.equal(
    calls.every((call) => /ORDER BY\b.*\bROWID$/.test(call.orderBy) && call.orderBy === 'ORDER BY ROWID'),
    true,
  );

  calls.length = 0;
  const descending = runtime.shim.datastore.query(ctx, 'Employee', { op: 'true' }, { sort: { field: 'name', dir: 'descending' } });
  await runtime.shim.datastore.field(ctx, descending, 'name');
  const ascending = runtime.shim.datastore.query(ctx, 'Employee', { op: 'true' }, { sort: { field: 'name', dir: 'ascending' } });
  await runtime.shim.datastore.field(ctx, ascending, 'name');
  const bare = runtime.shim.datastore.query(ctx, 'Employee', { op: 'true' }, { sort: { field: 'name' } });
  await runtime.shim.datastore.field(ctx, bare, 'name');
  assert.deepEqual(
    calls.map((call) => call.orderBy),
    ['ORDER BY name DESC, ROWID', 'ORDER BY name ASC, ROWID', 'ORDER BY name, ROWID'],
  );
  assert.equal(updates.length > 0, true);
});

test('system fields read row aliases and isDay uses the app time zone', () => {
  const kolkata = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata', now: new Date('2020-06-15T20:00:00Z') });
  const utc = createRuntime({ dryRun: true, appTimeZone: 'UTC', now: new Date('2020-06-15T20:00:00Z') });
  const ctx = kolkata.context({});
  const utcCtx = utc.context({});
  assert.equal(kolkata.shim.record.system({ Added_User: 'ada', added_user: 'other' }, 'Added_User'), 'ada');
  assert.equal(kolkata.shim.record.system({ added_user: 'ada' }, 'added_user'), 'ada');
  assert.equal(kolkata.shim.record.system({ CREATEDTIME: '01-Jan-2020' }, 'Added_Time'), '01-Jan-2020');
  assert.equal(kolkata.shim.record.system({ Added_Time: 'a', CREATEDTIME: 'b' }, 'Added_Time'), 'a');
  assert.equal(kolkata.shim.record.system({ Modified_Time: 'm', modifiedtime: 'x' }, 'Modified_Time'), 'm');
  assert.equal(kolkata.shim.record.system({ modified_user: 'ed' }, 'Modified_User'), 'ed');
  const row = kolkata.shim.record.bind(ctx, { Added_User: 'ada', Added_Time: '01-Jan-2020' }, 'Item');
  assert.equal(kolkata.shim.record.system(row, 'Added_User'), 'ada');
  assert.equal(kolkata.shim.record.system(row, 'Added_Time'), '01-Jan-2020');
  assert.equal(kolkata.shim.record.system({ nope: 1 }, 'Added_User'), undefined);
  assert.equal(kolkata.shim.record.system(null, 'Added_User'), undefined);
  assert.equal(kolkata.shim.record.system({ Added_User: 'ada' }, 'Not_A_System_Field'), undefined);

  const stamped = kolkata.context({ record: { Added_User: 'forged', Name: 'A' }, principal: { profile: 'Staff', loginUser: 'ada' } });
  kolkata.shim.record.stamp(stamped, 'insert');
  assert.equal(stamped.record.Added_User, 'ada');
  assert.equal(stamped.record.Name, 'A');
  assert.equal(String(stamped.record.Added_Time), '2020-06-16T01:30:00');
  assert.equal(kolkata.shim.zoho.loginUser(stamped), 'ada');
  assert.equal(kolkata.shim.zoho.adminUser(stamped), DRY_RUN_ADMIN_USER);
  assert.notEqual(stamped.record.Added_User, kolkata.shim.zoho.adminUser(stamped));

  const edited = kolkata.context({
    record: { Added_User: 'original', Modified_User: 'forged' },
    principal: { profile: 'Staff', loginUser: 'ada' },
  });
  kolkata.shim.record.stamp(edited, 'update');
  assert.equal(edited.record.Added_User, 'original');
  assert.equal(edited.record.Modified_User, 'ada');
  assert.equal(String(edited.record.Modified_Time), '2020-06-16T01:30:00');

  const bare = kolkata.context({ record: {} });
  kolkata.shim.record.stamp(bare, 'insert');
  assert.equal(bare.record.Added_User, DRY_RUN_LOGIN_USER);
  assert.equal(kolkata.shim.zoho.loginUser(bare), DRY_RUN_LOGIN_USER);
  assert.equal(kolkata.shim.zoho.adminUser(bare), DRY_RUN_ADMIN_USER);
  assert.equal(typeof kolkata.shim.zoho.adminUser(bare), 'string');
  assert.notEqual(bare.record.Added_User, DRY_RUN_ADMIN_USER);
  assert.notEqual(DRY_RUN_LOGIN_USER, 'ada');
  assert.notEqual(DRY_RUN_ADMIN_USER, 'ada@example.test');

  const owned = createRuntime({
    dryRun: true,
    appTimeZone: 'Asia/Kolkata',
    now: new Date('2020-06-15T20:00:00Z'),
    adminUser: 'app.owner',
  });
  const ownerCtx = owned.context({ principal: { profile: 'Administrator', loginUser: 'app.owner' } });
  assert.equal(owned.shim.zoho.adminUser(ownerCtx), 'app.owner');
  assert.equal(owned.shim.zoho.loginUser(ownerCtx), 'app.owner');
  owned.shim.record.stamp(ownerCtx, 'insert');
  assert.equal(ownerCtx.record.Added_User, 'app.owner');

  // 2020-06-15T20:00:00Z is 2020-06-16 01:30 in Asia/Kolkata and still 2020-06-15 in UTC.
  assert.equal(kolkata.shim.date.isDay('16-Jun-2020', 'today', ctx), true);
  assert.equal(kolkata.shim.date.isDay('15-Jun-2020', 'today', ctx), false);
  assert.equal(kolkata.shim.date.isDay('17-Jun-2020', 'tomorrow', ctx), true);
  assert.equal(kolkata.shim.date.isDay('15-Jun-2020', 'yesterday', ctx), true);
  assert.equal(utc.shim.date.isDay('15-Jun-2020', 'today', utcCtx), true);
  assert.equal(utc.shim.date.isDay('16-Jun-2020', 'today', utcCtx), false);
  assert.equal(kolkata.shim.date.isDay('', 'today', ctx), false);
  assert.equal(kolkata.shim.date.isDay(null, 'today', ctx), false);
  assert.equal(kolkata.shim.date.isDay('   ', 'tomorrow', ctx), false);
  assert.throws(() => kolkata.shim.date.isDay('not-a-date', 'today', ctx), (err: unknown) => {
    assert.ok(err instanceof DelugeRuntimeError);
    assert.match((err as Error).message, /UnParsable date/);
    return true;
  });
});

test('job pool names drop underscores and never call the network', () => {
  assert.equal(jobPoolName('Night_Run'), 'NightRun');
  assert.match(jobPoolName('___'), /^p[0-9a-f]{6}$/);
  assert.equal(jobPoolName('c2cpool'), 'c2cpool');
  const src = readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(/);
});

test('cancel delete refuses with Creator default modal text, or the alert text when one is set', () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'Asia/Calcutta' });
  const ctx = runtime.context({});
  assert.throws(() => runtime.shim.validate.cancelDelete(ctx, null), (err: Error & { code?: string }) => {
    assert.equal(err.code, 'DELETE_REFUSED');
    assert.equal(err.message, 'Delete validation failed for the following record | Alert Message: Failed to Delete Data.');
    return true;
  });
  assert.throws(() => runtime.shim.validate.cancelDelete(ctx, 'Locked'), /Alert Message: Locked$/);
  assert.equal(runtime.transcript.filter((e) => e.op === 'validate.cancelDelete').length, 2);
});

test('cancel submit refuses with the alert text, or a default when none is set', () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'Asia/Calcutta' });
  const ctx = runtime.context({});
  assert.throws(() => runtime.shim.validate.cancelSubmit(ctx, 'Quantity must be greater than zero'), (err: Error & { code?: string }) => {
    assert.equal(err.code, 'SUBMIT_REFUSED');
    assert.equal(err.message, 'Quantity must be greater than zero');
    return true;
  });
  assert.throws(() => runtime.shim.validate.cancelSubmit(ctx, null), /^Error: The record was not saved\.$|The record was not saved\./);
  assert.equal(runtime.transcript.filter((e) => e.op === 'validate.cancelSubmit').length, 2);
});

function sentFrom(runtime: ReturnType<typeof createRuntime>): string[] {
  return runtime.transcript
    .filter((e) => e.op === 'sendmail')
    .map((e) => (e as unknown as { message: { from: string } }).message.from);
}

test('mail from the application owner is sent from the configured sender, else the default Creator sender', async () => {
  const observed = createRuntime({ dryRun: true, appTimeZone: 'Asia/Calcutta' });
  await observed.shim.mail.send(observed.context({}), { from: observed.shim.zoho.adminUserId(observed.context({})), to: 'x', subject: 's', message: 'm' });
  assert.deepEqual(sentFrom(observed), ['notifications@zohocreatormail.example']);

  const configured = createRuntime({ dryRun: true, appTimeZone: 'Asia/Calcutta', mailFrom: 'noreply@verified.example.test' });
  await configured.shim.mail.send(configured.context({}), { from: configured.shim.zoho.adminUserId(configured.context({})), to: 'x', subject: 's', message: 'm' });
  await configured.shim.mail.send(configured.context({}), { from: 'ops@example.test', to: 'x', subject: 's', message: 'm' });
  assert.deepEqual(sentFrom(configured), ['noreply@verified.example.test', 'ops@example.test']);
});

test('subform.currentRow returns the live row named by ctx.subformRow, else null', () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const record: Record<string, unknown> = { Items: [{ Qty: 1 }, { Qty: 2 }], Other: [] };
  const ctx = runtime.context({ record, subformRow: { field: 'Items', index: 1 } });
  const row = runtime.shim.subform.currentRow(ctx, 'Items');
  assert.deepEqual(row, { Qty: 2 });
  runtime.shim.record.set(row, ['Qty'], 5);
  assert.deepEqual(record.Items, [{ Qty: 1 }, { Qty: 5 }]);
  assert.equal(runtime.shim.subform.currentRow(ctx, 'Other'), null);
  assert.equal(runtime.shim.subform.currentRow(runtime.context({ record }), 'Items'), null);
  assert.equal(runtime.shim.subform.currentRow(runtime.context({ record, subformRow: { field: 'Items', index: 9 } }), 'Items'), null);
});

test('for each over a non-collection is an uncaptured rejection, not a mapped Deluge error; one record iterates once', () => {
  // for each takes a list, comma-separated text, a CSV file or a collection of records
  // (deluge-docs/pages/list-manipulations__for-each-element.html, data-access__for-each-record.html).
  // Creator rejects other values, but no Creator message was captured for the
  // rejection — it is UncapturedDelugeError (unmapped at the gate), never
  // DelugeRuntimeError with an invented message.
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({});
  const one = runtime.shim.record.bind(ctx, { A: 1 }, 'F');
  assert.deepEqual(runtime.shim.each(ctx, one), [one]);
  for (const bad of [7, true, { not: 'a list' }]) {
    assert.throws(
      () => runtime.shim.each(ctx, bad),
      (err: unknown) =>
        err instanceof Error &&
        err.name === 'UncapturedDelugeError' &&
        !(err instanceof DelugeRuntimeError) &&
        /for each/.test(err.message),
    );
  }
  assert.deepEqual(runtime.shim.each(ctx, null), []);
});

test('record get and set on a collection use the first record; null and empty read null', () => {
  // <collection_variable>.<field_link_name> (deluge-docs/pages/data-access__update-records.html).
  const shim = createRuntime({ dryRun: true, appTimeZone: 'UTC' }).shim;
  const rows = [{ A: 1 }, { A: 2 }];
  assert.equal(shim.record.get(rows, 'A'), 1);
  shim.record.set(rows, ['A'], 5);
  assert.deepEqual(rows, [{ A: 5 }, { A: 2 }]);
  assert.equal(shim.record.get([], 'A'), null);
  assert.equal(shim.record.get(null, 'A'), null);
  assert.equal(shim.record.set(null, ['A'], 3), 3);
});

test('ID criteria compile to c2c_source_id-or-ROWID, never a bare ID column', () => {
  // Generated tables have ROWID and c2c_source_id; there is no ID column. A
  // migrated row keeps its Creator id in c2c_source_id; an app-created row has
  // only ROWID, so `ID == x` must check both.
  assert.equal(
    compileCriteria({ op: '==', field: 'ID', value: '1000000000000113058' }),
    "((c2c_source_id IS NOT NULL AND c2c_source_id = '1000000000000113058') OR ROWID = '1000000000000113058')",
  );
  // `!=` must keep rows whose c2c_source_id is NULL — plain NOT(x) is UNKNOWN.
  assert.equal(
    compileCriteria({ op: '!=', field: 'ID', value: '7' }),
    "((c2c_source_id IS NULL OR c2c_source_id != '7') AND ROWID != '7')",
  );
  assert.equal(
    compileCriteria({ op: 'in', field: 'ID', value: ['7', '8'] }),
    "((c2c_source_id IS NOT NULL AND c2c_source_id IN ('7', '8')) OR ROWID IN ('7', '8'))",
  );
  // A 19-digit Creator id keeps its digits on the way to ZCQL.
  assert.equal(
    compileCriteria({ op: '==', field: 'ID', value: '1000000000000113007' }),
    "((c2c_source_id IS NOT NULL AND c2c_source_id = '1000000000000113007') OR ROWID = '1000000000000113007')",
  );
  assert.equal(
    compileCriteria({ op: '==', field: 'ID', value: 1000000000000113007n }),
    "((c2c_source_id IS NOT NULL AND c2c_source_id = '1000000000000113007') OR ROWID = '1000000000000113007')",
  );
  // A lookup {id,label} value compares by its id.
  assert.equal(
    compileCriteria({ op: '==', field: 'ID', value: { id: '42', label: 'Deal' } }),
    "((c2c_source_id IS NOT NULL AND c2c_source_id = '42') OR ROWID = '42')",
  );
  // NOT (ID == x) must also include NULL-source rows — the leaf is total.
  assert.equal(
    compileCriteria({ op: 'not', arg: { op: '==', field: 'ID', value: '7' } }),
    "(NOT ((c2c_source_id IS NOT NULL AND c2c_source_id = '7') OR ROWID = '7'))",
  );
});

test('live Form[ID == x] finds a migrated row by c2c_source_id and a new row by ROWID', async () => {
  const { datastore, tables, calls } = mockDatastore({});
  tables.set('Orders', [
    { ROWID: '1001', Name: 'migrated', c2c_source_id: '1000000000000113058' },
    { ROWID: '1002', Name: 'created', c2c_source_id: null },
    { ROWID: '1003', Name: 'other', c2c_source_id: '1000000000000113099' },
  ]);
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore });
  const ctx = runtime.context({});
  const names = async (criteria: Parameters<typeof runtime.shim.datastore.query>[2]) => {
    const q = runtime.shim.datastore.query(ctx, 'Orders', criteria);
    return (await runtime.shim.datastore.rows(ctx, q)).map((r) => runtime.shim.record.get(r, 'Name'));
  };
  assert.deepEqual(await names({ op: '==', field: 'ID', value: '1000000000000113058' }), ['migrated']);
  assert.deepEqual(await names({ op: '==', field: 'ID', value: '1002' }), ['created']);
  assert.deepEqual(await names({ op: '==', field: 'ID', value: 1000000000000113058n }), ['migrated']);
  // `ID != x` keeps the created row (c2c_source_id NULL): naive NOT is UNKNOWN.
  assert.deepEqual(await names({ op: '!=', field: 'ID', value: '1000000000000113058' }), ['created', 'other']);
  assert.deepEqual(await names({ op: 'in', field: 'ID', value: ['1001', '1000000000000113099'] }), ['migrated', 'other']);
  // A lookup {id,label} criteria value matches by id (a migrated FK is the ROWID).
  assert.deepEqual(await names({ op: '==', field: 'ID', value: { id: '1003', label: 'Other' } }), ['other']);
  const where = calls[0]!.where;
  assert.equal(where.includes('c2c_source_id'), true);
  assert.equal(where.includes('ROWID'), true);
  assert.equal(/\bID\b\s*=/.test(where), false);
});

// Creator orders ID numerically. A migrated id lives in the varchar c2c_source_id,
// which ZCQL compares as text, so 17- and 19-digit ids (both real Creator shapes)
// must not order as text: '10000000008009043' > '1000000000000113058' as text.
const ID17 = '10000000008009043';
const ID19 = '1000000000000113058';
const ORDER_ROWS = {
  migrated: [
    { ROWID: '1001', Name: 'm17', c2c_source_id: ID17 },
    { ROWID: '1002', Name: 'm19', c2c_source_id: ID19 },
  ],
  native: [
    { ROWID: '10000000000000007', Name: 'n17', c2c_source_id: null },
    { ROWID: '1000000000000000000', Name: 'n19', c2c_source_id: null },
  ],
};
type OrderRow = { ROWID: string; Name: string; c2c_source_id: string | null };
const ORDER_SETS: Record<string, OrderRow[]> = {
  migrated: ORDER_ROWS.migrated,
  native: ORDER_ROWS.native,
  mixed: [...ORDER_ROWS.migrated, ...ORDER_ROWS.native],
};
/** Effective id of each row, in numeric order: n17 < m17 < n19 < m19. */
const ORDER_IDS: Record<string, bigint> = { m17: BigInt(ID17), m19: BigInt(ID19), n17: 10000000000000007n, n19: 1000000000000000000n };
const ORDER_PIVOTS: unknown[] = [ID17, ID19, '10000000000000007', '1000000000000000000', '100000000000000000', BigInt(ID17), { id: ID19, label: 'Deal' }];
const ORDER_OPS = ['<', '>', '<=', '>='] as const;

function expectedNames(rows: OrderRow[], op: (typeof ORDER_OPS)[number], pivot: unknown): string[] {
  const raw = pivot && typeof pivot === 'object' ? (pivot as { id: string }).id : pivot;
  const v = BigInt(String(raw));
  return rows
    .filter((r) => {
      const id = ORDER_IDS[r.Name]!;
      return op === '<' ? id < v : op === '>' ? id > v : op === '<=' ? id <= v : id >= v;
    })
    .map((r) => r.Name)
    .sort();
}

for (const [set, rows] of Object.entries(ORDER_SETS)) {
  test(`ID ordering on 17- vs 19-digit ids is numeric in matchRow (${set} rows)`, () => {
    for (const op of ORDER_OPS) {
      for (const pivot of ORDER_PIVOTS) {
        const got = rows.filter((r) => matchRow(r, { op, field: 'ID', value: pivot })).map((r) => r.Name).sort();
        assert.deepEqual(got, expectedNames(rows, op, pivot), `${set} ID ${op} ${String((pivot as { id?: string })?.id ?? pivot)}`);
      }
    }
  });

  test(`ID ordering on 17- vs 19-digit ids is numeric in generated ZCQL (${set} rows)`, async () => {
    for (const op of ORDER_OPS) {
      for (const pivot of ORDER_PIVOTS) {
        const { datastore, tables } = mockDatastore({});
        tables.set('Orders', rows.map((r) => ({ ...r })));
        const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore });
        const ctx = runtime.context({});
        const q = runtime.shim.datastore.query(ctx, 'Orders', { op, field: 'ID', value: pivot });
        const got = (await runtime.shim.datastore.rows(ctx, q)).map((r) => String(runtime.shim.record.get(r, 'Name'))).sort();
        assert.deepEqual(got, expectedNames(rows, op, pivot), `${set} ID ${op} ${String((pivot as { id?: string })?.id ?? pivot)}`);
        // NOT of an ordering leaf is its exact complement: the leaf is total.
        const nq = runtime.shim.datastore.query(ctx, 'Orders', { op: 'not', arg: { op, field: 'ID', value: pivot } });
        const negated = (await runtime.shim.datastore.rows(ctx, nq)).map((r) => String(runtime.shim.record.get(r, 'Name'))).sort();
        const all = rows.map((r) => r.Name);
        assert.deepEqual(negated, all.filter((n) => !got.includes(n)).sort(), `${set} NOT ID ${op}`);
      }
    }
  });
}

test('ID ordering compiles the source-id arm to digit count then text; equality, IN and LIKE are unchanged', () => {
  const n = '?'.repeat(ID17.length);
  assert.equal(
    compileCriteria({ op: '<', field: 'ID', value: ID17 }),
    `((c2c_source_id IS NOT NULL AND (NOT c2c_source_id LIKE '${n}*' OR (c2c_source_id LIKE '${n}' AND c2c_source_id < '${ID17}'))) OR (c2c_source_id IS NULL AND ROWID < '${ID17}'))`,
  );
  assert.equal(
    compileCriteria({ op: '>=', field: 'ID', value: BigInt(ID17) }),
    `((c2c_source_id IS NOT NULL AND (c2c_source_id LIKE '${n}?*' OR (c2c_source_id LIKE '${n}' AND c2c_source_id >= '${ID17}'))) OR (c2c_source_id IS NULL AND ROWID >= '${ID17}'))`,
  );
  // A non-digit operand keeps the plain comparison.
  assert.equal(
    compileCriteria({ op: '<', field: 'ID', value: 'abc' }),
    "((c2c_source_id IS NOT NULL AND c2c_source_id < 'abc') OR (c2c_source_id IS NULL AND ROWID < 'abc'))",
  );
  assert.equal(
    compileCriteria({ op: '==', field: 'ID', value: ID17 }),
    `((c2c_source_id IS NOT NULL AND c2c_source_id = '${ID17}') OR ROWID = '${ID17}')`,
  );
  assert.equal(
    compileCriteria({ op: 'in', field: 'ID', value: [ID17, ID19] }),
    `((c2c_source_id IS NOT NULL AND c2c_source_id IN ('${ID17}', '${ID19}')) OR ROWID IN ('${ID17}', '${ID19}'))`,
  );
  assert.equal(
    compileCriteria({ op: 'startsWith', field: 'ID', value: '5212' }),
    "((c2c_source_id IS NOT NULL AND c2c_source_id LIKE '5212*') OR (c2c_source_id IS NULL AND ROWID LIKE '5212*'))",
  );
});

test('rec.ID, Form[...].ID, distinct(ID), and sort by ID all resolve to the Catalyst ROWID', async () => {
  const { datastore, tables } = mockDatastore({});
  tables.set('Orders', [
    { ROWID: '1001', Name: 'migrated', c2c_source_id: '1000000000000113058' },
    { ROWID: '1002', Name: 'created', c2c_source_id: null },
  ]);
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore });
  const ctx = runtime.context({});
  const all = runtime.shim.datastore.query(ctx, 'Orders', { op: 'true' });
  const rows = await runtime.shim.datastore.rows(ctx, all);
  // rec.ID reads the Catalyst ROWID, not c2c_source_id.
  assert.equal(runtime.shim.record.get(rows[0]!, 'ID'), '1001');
  assert.equal(runtime.shim.record.get(rows[1]!, 'ID'), '1002');
  const one = runtime.shim.datastore.query(ctx, 'Orders', { op: '==', field: 'ID', value: '1000000000000113058' });
  assert.equal(await runtime.shim.datastore.field(ctx, one, 'ID'), '1001');
  assert.deepEqual(await runtime.shim.datastore.column(ctx, all, 'ID'), ['1001', '1002']);
  assert.deepEqual(await runtime.shim.datastore.aggregate(ctx, all, 'distinct', 'ID'), ['1001', '1002']);
  const sorted = runtime.shim.datastore.query(ctx, 'Orders', { op: 'true' }, { sort: { field: 'ID', dir: 'desc' } });
  assert.deepEqual((await runtime.shim.datastore.rows(ctx, sorted)).map((r) => runtime.shim.record.get(r, 'ID')), ['1002', '1001']);
});

test('input.ID and old.ID resolve the request ROWID and stored row identity', () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({ record: { Name: 'x' }, rowId: '4242', old: { ROWID: '4242' } });
  assert.equal(runtime.shim.input.get(ctx, 'ID'), '4242');
  assert.equal(runtime.shim.old.get(ctx, 'ID'), '4242');
  const posted = runtime.context({ record: { ID: '1000000000000113058' } });
  assert.equal(runtime.shim.input.get(posted, 'ID'), '1000000000000113058');
  const bound = runtime.shim.record.bind(ctx, { Name: 'x', ROWID: '777' }, 'Orders');
  assert.equal(runtime.shim.record.get(bound, 'ID'), '777');
});

test('record writes never traverse or create prototype keys, and reads stay own-only', () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({ record: {}, old: {} });
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    runtime.shim.input.set(ctx, [key, 'leaked'], 'x');
    runtime.shim.input.set(ctx, [key], { leaked: 'x' });
    runtime.shim.old.set(ctx, [key, 'leaked'], 'x');
    runtime.shim.record.set(ctx.record, [key, 'leaked'], 'x');
    assert.equal(({} as Record<string, unknown>).leaked, undefined, key);
    assert.equal(Object.hasOwn(ctx.record, key), false, key);
    assert.equal(Object.hasOwn(ctx.old, key), false, key);
  }
  // A fresh runtime and a fresh object do not observe any leaked key.
  const second = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const fresh = second.context({ record: {}, old: {} });
  assert.equal(second.shim.input.get(fresh, 'leaked'), undefined);
  assert.equal(second.shim.input.get(fresh, 'toString'), undefined);
  // Ordinary own keys still read and write.
  second.shim.input.set(fresh, ['a', 'b'], 'v');
  assert.equal(second.shim.input.get(fresh, 'a', 'b'), 'v');
  assert.equal((ctx.record as Record<string, Record<string, unknown>>).a === undefined, true);
});

test('the generated index accessors never yield or write a shared prototype', () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({ record: {}, old: {} });
  // Reads are own-only and refuse the prototype-path segment names.
  assert.equal(runtime.shim.get({ a: 1 }, 'a'), 1);
  for (const key of ['__proto__', 'constructor', 'prototype', '__defineGetter__', '__lookupGetter__', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(runtime.shim.get({ a: 1 }, key), undefined, key);
  }
  // An own key spelled like a prototype segment is still refused by name.
  const ownKey: Record<string, unknown> = {};
  Object.defineProperty(ownKey, '__proto__', { value: 'x', enumerable: true, writable: true, configurable: true });
  assert.equal(runtime.shim.get(ownKey, '__proto__'), undefined);
  // A stored shared prototype is not a readable value, and not a walk target.
  runtime.shim.input.set(ctx, ['holder'], Object.prototype);
  assert.equal(runtime.shim.input.get(ctx, 'holder'), undefined);
  runtime.shim.input.set(ctx, ['holder', 'leaked'], 'x');
  assert.equal((ctx.record.holder as Record<string, unknown>).leaked, undefined);
  assert.equal(({} as Record<string, unknown>).leaked, undefined);
  // The write side: unsafe names, prototype targets, and missing receivers.
  runtime.shim.set(Object.prototype, 'leaked', 'x');
  runtime.shim.set(Function.prototype, 'leaked', 'x');
  const m: Record<string, unknown> = {};
  runtime.shim.set(m, '__proto__', { leaked: 'x' });
  runtime.shim.set(runtime.shim.get(m, '__proto__'), 'leaked', 'x');
  runtime.shim.set(undefined, 'leaked', 'x');
  assert.equal(Object.getPrototypeOf(m), Object.prototype);
  assert.equal(({} as Record<string, unknown>).leaked, undefined);
  // Ordinary keys still write.
  runtime.shim.set(m, 'safe', 'y');
  assert.equal(m.safe, 'y');
  const list: unknown[] = [];
  runtime.shim.set(list, 0, 'z');
  assert.equal(list[0], 'z');
  // Map helpers take the same guard.
  const viaPut: Record<string, unknown> = {};
  runtime.shim.list.put(viaPut, '__proto__', { leaked: 'x' });
  runtime.shim.list.putAll(viaPut, JSON.parse('{"__proto__":{"leaked":"x"},"ok":1}'));
  assert.equal(Object.getPrototypeOf(viaPut), Object.prototype);
  assert.equal(viaPut.ok, 1);
  assert.equal(({} as Record<string, unknown>).leaked, undefined);
});

test('the date shim maps non-date text to UnParsable date; untranslated criteria are named', () => {
  // Creator's message for text that is not a date: golden vectors date.rel.bad-eq, date.cmp.*-null-null.
  for (const bad of ['32-Foo-2020', 'not a date']) {
    assert.throws(() => parseLiteral(bad), (err: unknown) => err instanceof DelugeRuntimeError && (err as Error).message === 'UnParsable date');
  }
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({});
  assert.throws(() => runtime.shim.date.getYear(12 as never, ctx), (err: unknown) => err instanceof DelugeRuntimeError && (err as Error).message === 'UnParsable date');
  assert.throws(() => runtime.shim.date.format(12, 'dd', ctx), (err: unknown) => err instanceof DelugeRuntimeError);
  assert.throws(
    () => compileCriteria({ op: 'todo', construct: 'criteria-dynamic' }),
    (err: unknown) => err instanceof UntranslatedConstruct && (err as UntranslatedConstruct).construct === 'criteria-dynamic',
  );
});

test('an app-unique field is checked before a live insert and update', async () => {
  const stored: Record<string, unknown>[] = [{ ROWID: '7001', Code: 'A1' }];
  const inserted: Record<string, unknown>[][] = [];
  const updated: Record<string, unknown>[][] = [];
  const wheres: string[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    appUniqueColumns: { Add_User: ['Code'] },
    datastore: {
      async query(_form, zcql) {
        wheres.push(zcql);
        const match = /Code = '([^']*)'/.exec(zcql);
        if (match) return stored.filter((row) => row.Code === match[1]);
        const id = /ROWID = '?(\d+)'?/.exec(zcql);
        return id ? stored.filter((row) => row.ROWID === id[1]) : stored;
      },
      async insert(_form, rows) {
        inserted.push(rows);
        return rows;
      },
      async update(_form, rows) {
        updated.push(rows);
        return rows;
      },
    },
  });
  const ctx = runtime.context({});
  await assert.rejects(
    () => runtime.shim.datastore.insert(ctx, 'Add_User', { Code: 'A1' }),
    (err: Error & { code?: string }) => err.code === 'DUPLICATE_VALUE' && err.message === 'Duplicate value for Code. Please give a different value',
  );
  assert.equal(inserted.length, 0);
  await runtime.shim.datastore.insert(ctx, 'Add_User', { Code: 'B2' });
  assert.equal(inserted.length, 1);
  await runtime.shim.datastore.insert(ctx, 'Add_User', { Code: '' });
  assert.equal(inserted.length, 2);
  // Updating the row that already holds the value is not a duplicate.
  await runtime.shim.datastore.update(ctx, 'Add_User', { op: '==', field: 'ROWID', value: '7001' }, { Code: 'A1' });
  assert.equal(updated.length, 1);
  // A form without app-unique fields does not read first.
  const before = wheres.length;
  await runtime.shim.datastore.insert(ctx, 'Other', { Code: 'A1' });
  assert.equal(wheres.length, before);
});

test('the direct datastore.writeRow/insertRow adapters check app-unique before writing', async () => {
  const stored: Record<string, unknown>[] = [
    { ROWID: '7001', Code: 'A1' },
    { ROWID: '7002', Code: 'B2' },
  ];
  const written: { op: string; rows: Record<string, unknown>[] }[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    appUniqueColumns: { Add_User: ['Code'] },
    datastore: {
      async query(_form, zcql) {
        const match = /Code = '([^']*)'/.exec(zcql);
        if (match) return stored.filter((row) => row.Code === match[1]);
        return stored;
      },
      async insert(_form, rows) {
        written.push({ op: 'insert', rows });
        return rows;
      },
      async update(_form, rows) {
        written.push({ op: 'update', rows });
        return rows;
      },
    },
  });
  const ctx = runtime.context({});
  await assert.rejects(
    () => runtime.shim.datastore.insertRow(ctx, 'Add_User', { Code: 'A1' }),
    (err: Error & { code?: string }) => err.code === 'DUPLICATE_VALUE',
  );
  assert.equal(written.length, 0, 'a duplicate never reaches the insert adapter');
  // writeRow onto another row's value is refused; onto the holder's own row is not.
  await assert.rejects(
    () => runtime.shim.datastore.writeRow(ctx, 'Add_User', '7002', { Code: 'A1' }),
    (err: Error & { code?: string }) => err.code === 'DUPLICATE_VALUE',
  );
  assert.equal(written.length, 0);
  await runtime.shim.datastore.writeRow(ctx, 'Add_User', '7001', { Code: 'A1' });
  assert.equal(written.length, 1);
  await runtime.shim.datastore.insertRow(ctx, 'Add_User', { Code: 'C3' });
  assert.equal(written.length, 2);
});

test('datastore.historyRows reads only the flow history table, without the caller policy', async () => {
  const store = mockDatastore({});
  store.tables.set('C2C_Flow_History', [
    { ROWID: '10', Machine: 'Order_Approval', Form: 'Orders', Record_ID: '123', Action: 'submit', Actor: 'userA' },
  ]);
  store.tables.set('Secret', [{ ROWID: '1', Payload: 'classified' }]);
  // The caller's profile has a grant on Orders only: every ordinary read of
  // the history table or Secret is denied.
  const access = { roles: [], profiles: { Staff: { Orders: {} } } };
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    datastore: store.datastore,
    access,
    flowHistoryTable: 'C2C_Flow_History',
  });
  const ctx = runtime.context({ principal: { profile: 'Staff' } });
  const rows = await runtime.shim.datastore.historyRows(ctx, 'C2C_Flow_History', { op: 'true' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.values.Actor, 'userA');
  // The ordinary read path still enforces the policy on the same table.
  await assert.rejects(
    () => runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, 'C2C_Flow_History', { op: 'true' })),
    (err: unknown) => err instanceof RecordAccessError,
  );
  // The internal read cannot be pointed at another table, granted or not.
  await assert.rejects(() => runtime.shim.datastore.historyRows(ctx, 'Secret', { op: 'true' }), /flow history table/);
  await assert.rejects(() => runtime.shim.datastore.historyRows(ctx, 'Orders', { op: 'true' }), /flow history table/);
  assert.equal(
    store.calls.filter((call) => call.form !== 'C2C_Flow_History').length,
    0,
    'historyRows queried only the flow history table',
  );
  // No configured history table: the read refuses rather than guessing one.
  const unbound = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore: store.datastore });
  const unboundCtx = unbound.context({});
  await assert.rejects(() => unbound.shim.datastore.historyRows(unboundCtx, 'C2C_Flow_History', { op: 'true' }), /flow history table/);
});

test('shim.list.get bounds and type behaviour (mutation proof target)', () => {
  const runtime = createRuntime({ dryRun: true });
  const shim = runtime.shim;
  const ctx = runtime.context({});

  const emptyList = shim.list();
  const oneList = shim.list();
  oneList.push('a');
  const threeList = shim.list();
  threeList.push('a', 'b', 'c');

  const cases = [-1, 0, 2, 3, 99, '0', 1.5];

  const expectError = (fn: () => unknown, message: string) => {
    let err: Error | undefined;
    try { fn(); } catch (e: any) { err = e; }
    assert.ok(err, 'expected an error');
    assert.equal(err.message, message);
  };

  for (const c of cases) {
    const msg = `Given index ${c} is greater than the list size`;
    expectError(() => shim.list.get(emptyList, c), msg);
    if (c === 0 || c === '0') {
      assert.equal(shim.list.get(oneList, c), 'a');
      assert.equal(shim.list.get(threeList, c), 'a');
    } else if (c === 2) {
      expectError(() => shim.list.get(oneList, c), msg);
      assert.equal(shim.list.get(threeList, c), 'c');
    } else {
      expectError(() => shim.list.get(oneList, c), msg);
      expectError(() => shim.list.get(threeList, c), msg);
    }
  }

  // Fetched collection (Form[c].get(i) path over fake rows)
  const form0: unknown[] = [];
  const form1 = [shim.record.bind(ctx, {id: 1}, 'F')];
  const form3 = [shim.record.bind(ctx, {id: 1}, 'F'), shim.record.bind(ctx, {id: 2}, 'F'), shim.record.bind(ctx, {id: 3}, 'F')];

  const fcases = [0, 5];
  for (const c of fcases) {
    const msg = `Given index ${c} is greater than the list size`;
    expectError(() => shim.list.get(form0, c), msg);
    if (c === 0) {
      assert.equal(shim.record.get(shim.list.get(form1, c), 'id'), 1);
      assert.equal(shim.record.get(shim.list.get(form3, c), 'id'), 1);
    } else {
      expectError(() => shim.list.get(form1, c), msg);
      expectError(() => shim.list.get(form3, c), msg);
    }
  }

  // Map key
  const map = { a: 1, b: 2 };
  assert.equal(shim.list.get(map, 'a'), 1);
  assert.equal(shim.list.get(map, 'c'), null);
  assert.equal(shim.list.get(map, 0), null);

  // String
  assert.equal(shim.list.get('hello', 0), null);
  assert.equal(shim.list.get('hello', 'e'), null);
});
test('matchRow NULL and blank handling characterization', () => {
  const tests = [
    { rowVal: 'NULL', field: 'TextField', op: '==', targetVal: 'NULL', expected: true },
    { rowVal: 'NULL', field: 'TextField', op: '!=', targetVal: 'NULL', expected: false },
    { rowVal: 'NULL', field: 'TextField', op: 'in', targetVal: 'NULL', expected: true },
    { rowVal: 'NULL', field: 'TextField', op: 'not in', targetVal: 'NULL', expected: false },
    { rowVal: 'NULL', field: 'TextField', op: 'isNull', targetVal: 'NULL', expected: true },
    { rowVal: 'NULL', field: 'TextField', op: 'notNull', targetVal: 'NULL', expected: false },
    { rowVal: 'NULL', field: 'TextField', op: '==', targetVal: 'BLANK', expected: false },
    { rowVal: 'NULL', field: 'TextField', op: '!=', targetVal: 'BLANK', expected: true },
    { rowVal: 'NULL', field: 'TextField', op: 'in', targetVal: 'BLANK', expected: false },
    { rowVal: 'NULL', field: 'TextField', op: 'not in', targetVal: 'BLANK', expected: true },
    { rowVal: 'NULL', field: 'TextField', op: '==', targetVal: 'REAL', expected: false },
    { rowVal: 'NULL', field: 'TextField', op: '!=', targetVal: 'REAL', expected: true },
    { rowVal: 'NULL', field: 'TextField', op: 'in', targetVal: 'REAL', expected: false },
    { rowVal: 'NULL', field: 'TextField', op: 'not in', targetVal: 'REAL', expected: true },
    { rowVal: 'NULL', field: 'NumberField', op: '==', targetVal: 'NULL', expected: true },
    { rowVal: 'NULL', field: 'NumberField', op: '!=', targetVal: 'NULL', expected: false },
    { rowVal: 'NULL', field: 'NumberField', op: 'in', targetVal: 'NULL', expected: true },
    { rowVal: 'NULL', field: 'NumberField', op: 'not in', targetVal: 'NULL', expected: false },
    { rowVal: 'NULL', field: 'NumberField', op: 'isNull', targetVal: 'NULL', expected: true },
    { rowVal: 'NULL', field: 'NumberField', op: 'notNull', targetVal: 'NULL', expected: false },
    { rowVal: 'NULL', field: 'NumberField', op: '==', targetVal: 'BLANK', expected: false },
    { rowVal: 'NULL', field: 'NumberField', op: '!=', targetVal: 'BLANK', expected: true },
    { rowVal: 'NULL', field: 'NumberField', op: 'in', targetVal: 'BLANK', expected: false },
    { rowVal: 'NULL', field: 'NumberField', op: 'not in', targetVal: 'BLANK', expected: true },
    { rowVal: 'NULL', field: 'NumberField', op: '==', targetVal: 'REAL', expected: false },
    { rowVal: 'NULL', field: 'NumberField', op: '!=', targetVal: 'REAL', expected: true },
    { rowVal: 'NULL', field: 'NumberField', op: 'in', targetVal: 'REAL', expected: false },
    { rowVal: 'NULL', field: 'NumberField', op: 'not in', targetVal: 'REAL', expected: true },
    { rowVal: 'NULL', field: 'DateField', op: '==', targetVal: 'NULL', expected: true },
    { rowVal: 'NULL', field: 'DateField', op: '!=', targetVal: 'NULL', expected: false },
    { rowVal: 'NULL', field: 'DateField', op: 'in', targetVal: 'NULL', expected: true },
    { rowVal: 'NULL', field: 'DateField', op: 'not in', targetVal: 'NULL', expected: false },
    { rowVal: 'NULL', field: 'DateField', op: 'isNull', targetVal: 'NULL', expected: true },
    { rowVal: 'NULL', field: 'DateField', op: 'notNull', targetVal: 'NULL', expected: false },
    { rowVal: 'NULL', field: 'DateField', op: '==', targetVal: 'BLANK', expected: false },
    { rowVal: 'NULL', field: 'DateField', op: '!=', targetVal: 'BLANK', expected: true },
    { rowVal: 'NULL', field: 'DateField', op: 'in', targetVal: 'BLANK', expected: false },
    { rowVal: 'NULL', field: 'DateField', op: 'not in', targetVal: 'BLANK', expected: true },
    { rowVal: 'NULL', field: 'DateField', op: '==', targetVal: 'REAL', expected: false },
    { rowVal: 'NULL', field: 'DateField', op: '!=', targetVal: 'REAL', expected: true },
    { rowVal: 'NULL', field: 'DateField', op: 'in', targetVal: 'REAL', expected: false },
    { rowVal: 'NULL', field: 'DateField', op: 'not in', targetVal: 'REAL', expected: true },
    { rowVal: 'BLANK', field: 'TextField', op: '==', targetVal: 'NULL', expected: false },
    { rowVal: 'BLANK', field: 'TextField', op: '!=', targetVal: 'NULL', expected: true },
    { rowVal: 'BLANK', field: 'TextField', op: 'in', targetVal: 'NULL', expected: false },
    { rowVal: 'BLANK', field: 'TextField', op: 'not in', targetVal: 'NULL', expected: true },
    { rowVal: 'BLANK', field: 'TextField', op: 'isNull', targetVal: 'NULL', expected: false },
    { rowVal: 'BLANK', field: 'TextField', op: 'notNull', targetVal: 'NULL', expected: true },
    { rowVal: 'BLANK', field: 'TextField', op: '==', targetVal: 'BLANK', expected: true },
    { rowVal: 'BLANK', field: 'TextField', op: '!=', targetVal: 'BLANK', expected: false },
    { rowVal: 'BLANK', field: 'TextField', op: 'in', targetVal: 'BLANK', expected: true },
    { rowVal: 'BLANK', field: 'TextField', op: 'not in', targetVal: 'BLANK', expected: false },
    { rowVal: 'BLANK', field: 'TextField', op: '==', targetVal: 'REAL', expected: false },
    { rowVal: 'BLANK', field: 'TextField', op: '!=', targetVal: 'REAL', expected: true },
    { rowVal: 'BLANK', field: 'TextField', op: 'in', targetVal: 'REAL', expected: false },
    { rowVal: 'BLANK', field: 'TextField', op: 'not in', targetVal: 'REAL', expected: true },
    { rowVal: 'BLANK', field: 'NumberField', op: '==', targetVal: 'NULL', expected: false },
    { rowVal: 'BLANK', field: 'NumberField', op: '!=', targetVal: 'NULL', expected: true },
    { rowVal: 'BLANK', field: 'NumberField', op: 'in', targetVal: 'NULL', expected: false },
    { rowVal: 'BLANK', field: 'NumberField', op: 'not in', targetVal: 'NULL', expected: true },
    { rowVal: 'BLANK', field: 'NumberField', op: 'isNull', targetVal: 'NULL', expected: false },
    { rowVal: 'BLANK', field: 'NumberField', op: 'notNull', targetVal: 'NULL', expected: true },
    { rowVal: 'BLANK', field: 'NumberField', op: '==', targetVal: 'BLANK', expected: true },
    { rowVal: 'BLANK', field: 'NumberField', op: '!=', targetVal: 'BLANK', expected: false },
    { rowVal: 'BLANK', field: 'NumberField', op: 'in', targetVal: 'BLANK', expected: true },
    { rowVal: 'BLANK', field: 'NumberField', op: 'not in', targetVal: 'BLANK', expected: false },
    { rowVal: 'BLANK', field: 'NumberField', op: '==', targetVal: 'REAL', expected: false },
    { rowVal: 'BLANK', field: 'NumberField', op: '!=', targetVal: 'REAL', expected: true },
    { rowVal: 'BLANK', field: 'NumberField', op: 'in', targetVal: 'REAL', expected: false },
    { rowVal: 'BLANK', field: 'NumberField', op: 'not in', targetVal: 'REAL', expected: true },
    { rowVal: 'BLANK', field: 'DateField', op: '==', targetVal: 'NULL', expected: false },
    { rowVal: 'BLANK', field: 'DateField', op: '!=', targetVal: 'NULL', expected: true },
    { rowVal: 'BLANK', field: 'DateField', op: 'in', targetVal: 'NULL', expected: false },
    { rowVal: 'BLANK', field: 'DateField', op: 'not in', targetVal: 'NULL', expected: true },
    { rowVal: 'BLANK', field: 'DateField', op: 'isNull', targetVal: 'NULL', expected: false },
    { rowVal: 'BLANK', field: 'DateField', op: 'notNull', targetVal: 'NULL', expected: true },
    { rowVal: 'BLANK', field: 'DateField', op: '==', targetVal: 'BLANK', expected: true },
    { rowVal: 'BLANK', field: 'DateField', op: '!=', targetVal: 'BLANK', expected: false },
    { rowVal: 'BLANK', field: 'DateField', op: 'in', targetVal: 'BLANK', expected: true },
    { rowVal: 'BLANK', field: 'DateField', op: 'not in', targetVal: 'BLANK', expected: false },
    { rowVal: 'BLANK', field: 'DateField', op: '==', targetVal: 'REAL', expected: false },
    { rowVal: 'BLANK', field: 'DateField', op: '!=', targetVal: 'REAL', expected: true },
    { rowVal: 'BLANK', field: 'DateField', op: 'in', targetVal: 'REAL', expected: false },
    { rowVal: 'BLANK', field: 'DateField', op: 'not in', targetVal: 'REAL', expected: true },
    { rowVal: 'REAL', field: 'TextField', op: '==', targetVal: 'NULL', expected: false },
    { rowVal: 'REAL', field: 'TextField', op: '!=', targetVal: 'NULL', expected: true },
    { rowVal: 'REAL', field: 'TextField', op: 'in', targetVal: 'NULL', expected: false },
    { rowVal: 'REAL', field: 'TextField', op: 'not in', targetVal: 'NULL', expected: true },
    { rowVal: 'REAL', field: 'TextField', op: 'isNull', targetVal: 'NULL', expected: false },
    { rowVal: 'REAL', field: 'TextField', op: 'notNull', targetVal: 'NULL', expected: true },
    { rowVal: 'REAL', field: 'TextField', op: '==', targetVal: 'BLANK', expected: false },
    { rowVal: 'REAL', field: 'TextField', op: '!=', targetVal: 'BLANK', expected: true },
    { rowVal: 'REAL', field: 'TextField', op: 'in', targetVal: 'BLANK', expected: false },
    { rowVal: 'REAL', field: 'TextField', op: 'not in', targetVal: 'BLANK', expected: true },
    { rowVal: 'REAL', field: 'TextField', op: '==', targetVal: 'REAL', expected: true },
    { rowVal: 'REAL', field: 'TextField', op: '!=', targetVal: 'REAL', expected: false },
    { rowVal: 'REAL', field: 'TextField', op: 'in', targetVal: 'REAL', expected: true },
    { rowVal: 'REAL', field: 'TextField', op: 'not in', targetVal: 'REAL', expected: false },
    { rowVal: 'REAL', field: 'NumberField', op: '==', targetVal: 'NULL', expected: false },
    { rowVal: 'REAL', field: 'NumberField', op: '!=', targetVal: 'NULL', expected: true },
    { rowVal: 'REAL', field: 'NumberField', op: 'in', targetVal: 'NULL', expected: false },
    { rowVal: 'REAL', field: 'NumberField', op: 'not in', targetVal: 'NULL', expected: true },
    { rowVal: 'REAL', field: 'NumberField', op: 'isNull', targetVal: 'NULL', expected: false },
    { rowVal: 'REAL', field: 'NumberField', op: 'notNull', targetVal: 'NULL', expected: true },
    { rowVal: 'REAL', field: 'NumberField', op: '==', targetVal: 'BLANK', expected: false },
    { rowVal: 'REAL', field: 'NumberField', op: '!=', targetVal: 'BLANK', expected: true },
    { rowVal: 'REAL', field: 'NumberField', op: 'in', targetVal: 'BLANK', expected: false },
    { rowVal: 'REAL', field: 'NumberField', op: 'not in', targetVal: 'BLANK', expected: true },
    { rowVal: 'REAL', field: 'NumberField', op: '==', targetVal: 'REAL', expected: true },
    { rowVal: 'REAL', field: 'NumberField', op: '!=', targetVal: 'REAL', expected: false },
    { rowVal: 'REAL', field: 'NumberField', op: 'in', targetVal: 'REAL', expected: true },
    { rowVal: 'REAL', field: 'NumberField', op: 'not in', targetVal: 'REAL', expected: false },
    { rowVal: 'REAL', field: 'DateField', op: '==', targetVal: 'NULL', expected: false },
    { rowVal: 'REAL', field: 'DateField', op: '!=', targetVal: 'NULL', expected: true },
    { rowVal: 'REAL', field: 'DateField', op: 'in', targetVal: 'NULL', expected: false },
    { rowVal: 'REAL', field: 'DateField', op: 'not in', targetVal: 'NULL', expected: true },
    { rowVal: 'REAL', field: 'DateField', op: 'isNull', targetVal: 'NULL', expected: false },
    { rowVal: 'REAL', field: 'DateField', op: 'notNull', targetVal: 'NULL', expected: true },
    { rowVal: 'REAL', field: 'DateField', op: '==', targetVal: 'BLANK', expected: false },
    { rowVal: 'REAL', field: 'DateField', op: '!=', targetVal: 'BLANK', expected: true },
    { rowVal: 'REAL', field: 'DateField', op: 'in', targetVal: 'BLANK', expected: false },
    { rowVal: 'REAL', field: 'DateField', op: 'not in', targetVal: 'BLANK', expected: true },
    { rowVal: 'REAL', field: 'DateField', op: '==', targetVal: 'REAL', expected: true },
    { rowVal: 'REAL', field: 'DateField', op: '!=', targetVal: 'REAL', expected: false },
    { rowVal: 'REAL', field: 'DateField', op: 'in', targetVal: 'REAL', expected: true },
    { rowVal: 'REAL', field: 'DateField', op: 'not in', targetVal: 'REAL', expected: false },
  ];

  const rows: any = {
    NULL: { TextField: null, NumberField: null, DateField: null },
    BLANK: { TextField: '', NumberField: '', DateField: '' },
    REAL: { TextField: 'real_val', NumberField: 123, DateField: '2026-10-11' }
  };
  const targetValues: any = {
    NULL: null,
    BLANK: '',
    REAL: { TextField: 'real_val', NumberField: 123, DateField: '2026-10-11' }
  };

  for (const t of tests) {
    const row = rows[t.rowVal];
    let criteria: any;

    if (t.op === 'isNull' || t.op === 'notNull') {
      criteria = { op: t.op, field: t.field };
    } else {
      let val = t.targetVal === 'REAL' ? targetValues.REAL[t.field] : targetValues[t.targetVal];
      if (t.op === 'in') {
        criteria = { op: 'in', field: t.field, value: [val] };
      } else if (t.op === 'not in') {
        criteria = { op: 'not', arg: { op: 'in', field: t.field, value: [val] } };
      } else {
        criteria = { op: t.op, field: t.field, value: val };
      }
    }

    const actual = matchRow(row, criteria);
    assert.equal(actual, t.expected, `${t.rowVal} ${t.field} ${t.op} ${t.targetVal}`);
  }
});

test('app.users and app.userEmailIds require admin or developer profile and refuse low-privilege callers', async () => {
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    appUsers: async () => [
      { user_id: '100', email: 'a@example.test' },
      { zuid: '200', email_id: 'b@example.test' },
      { username: 'fallback' },
    ],
  });

  // Non-admin caller refused
  const employeeCtx = runtime.context({ principal: { profile: 'Employee' } });
  await assert.rejects(
    () => runtime.shim.app.users(employeeCtx),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, 'RECORD_ACCESS_DENIED');
      // No leak in error paths: error text does not contain any emails or user IDs
      assert.equal(e.message?.includes('a@example.test'), false);
      assert.equal(e.message?.includes('100'), false);
      return true;
    },
  );
  await assert.rejects(
    () => runtime.shim.app.userEmailIds(employeeCtx),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, 'RECORD_ACCESS_DENIED');
      assert.equal(e.message?.includes('a@example.test'), false);
      return true;
    },
  );

  // Unauthenticated caller refused
  const unauthCtx = runtime.context({});
  await assert.rejects(() => runtime.shim.app.users(unauthCtx), (err: unknown) => (err as { code?: string }).code === 'RECORD_ACCESS_DENIED');

  // Lookalike profile and role names do not grant user listing.
  for (const profile of ['Non-Admin', 'Admin Assistant', 'Developer Support']) {
    const ctx = runtime.context({ principal: { profile } });
    await assert.rejects(() => runtime.shim.app.users(ctx), (err: unknown) => (err as { code?: string }).code === 'RECORD_ACCESS_DENIED');
  }
  const roleOnly = runtime.context({ principal: { profile: 'Employee', role: 'Administrator' } });
  await assert.rejects(() => runtime.shim.app.users(roleOnly), (err: unknown) => (err as { code?: string }).code === 'RECORD_ACCESS_DENIED');

  // Admin gets list
  const adminCtx = runtime.context({ principal: { profile: 'Administrator' } });
  assert.deepEqual(await runtime.shim.app.users(adminCtx), ['100', '200', 'fallback']);
  assert.deepEqual(await runtime.shim.app.userEmailIds(adminCtx), ['a@example.test', 'b@example.test']);

  // Developer gets list
  const devCtx = runtime.context({ principal: { profile: 'Developer' } });
  assert.deepEqual(await runtime.shim.app.users(devCtx), ['100', '200', 'fallback']);
  assert.deepEqual(await runtime.shim.app.userEmailIds(devCtx), ['a@example.test', 'b@example.test']);

  // Error in adapter does not leak sensitive information
  const failingRuntime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    appUsers: async () => {
      throw new Error('connection reset by peer for secret_user@internal.example.test (id 9999)');
    },
  });
  await assert.rejects(
    () => failingRuntime.shim.app.users(adminCtx),
    (err: unknown) => {
      const msg = String(err);
      assert.equal(msg.includes('secret_user@internal.example.test'), false);
      assert.equal(msg.includes('9999'), false);
      return true;
    },
  );

  // Dry run behavior
  const dry = createRuntime({ dryRun: true });
  const dryAdminCtx = dry.context({ principal: { profile: 'Administrator' } });
  assert.deepEqual(await dry.shim.app.users(dryAdminCtx), []);
  const dryEmployeeCtx = dry.context({ principal: { profile: 'Employee' } });
  await assert.rejects(() => dry.shim.app.users(dryEmployeeCtx), (err: unknown) => (err as { code?: string }).code === 'RECORD_ACCESS_DENIED');
});
