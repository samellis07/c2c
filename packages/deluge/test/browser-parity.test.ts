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
