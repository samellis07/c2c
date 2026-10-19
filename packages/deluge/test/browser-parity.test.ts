import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { DelugeDate } from '../../shims/src/date.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { CLIENT_SHIM_METHODS } from '../src/client-shim.js';

// Every browser-implemented method below runs on the shims runtime and on the
// real browserShim() and must agree, like client-list-prefetch-crosscheck.test.
// The browser reads the app zone from ctx (or C2C_APP_TIMEZONE), never the
// browser's own zone.

type Shim = Record<string, (...args: never[]) => unknown>;

async function browserRuntime(): Promise<{ browserShim: (fetchImpl?: unknown) => Shim }> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as never;
}

const runtime = createRuntime({ dryRun: true, appTimeZone: 'America/New_York' });
const zoneRuntime = (zone: string) => createRuntime({ dryRun: true, appTimeZone: zone });

/** The plain { y, m, d, hh, mm, ss } view a value takes on the wire. A bigint is its digit text, like jsonReplacer. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

test('date arithmetic and component reads agree on both runtimes', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const ctx = { appTimeZone: 'America/New_York' };
  const dates: unknown[] = [
    new DelugeDate(2026, 10, 16, 9, 30, 45),
    new DelugeDate(2026, 1, 31, 23, 59, 59), // month-end clamp
    new DelugeDate(2024, 2, 29, 12, 0, 0), // leap day
    new DelugeDate(2026, 3, 8, 1, 30, 0), // DST spring-forward night
    new DelugeDate(2026, 11, 1, 0, 30, 0), // DST fall-back night
    '15-Oct-2026 07:05:03',
    '2026-10-15 07:05:03',
    null,
    '',
  ];
  const shifts: Record<string, unknown[][]> = {
    addDay: [[0], [1], [-3], [40]],
    addWeek: [[1], [-2]],
    addMonth: [[1], [-1], [13]],
    addYear: [[1], [-4]],
    addHour: [[1], [-5], [26]],
    addMinutes: [[90], [-90]],
    addSeconds: [[3601], [-3601]],
    subDay: [[1], [-3], [40]],
    subWeek: [[1], [-2]],
    subMonth: [[1], [-1], [13]],
    subYear: [[1], [-4]],
    subHour: [[1], [-5], [26]],
    subMinutes: [[90], [-90]],
    subSeconds: [[3601], [-3601]],
  };
  for (const [name, argSets] of Object.entries(shifts)) {
    for (const d of dates) {
      for (const args of argSets) {
        const want = server.date[name]!(d, ...args, ctx);
        const got = browser.date[name]!(d, ...args, ctx);
        assert.deepEqual(plain(got), plain(want), `${name}(${JSON.stringify(plain(d))}, ${args})`);
      }
    }
  }
  const readers = ['toDate', 'toTime', 'getYear', 'getMonth', 'getDay', 'getHour', 'getMinutes', 'getSeconds', 'getDayOfWeek', 'getDayOfYear'];
  for (const name of readers) {
    for (const d of dates) {
      const want = server.date[name]!(d, ctx);
      const got = browser.date[name]!(d, ctx);
      assert.deepEqual(plain(got), plain(want), `${name}(${JSON.stringify(plain(d))})`);
    }
  }
  const pairs: [unknown, unknown][] = [
    [new DelugeDate(2026, 10, 16, 9, 30, 45), new DelugeDate(2026, 10, 15, 9, 30, 45)],
    [new DelugeDate(2026, 10, 16, 0, 0, 0), new DelugeDate(2026, 10, 15, 23, 0, 0)],
    ['15-Oct-2026', '16-Oct-2026'],
    [null, new DelugeDate(2026, 10, 16)],
    [new DelugeDate(2026, 10, 16), 'not a date'],
  ];
  for (const [a, b] of pairs) {
    const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
      try {
        return { ok: plain(api.diffDays!(a, b)) };
      } catch (err) {
        return { error: (err as Error).message };
      }
    };
    assert.deepEqual(run(browser.date), run(server.date), `diffDays(${JSON.stringify(plain(a))}, ${JSON.stringify(plain(b))})`);
  }
});

test('hour/minute/second shifts carry out-of-range clock fields like the server', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const ctx = { appTimeZone: 'America/New_York' };
  const dates: unknown[] = [
    '15-Oct-2026 23:60:00', // mm=60: hour shifts carry mm raw
    '15-Oct-2026 23:59:61', // ss=61: hour/minute shifts carry ss raw
    '15-Oct-2026 23:59:59', // day-boundary carry
    '15-Oct-2026 00:00:00', // midnight, negative shifts borrow a day
    '08-Mar-2026 01:30:00', // DST spring-forward night
    '01-Nov-2026 00:30:00', // DST fall-back night
    '08-Mar-2026 01:60:00', // mm=60 on a DST night
    '01-Nov-2026 00:00:61', // ss=61 on a DST night
  ];
  const fns = ['addHour', 'subHour', 'addMinutes', 'subMinutes', 'addSeconds', 'subSeconds'];
  const amounts = [-25, -1, 0, 1, 25];
  for (const name of fns) {
    for (const d of dates) {
      for (const n of amounts) {
        const want = server.date[name]!(d, n, ctx);
        const got = browser.date[name]!(d, n, ctx);
        assert.deepEqual(plain(got), plain(want), `${name}(${JSON.stringify(d)}, ${n})`);
      }
    }
  }
});

test('a bad literal throws on both runtimes', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  for (const name of ['addDay', 'toTime', 'getDay', 'getDayOfYear']) {
    const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
      try {
        return { ok: plain(api[name]!('garbage', 1)) };
      } catch (err) {
        return { error: (err as Error).message };
      }
    };
    assert.deepEqual(run(browser.date), run(server.date), name);
  }
});

test('convert.toLong and toNumber agree on both runtimes, zone-aware on dates', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  for (const zone of ['UTC', 'America/New_York', 'GMT+5:30']) {
    const server = zoneRuntime(zone).shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
    const ctx = { appTimeZone: zone };
    const values: unknown[] = [
      7,
      -7.9,
      '42',
      '  -17.99 ',
      '1e3',
      '9007199254740993',
      9007199254740993n,
      new DelugeDate(2026, 3, 8, 1, 30, 0), // exists in every zone here
      new DelugeDate(2026, 11, 1, 1, 30, 0), // fall-back overlap: the earlier instant
      null,
      'abc',
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const name of ['toLong', 'toNumber']) {
      for (const value of values) {
        const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
          try {
            return { ok: plain(api[name]!(value, ctx)) };
          } catch (err) {
            return { error: (err as Error).message };
          }
        };
        assert.deepEqual(run(browser.convert), run(server.convert), `${name}(${String(plain(value))}) in ${zone}`);
      }
    }
  }
  // The DST gap is an error on both runtimes, not an invented instant.
  const gap = new DelugeDate(2026, 3, 8, 2, 30, 0);
  const server = zoneRuntime('America/New_York').shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
    try {
      return { ok: plain(api.toLong!(gap, { appTimeZone: 'America/New_York' })) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  };
  assert.deepEqual(run(browser.convert), run(server.convert));
});

test('date.parse agrees on both runtimes, bad literal included', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  for (const literal of ['15-Oct-2026', '01-Jan-2020 13:45:00', '2026-10-15', '2026-10-15 07:05:03', '13-Foo-2026', 'Yes', 'not a date', '']) {
    const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
      try {
        return { ok: plain(api.parse!(literal)) };
      } catch (err) {
        return { error: (err as Error).message };
      }
    };
    assert.deepEqual(run(browser.date), run(server.date), `parse(${JSON.stringify(literal)})`);
  }
});

test('string.getAlphaNumeric and removeAllAlpha agree on both runtimes', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const values: unknown[] = ['abc123 XYZ!', 'café 2026', '', '---', null, 42];
  for (const name of ['getAlphaNumeric', 'removeAllAlpha']) {
    for (const value of values) {
      assert.deepEqual(browser.string[name]!(value), server.string[name]!(value), `${name}(${JSON.stringify(value)})`);
    }
  }
});

test('old.get reads the snapshot the handler carries', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const old = { Name: 'before', Meta: { Tag: 'x' }, ROWID: '77' };
  const sctx = runtime.context({ record: {}, old });
  const bctx = { old };
  for (const path of [['Name'], ['Meta', 'Tag'], ['ID'], ['Missing']]) {
    assert.deepEqual(browser.old.get!(bctx, ...path), server.old.get!(sctx, ...path), `old.${path.join('.')}`);
  }
});

test('zoho env constants read the server-evaluated prefetch slot and refuse a missing one', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const sctx = runtime.context({ record: {} });
  const names = ['adminUser', 'adminUserId', 'appName', 'appUri', 'loginUser', 'loginUserId'];
  // The handler's prefetch fills slots["zoho.<env>"]; the browser reads it back.
  const slots: Record<string, unknown> = {};
  for (const name of names) slots[`zoho.${name}`] = server.zoho[name]!(sctx);
  const ctx = { slots: JSON.parse(JSON.stringify(slots)) };
  for (const name of names) {
    assert.deepEqual(browser.zoho[name]!(ctx), plain(slots[`zoho.${name}`]), name);
  }
  for (const name of names) {
    assert.throws(() => browser.zoho[name]!({}), /Prefetch is stale or failed/, `${name}: a missing slot blocks, it is never guessed`);
    const partial = { slots: { 'zoho.adminUser': slots['zoho.adminUser'] } };
    if (name !== 'adminUser') assert.throws(() => browser.zoho[name]!(partial), /Prefetch is stale or failed/, name);
  }
});

test('every allowlisted method has a real implementation, and dropping one fails the surface test', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, unknown>>;
  // A bare property read of the catch-all stub is a callable proxy, never a
  // data value: assert the implemented entries are plain functions.
  for (const [ns, methods] of CLIENT_SHIM_METHODS) {
    for (const method of methods) {
      const fn = browser[ns]?.[method];
      // The catch-all stub is a callable proxy: reading a property off it
      // answers another stub, so a real function has no __c2cStubProbe.
      assert.equal(typeof fn, 'function', `${ns}.${method}`);
      assert.equal((fn as Record<string, unknown>).__c2cStubProbe, undefined, `${ns}.${method} is a real function, not the stub`);
    }
  }
});

test('the between-days family agrees on both runtimes, blank ends included', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const ctx = { appTimeZone: 'America/New_York' };
  const pairs: [unknown, unknown][] = [
    [new DelugeDate(1990, 6, 14), new DelugeDate(2026, 10, 16)],
    [new DelugeDate(2026, 10, 16, 9, 30, 45), new DelugeDate(2026, 10, 15, 9, 30, 45)],
    [new DelugeDate(2024, 2, 29), new DelugeDate(2023, 2, 28)], // leap day, negative
    ['15-Oct-2026', '16-Oct-2026'],
    ['15-Oct-2026 07:05:03', '2026-10-15 07:05:03'],
    [null, new DelugeDate(2026, 10, 16)],
    [new DelugeDate(2026, 10, 16), ''],
    ['not a date', new DelugeDate(2026, 10, 16)],
  ];
  for (const name of ['daysBetween', 'monthsBetween', 'yearsBetween', 'days360']) {
    for (const [a, b] of pairs) {
      const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
        try {
          return { ok: plain(api[name]!(a, b, ctx)) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      };
      assert.deepEqual(run(browser.date), run(server.date), `${name}(${JSON.stringify(plain(a))}, ${JSON.stringify(plain(b))})`);
    }
  }
});

test('record.system reads the stored system columns the same on both runtimes', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const rows: unknown[] = [
    { Added_User: 'sam', Added_Time: 'x', Modified_User: 'kim', Modified_Time: 'y' },
    { added_user: 'sam', createdtime: 'x', modified_user: 'kim', modifiedtime: 'y' },
    { __row: true, form: 'F', values: { Added_User: 'sam' } },
    { Name: 'no system columns' },
    [{ Added_User: 'first' }, { Added_User: 'second' }],
    null,
    'text',
  ];
  for (const name of ['Added_User', 'Added_Time', 'Modified_User', 'Modified_Time', 'added_user', 'Missing']) {
    for (const row of rows) {
      assert.deepEqual(browser.record.system!(row, name), server.record.system!(row, name), `record.system(${JSON.stringify(row)}, ${name})`);
    }
  }
});

test('date.toStartOfWeek agrees on both runtimes in every app zone', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const dates: unknown[] = [
    new DelugeDate(2026, 10, 17, 9, 30, 45), // Saturday
    new DelugeDate(2026, 10, 18, 0, 0, 1), // Sunday
    new DelugeDate(2026, 10, 19, 23, 59, 59), // Monday
    new DelugeDate(2026, 1, 1, 12, 0, 0), // year boundary, Thursday
    new DelugeDate(2024, 2, 29, 12, 0, 0), // leap day
    '15-Oct-2026 07:05:03',
    '11-Oct-2026', // a Sunday
    '2026-10-14',
    null,
    '',
  ];
  for (const zone of ['America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
    const server = zoneRuntime(zone).shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
    const ctx = { appTimeZone: zone };
    for (const d of dates) {
      const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
        try {
          return { ok: plain(api.toStartOfWeek!(d, ctx)) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      };
      assert.deepEqual(run(browser.date), run(server.date), `toStartOfWeek(${JSON.stringify(plain(d))}) in ${zone}`);
    }
  }
});

test('string.trim, getPrefix and getSuffix agree on both runtimes', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const values: unknown[] = ['  abc  ', 'a:b:c', '', '   ', null, 42, 'nosep', 'x:', ':x', '::', 'a::b'];
  const seps: unknown[] = [':', '', null, 'b', '::', 'zzz'];
  for (const value of values) {
    assert.deepEqual(browser.string.trim!(value), server.string.trim!(value), `trim(${JSON.stringify(value)})`);
    for (const sep of seps) {
      assert.deepEqual(browser.string.getPrefix!(value, sep), server.string.getPrefix!(value, sep), `getPrefix(${JSON.stringify(value)}, ${JSON.stringify(sep)})`);
      assert.deepEqual(browser.string.getSuffix!(value, sep), server.string.getSuffix!(value, sep), `getSuffix(${JSON.stringify(value)}, ${JSON.stringify(sep)})`);
    }
  }
});

test('math.round agrees on both runtimes, bigint and negative halves included', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const values: unknown[] = [1.5, -1.5, 2.675, -2.675, 0, '3.14159', 7n, 9007199254740993n, Number.NaN, Number.POSITIVE_INFINITY, null, 'abc', 1234.5678];
  const places: unknown[] = [0, 1, 2, -1, 'x', null];
  for (const value of values) {
    for (const p of places) {
      const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
        try {
          return { ok: plain(api.round!(value, p)) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      };
      assert.deepEqual(run(browser.math), run(server.math), `round(${String(plain(value))}, ${String(plain(p))})`);
    }
  }
});

test('convert.toList agrees on both runtimes, error cases included', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const ctx = { appTimeZone: 'America/New_York' };
  const cases: [unknown, unknown][] = [
    ['a,b,c', ','],
    ['x', ','],
    ['x', undefined],
    ['x', null],
    ['', ','],
    ['a::b', '::'],
    ['a,,b', ','],
    [['a', 'b'], undefined],
    [[], ','],
    [42, ','],
    [null, ','],
    [{ a: 1 }, ','],
    ['a-b', ','],
  ];
  for (const [value, sep] of cases) {
    const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
      try {
        return { ok: plain(sep === undefined ? api.toList!(value, ctx) : api.toList!(value, ctx, sep)) };
      } catch (err) {
        return { error: (err as Error).message };
      }
    };
    assert.deepEqual(run(browser.convert), run(server.convert), `toList(${JSON.stringify(plain(value))}, ${JSON.stringify(sep)})`);
  }
  // A third argument is the same 'at most one argument' refusal on both.
  const extra = (api: Record<string, (...args: unknown[]) => unknown>) => {
    try {
      return { ok: plain(api.toList!('a,b', ctx, ',', 'extra')) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  };
  assert.deepEqual(extra(browser.convert), extra(server.convert));
});

test('date.toStartOfMonth agrees on both runtimes in every app zone', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const dates: unknown[] = [
    new DelugeDate(2026, 10, 17, 9, 30, 45),
    new DelugeDate(2026, 10, 1, 0, 0, 0), // already the first
    new DelugeDate(2026, 10, 31, 23, 59, 59), // month-end
    new DelugeDate(2024, 2, 29, 12, 0, 0), // leap day
    new DelugeDate(2026, 1, 31, 12, 0, 0), // year boundary
    new DelugeDate(2026, 3, 8, 1, 30, 0), // DST spring-forward night
    new DelugeDate(2026, 3, 8, 2, 30, 0), // DST gap wall time
    new DelugeDate(2026, 11, 1, 1, 30, 0), // DST fall-back overlap
    '15-Oct-2026 07:05:03',
    '2026-10-31',
    null,
    '',
  ];
  for (const zone of ['America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
    const server = zoneRuntime(zone).shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
    const ctx = { appTimeZone: zone };
    for (const d of dates) {
      const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
        try {
          return { ok: plain(api.toStartOfMonth!(d, ctx)) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      };
      assert.deepEqual(run(browser.date), run(server.date), `toStartOfMonth(${JSON.stringify(plain(d))}) in ${zone}`);
    }
  }
});

test('math.sqrt agrees on both runtimes, bigint squares and negatives included', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const values: unknown[] = [
    4,
    2,
    0,
    -4,
    -0.0001,
    0.25,
    '9',
    ' 16.5 ',
    '',
    'abc',
    null,
    undefined,
    true,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    4n,
    0n,
    2n,
    -4n,
    1000000000000000000n, // 10^18: a perfect square past 2^53 stays a bigint
    9007199254740993n, // past 2^53, not a square: refuses
    9007199254740991n, // inside the safe range, not a square
    [4],
    { v: 4 },
  ];
  for (const value of values) {
    const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
      try {
        return { ok: plain(api.sqrt!(value)) };
      } catch (err) {
        return { error: `${(err as Error).name}:${(err as Error).message}` };
      }
    };
    assert.deepEqual(run(browser.math), run(server.math), `sqrt(${typeof value === 'bigint' ? `${value}n` : JSON.stringify(value)})`);
  }
});

test('string.toUpperCase agrees on both runtimes, non-ASCII included', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const values: unknown[] = [
    'hello',
    'Hello World',
    'café',
    'ß', // expands to SS
    'ﬁle', // ligature expands
    'ǳungla', // titlecase digraph
    'στρ', // Greek
    'ıstanbul', // dotless i
    'already UPPER',
    '',
    '   ',
    null,
    42,
    -1.5,
    true,
  ];
  for (const value of values) {
    assert.deepEqual(browser.string.toUpperCase!(value), server.string.toUpperCase!(value), `toUpperCase(${JSON.stringify(value)})`);
  }
});

test('convert.toMap agrees on both runtimes, malformed inputs included', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const ctx = { appTimeZone: 'America/New_York' };
  const values: unknown[] = [
    '{"a":1,"b":"x"}',
    '{a:1,b:"x"}', // Deluge's loose key:value form
    '{a:1,b:two}', // bare identifier value
    '{a:{b:2},c:"x,y"}', // nested map and a quoted comma
    '{a:1.5,b:-0.25}', // decimals stay exact
    '{a:+9007199254740993}', // past 2^53 keeps its digits as text
    '{"a":9007199254740993}', // the same inside strict JSON
    '{}',
    '{ }',
    '{a:}', // empty value
    '{:1}', // empty key
    '{a:1,}', // trailing comma
    '{a:1 b:2}', // missing comma
    '{a:"unterminated}',
    '{a:[1,2]}', // a list value is refused
    '{a:1', // unclosed
    'not a map',
    '[1,2]',
    '42',
    '',
    '   ',
    null,
    undefined,
    42,
    true,
    { a: 1, b: 'x' }, // a plain object copies
    [['a', 1]],
    'x'.repeat(5 * 1024 * 1024 + 1), // past the 5 MB text bound
  ];
  for (const value of values) {
    const run = (api: Record<string, (...args: unknown[]) => unknown>) => {
      try {
        return { ok: plain(api.toMap!(value, ctx)) };
      } catch (err) {
        return { error: `${(err as Error).name}:${(err as Error).message}` };
      }
    };
    assert.deepEqual(run(browser.convert), run(server.convert), `toMap(${typeof value === 'string' && value.length > 80 ? `string(${value.length})` : String(value)})`);
  }
  // A date is refused on both runtimes: DelugeDate on the server, its
  // plain {y,m,d,hh,mm,ss} wire shape in the browser.
  const run = (api: Record<string, (...args: unknown[]) => unknown>, value: unknown) => {
    try {
      return { ok: plain(api.toMap!(value, ctx)) };
    } catch (err) {
      return { error: `${(err as Error).name}:${(err as Error).message}` };
    }
  };
  assert.deepEqual(
    run(browser.convert, { y: 2026, m: 10, d: 17, hh: 9, mm: 30, ss: 45 }),
    run(server.convert, new DelugeDate(2026, 10, 17, 9, 30, 45)),
    'toMap(date)',
  );
  // An extra argument is the same refusal on both.
  const extra = (api: Record<string, (...args: unknown[]) => unknown>) => {
    try {
      return { ok: plain(api.toMap!('{"a":1}', ctx, 'extra')) };
    } catch (err) {
      return { error: `${(err as Error).name}:${(err as Error).message}` };
    }
  };
  assert.deepEqual(extra(browser.convert), extra(server.convert));
});

test('convert.toMap refuses adversarial input on both runtimes', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const server = runtime.shim as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const ctx = { appTimeZone: 'America/New_York' };
  const run = (api: Record<string, (...args: unknown[]) => unknown>, value: unknown) => {
    try {
      return { ok: api.toMap!(value, ctx) as Record<string, unknown> };
    } catch (err) {
      return { error: `${(err as Error).name}:${(err as Error).message}` };
    }
  };
  // A 10,000-level map must fail fast with the same conversion error, never a RangeError.
  const deep = '{a:'.repeat(10_000) + '1' + '}'.repeat(10_000);
  const started = Date.now();
  const serverDeep = run(server.convert, deep);
  const browserDeep = run(browser.convert, deep);
  assert.ok(Date.now() - started < 10_000, 'deep input must fail fast');
  assert.deepEqual(browserDeep, serverDeep);
  assert.deepEqual(serverDeep, { error: 'DelugeConversionError:toMap: text exceeds the depth limit' });
  // 64 levels is the cap on both runtimes; 65 is refused.
  const atCap = '{a:'.repeat(64) + '1' + '}'.repeat(64);
  assert.deepEqual(run(browser.convert, atCap), run(server.convert, atCap));
  assert.deepEqual(
    run(server.convert, '{a:'.repeat(65) + '1' + '}'.repeat(65)),
    { error: 'DelugeConversionError:toMap: text exceeds the depth limit' },
  );
  // Prototype-mutating keys are data on both runtimes, at every depth.
  for (const input of [
    '{__proto__:{polluted:1}}',
    '{"__proto__":{"polluted":1}}',
    '{a:{__proto__:{polluted:1}}}',
    '{__proto__:1}',
    '{constructor:{prototype:{polluted:1}}}',
    '{prototype:{polluted:1}}',
  ]) {
    for (const api of [server.convert, browser.convert]) {
      const result = run(api, input);
      assert.ok('ok' in result, `toMap(${input}) should parse`);
      assert.equal(Object.getPrototypeOf(result.ok!), Object.prototype, `toMap(${input}) prototype`);
    }
    assert.deepEqual(plain(run(browser.convert, input).ok), plain(run(server.convert, input).ok), `toMap(${input})`);
    const parsed = run(server.convert, input).ok!;
    const top = input.includes('a:{') ? (parsed.a as Record<string, unknown>) : parsed;
    assert.equal(Object.hasOwn(top, Object.keys(top)[0]!), true, `toMap(${input}) own key`);
  }
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test('remaining allowlisted collection, comparison, and scalar builtins agree', async () => {
  const browser = (await browserRuntime()).browserShim() as unknown as Record<string, unknown>;
  const server = runtime.shim as unknown as Record<string, unknown>;
  const invoke = (api: Record<string, unknown>, ns: string, name: string, args: unknown[]) => {
    try {
      const fn = (api[ns] as Record<string, (...xs: unknown[]) => unknown>)[name]!;
      return { ok: plain(fn(...args)) };
    } catch (err) {
      return { error: `${(err as Error).name}:${(err as Error).message}` };
    }
  };
  const cases: Array<[string, string, unknown[]]> = [
    ['compare', 'eq', [null, '']], ['compare', 'ne', ['é', 'e']],
    ['string', 'getAlphaNumeric', [' café-2026!']], ['string', 'removeAllAlpha', ['a1é-2']],
    ['string', 'toUpperCase', ['ß café']], ['string', 'trim', ['  漢字  ']],
    ['list', 'add', [[1, 2], null]], ['list', 'addAll', [[1], ['é', null]]],
    ['list', 'clear', [[1, 2]]], ['list', 'contains', [[null, 'é'], null]],
    ['list', 'containsKey', [{ 'é': 1 }, 'é']], ['list', 'containsValue', [{ a: null }, null]],
    ['list', 'deleteAll', [[1, null, 1], 1]], ['list', 'deleteItem', [[1, null], null]],
    ['list', 'deleteKey', [{ a: 1, 'é': 2 }, 'é']], ['list', 'deleteKeys', [{ a: 1, b: 2 }, ['a', null]]],
    ['list', 'distinct', [[1, null, 1, 'é', 'é']]], ['list', 'duplicate', [{ a: 1, nested: ['é'] }]],
    ['list', 'get', [['é', null], 0]], ['list', 'getKey', [{ a: null, b: 2 }, null]],
    ['list', 'getLastKey', [{ a: null, b: 2 }, null]], ['list', 'indexOf', [['a', null, 'a'], null]],
    ['list', 'insert', [[1, 3], 1, 'é']], ['list', 'insertAll', [[1, 4], 1, ['é', null]]],
    ['list', 'intersect', [[1, null, 'é'], [null, 'é']]], ['list', 'keys', [{ a: 1, 'é': 2 }]],
    ['list', 'lastIndexOf', [['a', null, 'a'], 'a']], ['list', 'length', [[1, null]]],
    ['list', 'notContains', [[1, null], 'é']], ['list', 'put', [{ a: 1 }, 'é', null]],
    ['list', 'putAll', [{ a: 1 }, { 'é': null }]], ['list', 'remove', [[1, 2, 3], 1]],
    ['list', 'removeAll', [[1, null, 1], [1, null]]], ['list', 'removeElement', [[1, null], null]],
    ['list', 'size', [{ a: 1, 'é': null }]], ['list', 'sort', [[3, null, 1], true]],
    ['list', 'sortKey', [{ b: 2, a: 1 }]], ['list', 'subList', [[1, null, 'é'], 0, 2]],
    ['list', 'update', [[1, 2], 1, null]], ['list', 'values', [{ a: 1, 'é': null }]],
    ['math', 'round', [1.005, 2]], ['math', 'sqrt', [9007199254740993n]],
  ];
  for (const [ns, name, args] of cases) {
    // List operations intentionally mutate their input; give each runtime an
    // independent copy so the comparison observes only semantic differences.
    assert.deepEqual(invoke(browser, ns, name, structuredClone(args)), invoke(server, ns, name, structuredClone(args)), `${ns}.${name}`);
  }
  // Keep parity coverage exhaustive as the allowlist grows: methods whose
  // useful inputs are context-specific still get an error/blank-input check.
  const exercised = new Set(cases.map(([ns, name]) => `${ns}.${name}`));
  for (const [ns, methods] of CLIENT_SHIM_METHODS) {
    if (['client', 'input', 'record', 'subform', 'zoho', 'convert', 'date'].includes(ns)) continue;
    for (const name of methods) {
      if (exercised.has(`${ns}.${name}`)) continue;
      assert.deepEqual(invoke(browser, ns, name, []), invoke(server, ns, name, []), `${ns}.${name} blank input`);
    }
  }
});
