import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { emptyApp, type App, type Workflow } from '../../core/src/index.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { generate } from '../src/generate.js';

const Z = { start: 0, end: 0 };

function stripComments(s: string): string {
  return s.replace(/^\s*\/\/ Deluge: .*\n?/gm, '');
}

function field(name: string): App['forms'][number]['fields'][number] {
  return { name, type: 'text', modifiers: [], required: false, unique: false, properties: [], subfields: [], annotations: [], flags: [], span: Z };
}

function form(name: string, fields: string[]): App['forms'][number] {
  return { name, properties: [], fields: fields.map(field), actions: [], blocks: [], span: Z };
}

function onLoad(script: string): { client: string; prefetch: string | undefined; todos: string[] } {
  const wf: Workflow = { name: 'on load', form: 'Orders', event: 'on load', deluge: { text: script, span: Z }, properties: [], span: Z };
  const g = generate({
    ...emptyApp('empty'),
    name: 'Demo_App',
    forms: [form('Orders', ['Status', 'Kind', 'Qty']), form('Limits', ['Code', 'Cap'])],
    workflows: [wf],
  });
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs');
  assert.ok(client);
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs');
  return { client: client.source, prefetch: prefetch?.source, todos: g.todos.map((t) => t.construct) };
}

async function load(source: string, name: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-row-acc-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  writeFileSync(join(dir, name), source);
  return (await import(pathToFileURL(join(dir, name)).href)) as Record<string, unknown>;
}

// A local summed from fields of the rows a client loop walks, then compared
// after the loop. The client loop iterates the same prefetched rows the
// server reads, so the sum is a client value and the condition is not a
// server read.
const ACCUMULATOR = [
  'total = 0;',
  'for each rec in Orders[Status == "Open"] {',
  '  if (rec.Kind != "Free") {',
  '    total = total + rec.Qty;',
  '  }',
  '}',
  'left = 5 - total;',
  'if (left <= 0) { alert "none left"; } else { alert "some left"; }',
].join('\n');

test('a local summed from client-iterated prefetched rows is assigned on the client and decides the condition there', async () => {
  const out = onLoad(ACCUMULATOR);
  assert.deepEqual(out.todos, []);
  assert.ok(out.prefetch);
  const code = stripComments(out.client);
  assert.doesNotMatch(code, /shim\.todo\(/);
  assert.match(code, /for \(var d_rec of shim\.each\(ctx, slots\["c0"\]\)\)/);
  assert.match(code, /total = \(total \+ shim\.record\.get\(d_rec, "Qty"\)\);/);
  assert.match(code, /var left = \(5 - total\);\n\s*if \(\(left <= 0\)\)/);

  const pre = (await load(out.prefetch, 'prefetch.mjs')) as { prefetch: (ctx: unknown) => Promise<Record<string, unknown>> };
  const cmod = (await load(out.client, 'client.mjs')) as { clientActions: (ctx: unknown) => Promise<{ op: string; message?: unknown }[]> };
  const run = async (rows: Record<string, unknown>[]) => {
    const runtime = createRuntime({
      dryRun: true,
      appTimeZone: 'UTC',
      seed: { Orders: rows },
      clientPrefetch: async (_path, nonce) => ({ nonce, slots: await pre.prefetch(runtime.context({ record: {} })) }),
    });
    return (await cmod.clientActions(runtime.context({ record: {} }))).map((a) => [a.op, a.message]);
  };
  // 2 + 1 counted (the free row and the closed row are not): 2 left.
  assert.deepEqual(
    await run([
      { ROWID: '1', Status: 'Open', Kind: 'Paid', Qty: 2 },
      { ROWID: '2', Status: 'Open', Kind: 'Free', Qty: 9 },
      { ROWID: '3', Status: 'Open', Kind: 'Paid', Qty: 1 },
      { ROWID: '4', Status: 'Closed', Kind: 'Paid', Qty: 9 },
    ]),
    [['alert', 'some left']],
  );
  // 4 + 3 counted: none left.
  assert.deepEqual(
    await run([
      { ROWID: '1', Status: 'Open', Kind: 'Paid', Qty: 4 },
      { ROWID: '2', Status: 'Open', Kind: 'Paid', Qty: 3 },
    ]),
    [['alert', 'none left']],
  );
});

test('a row-summed local compared with another server read stays a counted client todo', () => {
  const out = onLoad([
    'total = 0;',
    'for each rec in Orders[Status == "Open"] {',
    '  total = total + rec.Qty;',
    '}',
    'if (total > Limits[Code == "A"].Cap) { alert "over"; }',
  ].join('\n'));
  assert.deepEqual(out.todos, ['client-condition-uses-server']);
  assert.match(stripComments(out.client), /if \(await shim\.todo\(ctx, "client-condition-uses-server"\)\)/);
});

test('a local summed per row from a second server read stays a counted client todo', () => {
  const out = onLoad([
    'total = 0;',
    'for each rec in Orders[Status == "Open"] {',
    '  total = total + Limits[Code == rec.Kind].Cap;',
    '}',
    'if (total > 3) { alert "over"; }',
  ].join('\n'));
  assert.deepEqual(out.todos, ['client-condition-uses-server']);
  assert.doesNotMatch(stripComments(out.client), /total = \(total \+/);
});

test('a local summed inside a loop the client cannot iterate is not assigned on the client', () => {
  // The collection calls an app function, so the client loop is refused.
  // The sum must not become a client local: the condition stays counted.
  const out = onLoad([
    'total = 0;',
    'for each rec in Orders[Status == thisapp.pick()] {',
    '  total = total + rec.Qty;',
    '}',
    'if (total > 3) { alert "over"; }',
  ].join('\n'));
  assert.ok(out.todos.includes('client-condition-uses-server'));
  const code = stripComments(out.client);
  assert.doesNotMatch(code, /total = \(total \+/);
  assert.doesNotMatch(code, /if \(\(total > 3\)\)/);
});
