import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CLIENT_SHIM_CALLABLE, CLIENT_SHIM_METHODS } from '../../deluge/src/client-shim.js';
import { translate } from '../../deluge/src/translate.js';
import * as lists from '../../shims/src/list.js';
import { ifnull } from '../../shims/src/text.js';
import { isNumber } from '../../shims/src/number.js';

type Fn = (...args: unknown[]) => unknown;
type Shim = Record<string, unknown>;

async function runtime(): Promise<{ browserShim: (fetchImpl?: unknown) => Shim; browserShimSurface: (fetchImpl?: unknown) => Shim; clientListMethods: () => Record<string, Fn> }> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as never;
}

/** The browser's catch-all stub answers every property with another stub; a real function has no such property. */
function implemented(value: unknown): boolean {
  return typeof value === 'function' && (value as unknown as Record<string, unknown>).__c2cStubProbe === undefined;
}

test('browserShim implements every shim name the translator may emit into client code', async () => {
  const shim = (await runtime()).browserShim(async () => new Response('{}'));
  const missing: string[] = [];
  for (const name of CLIENT_SHIM_CALLABLE) if (!implemented(shim[name])) missing.push(name);
  for (const [ns, methods] of CLIENT_SHIM_METHODS) {
    const space = shim[ns] as Record<string, unknown>;
    for (const method of methods) if (!implemented(space?.[method])) missing.push(`${ns}.${method}`);
  }
  assert.deepEqual(missing, []);
  // The stub itself is detected, so the check above cannot pass vacuously.
  assert.equal(implemented((shim.string as Record<string, unknown>).toUpperCase), false);
  assert.equal(implemented((shim.list as Record<string, unknown>).aggregate), false);
});

test('the client-shim allowlist is exactly the surface the browser shim implements', async () => {
  const rt = await runtime();
  const surface = rt.browserShimSurface(async () => new Response('{}'));
  const shim = rt.browserShim(async () => new Response('{}'));
  const sorted = (names: Iterable<string>): string[] => [...names].sort();
  // Callables are the surface's function entries; namespaces its object entries, plus `list`, which is both.
  const callables = Object.keys(surface).filter((name) => typeof surface[name] === 'function');
  const namespaces = Object.keys(surface).filter((name) => name === 'list' || (surface[name] !== null && typeof surface[name] === 'object'));
  assert.deepEqual(sorted(Object.keys(surface)), sorted(new Set([...callables, ...namespaces])));
  assert.deepEqual(sorted(callables), sorted(CLIENT_SHIM_CALLABLE));
  assert.deepEqual(sorted(namespaces), sorted(CLIENT_SHIM_METHODS.keys()));
  for (const ns of namespaces) {
    const methods = ns === 'list' ? Object.keys(rt.clientListMethods()) : Object.keys(surface[ns] as object);
    assert.deepEqual(sorted(methods), sorted(CLIENT_SHIM_METHODS.get(ns)!), ns);
    for (const method of methods) assert.equal(implemented((shim[ns] as Record<string, unknown>)[method]), true, `${ns}.${method}`);
  }
  for (const name of callables) assert.equal(implemented(shim[name]), true, name);
});

async function blockedMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    assert.equal((err as { c2cElementBlocked?: boolean }).c2cElementBlocked, true);
    return (err as Error).message;
  }
  assert.fail('expected the client action to be blocked');
}

test('browser client.call and client.element refuse a reply that carries an error, like the server runtime', async () => {
  const reply = (extra: Record<string, unknown>) =>
    (async (_url: string, init: { body: string }) => {
      const { nonce } = JSON.parse(init.body) as { nonce: string };
      return new Response(JSON.stringify({ nonce, ...extra }));
    }) as unknown;
  const { browserShim } = await runtime();
  const client = (fetchImpl: unknown) => browserShim(fetchImpl).client as Record<string, Fn>;
  const ctx = () => ({ formNonce: 'n-1', prefetchPath: '/functions/form/prefetch', record: {} });

  assert.equal(await client(reply({ ok: true, value: 7 })).call!(ctx(), 'Lookup.fn', []), 7);
  assert.equal(await blockedMessage(() => client(reply({ ok: true, error: 'lookup failed', value: 7 })).call!(ctx(), 'Lookup.fn', []) as Promise<unknown>), 'lookup failed');

  assert.equal(await client(reply({ slots: { s1: 3 } })).element!(ctx(), 'x', 1, 's1'), 3);
  assert.equal(await blockedMessage(() => client(reply({ error: 'slot failed', slots: { s1: 3 } })).element!(ctx(), 'x', 1, 's1') as Promise<unknown>), 'slot failed');
});

test('browser client.run posts the merged route with runEvent and blocks a refused run', async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const reply = (status: number, extra: Record<string, unknown>) =>
    (async (url: string, init: { body: string }) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify(extra), { status });
    }) as unknown;
  const { browserShim } = await runtime();
  const client = (fetchImpl: unknown) => browserShim(fetchImpl).client as Record<string, Fn>;
  const ctx = () => ({ formNonce: 'n-2', record: { Name: 'x' }, runPath: '/forms/Orders/input', runEvent: 'on user input of Name' });

  const ok = (await client(reply(200, { dryRun: true, result: null })).run!(ctx())) as Record<string, unknown>;
  assert.equal(ok.dryRun, true);
  assert.deepEqual(sent[0], { url: '/forms/Orders/input', body: { record: { Name: 'x' }, nonce: 'n-2', runEvent: 'on user input of Name' } });
  // A refused status and a refused reply both block the run like client.call.
  assert.equal(await blockedMessage(() => client(reply(404, { error: 'unknown script event' })).run!(ctx()) as Promise<unknown>), 'unknown script event');
  assert.equal(await blockedMessage(() => client(reply(200, { error: 'refused' })).run!(ctx()) as Promise<unknown>), 'refused');
  // No runPath on the context blocks the run without a request.
  await blockedMessage(() => client(reply(200, {})).run!({ formNonce: 'n-2', record: {} }) as Promise<unknown>);
});

const RECEIVERS: unknown[] = [
  [1, 2, 3, 2],
  ['b', 'a', 'c', 'a'],
  [],
  [10, '2', 1, null],
  ['1000000000000000001', 7],
  [{ a: 1, ID: 5 }, { __row: true, form: 'F', values: { a: 2, ROWID: '9' } }, null],
  { a: 1, b: 2 },
  {},
  'hello world',
  '',
  null,
  7,
];
const ARGS: unknown[][] = [
  [],
  [0],
  [2],
  [5],
  [-1],
  ['a'],
  ['2'],
  ['o'],
  [false],
  [true],
  [null],
  [[2, 3]],
  [['a', 'b']],
  [{ c: 3 }],
  [1, 3],
  [1, 'x'],
  [0, 2],
  ['a', 9],
  [1000000000000000001n],
  ['ID'],
];

function outcome(fn: Fn, receiver: unknown, args: unknown[]): { value?: unknown; receiver: unknown; error?: string } {
  const own = structuredClone(receiver);
  try {
    const value = fn(own, ...structuredClone(args));
    return { value: value === own ? '<receiver>' : value, receiver: own };
  } catch (err) {
    return { error: (err as Error).message, receiver: own };
  }
}

test('browser list operations match packages/shims on the same inputs', async () => {
  const client = (await runtime()).clientListMethods();
  const server = lists as unknown as Record<string, Fn>;
  const methods = [...CLIENT_SHIM_METHODS.get('list')!];
  assert.deepEqual(Object.keys(client).sort(), [...methods].sort());
  let compared = 0;
  for (const method of methods) {
    assert.equal(typeof server[method], 'function', method);
    for (const receiver of RECEIVERS) {
      for (const args of ARGS) {
        const want = outcome(server[method]!, receiver, args);
        const got = outcome(client[method]!, receiver, args);
        assert.deepEqual(got, want, `${method}(${JSON.stringify(receiver)}, ${String(args)})`);
        compared++;
      }
    }
  }
  assert.ok(compared > 1000);
  const shim = (await runtime()).browserShim();
  const list = shim.list as Fn & Record<string, Fn>;
  assert.deepEqual(list('Text'), []);
  assert.equal(list.contains!(['a'], 'b'), false);
  assert.equal(list.size!(['a', 'b']), 2);
  assert.equal(list.size!(['a']) !== 0, true);
});

test('browser null tests and ifnull match the server runtime', async () => {
  const shim = (await runtime()).browserShim();
  const values: unknown[] = [null, undefined, '', ' ', 'x', '12', ' 1.5 ', '1e3', 0, 3.5, Number.NaN, 5n, true, [], [1], {}, { a: 1 }];
  for (const v of values) {
    assert.equal((shim.isEmpty as Fn)(v), lists.isEmpty(v), `isEmpty ${String(v)}`);
    assert.equal((shim.isNumber as Fn)(v), isNumber(v), `isNumber ${String(v)}`);
    assert.equal((shim.isBlank as Fn)(v), v == null || (typeof v === 'string' && v.trim() === ''), `isBlank ${String(v)}`);
    assert.equal((shim.isNull as Fn)(v), v == null || v === '', `isNull ${String(v)}`);
    for (const r of ['r', '', null]) assert.deepEqual((shim.ifnull as Fn)(v, r), ifnull(v, r));
  }
});

/** Runs a translated client body the way the generated `clientActions` does, with no DOM. */
async function runClient(code: string, record: Record<string, unknown>): Promise<unknown[]> {
  const shim = (await runtime()).browserShim(async () => new Response('{}'));
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (ctx: unknown) => Promise<unknown[]>;
  const run = new AsyncFunction('ctx', `const shim = ctx.shim;\nconst actions = [];\n${code}\nreturn actions;`);
  return run({ shim, record });
}

test('a translated `not in` list condition runs correctly in the browser shim', async () => {
  const src = 'l = {"a","b"};\nif (input.Name not in l)\n{\n  alert "not listed";\n}\nn = List();\nn.add(input.Name);\nn.addAll(l);\nif (n.size() > 2 && n.indexOf("b") == 2)\n{\n  info "three";\n}';
  const out = translate(src, { inputFields: ['Name'] });
  assert.match(out.client, /!shim\.list\.contains\(l, shim\.input\.get\(ctx, "Name"\)\)/);
  assert.equal(out.prefetch, '');
  assert.deepEqual(out.todos, []);
  assert.deepEqual(await runClient(out.client, { Name: 'a' }), [{ op: 'info', message: 'three' }]);
  assert.deepEqual(await runClient(out.client, { Name: 'z' }), [
    { op: 'alert', message: 'not listed' },
    { op: 'info', message: 'three' },
  ]);
});
