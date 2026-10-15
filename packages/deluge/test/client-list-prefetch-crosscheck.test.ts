import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../../shims/src/runtime.js';
import { translate } from '../src/translate.js';

// Each case runs its prefetch on the server shims, sends the slots through
// JSON (as on the wire), then runs the client body on both the shims runtime
// and the browser runtime. The actions must match the Deluge result.

const SEED = {
  Items: [
    { ROWID: '1', Code: 1, Kind: 'a' },
    { ROWID: '2', Code: 2, Kind: 'a' },
    { ROWID: '3', Code: 3, Kind: 'b' },
  ],
};

type Action = { op: string; message?: string; target?: unknown; args?: unknown[] };

// The browser shim is a thenable proxy, so it is returned unawaited.
async function browserRuntime(): Promise<{ browserShim: () => unknown }> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as { browserShim: () => unknown };
}

async function run(src: string, record: Record<string, unknown>): Promise<{ todo: number; shims: string[]; browser: string[] }> {
  const t = translate(src);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: SEED });
  const slots: Record<string, unknown> = {};
  const body = (names: string[], code: string) => new Function(...names, `return (async () => {\n${code}\n})();`) as (...args: unknown[]) => Promise<void>;
  await body(['shim', 'ctx', 'slots'], t.prefetch)(runtime.shim, runtime.context({ record }), slots);
  const wire = JSON.parse(JSON.stringify(slots)) as Record<string, unknown>;
  const client = async (shim: unknown, ctx: unknown) => {
    const actions: Action[] = [];
    await body(['shim', 'ctx', 'slots', 'actions'], t.client)(shim, ctx, wire, actions);
    return actions.map((a) => (a.op === 'alert' ? `alert ${a.message}` : `${a.op} ${JSON.stringify(a.target)} ${JSON.stringify(a.args)}`));
  };
  return {
    todo: t.stats.todo,
    shims: await client(runtime.shim, runtime.context({ record })),
    browser: await client((await browserRuntime()).browserShim(), { record }),
  };
}

const CASES: { name: string; src: string; record?: Record<string, unknown>; want: string[] }[] = [
  {
    name: 'a self-assign read after each step',
    src: 'n = Items[ID != 0].count(); if (n > 3) { alert "a"; } n = n + 1; if (n > 3) { alert "b"; } n = n + 1; if (n == 5) { alert "c"; }',
    want: ['alert b', 'alert c'],
  },
  {
    name: 'removeElement of an input value, then a size condition',
    src: 'l = Items[Kind == "a"].Code.getAll(); l.removeElement(input.Ref); if (l.size() == 1) { alert "one"; } else { alert "other"; }',
    record: { Ref: 2 },
    want: ['alert one'],
  },
  {
    name: 'removeElement of an input value that is not in the list',
    src: 'l = Items[Kind == "a"].Code.getAll(); l.removeElement(input.Ref); if (l.size() == 1) { alert "one"; } else { alert "other"; }',
    record: { Ref: 9 },
    want: ['alert other'],
  },
  {
    name: 'add of an input value',
    src: 'l = Items[Kind == "a"].Code.getAll(); l.add(input.Ref); if (l.size() == 3) { alert "three"; }',
    record: { Ref: 7 },
    want: ['alert three'],
  },
  {
    name: 'a condition before and after an add',
    src: 'l = Items[Kind == "a"].Code.getAll(); if (l.size() == 2) { alert "before"; } l.add(input.Ref); if (l.size() == 3) { alert "after"; } if (l.size() == 2) { alert "stale"; }',
    record: { Ref: 7 },
    want: ['alert before', 'alert after'],
  },
  {
    name: 'duplicates and order',
    src: 'l = Items[ID != 0].Code.getAll(); l.add(1); input.Pick:ui.add(l);',
    want: ['ui ["Pick"] [[1,2,3,1]]'],
  },
  {
    name: 'removeElement of an input value, then a server-fed add',
    src: 'l = Items[ID != 0].Code.getAll(); l.removeElement(input.Ref); l.add(Items[Kind == "b"].count()); input.Pick:ui.add(l);',
    record: { Ref: 2 },
    want: ['ui ["Pick"] [[1,3,1]]'],
  },
  {
    name: 'removeAll of an input list',
    src: 'l = Items[ID != 0].Code.getAll(); l.removeAll(input.Picks); input.Pick:ui.add(l);',
    record: { Picks: [1, 3] },
    want: ['ui ["Pick"] [[2]]'],
  },
  {
    name: 'a loop removing input row values',
    src: 'l = Items[ID != 0].Code.getAll(); for each s in input.Lines { l.removeElement(s.Ref); } if (l.contains(3)) { alert "has3"; } if (l.size() == 2) { alert "two"; }',
    record: { Lines: [{ Ref: 3 }] },
    want: ['alert two'],
  },
  {
    name: 'two removeElements, then contains',
    src: 'l = Items[ID != 0].Code.getAll(); l.removeElement(input.A); l.removeElement(input.B); if (l.contains(2)) { alert "has2"; } else { alert "no2"; }',
    record: { A: 1, B: 2 },
    want: ['alert no2'],
  },
  {
    name: 'a loop adding a row column',
    src: 'ids = List:Int(); for each r in Items[Kind == "a"] { ids.add(r.Code); } input.Pick:ui.add(ids);',
    want: ['ui ["Pick"] [[1,2]]'],
  },
  {
    name: 'a loop adding duplicate values',
    src: 'ks = List(); for each r in Items[ID != 0] { ks.add(r.Kind); } input.Pick:ui.add(ks);',
    want: ['ui ["Pick"] [["a","a","b"]]'],
  },
  {
    name: 'a field showing the list before a loop and another after it',
    src: 'ids = Items[Kind == "b"].Code.getAll(); input.A:ui.add(ids); for each r in Items[Kind == "a"] { ids.add(r.Code); } input.B:ui.add(ids);',
    want: ['ui ["A"] [[3]]', 'ui ["B"] [[3,1,2]]'],
  },
  {
    name: 'two loops with a field between them',
    src: 'ids = List:Int(); for each r in Items[Kind == "a"] { ids.add(r.Code); } input.A:ui.add(ids); for each r in Items[Kind == "b"] { ids.add(r.Code); } input.B:ui.add(ids);',
    want: ['ui ["A"] [[1,2]]', 'ui ["B"] [[1,2,3]]'],
  },
  {
    name: 'a scalar sum over rows',
    src: 't = 0; for each r in Items[ID != 0] { t = t + r.Code; } if (t == 6) { alert "six"; }',
    want: ['alert six'],
  },
];

for (const c of CASES) {
  test(`client and browser agree with Deluge: ${c.name}`, async () => {
    const got = await run(c.src, c.record ?? {});
    assert.equal(got.todo, 0, 'translated, not a counted todo');
    assert.deepEqual(got.shims, c.want, 'shims runtime');
    assert.deepEqual(got.browser, c.want, 'browser runtime');
  });
}
