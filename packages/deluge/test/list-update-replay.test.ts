import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../../shims/src/runtime.js';
import { translate } from '../src/translate.js';

const CLIENT_TODO = 'client-condition-uses-server';

function todoCount(src: string): number {
  return translate(src).todos.filter((item) => item.construct === CLIENT_TODO).length;
}

async function prefetchSlots(code: string, seed: Record<string, Record<string, unknown>[]>, record: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed });
  const slots: Record<string, unknown> = {};
  await (new Function('shim', 'ctx', 'slots', `return (async () => {\n${code}\n})();`) as (
    shim: unknown,
    ctx: unknown,
    slots: Record<string, unknown>,
  ) => Promise<void>)(runtime.shim, runtime.context({ record }), slots);
  return slots;
}

const SEED = {
  Items: [
    { ROWID: '1', Code: 1, Kind: 'a' },
    { ROWID: '2', Code: 2, Kind: 'a' },
    { ROWID: '3', Code: 3, Kind: 'b' },
  ],
};

test('a list built by a loop over a query, then trimmed by input rows, reaches the client choice', async () => {
  const src = [
    'ids = List:Int();',
    'for each r in Items[Kind == input.Kind] { ids.add(r.Code); }',
    'for each s in input.Lines { ids.removeElement(s.Ref); }',
    'if (!ids.isEmpty()) { input.Pick:ui.add(ids); }',
  ].join('\n');
  const t = translate(src);
  assert.equal(t.stats.todo, 0);
  assert.doesNotMatch(t.client, /shim\.todo/);
  const slots = await prefetchSlots(t.prefetch, SEED, { Kind: 'a', Lines: [{ Ref: 2 }] });
  assert.deepEqual(slots.c0, [1]);
  assert.equal(slots.c1, true);
  const none = await prefetchSlots(t.prefetch, SEED, { Kind: 'a', Lines: [{ Ref: 1 }, { Ref: 2 }] });
  assert.deepEqual(none.c0, []);
  assert.equal(none.c1, false);
});

test('a column list minus its intersection with input rows decides a validate alert', async () => {
  const src = [
    'kept = List:Int();',
    'gone = Items[Kind == "a"].Code.getAll();',
    'for each s in input.Lines { kept.add(s.Ref); }',
    'both = gone.intersect(kept);',
    'gone.removeAll(both);',
    'if (!gone.isEmpty()) { alert "x"; cancel submit; }',
  ].join('\n');
  const t = translate(src);
  assert.equal(t.stats.todo, 0);
  assert.equal((await prefetchSlots(t.prefetch, SEED, { Lines: [{ Ref: 1 }] })).c0, true);
  assert.equal((await prefetchSlots(t.prefetch, SEED, { Lines: [{ Ref: 1 }, { Ref: 2 }] })).c0, false);
});

test('the replay updates a copy: a slot holding the list before the update keeps that value', async () => {
  const t = translate('l = Items[Kind == "a"].Code.getAll(); input.A:ui.add(l); l.add(9); input.B:ui.add(l);');
  assert.equal(t.stats.todo, 0);
  const slots = await prefetchSlots(t.prefetch, SEED);
  assert.deepEqual(slots.c0, [1, 2]);
  assert.deepEqual(slots.c1, [1, 2, 9]);
});

test('a self-assign read after each step replays every version once', async () => {
  const src = 'n = Items[ID != 0].count();\nif (n > 3) { alert "a"; }\nn = n + 1;\nif (n > 3) { alert "b"; }\nn = n + 1;\nif (n == 5) { alert "c"; }';
  const t = translate(src);
  assert.equal(t.stats.todo, 0);
  const slots = await prefetchSlots(t.prefetch, SEED);
  // count 3, then 4, then 5
  assert.deepEqual([slots.c0, slots.c1, slots.c2], [false, true, true]);
});

test('an update stays a counted todo when another local shares the list', () => {
  assert.equal(todoCount('l = List(); b = l; l.add(Items[Kind == "a"].count()); if (l.size() > 0) { alert "x"; }'), 1);
});

test('an update that calls an app function stays a counted todo', () => {
  assert.equal(todoCount('l = List(); l.add(thisapp.Pick(input.ID)); if (l.size() > 0) { alert "x"; }'), 1);
});

test('a loop that does anything besides the list update stays a counted todo', () => {
  for (const body of ['ids.add(r.ID); r.Seen = true;', 'ids.add(r.ID); n = r.ID;', 'ids.add(r.ID); other.add(r.ID);', 'if (r.ID > 1) { ids.add(r.ID); }']) {
    const src = `ids = List:Int(); other = List:Int(); for each r in Items[Kind == "a"] { ${body} } if (!ids.isEmpty()) { alert "x"; }`;
    assert.equal(todoCount(src), 1, body);
  }
});

test('a loop over a collection that reads the updated list stays a counted todo', () => {
  assert.equal(todoCount('ids = Items[Kind == "a"].ID.getAll(); for each r in Items[ID in ids] { ids.add(r.ID); } if (ids.size() > 1) { alert "x"; }'), 1);
});

test('a conditional update inside a loop over a server collection stays a counted todo', () => {
  assert.equal(todoCount('ids = List:Int(); for each r in Items[Kind == "a"] { if (r.Code > 0) { ids.add(r.Code); } } if (ids.size() > 1) { alert "x"; }'), 1);
});

test('a conditional update inside a loop whose collection reads the list stays a counted todo', () => {
  assert.equal(todoCount('ids = Items[Kind == "a"].ID.getAll(); for each r in Items[ID in ids] { if (r.ID > 0) { ids.add(r.ID); } } if (ids.size() > 1) { alert "x"; }'), 1);
});
