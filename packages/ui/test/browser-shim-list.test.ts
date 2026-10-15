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

async function runtime(): Promise<{ browserShim: (fetchImpl?: unknown) => Shim; clientListMethods: () => Record<string, Fn> }> {
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
  assert.equal(implemented((shim.string as Record<string, unknown>).trim), false);
  assert.equal(implemented((shim.list as Record<string, unknown>).aggregate), false);
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
