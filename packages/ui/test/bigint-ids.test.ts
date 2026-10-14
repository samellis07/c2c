/** Golden: the browser runtime keeps a bare 19-digit id from a c2c_api JSON reply. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { UiModel } from '../src/index.js';

const CREATOR = '1000000000000000001';
const ROWID_17 = '10000000000315013';

const model = {
  name: 'Big Ids',
  nav: [{ name: 'Menu', hidden: false, items: [{ kind: 'report', name: 'R', label: 'R', href: '#/report/R' }] }],
  pages: [],
  forms: [],
  reports: [
    {
      name: 'R',
      label: 'R',
      status: 'generated',
      view: 'list',
      queryEndpoint: '/reports/R',
      pageSize: 300,
      columns: [
        { field: 'ROWID', label: 'Row' },
        { field: 'Author', label: 'Author' },
        { field: 'Qty', label: 'Qty' },
      ],
      filters: [],
      sort: [],
      groupBy: [],
      customActions: [],
      detail: false,
    },
  ],
} as unknown as UiModel;

test('a report row with bare 17- and 19-digit ids renders the exact digits', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  const runtime = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as {
    boot(model: UiModel, doc: Document): Promise<void>;
  };
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>', {
    url: 'http://localhost/slate/index.html#/report/R',
  }).window as unknown as { document: Document; fetch: unknown };
  const body = `{"rows":[{"ROWID":${ROWID_17},"Author":${CREATOR},"Qty":2}]}`;
  // A fetch Response: json() is JSON.parse of the same text.
  win.fetch = async () => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
  await runtime.boot(model, win.document);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const cells = Array.from(win.document.querySelectorAll('[data-rows] tbody td')).map((td) => td.textContent);
  assert.deepEqual(cells, [ROWID_17, CREATOR, '2']);
});

async function clientRuntime() {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as {
    browserShim(fetchImpl: unknown): { client: { prefetch(ctx: unknown, path: string): Promise<{ ok: boolean }> } };
  };
}

test('prefetch sends a bigint in the record as its digits', async () => {
  const sent: string[] = [];
  const fetchImpl = async (_url: string, init: { body: string }) => {
    sent.push(init.body);
    return { ok: true, status: 200, text: async () => '{"slots":{},"nonce":"n"}' };
  };
  const shim = (await clientRuntime()).browserShim(fetchImpl);
  const got = await shim.client.prefetch({ record: { A: BigInt(CREATOR), M: { ids: [BigInt(ROWID_17)] } }, formNonce: 'n' }, '/forms/F/load/prefetch');
  assert.equal(got.ok, true);
  assert.deepEqual(sent, [`{"record":{"A":"${CREATOR}","M":{"ids":["${ROWID_17}"]}},"nonce":"n"}`]);
});

test('the client prefetch and submit bodies serialise with the bigint replacer', () => {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  // prefetch, the deferred slot read, the form submit, and the smoke page's
  // submit — every one replacer-safe.
  const bodies = source.match(/JSON\.stringify\(\{ record[^\n]*/g) ?? [];
  assert.equal(bodies.length, 4);
  for (const line of bodies) assert.match(line, /, jsonReplacer\),$/, line);
});
