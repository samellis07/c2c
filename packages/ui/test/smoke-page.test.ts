/**
 * The hidden in-app smoke page (#/admin/smoke). It runs the embedded
 * C2C_SMOKE_PLAN through the same guarded endpoints the forms and reports
 * use, paints a result table plus a machine-readable JSON block, and speaks
 * in statuses and counts only — never tokens or record values.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, type UiModel } from '../src/index.js';
import { smokeCanonical, smokePlanDigest, smokeSha256 } from '../../deploy/src/smoke-result.js';
import { decodeSmokeCode } from '../../deploy/src/smoke-code.js';

const DS = `\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tsection S
\t{
\t\tform Vendor
\t\t{
\t\t\tmust have Vendor_Name
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tform Item
\t\t{
\t\t\tStatus
\t\t\t(
\t\t\t\ttype = dropdown
\t\t\t\tvalues = {"Open","Closed"}
\t\t\t)
\t\t\tmust have Item_Name
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tmust have Vendor
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tvalues = Vendor.Vendor_Name
\t\t\t)
\t\t\tPhoto
\t\t\t(
\t\t\t\ttype = file
\t\t\t)
\t\t\tmust have Lines
\t\t\t(
\t\t\t\ttype = grid
\t\t\t\tmust have Note
\t\t\t\t(
\t\t\t\t\ttype = text
\t\t\t\t)
\t\t\t)
\t\t}
\t\tlist Item_Report
\t\t{
\t\t\tshow all rows from Item
\t\t}
\t}
`;

function appOf(body: string): App {
  return deriveIr(parse(`application "Widget"\n{\n${body}\n}\n`));
}

async function loadRuntime(ds: string): Promise<{ dir: string; runtime: Record<string, unknown>; model: UiModel }> {
  const built = buildUi(appOf(ds));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-smoke-page-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of built.files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.data);
  }
  const runtimePath = [...built.files.map((file) => file.path)].find((path) => /slate\/assets\/runtime\.[0-9a-f]{10}\.js$/.test(path));
  assert.ok(runtimePath);
  const runtime = (await import(pathToFileURL(join(dir, runtimePath)).href)) as Record<string, unknown>;
  const modelPath = [...built.files.map((file) => file.path)].find((path) => /slate\/assets\/model\.[0-9a-f]{10}\.js$/.test(path));
  const loaded = (await import(pathToFileURL(join(dir, modelPath!)).href)) as { model: UiModel };
  return { dir, runtime, model: loaded.model };
}

interface FakeReply {
  status: number;
  body: unknown;
}

/** The plan a deploy embeds as globalThis.C2C_SMOKE_PLAN (the JSON shape smoke.ts produces). */
function smokePlan(): Record<string, unknown>[] {
  const record = [
    { name: 'Item_Name', source: 'run marker' },
    { name: 'Vendor', source: 'lookup Vendor', lookupForm: 'Vendor', lookupTable: 'Vendor', lookupEndpoint: '/lookups/Vendor/Vendor_Name' },
    { name: 'Photo', source: 'smoke upload', fileRef: true },
    { name: 'Lines', source: 'one subform row', children: [{ name: 'Note', source: 'run marker' }] },
  ];
  return [
    { kind: 'session', label: 'session bootstrap', method: 'GET', path: '/' },
    { kind: 'submit', label: 'submit Vendor', form: 'Vendor', table: 'Vendor', method: 'POST', path: '/forms/Vendor/submit', record: [{ name: 'Vendor_Name', source: 'run marker' }], marker: { field: 'Vendor_Name' } },
    { kind: 'read-back', label: 'read-back Vendor', form: 'Vendor', table: 'Vendor', expect: { field: 'Vendor_Name', submitted: 'record' } },
    { kind: 'upload', label: 'upload Item.Photo', form: 'Item', method: 'POST', path: '/uploads/Item/Photo', upload: { field: 'Photo' } },
    { kind: 'submit', label: 'submit Item', form: 'Item', table: 'Item', method: 'POST', path: '/forms/Item/submit', record, marker: { field: 'Item_Name' } },
    {
      kind: 'read-back',
      label: 'read-back Item',
      form: 'Item',
      table: 'Item',
      expect: { field: 'Item_Name', submitted: 'record' },
      lookups: [{ field: 'Vendor', endpoint: '/lookups/Vendor/Vendor_Name', parent: 'Vendor', table: 'Vendor', display: 'Vendor_Name' }],
      children: [{ field: 'Lines', table: 'Item_Lines', parentColumn: 'parent_id', orderColumn: 'row_order' }],
      files: [{ field: 'Photo', uploadPath: '/uploads/Item/Photo', filesPath: '/files/Item/Photo' }],
    },
    { kind: 'update', label: 'update Item', form: 'Item', table: 'Item', method: 'POST', path: '/admin/smoke', update: { field: 'Status', note: 'second choice', value: 'Closed' }, marker: { field: 'Item_Name' } },
    { kind: 'read-back', label: 'read-back Item (after update)', form: 'Item', table: 'Item', expect: { field: 'Status', value: 'Closed' } },
    { kind: 'report', label: 'report Item_Report', method: 'POST', path: '/reports/Item_Report' },
    { kind: 'cleanup', label: 'delete Item', form: 'Item', table: 'Item', marker: { field: 'Item_Name' } },
    { kind: 'cleanup', label: 'delete Vendor', form: 'Vendor', table: 'Vendor', marker: { field: 'Vendor_Name' } },
  ];
}

/** A tiny in-memory app: two tables, one child link, endpoints as paths. */
function fakeServer() {
  const rows: Record<string, Record<string, unknown>[]> = { Vendor: [], Item: [] };
  const calls: { method: string; path: string; body: unknown }[] = [];
  let nextId = 1000;
  const handler = async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const parsed = new URL(url, 'http://localhost');
    const path = parsed.pathname;
    const method = String(init?.method ?? 'GET').toUpperCase();
    let body: Record<string, unknown> = {};
    if (init?.body) {
      // The Stratus PUT carries raw file bytes — not JSON.
      try {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
      } catch {
        body = { __bytes: String(init.body).length };
      }
    }
    calls.push({ method, path, body });
    const reply = (status: number, data: unknown): FakeReply & { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> } => ({
      status,
      ok: status >= 200 && status < 300,
      body: data,
      json: async () => data,
      text: async () => JSON.stringify(data),
    });
    if (path.startsWith('/stratus/')) return reply(200, 'ok');
    if (path === '/admin/smoke') {
      if (body.op === 'update') {
        const form = String(body.form);
        const rowId = String(body.rowId);
        const marker = (body.marker ?? {}) as { field?: string; tag?: string };
        const row = (rows[form] ?? []).find((item) => String(item.ROWID) === rowId);
        if (!row) return reply(404, { error: 'no such row' });
        if (row[String(marker.field)] !== marker.tag) return reply(409, { error: 'row carries no marker of this run' });
        Object.assign(row, (body.fields ?? {}) as Record<string, unknown>);
        return reply(200, { updated: true });
      }
      if (body.op === 'delete') {
        const form = String(body.form);
        const rowId = String(body.rowId);
        const marker = (body.marker ?? {}) as { field?: string; tag?: string };
        const list = rows[form] ?? [];
        const row = list.find((item) => String(item.ROWID) === rowId);
        if (!row) return reply(404, { error: 'no such row' });
        // No marker: the endpoint deletes exactly the named ROWID (markerless forms).
        if (body.marker === undefined) {
          rows[form] = list.filter((item) => item !== row);
          return reply(200, { deleted: true });
        }
        if (!String(row[String(marker.field)] ?? '').includes(String(marker.tag))) return reply(409, { error: 'row carries no marker of this run' });
        rows[form] = list.filter((item) => item !== row);
        return reply(200, { deleted: true });
      }
      return reply(200, { ok: true, mode: 'live', forms: 2 });
    }
    const submitMatch = /^\/forms\/([^/]+)\/submit$/.exec(path);
    if (submitMatch) {
      const form = submitMatch[1]!;
      const record = (body.record ?? {}) as Record<string, unknown>;
      if (body.ROWID) {
        const row = (rows[form] ?? []).find((item) => String(item.ROWID) === String(body.ROWID));
        if (!row) return reply(404, { error: 'no such row' });
        Object.assign(row, record);
        return reply(200, { wrote: true, values: { ROWID: row.ROWID } });
      }
      const rowid = String(nextId++);
      rows[form].push({ ...record, ROWID: rowid });
      return reply(200, { wrote: true, values: { ROWID: rowid } });
    }
    const lookupMatch = /^\/lookups\/([^/]+)\/([^/]+)$/.exec(path);
    if (lookupMatch) {
      const form = lookupMatch[1]!;
      const display = decodeURIComponent(lookupMatch[2]!);
      return reply(200, {
        rows: (rows[form] ?? []).map((row) => ({ ROWID: row.ROWID, [display]: row[display] })),
        field: display,
      });
    }
    if (path === '/uploads/Item/Photo') {
      return reply(200, {
        reference: { key: 'uploads/Item/Photo/' + 'a'.repeat(64) + '/c2c-smoke.txt' },
        upload: { method: 'PUT', url: 'http://localhost/stratus/put/key', headers: { 'Content-Type': 'text/plain' }, expiresIn: 600 },
      });
    }
    if (path === '/files/Item/Photo') {
      const row = rows.Item.find((item) => String(item.ROWID) === String(body.rowId));
      const key = row?.Photo && typeof row.Photo === 'object' ? (row.Photo as { key?: string }).key : undefined;
      return key ? reply(200, { key, url: 'http://localhost/stratus/get/key', expiresIn: 600 }) : reply(404, { error: 'no file' });
    }
    if (path === '/reports/Item_Report') {
      const filter = body.filter as { field?: string; value?: unknown } | undefined;
      let list = rows.Item;
      if (filter?.field === 'ROWID') list = list.filter((item) => String(item.ROWID) === String(filter.value));
      return reply(200, {
        rows: list.map((row) => ({ ...row })),
        total: list.length,
      });
    }
    return reply(404, { error: `unhandled ${method} ${path}` });
  };
  return { rows, calls, handler };
}

interface SmokeDom {
  window: { document: Document };
}

async function bootSmoke(model: UiModel, runtime: Record<string, unknown>, fetchImpl: unknown, plan: unknown): Promise<{ dom: SmokeDom; state: string }> {
  const dom = new JSDOM('<!doctype html><body><header><strong id="app-title"></strong></header><nav id="nav"></nav><main id="main"></main></body></html>', {
    url: 'http://localhost/slate/index.html',
  });
  const view = dom.window as unknown as { location: { hash: string }; fetch: unknown; C2C_SMOKE_PLAN?: unknown; C2C_SMOKE_PROJECT?: string; document: Document };
  view.location.hash = '#/admin/smoke';
  view.fetch = fetchImpl;
  if (plan !== undefined) view.C2C_SMOKE_PLAN = plan;
  view.C2C_SMOKE_PROJECT = '1001';
  const boot = runtime.boot as (model: UiModel, doc: unknown) => Promise<void>;
  await boot(model, view.document);
  // The runner is async; wait for a terminal state.
  for (let i = 0; i < 200; i++) {
    const state = view.document.querySelector('[data-smoke-state]')?.getAttribute('data-smoke-state');
    if (state && state !== 'pending' && state !== 'running') return { dom: dom as unknown as SmokeDom, state };
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { dom: dom as unknown as SmokeDom, state: 'timeout' };
}

test('#/admin/smoke runs the embedded plan and paints the table plus JSON', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    const server = fakeServer();
    const { dom, state } = await bootSmoke(model, runtime, server.handler, smokePlan());
    assert.equal(state, 'done');
    const main = dom.window.document.getElementById('main')!;
    const lines = [...main.querySelectorAll('[data-smoke-steps] tr')].map((tr) => tr.textContent ?? '');
    assert.ok(lines.some((line) => /submit Item: 200 wrote \d+/.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /read-back Item: row \d+ present/.test(line)));
    assert.ok(lines.some((line) => /child Lines: 1 row/.test(line)));
    assert.ok(lines.some((line) => /lookup Vendor: display resolved/.test(line)));
    assert.ok(lines.some((line) => /file Photo: key resolves/.test(line)));
    assert.ok(lines.some((line) => /update Item: 200 updated/.test(line)));
    assert.ok(lines.some((line) => /delete Item: row \d+ deleted \(verified gone\)/.test(line)));
    assert.ok(lines.some((line) => /created 2, deleted 2, left 0/.test(line)));

    const jsonText = main.querySelector('#c2c-smoke-json')?.textContent ?? '';
    const result = JSON.parse(jsonText) as { version?: string; ok?: boolean; created?: number; deleted?: number; steps?: unknown[] };
    assert.equal(result.version, 'c2c-smoke/1');
    assert.equal(result.ok, true);
    assert.equal(result.created, 2);
    assert.equal(result.deleted, 2);
    assert.ok(Array.isArray(result.steps) && result.steps.length > 0);
    // The block is bound to where and what it ran, and sealed so `c2c smoke --result` can check it.
    const bound = result as Record<string, unknown>;
    assert.equal(bound.origin, 'http://localhost');
    assert.equal(bound.app, 'Widget');
    assert.equal(bound.project, '1001');
    assert.equal(bound.plan, smokePlanDigest(smokePlan()));
    assert.ok(Math.abs(Date.parse(String(bound.at)) - Date.now()) < 60_000, String(bound.at));
    const { digest, ...sealed } = bound;
    assert.equal(digest, smokeSha256(smokeCanonical(sealed)));
    assert.equal(main.querySelector('[data-smoke-copy]')?.hasAttribute('hidden'), false, 'the page says where the block goes');

    // The update went through the admin-only smoke endpoint, marker-scoped.
    const update = server.calls.find((call) => call.path === '/admin/smoke' && (call.body as { op?: string }).op === 'update');
    assert.equal((update?.body as { fields?: Record<string, unknown> }).fields?.Status, 'Closed');
    assert.equal((update?.body as { marker?: { field?: string } }).marker?.field, 'Item_Name');
    // The upload PUT went to the signed URL without the session.
    const put = server.calls.find((call) => call.path.startsWith('/stratus/'));
    assert.equal(put?.method, 'PUT');
    // Both rows deleted; nothing left.
    assert.equal(server.rows.Item.length, 0);
    assert.equal(server.rows.Vendor.length, 0);
    // The route is not in the nav.
    assert.equal(dom.window.document.getElementById('nav')?.innerHTML.includes('admin/smoke'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#/admin/smoke paints denied on a 403 and unavailable without a plan', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    const denied = async () => ({ status: 403, ok: false, json: async () => ({ error: 'denied' }), text: async () => '{"error":"denied"}' });
    const first = await bootSmoke(model, runtime, denied, smokePlan());
    assert.equal(first.state, 'denied');
    assert.match(first.dom.window.document.querySelector('[data-smoke-state]')?.textContent ?? '', /not available|administrator|denied/i);

    const second = await bootSmoke(model, runtime, async () => ({ status: 200, ok: true, json: async () => ({}) , text: async () => '{}' }), undefined);
    assert.equal(second.state, 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#/admin/smoke paints not-signed-in when the status answer is not the documented shape', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    // A sign-in page: 200 HTML, res.ok true — never authorization.
    const login = async () => ({ status: 200, ok: true, text: async () => '<html><body>Sign in</body></html>' });
    const first = await bootSmoke(model, runtime, login, smokePlan());
    assert.equal(first.state, 'not-signed-in');
    // A 200 JSON body that is not { ok: true, mode, forms } is not authorization either.
    const wrong = async () => ({ status: 200, ok: true, text: async () => '{"ok":true}' });
    const second = await bootSmoke(model, runtime, wrong, smokePlan());
    assert.equal(second.state, 'not-signed-in');
    // A 401 is no session.
    const anonymous = async () => ({ status: 401, ok: false, text: async () => '{"error":"authenticated caller required"}' });
    const third = await bootSmoke(model, runtime, anonymous, smokePlan());
    assert.equal(third.state, 'not-signed-in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

type RunSmokePlan = (model: UiModel, plan: unknown, view: unknown) => Promise<{ ok: boolean; lines: string[]; json: Record<string, unknown> }>;

function fakeReply(status: number, body: unknown): { status: number; ok: boolean; text(): Promise<string> } {
  return { status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

test('#/admin/smoke accepts a signed upload URL only on https or an exact loopback host', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    const runSmokePlan = runtime.runSmokePlan as RunSmokePlan;
    const plan = [
      { kind: 'session', label: 'session bootstrap' },
      { kind: 'upload', label: 'upload Item.Photo', form: 'Item', method: 'POST', path: '/uploads/Item/Photo', upload: { field: 'Photo' } },
    ];
    const run = async (uploadUrl: string) => {
      const calls: { method: string; url: string }[] = [];
      const fetch = async (url: string, init?: { method?: string }) => {
        calls.push({ method: String(init?.method ?? 'GET'), url: String(url) });
        if (String(url).includes('/uploads/')) return fakeReply(200, { reference: { key: 'k1' }, upload: { url: uploadUrl, headers: {} } });
        return fakeReply(200, 'ok');
      };
      const result = await runSmokePlan(model, plan, { fetch });
      return { result, calls };
    };
    // A host that merely starts with a loopback name is not loopback.
    for (const host of ['http://127.0.0.1.evil.test/obj', 'http://localhost.evil.test/obj', 'http://evil.test/obj']) {
      const { result, calls } = await run(host);
      assert.equal(result.ok, false, `${host} must be refused`);
      assert.ok(result.lines.some((line) => /not an https target/.test(line)), result.lines.join('\n'));
      assert.equal(calls.some((call) => call.method === 'PUT'), false, `no PUT to ${host}`);
    }
    // https anywhere, and http on an exact loopback host, still carry the PUT.
    for (const host of ['https://objects.example.test/obj', 'http://127.0.0.1:9000/obj', 'http://localhost:9000/obj', 'http://[::1]:9000/obj']) {
      const { result, calls } = await run(host);
      assert.equal(result.ok, true, `${host}: ${result.lines.join('\n')}`);
      assert.ok(calls.some((call) => call.method === 'PUT' && call.url === host), JSON.stringify(calls));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#/admin/smoke fails a report step whose answer is not the report shape', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    const runSmokePlan = runtime.runSmokePlan as RunSmokePlan;
    // A report-only plan: no submits, one report call.
    const plan = [
      { kind: 'session', label: 'session bootstrap' },
      { kind: 'report', label: 'report Item_Report', method: 'POST', path: '/reports/Item_Report' },
    ];
    // A sign-in page answers 200 HTML — not a report, so the run proves nothing.
    const walled = await runSmokePlan(model, plan, { fetch: async () => fakeReply(200, '<html><body>Sign in</body></html>') });
    assert.equal(walled.ok, false, 'a 200 HTML report answer is not a pass');
    assert.equal(walled.json.ok, false);
    assert.ok(walled.lines.some((line) => /report Item_Report: 200/.test(line) && /not the report shape/.test(line)), walled.lines.join('\n'));
    // The same step on the documented shape passes and names the row count.
    const fine = await runSmokePlan(model, plan, { fetch: async () => fakeReply(200, '{"rows":[{},{}]}') });
    assert.equal(fine.ok, true, fine.lines.join('\n'));
    assert.ok(fine.lines.some((line) => /report Item_Report: 200 \(2 rows\)/.test(line)), fine.lines.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#/admin/smoke json ok agrees with the CLI verdict when every submit is a dry-run', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    const runSmokePlan = runtime.runSmokePlan as RunSmokePlan;
    // A submit step whose endpoint dry-runs wrote nothing — a pass would be
    // vacuous, same as the CLI's submits>0 && created===0 guard.
    const plan = [
      { kind: 'session', label: 'session bootstrap' },
      { kind: 'submit', label: 'submit Item', form: 'Item', method: 'POST', path: '/forms/Item/submit', record: [{ name: 'Item_Name', source: 'run marker' }] },
      { kind: 'report', label: 'report Item_Report', method: 'POST', path: '/reports/Item_Report' },
    ];
    const fetch = async (url: string) => (String(url).includes('/reports/') ? fakeReply(200, '{"rows":[]}') : fakeReply(200, '{"dryRun":true,"wrote":false}'));
    const result = await runSmokePlan(model, plan, { fetch });
    assert.equal(result.ok, false, result.lines.join('\n'));
    assert.equal(result.json.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#/admin/smoke never reports done for a run that exercised nothing', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    const server = fakeServer();
    const plan = [
      { kind: 'session', label: 'session bootstrap' },
      { kind: 'skip', label: 'submit Item', reason: 'no marker field' },
      { kind: 'skip', label: 'read-back Item', reason: 'no row' },
    ];
    const { dom, state } = await bootSmoke(model, runtime, server.handler, plan);
    assert.equal(state, 'failed');
    const result = JSON.parse(dom.window.document.querySelector('#c2c-smoke-json')?.textContent ?? '{}') as { ok?: boolean; exercised?: number };
    assert.equal(result.ok, false);
    assert.equal(result.exercised, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#/admin/smoke shows the result code with a Copy button and the paste-into-your-AI-chat line', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    const server = fakeServer();
    const { dom, state } = await bootSmoke(model, runtime, server.handler, smokePlan());
    assert.equal(state, 'done');
    const doc = dom.window.document;
    const box = doc.querySelector('[data-smoke-code]')!;
    assert.equal(box.hasAttribute('hidden'), false, 'the code box is shown');
    assert.equal(box.querySelector('p')?.textContent, 'Paste this into your AI chat (Claude or any LLM):');
    const code = doc.getElementById('c2c-smoke-code')?.textContent ?? '';
    assert.match(code, /^c2cs1k[A-Za-z0-9_-]+$/, code);
    // The code is the block the page prints, packed.
    const unpacked = decodeSmokeCode(code, smokePlan());
    assert.ok(unpacked.ok, unpacked.ok ? '' : unpacked.reason);
    assert.deepEqual(JSON.parse(unpacked.json), JSON.parse(doc.getElementById('c2c-smoke-json')?.textContent ?? ''));
    // Copy puts exactly the code on the clipboard.
    const button = doc.querySelector('[data-smoke-copy-code]') as HTMLButtonElement;
    assert.equal(button.textContent, 'Copy');
    const copied: string[] = [];
    Object.defineProperty((dom.window as unknown as { navigator: object }).navigator, 'clipboard', { value: { writeText: async (text: string) => void copied.push(text) }, configurable: true });
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(copied, [code]);
    assert.equal(button.textContent, 'Copied');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#/admin/smoke leaves pending when the auth SDK never settles', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    const bootWithAuth = async (auth: unknown, timeouts: Record<string, number>) => {
      const dom = new JSDOM('<!doctype html><body><header><strong id="app-title"></strong></header><nav id="nav"></nav><main id="main"></main></body></html>', {
        url: 'http://localhost/slate/index.html',
      });
      const view = dom.window as unknown as {
        location: { hash: string };
        fetch: unknown;
        catalyst?: unknown;
        C2C_SMOKE_PLAN?: unknown;
        C2C_SMOKE_PROJECT?: string;
        document: Document;
      } & Record<string, number>;
      view.location.hash = '#/admin/smoke';
      view.fetch = async () => fakeReply(401, '{"error":"authenticated caller required"}');
      view.C2C_SMOKE_PLAN = smokePlan();
      view.C2C_SMOKE_PROJECT = '1001';
      view.catalyst = auth;
      Object.assign(view, timeouts);
      const boot = runtime.boot as (model: UiModel, doc: unknown) => Promise<void>;
      await boot(model, view.document);
      for (let i = 0; i < 400; i++) {
        const state = view.document.querySelector('[data-smoke-state]')?.getAttribute('data-smoke-state');
        if (state && state !== 'pending' && state !== 'running') return { dom, state, doc: view.document };
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return { dom, state: 'timeout', doc: view.document };
    };
    // The Catalyst SDK on a host without its auth endpoints (Slate answers
    // /baas/* 404) leaves generateAuthToken pending forever — the page must
    // still send the call and land on a clear answer, not hang on 'pending'.
    const hanging = { isUserAuthenticated: async () => ({}), generateAuthToken: () => new Promise(() => {}) };
    const first = await bootWithAuth(hanging, { C2C_AUTH_TIMEOUT_MS: 20 });
    assert.equal(first.state, 'not-signed-in');
    // Both SDK calls pending is the same hang one step earlier.
    const pending = { isUserAuthenticated: () => new Promise(() => {}), generateAuthToken: () => new Promise(() => {}) };
    const second = await bootWithAuth(pending, { C2C_AUTH_TIMEOUT_MS: 20 });
    assert.equal(second.state, 'not-signed-in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#/admin/smoke reports a stalled access check instead of waiting forever', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    const dom = new JSDOM('<!doctype html><body><header><strong id="app-title"></strong></header><nav id="nav"></nav><main id="main"></main></body></html>', {
      url: 'http://localhost/slate/index.html',
    });
    const view = dom.window as unknown as {
      location: { hash: string };
      fetch: unknown;
      C2C_SMOKE_PLAN?: unknown;
      C2C_SMOKE_PROJECT?: string;
      C2C_SMOKE_STATUS_TIMEOUT_MS?: number;
      document: Document;
    };
    view.location.hash = '#/admin/smoke';
    view.fetch = () => new Promise(() => {});
    view.C2C_SMOKE_PLAN = smokePlan();
    view.C2C_SMOKE_PROJECT = '1001';
    view.C2C_SMOKE_STATUS_TIMEOUT_MS = 20;
    const boot = runtime.boot as (model: UiModel, doc: unknown) => Promise<void>;
    await boot(model, view.document);
    let state = 'timeout';
    for (let i = 0; i < 400; i++) {
      const current = view.document.querySelector('[data-smoke-state]')?.getAttribute('data-smoke-state');
      if (current && current !== 'pending' && current !== 'running') {
        state = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(state, 'failed');
    assert.match(view.document.querySelector('[data-smoke-state]')?.textContent ?? '', /timed out/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A form with no marker field: the run submits a canned record and cleans up by the ROWID it created. */
function markerlessPlan(): Record<string, unknown>[] {
  return [
    { kind: 'session', label: 'session bootstrap', method: 'GET', path: '/' },
    { kind: 'submit', label: 'submit Vendor', form: 'Vendor', table: 'Vendor', method: 'POST', path: '/forms/Vendor/submit', record: [{ name: 'Vendor_Name', source: 'canned', value: 'Acme' }] },
    { kind: 'read-back', label: 'read-back Vendor', form: 'Vendor', table: 'Vendor' },
    { kind: 'cleanup', label: 'delete Vendor', form: 'Vendor', table: 'Vendor' },
  ];
}

test('#/admin/smoke cleans up a form with no marker field by the exact ROWID it created', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    const server = fakeServer();
    server.rows.Vendor.push({ ROWID: '7', Vendor_Name: 'Acme' }, { ROWID: '8', Vendor_Name: 'Existing' });
    const result = await (runtime.runSmokePlan as RunSmokePlan)(model, markerlessPlan(), { fetch: server.handler });
    assert.equal(result.ok, true, result.lines.join('\n'));
    assert.equal(result.json.created, 1);
    assert.equal(result.json.deleted, 1);
    assert.equal(result.json.left, 0);
    const deletes = server.calls.filter((call) => call.path === '/admin/smoke' && (call.body as { op?: string }).op === 'delete');
    assert.deepEqual(
      deletes.map((call) => call.body),
      [{ op: 'delete', form: 'Vendor', rowId: '1000' }],
    );
    // Rows the run did not create — even one with the same values — stay.
    assert.deepEqual(server.rows.Vendor.map((row) => row.ROWID), ['7', '8']);
    assert.ok(result.lines.some((line: string) => line.includes('delete Vendor') && line.includes('row 1000 deleted (verified gone)')), result.lines.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#/admin/smoke keeps ok false and names the row when a markerless delete fails', async () => {
  const { dir, runtime, model } = await loadRuntime(DS);
  try {
    const server = fakeServer();
    const fetch = async (url: string, init: { method?: string; body?: string }) => {
      if (String(url).endsWith('/admin/smoke') && String(init?.body ?? '').includes('"op":"delete"')) {
        return { ok: false, status: 403, json: async () => ({ error: 'delete not granted' }), text: async () => '{"error":"delete not granted"}' };
      }
      return server.handler(url, init);
    };
    const result = await (runtime.runSmokePlan as RunSmokePlan)(model, markerlessPlan(), { fetch });
    assert.equal(result.ok, false, result.lines.join('\n'));
    assert.equal(result.json.ok, false);
    assert.equal(result.json.left, 1);
    const step = (result.json.steps as { label: string; ok: boolean; detail: string }[]).find((row) => row.label === 'delete Vendor');
    assert.deepEqual(step, { label: 'delete Vendor', ok: false, detail: 'row 1000 not deleted — 403 delete not granted; left in place' });
    assert.deepEqual(server.rows.Vendor.map((row) => row.ROWID), ['1000']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
