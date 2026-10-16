import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../../shims/src/runtime.js';
import { translate } from '../src/translate.js';

// A server-filled list the client then trims under an `if` is declared on the
// client from a prefetch slot. That declaration must run after the client's
// own earlier `L = List()` of the same name: declared at the top of the
// handler, the later `var L = []` resets the copy and the client works on an
// empty list where Deluge (and the server) hold the filled one.

const SEED = {
  Items: [
    { ROWID: '1', Code: 1, Kind: 'a' },
    { ROWID: '2', Code: 2, Kind: 'a' },
    { ROWID: '3', Code: 3, Kind: 'b' },
  ],
};

type Action = { op: string; method?: string; args?: unknown[] };

async function run(code: string, params: string[], args: unknown[]): Promise<void> {
  const fn = new Function(...params, `return (async () => {\n${code}\n})();`) as (...a: unknown[]) => Promise<void>;
  await fn(...args);
}

/** Runs the server half, the prefetch and the client half on one record; returns the field the server wrote and the client's `ui.add` args. */
async function both(src: string, record: Record<string, unknown>): Promise<{ server: unknown; client: unknown[][] }> {
  const t = translate(src);
  assert.equal(t.stats.todo, 0, 'no counted todo');
  const server = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: SEED });
  const sctx = server.context({ record: { ...record } }) as { record: Record<string, unknown> };
  await run(t.server, ['shim', 'ctx', 'actions'], [server.shim, sctx, []]);
  const pre = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: SEED });
  const slots: Record<string, unknown> = {};
  await run(t.prefetch, ['shim', 'ctx', 'slots'], [pre.shim, pre.context({ record: { ...record } }), slots]);
  const client = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: {} });
  const actions: Action[] = [];
  await run(t.client, ['shim', 'ctx', 'slots', 'actions'], [client.shim, client.context({ record: { ...record } }), slots, actions]);
  return {
    server: sctx.record.Out,
    client: actions.filter((a) => a.op === 'ui' && a.method === 'add').map((a) => (a.args ?? []).map((v) => (Array.isArray(v) ? [...v] : v))),
  };
}

const TRIM = 'for each s in input.Lines { if (s.Ref > 0) { ids.removeElement(s.Ref); } }';
const FILL = 'for each r in Items[Kind == input.Kind] { ids.add(r.Code); }';
const RECORD = { Kind: 'a', Lines: [{ Ref: 2 }] };

test('a list declared, server-filled, then trimmed in a client loop keeps the filled value on the client', async () => {
  const src = ['ids = List();', FILL, TRIM, 'input.Out = ids.toString();', 'input.Pick:ui.add(ids);'].join('\n');
  const out = await both(src, RECORD);
  assert.equal(out.server, '1');
  assert.deepEqual(out.client, [[[1]]]);
});

test('a list declared twice before the server fill keeps the filled value on the client', async () => {
  const src = ['ids = List:Int();', 'ids = List();', FILL, TRIM, 'input.Out = ids.toString();', 'input.Pick:ui.add(ids);'].join('\n');
  const out = await both(src, RECORD);
  assert.equal(out.server, '1');
  assert.deepEqual(out.client, [[[1]]]);
});

test('a list re-declared after the client update starts empty again on both sides', async () => {
  const src = ['ids = List();', FILL, TRIM, 'input.Pick:ui.add(ids);', 'ids = List();', 'ids.add(7);', 'input.Out = ids.toString();', 'input.Pick:ui.add(ids);'].join('\n');
  const out = await both(src, RECORD);
  assert.equal(out.server, '7');
  assert.deepEqual(out.client, [[[1]], [[7]]]);
});

test('a list re-declared and refilled inside one loop trims the refilled value on every pass', async () => {
  const src = [
    'for each k in input.Kinds {',
    '  ids = List();',
    '  for each r in Items[Kind == k.Kind] { ids.add(r.Code); }',
    '  if (k.Drop > 0) { ids.removeElement(k.Drop); }',
    '  input.Pick:ui.add(ids);',
    '}',
  ].join('\n');
  // A client loop cannot iterate a server collection, so this stays a counted
  // todo rather than a client copy reset at the wrong place.
  const t = translate(src);
  assert.ok(t.stats.todo > 0);
  assert.doesNotMatch(t.client, /var ids = shim\.list\.duplicate\(slots/);
});

test('a client update declared before a top-level statement that re-declares the list earlier in it stays server-only', async () => {
  const src = [
    'ids = List();',
    'if (input.Kind != "") {',
    '  ids = List();',
    '  ' + FILL,
    '  ' + TRIM,
    '}',
    'input.Out = ids.toString();',
    'input.Pick:ui.add(ids);',
  ].join('\n');
  const t = translate(src);
  // Wherever the client copy is declared, it must not sit above a client
  // `ids = List()` that runs before the update it feeds.
  const decl = t.client.indexOf('shim.list.duplicate(slots');
  if (decl >= 0) {
    const reset = t.client.indexOf('ids = [];', decl);
    const update = t.client.indexOf('shim.list.removeElement(ids', decl);
    assert.ok(reset < 0 || update < reset, `client copy reset before its update:\n${t.client}`);
  }
  if (t.stats.todo === 0) {
    const out = await both(src, RECORD);
    assert.deepEqual(out.client, [[[1]]]);
  }
});
