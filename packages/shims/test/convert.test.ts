import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DelugeConversionError, toDecimal, toJSONCollection, toJSONList, toList, toLong, toMap, toNumber } from '../src/convert.js';
import { DelugeDate, TimeZoneRequired, epochMillis, partsInZone } from '../src/date.js';
import { normalizeDate } from '../src/write-rules.js';
import { createRuntime, rangeSlotRequest, LIMITS } from '../src/runtime.js';

test('toLong truncates decimals, rejects empty or non-numeric text, and rejects null', () => {
  assert.equal(toLong(99.9), 99);
  assert.equal(toLong(-1.9), -1);
  assert.equal(toLong('100'), 100);
  assert.equal(toLong(' 100.9 '), 100);
  assert.equal(toLong('99.9'), 99);
  assert.equal(toNumber(99.9), 99);
  assert.equal(toDecimal('100')?.toString(), '100');
  assert.equal(toDecimal(99.9)?.toString(), '99.9');
  assert.equal(toDecimal(' 10.50 ')?.toString(), '10.50');
  for (const bad of ['', '   ', 'abc', '12a', null, undefined, true]) {
    assert.throws(() => toLong(bad), DelugeConversionError);
  }
  for (const bad of ['', '   ', 'abc', '12a', true]) {
    assert.throws(() => toDecimal(bad), DelugeConversionError);
  }
  assert.equal(toDecimal(null), null);
  assert.equal(toDecimal(undefined), null);
  assert.throws(() => toLong('100', undefined, 1), DelugeConversionError);
});

test('toLong on a date is epoch millis in the app time zone', () => {
  const epoch = new DelugeDate(1969, 12, 31, 16, 0, 0);
  const ctx = { appTimeZone: 'America/Los_Angeles' };
  assert.equal(toLong(epoch, ctx), 0);
  assert.equal(toLong(new DelugeDate(1969, 12, 31, 16, 0, 1), ctx), 1000);
  assert.equal(toLong(new DelugeDate(1969, 12, 31, 15, 59, 59), ctx), -1000);
  assert.throws(() => toLong(epoch), TimeZoneRequired);
});

test('toList keeps empty tokens and does not invent a separator', () => {
  assert.deepEqual(toList('ZohoCreator/ZohoCRM', undefined, '/'), ['ZohoCreator', 'ZohoCRM']);
  // Creator empty tokens are null, not "" (toList.consecutive, toList.empty-source).
  assert.deepEqual(toList('a//b', undefined, '/'), ['a', null, 'b']);
  assert.deepEqual(toList('abc', undefined, ','), ['abc']);
  assert.deepEqual(toList('abc'), ['abc']);
  assert.deepEqual(toList('abc', undefined, ''), ['abc']);
  assert.deepEqual(toList(['a', 'b']), ['a', 'b']);
  assert.throws(() => toList(null), DelugeConversionError);
  assert.throws(() => toList('a', undefined, '/', 'b'), DelugeConversionError);
});

test('toMap accepts JSON and Deluge {key:value} text, and rejects the rest', () => {
  assert.deepEqual(toMap('{company:Zoho, product:Creator}'), { company: 'Zoho', product: 'Creator' });
  assert.deepEqual(toMap('{"product":"Creator","n":2}'), { product: 'Creator', n: 2 });
  assert.deepEqual(toMap('{}'), {});
  assert.deepEqual(toMap({ a: 1 }), { a: 1 });
  for (const bad of ['', '   ', 'Zoho', '[1,2]', null, undefined]) {
    assert.throws(() => toMap(bad), DelugeConversionError);
  }
  assert.throws(() => toMap('{' + 'x'.repeat(5 * 1024 * 1024) + '}'), DelugeConversionError);
});

test('toLong refuses magnitudes past 2^53 instead of rounding, and truncates negative decimals toward zero', () => {
  // Deluge truncates the fraction toward zero, including negatives:
  // https://www.zoho.com/deluge/help/functions/common/tolong.html
  assert.equal(toLong('-1.9'), -1);
  assert.equal(toLong('-99.2'), -99);
  assert.equal(toLong('9007199254740993'), 9007199254740993n);
  assert.equal(toLong('-9007199254740993.9'), -9007199254740993n);
  assert.throws(() => toLong(2 ** 53), DelugeConversionError);
  assert.throws(() => toLong(-(2 ** 53)), DelugeConversionError);
});

test('toLong across a DST boundary uses the app time zone instant', () => {
  // Deluge date-time toLong is epoch millis. The app zone, not UTC, decides
  // which instant that wall clock is (published anchor: 31-Dec-1969 16:00:00
  // in America/Los_Angeles is 0).
  const zone = { appTimeZone: 'America/Los_Angeles' };
  assert.equal(toLong(new DelugeDate(2024, 3, 10, 1, 30, 0), zone), Date.parse('2024-03-10T09:30:00Z'));
  assert.equal(toLong(new DelugeDate(2024, 3, 10, 3, 0, 0), zone), Date.parse('2024-03-10T10:00:00Z'));
  assert.throws(() => toLong(new DelugeDate(2024, 3, 10, 2, 30, 0), zone), /does not exist/);
  // 2024-11-03 01:30 happens twice. The earlier instant (PDT, UTC-7) is kept.
  assert.equal(toLong(new DelugeDate(2024, 11, 3, 1, 30, 0), zone), Date.parse('2024-11-03T08:30:00Z'));
});

test('date-only values and app-local datetimes are stable across host timezone settings', () => {
  const previous = process.env.TZ;
  const zones = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Pacific/Kiritimati'];
  try {
    for (const hostZone of zones) {
      process.env.TZ = hostZone;
      assert.deepEqual(normalizeDate('05-Oct-2026'), { ok: true, value: '2026-10-05' });
      const instant = Date.parse('2024-03-10T07:00:00Z');
      const wall = partsInZone(new Date(instant), 'America/New_York');
      assert.deepEqual([wall.y, wall.m, wall.d, wall.hh, wall.mm, wall.ss], [2024, 3, 10, 3, 0, 0]);
      assert.equal(epochMillis(new DelugeDate(2024, 3, 10, 3), 'America/New_York'), instant);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('toMap rejects invalid JSON and text over 5 MB', () => {
  // https://www.zoho.com/deluge/help/functions/string/tomap.html — not a map throws; text over 5 MB throws.
  assert.throws(() => toMap('{"a":'), DelugeConversionError);
  assert.throws(() => toMap('{not valid}'), DelugeConversionError);
  assert.throws(() => toMap('[1,2]'), DelugeConversionError);
  assert.throws(() => toMap('{' + 'x'.repeat(5 * 1024 * 1024) + '}'), DelugeConversionError);
});

test('toJSONList parses JSON array text into a list; anything else throws', () => {
  // https://www.zoho.com/deluge/help/functions/common/tojsonlist.html —
  // non-JSON text is a runtime error, not an empty list.
  assert.deepEqual(toJSONList('[343,443,577]'), [343, 443, 577]);
  assert.deepEqual(toJSONList('[{"id":1,"name":"A"},{"id":2,"name":"B"}]'), [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
  assert.deepEqual(toJSONList('["a", null, true]'), ['a', null, true]);
  assert.deepEqual(toJSONList('[]'), []);
  // A list value is already a list (e.g. a `.get` result on a parsed map).
  assert.deepEqual(toJSONList(['a', 'b']), ['a', 'b']);
  for (const bad of ['{"a":1}', '[1,', 'not json', '', '   ', '5', '"x"', 'null', '{a:1}']) {
    assert.throws(() => toJSONList(bad), DelugeConversionError);
  }
  assert.throws(() => toJSONList(null), DelugeConversionError);
  assert.throws(() => toJSONList({ a: 1 }), DelugeConversionError);
  assert.throws(() => toJSONList('[1]', undefined, 'extra'), DelugeConversionError);
});

test('toJSONList keeps a 19-digit id exact inside the array', () => {
  const list = toJSONList('[{"id":3000000012345678901}]') as { id: unknown }[];
  assert.equal(String(list[0]!.id), '3000000012345678901');
});

test('toJSONCollection parses JSON object text into a map; anything else throws', () => {
  assert.deepEqual(toJSONCollection('{"a":1,"b":[2,3]}'), { a: 1, b: [2, 3] });
  assert.deepEqual(toJSONCollection('{}'), {});
  assert.deepEqual(toJSONCollection({ a: 1 }), { a: 1 });
  for (const bad of ['[1,2]', '{"a":', 'not json', '', '   ', '5', '"x"']) {
    assert.throws(() => toJSONCollection(bad), DelugeConversionError);
  }
  assert.throws(() => toJSONCollection(null), DelugeConversionError);
  assert.throws(() => toJSONCollection('{"a":1}', undefined, 'extra'), DelugeConversionError);
});

test('toList splits on the given separator and keeps empty tokens', () => {
  // https://www.zoho.com/deluge/help/functions/string/tolist.html
  assert.deepEqual(toList('/a/b/', undefined, '/'), [null, 'a', 'b', null]);
  assert.deepEqual(toList('a::b::c', undefined, '::'), ['a', 'b', 'c']);
  assert.deepEqual(toList('a,b', undefined, '/'), ['a,b']);
});

test('dry-run client prefetch does not pretend an empty snapshot succeeded', async () => {
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({});
  const blocked = await runtime.shim.client.prefetch(ctx, '/forms/Orders/load/prefetch');
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.slots, {});
  assert.match(blocked.message ?? '', /blocked/);
  assert.equal(runtime.transcript.find((e) => e.op === 'client-prefetch')?.performed, false);
  const injected = createRuntime({
    dryRun: true,
    clientPrefetch: (_path, nonce) => ({ slots: { c0: true }, nonce }),
  });
  const ready = injected.context({ formNonce: 'load-1' });
  assert.deepEqual(await injected.shim.client.prefetch(ready, '/x'), { ok: true, slots: { c0: true }, nonce: 'load-1' });
});

test('a stale or failed prefetch is retried once and otherwise blocks with no slots', async () => {
  let calls = 0;
  const staleThenFresh = createRuntime({
    dryRun: true,
    clientPrefetch: (_path, nonce) => {
      calls += 1;
      if (calls === 1) return { slots: { c0: true }, nonce: 'old' };
      return { slots: { c0: false }, nonce };
    },
  });
  const ctx = staleThenFresh.context({ formNonce: 'n2' });
  const retried = await staleThenFresh.shim.client.prefetch(ctx, '/forms/Orders/load/prefetch');
  assert.equal(retried.ok, true);
  assert.equal(retried.retried, true);
  assert.deepEqual(retried.slots, { c0: false });
  assert.equal(calls, 2);

  const changed = createRuntime({
    dryRun: true,
    clientPrefetch: (_path, nonce) => {
      changedCtx.formNonce = `after-${nonce}`;
      return { slots: { c0: true }, nonce };
    },
  });
  const changedCtx = changed.context({ formNonce: 'load' });
  const dropped = await changed.shim.client.prefetch(changedCtx, '/x');
  assert.equal(dropped.ok, false);
  assert.deepEqual(dropped.slots, {});
  assert.match(dropped.message ?? '', /blocked/);

  const failing = createRuntime({
    dryRun: true,
    clientPrefetch: () => {
      throw new Error('network');
    },
  });
  const failed = await failing.shim.client.prefetch(failing.context({ formNonce: 'load' }), '/x');
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.slots, {});
  assert.match(failed.message ?? '', /blocked/);
});

test('shim.client.call uses the prefetch adapter and fails closed on stale or failed replies', async () => {
  const seen: unknown[] = [];
  const runtime = createRuntime({
    dryRun: true,
    clientPrefetch: (path, nonce, request) => {
      seen.push({ path, request });
      return { ok: true, nonce, value: 7 };
    },
  });
  const ctx = runtime.context({ formNonce: 'n1' });
  assert.equal(await runtime.shim.client.call(ctx, 'Util.Ok', [3]), 7);
  assert.deepEqual(seen, [{ path: '/functions/util-ok/call', request: { args: [3] } }]);
  assert.equal(runtime.transcript.find((entry) => entry.op === 'client-call')?.performed, true);

  const stale = createRuntime({
    dryRun: true,
    clientPrefetch: () => ({ ok: true, nonce: 'old', value: true }),
  });
  await assert.rejects(
    stale.shim.client.call(stale.context({ formNonce: 'n1' }), 'Util.Ok', []),
    (err: unknown) => !!err && typeof err === 'object' && (err as { c2cElementBlocked?: unknown }).c2cElementBlocked === true,
  );
  const noAdapter = createRuntime({ dryRun: true });
  await assert.rejects(
    noAdapter.shim.client.call(noAdapter.context({ formNonce: 'n1' }), 'Util.Ok', []),
    /blocked/,
  );
});

test('rangeSlotRequest requires integer bounds and clamps them to the ZCQL page cap', () => {
  // No `slot` key: an ordinary prefetch, not a deferred range read.
  assert.deepEqual(rangeSlotRequest({ record: {}, nonce: 'n1' }), { from: 0, to: 0, empty: false });
  assert.deepEqual(rangeSlotRequest(null), { from: 0, to: 0, empty: false });

  // Valid bounds pass through (proplength = 0 → range 1..11).
  assert.deepEqual(rangeSlotRequest({ slot: 'c0', range: { from: 1, to: 11 } }), {
    slot: 'c0',
    from: 1,
    to: 11,
    empty: false,
  });

  // `to` before `from` (proplength = 11 → range 1..0, or 12 → 1..-1) is an
  // empty read, not an error: the loop iterates zero times.
  assert.deepEqual(rangeSlotRequest({ slot: 'c0', range: { from: 1, to: 0 } }), { slot: 'c0', from: 1, to: 0, empty: true });
  assert.equal(rangeSlotRequest({ slot: 'c0', range: { from: 1, to: -1 } }).empty, true);

  // Bounds below 1 clamp up (a forged `from: -5` cannot read before row 1).
  assert.deepEqual(rangeSlotRequest({ slot: 'c0', range: { from: -5, to: 3 } }), { slot: 'c0', from: 1, to: 3, empty: false });

  // A forged huge end clamps to `from + LIMITS.zcqlRowsPerQuery`.
  const forged = rangeSlotRequest({ slot: 'c0', range: { from: 1, to: 100000 } });
  assert.equal(forged.from, 1);
  assert.equal(forged.to, 1 + LIMITS.zcqlRowsPerQuery);
  assert.equal(forged.empty, false);

  // A `from` past LIMITS.zcqlMaxRows is refused: no deep offset reaches the store.
  for (const from of [LIMITS.zcqlMaxRows + 1, 1_000_000_000_000]) {
    const deep = rangeSlotRequest({ slot: 'c0', range: { from, to: from + LIMITS.zcqlRowsPerQuery } });
    assert.ok(deep.error, `expected refusal for from ${from}`);
    assert.equal(deep.slot, undefined);
  }
  // A deep page inside the bound is served; its end clamps to LIMITS.zcqlMaxRows.
  const deepOk = rangeSlotRequest({ slot: 'c0', range: { from: LIMITS.zcqlMaxRows - 99, to: LIMITS.zcqlMaxRows + 200 } });
  assert.deepEqual(deepOk, { slot: 'c0', from: LIMITS.zcqlMaxRows - 99, to: LIMITS.zcqlMaxRows, empty: false });
  assert.deepEqual(rangeSlotRequest({ slot: 'c0', range: { from: LIMITS.zcqlMaxRows, to: LIMITS.zcqlMaxRows } }), {
    slot: 'c0',
    from: LIMITS.zcqlMaxRows,
    to: LIMITS.zcqlMaxRows,
    empty: false,
  });

  // Non-integer, non-number, or missing bounds are refused.
  for (const range of [
    { from: 1.5, to: 11 },
    { from: 1, to: 11.5 },
    { from: '1', to: 11 },
    { from: 1, to: '11' },
    { from: 1 },
    { to: 11 },
    undefined,
    'x',
  ]) {
    const bad = rangeSlotRequest({ slot: 'c0', range });
    assert.ok(bad.error, `expected refusal for range ${JSON.stringify(range)}`);
  }
  // A slot that is not a non-empty string is refused.
  assert.ok(rangeSlotRequest({ slot: 1, range: { from: 1, to: 2 } }).error);
  assert.ok(rangeSlotRequest({ slot: '', range: { from: 1, to: 2 } }).error);
});

test('shim.client.rows sends the evaluated bounds and returns only the named slot', async () => {
  const seen: { slot?: unknown; range?: unknown }[] = [];
  const runtime = createRuntime({
    dryRun: true,
    clientPrefetch: (_path, nonce, request) => {
      seen.push({ slot: request?.slot, range: request?.range });
      return { slots: { c0: [1, 2, 3], c1: [4] }, nonce };
    },
  });
  const ctx = runtime.context({ formNonce: 'n1', prefetchPath: '/forms/Orders/load/prefetch' });
  const got = await runtime.shim.client.rows(ctx, 'c0', 1, 11 - 0);
  assert.equal(got.ok, true);
  assert.deepEqual(got.rows, [1, 2, 3]);
  assert.deepEqual(seen, [{ slot: 'c0', range: { from: 1, to: 11 } }]);

  // A response missing the named slot blocks the action.
  const missing = await runtime.shim.client.rows(ctx, 'c9', 1, 5);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.rows, []);
  assert.match(missing.message ?? '', /blocked/);
});
