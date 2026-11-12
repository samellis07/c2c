import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

type Reader = {
  request(key: string, call: (args: unknown[], init?: { signal?: unknown }) => Promise<unknown>, args?: unknown[], meta?: Record<string, unknown>, control?: Control, onResult?: (value: unknown, failure: { code: string } | null) => void): number;
  pending(): number;
  inFlight(): number;
};

type Control = {
  isConnected: boolean;
  ownerDocument: FakeDocument;
  hidden?: boolean;
  disabled?: boolean;
  attrs: Record<string, string>;
  setAttribute(name: string, value: string): void;
};

type FakeDocument = {
  body: { children: unknown[]; appendChild(el: unknown): void };
  live: Record<string, unknown> | null;
  querySelector(sel: string): Record<string, unknown> | null;
  createElement(tag: string): Record<string, unknown>;
};

function fakeDocument(): FakeDocument {
  const doc: FakeDocument = {
    live: null,
    body: { children: [], appendChild(el) { this.children.push(el); } },
    querySelector(sel: string) { return sel === '[data-c2c-condition-status]' ? doc.live : null; },
    createElement() {
      const el: Record<string, unknown> = { attrs: {}, style: {}, textContent: '' };
      (el as { setAttribute(n: string, v: string): void }).setAttribute = (n, v) => {
        (el.attrs as Record<string, string>)[n] = v;
        if (n === 'data-c2c-condition-status') doc.live = el;
      };
      return el;
    },
  };
  return doc;
}

function fakeControl(doc = fakeDocument()): Control {
  const attrs: Record<string, string> = {};
  return {
    isConnected: true,
    ownerDocument: doc,
    attrs,
    setAttribute(name, value) { attrs[name] = value; },
  };
}

function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++next;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    tick: (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])) {
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    now: () => now,
  };
}

async function reader(options: Record<string, unknown> = {}): Promise<{ createConditionReader: (o?: Record<string, unknown>) => Reader }> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as never;
}

function harness(options: Record<string, unknown> = {}) {
  const clock = fakeClock();
  const calls: { args: unknown[]; init?: { signal?: unknown }; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const call = (args: unknown[] = [], init?: { signal?: unknown }) =>
    new Promise<unknown>((resolve, reject) => calls.push({ args, init, resolve, reject }));
  const results: { value: unknown; failure: { code: string } | null }[] = [];
  const onResult = (value: unknown, failure: { code: string } | null) => results.push({ value, failure });
  return { clock, calls, call, results, onResult, options };
}

const flush = () => new Promise((r) => setImmediate(r));

test('a burst of condition requests for one control coalesces to a single call', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout });
  const control = fakeControl();
  for (let i = 0; i < 5; i++) r.request('k', h.call, [i], {}, control, h.onResult);
  assert.equal(h.calls.length, 0, 'nothing fires before the debounce window');
  assert.equal(r.pending(), 1);
  h.clock.tick(75);
  await flush();
  assert.equal(h.calls.length, 1, 'five requests coalesced into one call');
  assert.deepEqual(h.calls[0]!.args, [4], 'the latest args win');
  h.calls[0]!.resolve(true);
  await flush();
  assert.deepEqual(h.results.map((x) => x.value), [false, false, false, false, true]);
});

test('a newer request supersedes an in-flight one; the old request settles safely and its late reply is dropped', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout });
  const control = fakeControl();
  r.request('k', h.call, ['A'], {}, control, h.onResult);
  h.clock.tick(75);
  r.request('k', h.call, ['B'], {}, control, h.onResult);
  h.clock.tick(150);
  assert.equal(h.calls.length, 2, 'both requests dispatched');
  h.calls[1]!.resolve(true);
  await flush();
  assert.equal(control.attrs['data-c2c-condition-state'], 'verified-true');
  h.calls[0]!.resolve(false);
  await flush();
  // The superseded A reply must not overwrite B's applied state.
  assert.equal(control.attrs['data-c2c-condition-state'], 'verified-true', 'stale reply dropped');
  assert.equal(h.results.length, 2, 'both callers settle exactly once');
  assert.deepEqual(h.results.map((x) => x.value), [false, true]);
  assert.equal(h.results[0]!.failure?.code, 'CONDITION_UNVERIFIED');
});

test('the in-flight cap applies the safe default without making the call', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout, maxInFlight: 1 });
  const c1 = fakeControl();
  const c2 = fakeControl();
  r.request('k1', h.call, [], {}, c1, h.onResult);
  r.request('k2', h.call, [], { securityRelevant: true }, c2, h.onResult);
  h.clock.tick(75);
  await flush();
  assert.equal(h.calls.length, 1, 'only the first request dispatched');
  assert.equal(h.results.length, 1);
  assert.deepEqual(h.results[0], { value: false, failure: { code: 'CONDITION_UNVERIFIED' } });
  assert.equal(c2.hidden, true, 'security-relevant control fails hidden');
  assert.equal(c2.attrs['data-c2c-condition-state'], 'could-not-verify');
  h.calls[0]!.resolve(true);
  await flush();
});

test('a request past its timeout aborts through AbortController', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout, timeoutMs: 100 });
  const control = fakeControl();
  r.request('k', h.call, [], { securityRelevant: true, action: 'show' }, control, h.onResult);
  h.clock.tick(75);
  await flush();
  assert.equal(h.calls.length, 1);
  const signal = h.calls[0]!.init?.signal as { aborted: boolean } | undefined;
  assert.ok(signal && typeof signal === 'object', 'a signal reached the call');
  h.clock.tick(100);
  assert.equal(signal!.aborted, true, 'timeout fired controller.abort()');
  h.calls[0]!.reject(new Error('aborted'));
  await flush();
  assert.equal(control.hidden, true, 'aborted request takes the hidden safe default');
  assert.deepEqual(h.results[0], { value: false, failure: { code: 'CONDITION_UNVERIFIED' } });
});

test('an offline navigator never dispatches and fails closed', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const r = createConditionReader({
    setTimeout: h.clock.setTimeout,
    clearTimeout: h.clock.clearTimeout,
    viewRef: { navigator: { onLine: false } },
  });
  const control = fakeControl();
  r.request('k', h.call, [], { securityRelevant: true, action: 'show' }, control, h.onResult);
  h.clock.tick(75);
  await flush();
  assert.equal(h.calls.length, 0, 'offline: no request made');
  assert.equal(control.hidden, true);
  assert.deepEqual(h.results[0], { value: false, failure: { code: 'CONDITION_UNVERIFIED' } });
});

test('a non-boolean, null, or malformed result takes the safe default', async () => {
  const { createConditionReader } = await reader();
  for (const bad of ['true', 1, null, undefined, { value: true }, []]) {
    const h = harness();
    const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout });
    const control = fakeControl();
    r.request(`k-${JSON.stringify(bad)}`, h.call, [], { securityRelevant: true }, control, h.onResult);
    h.clock.tick(75);
    await flush();
    h.calls[0]!.resolve(bad);
    await flush();
    assert.equal(control.hidden, true, `${JSON.stringify(bad)} failed hidden`);
    assert.deepEqual(h.results[0], { value: false, failure: { code: 'CONDITION_UNVERIFIED' } });
  }
});

test('a thrown call takes the safe default and reports CONDITION_UNVERIFIED', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout });
  const control = fakeControl();
  r.request('k', h.call, [], { securityRelevant: true, action: 'show' }, control, h.onResult);
  h.clock.tick(75);
  await flush();
  h.calls[0]!.reject(Object.assign(new Error('network exploded'), { code: 'STORE_UNAVAILABLE' }));
  await flush();
  assert.equal(control.hidden, true);
  // The endpoint's machine-readable code reaches the caller, never the message.
  assert.deepEqual(h.results[0], { value: false, failure: { code: 'STORE_UNAVAILABLE' } });
});

test('a reply for a control removed from the document settles without touching its UI', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout });
  const doc = fakeDocument();
  const control = fakeControl(doc);
  r.request('k', h.call, [], { securityRelevant: true }, control, h.onResult);
  h.clock.tick(75);
  await flush();
  control.isConnected = false;
  h.calls[0]!.resolve(true);
  await flush();
  assert.equal(control.hidden, undefined, 'no mutation on a detached control');
  assert.equal(control.attrs['data-c2c-condition-state'], undefined);
  assert.equal(doc.live, null, 'no announcement for a removed control');
  assert.equal(h.results.length, 1, 'the caller still settles');
  assert.equal(h.results[0]!.value, true);
});

test('two controls coordinate independently', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout });
  const cA = fakeControl();
  const cB = fakeControl();
  r.request('A', h.call, ['a'], {}, cA, h.onResult);
  r.request('B', h.call, ['b'], { securityRelevant: true, action: 'show' }, cB, h.onResult);
  h.clock.tick(75);
  await flush();
  assert.equal(h.calls.length, 2, 'distinct keys are not coalesced together');
  h.calls[0]!.resolve(false);
  h.calls[1]!.resolve(true);
  await flush();
  assert.equal(h.results.length, 2);
  assert.equal(cB.hidden, false, 'B took its own verified value');
});

test('a failure announces through aria-live without leaking server text', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout });
  const doc = fakeDocument();
  const control = fakeControl(doc);
  r.request('k', h.call, [], { securityRelevant: true, action: 'show' }, control, h.onResult);
  h.clock.tick(75);
  await flush();
  h.calls[0]!.reject(new Error('secret server detail: uid=admin@internal /etc/passwd'));
  await flush();
  assert.ok(doc.live, 'the live region was created');
  const live = doc.live!;
  assert.equal((live.attrs as Record<string, string>)['aria-live'], 'polite');
  assert.equal((live.attrs as Record<string, string>).role, 'status');
  assert.equal(live.textContent, 'Could not verify this value.');
  assert.ok(!String(live.textContent).includes('secret') && !String(live.textContent).includes('admin'), 'no server text leaks');
});

test('a declared non-security condition may safely default to shown', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout });
  const control = fakeControl();
  r.request('k', h.call, [], { securityRelevant: false, safeDefault: 'shown', action: 'show' }, control, h.onResult);
  h.clock.tick(75);
  await flush();
  h.calls[0]!.reject(new Error('offline'));
  await flush();
  assert.equal(control.hidden, false, 'shown safe default keeps the control visible');
  assert.deepEqual(h.results[0], { value: true, failure: { code: 'CONDITION_UNVERIFIED' } });
});

test('undeclared metadata fails closed and a destructive action disables', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout });
  const control = fakeControl();
  r.request('k', h.call, [], { action: 'disable', destructive: true }, control, h.onResult);
  h.clock.tick(75);
  await flush();
  h.calls[0]!.reject(new Error('boom'));
  await flush();
  assert.equal(control.disabled, true, 'destructive control disabled on failure');
  assert.deepEqual(h.results[0], { value: false, failure: { code: 'CONDITION_UNVERIFIED' } });
});

test('a stale form nonce discards the reply', async () => {
  const { createConditionReader } = await reader();
  const h = harness();
  const form = { formNonce: 'n1' };
  const r = createConditionReader({ setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout, form });
  const control = fakeControl();
  r.request('k', h.call, [], {}, control, h.onResult);
  h.clock.tick(75);
  await flush();
  form.formNonce = 'n2';
  h.calls[0]!.resolve(true);
  await flush();
  assert.equal(control.attrs['data-c2c-condition-state'], undefined, 'reply from dead form state dropped');
  assert.equal(h.results.length, 0);
});
