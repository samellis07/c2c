/**
 * Live submit and report through the generated handlers and the Slate runtime.
 * The datastore is in-memory. Nothing here calls Catalyst.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { isoDate, E2E_INSTRUCTION_CASES, type E2eStep } from '../src/e2e.js';
import { buildUi } from '../../ui/src/index.js';
import { DelugeRuntimeError } from '../../shims/src/errors.js';

const CLOCK = new Date('2026-10-06T08:30:00.000Z');

interface MemoryStore {
  now: Date;
  rowsOf(form: string): Record<string, unknown>[];
  insert(form: string, rows: Record<string, unknown>[]): Promise<unknown>;
  update(form: string, rows: Record<string, unknown>[]): Promise<unknown>;
  delete(form: string, rowIds: string[]): Promise<unknown>;
  query(form: string, where: string, limit: number, offset: number, orderBy: string): Promise<Record<string, unknown>[]>;
}

interface SpecStep {
  op: string;
  form?: string;
  field?: string;
  report?: string;
  match?: string;
  text?: string;
  button?: string;
  value?: string;
  fragment?: string;
  cells?: Record<string, unknown>;
}

test('Sample app TC01-TC03 save and query through the live Slate runtime', { timeout: 120000 }, async () => {
  const app = sampleApp(await sampleSource());
  const session = await startLive(app);
  try {
    const cases = E2E_INSTRUCTION_CASES.filter((item) => item.targets.includes('catalyst') && ['TC01', 'TC02', 'TC03'].includes(item.id));
    assert.equal(cases.length, 3);
    for (const item of cases) await runSteps(session, item.steps, item.id);
    const saved = session.store.rowsOf('Sample_Item').find((row) => row.Item_Name === 'Widget Alpha');
    assert.ok(saved, 'TC01 row was not inserted');
    assert.equal(saved.Status, 'Submitted');
    assert.equal(String(saved.Total_Amount), '255.00');
    assert.equal(session.store.rowsOf('Sample_Item').some((row) => row.Item_Name === 'Zero Qty Item'), false);
    assert.equal(session.store.rowsOf('Sample_Item').some((row) => row.Item_Name === 'Negative Price Item'), false);
  } finally {
    await session.close();
  }
});

test('on success reads input.ID and the row just inserted', { timeout: 120000 }, async () => {
  // Server-only success script: Slate posts to functions/aio/<form>/submit.mjs.
  const app = adminApp(`\tforms
\t{
\t\tform Echo
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tform Id_Log
\t\t{
\t\t\tSeen
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tSource
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tHits
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tCapture as "Capture"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Echo
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\ton success
\t\t\t\t\t(
\t\t\t\t\t\tn = Echo[Name == input.Name].count();
\t\t\t\t\t\tinsert into Id_Log
\t\t\t\t\t\t[
\t\t\t\t\t\t\tSeen = input.ID
\t\t\t\t\t\t\tSource = input.Name
\t\t\t\t\t\t\tHits = n
\t\t\t\t\t\t];
\t\t\t\t\t)
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const session = await startLive(app);
  try {
    await runSteps(session, [
      { op: 'open_form', form: 'Echo' },
      { op: 'fill', form: 'Echo', field: 'Name', value: 'Ada' },
      { op: 'click' },
    ], 'id-after-insert');
    assert.equal(session.failures.length, 0, session.failures.join(' | '));
    const echo = session.store.rowsOf('Echo').find((row) => row.Name === 'Ada');
    const log = session.store.rowsOf('Id_Log')[0];
    assert.ok(echo, 'Echo row was not inserted');
    assert.ok(log, 'on success did not write Id_Log');
    assert.equal(String(log.Source), 'Ada');
    assert.equal(String(log.Hits), '1', 'on success ran before the Echo insert, so the fetch saw no row');
    assert.equal(String(log.Seen), String(echo.ROWID), 'on success did not see input.ID of the inserted row');
  } finally {
    await session.close();
  }
});

test('a throw in on success leaves the inserted row and reports the error', { timeout: 120000 }, async () => {
  // info makes a client handler, so Slate posts to the on-success Advanced I/O module.
  const app = adminApp(`\tforms
\t{
\t\tform Echo
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tform Boom
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tCapture as "Capture"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Echo
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\ton success
\t\t\t\t\t(
\t\t\t\t\t\tinfo "before-boom";
\t\t\t\t\t\tinsert into Boom
\t\t\t\t\t\t[
\t\t\t\t\t\t\tName = input.Name
\t\t\t\t\t\t];
\t\t\t\t\t)
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const session = await startLive(app, {
    insertError: (form) => (form === 'Boom' ? 'boom insert refused' : null),
  });
  try {
    await runSteps(session, [
      { op: 'open_form', form: 'Echo' },
      { op: 'fill', form: 'Echo', field: 'Name', value: 'Ada' },
      { op: 'click' },
    ], 'throw-after-insert');
    const banner = session.doc.querySelector('[data-banner]')?.textContent ?? '';
    assert.match(banner, /boom insert refused/);
    const echo = session.store.rowsOf('Echo').find((row) => row.Name === 'Ada');
    assert.ok(echo, 'the Echo row was rolled back after on success threw');
    assert.equal(session.store.rowsOf('Boom').length, 0);
  } finally {
    await session.close();
  }
});

test('live report applies a predefined filter label and ignores a raw criteria string', { timeout: 120000 }, async () => {
  const app = adminApp(`\tforms
\t{
\t\tform Item
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tStatus
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
\treports
\t{
\t\tlist All_Items
\t\t{
\t\t\tshow all rows from Item
\t\t\t(
\t\t\t\tName
\t\t\t\tStatus
\t\t\t)
\t\t\tfilters
\t\t\t(
\t\t\t\tStatus
\t\t\t\t"Open" : Status == "Open"
\t\t\t)
\t\t}
\t}`);
  const session = await startLive(app);
  try {
    await session.store.insert('Item', [
      { Name: 'Ada', Status: 'Open' },
      { Name: 'Bea', Status: 'Closed' },
    ]);
    await session.go('#/report/All_Items');
    const texts = () =>
      [...session.doc.querySelectorAll('section[data-report="All_Items"] [data-rows] tbody tr')].map((row) =>
        [...row.querySelectorAll('td:not([data-card-actions])')].map((cell) => cell.textContent ?? '').join(''),
      );
    assert.deepEqual(texts().sort(), ['AdaOpen', 'BeaClosed']);
    const select = session.doc.querySelector('select[data-filter]') as HTMLSelectElement | null;
    assert.ok(select, 'report filter select missing');
    assert.equal(select.value, '');
    select.value = 'Open';
    select.dispatchEvent(new session.win.Event('change', { bubbles: true }));
    await session.settle();
    assert.deepEqual(texts(), ['AdaOpen']);
    select.value = 'Status';
    select.dispatchEvent(new session.win.Event('change', { bubbles: true }));
    await session.settle();
    assert.deepEqual(texts().sort(), ['AdaOpen', 'BeaClosed'], 'a field-only filter has no criteria');
    const endpoint = session.doc.querySelector('section[data-report="All_Items"]')?.getAttribute('data-endpoint');
    assert.ok(endpoint);
    const res = await fetch(`${session.origin}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'query', q: '', filter: 'Status == "Open" OR Name == "Bea"', page: 0, pageSize: 300 }),
    });
    const body = (await res.json()) as { rows?: { Name?: string }[] };
    assert.equal(res.status, 200);
    assert.deepEqual((body.rows ?? []).map((row) => row.Name).sort(), ['Ada', 'Bea']);
  } finally {
    await session.close();
  }
});

function adminApp(inner: string): App {
  return sampleApp(
    [
      'application "c2c-success-order"',
      '{',
      '\ttime zone = "Asia/Kolkata"',
      '\tshare_settings',
      '\t{',
      '\t\t"Administrator"',
      '\t\t{',
      '\t\t\tname = "Administrator"',
      '\t\t\ttype = Users_Permissions',
      '\t\t\tdescription = "This profile will have all the permissions."',
      '\t\t}',
      '\t}',
      inner,
      '}',
      '',
    ].join('\n'),
  );
}

async function sampleSource(): Promise<string> {
  const gen = (await import(pathToFileURL(join(repoRoot(), 'fixtures/sample-app/sample-app.mjs')).href)) as {
    sampleItemForm(): string[];
    sampleItemReport(): string[];
    sampleWorkflow(): string[];
  };
  return [
    'application "sample-app"',
    '{',
    '\ttime zone = "Asia/Kolkata"',
    '\tshare_settings',
    '\t{',
    '\t\t"Administrator"',
    '\t\t{',
    '\t\t\tname = "Administrator"',
    '\t\t\ttype = Users_Permissions',
    '\t\t\tdescription = "This profile will have all the permissions."',
    '\t\t}',
    '\t}',
    '\tforms',
    '\t{',
    ...gen.sampleItemForm(),
    '\t}',
    '\treports',
    '\t{',
    ...gen.sampleItemReport(),
    '\t}',
    ...gen.sampleWorkflow(),
    '}',
    '',
  ].join('\n');
}

function sampleApp(source: string): App {
  return deriveIr(parse(source));
}

interface Session {
  store: MemoryStore;
  origin: string;
  doc: Document;
  win: Window & { Event: typeof Event };
  go(hash: string): Promise<void>;
  settle(): Promise<void>;
  close(): Promise<void>;
  failures: string[];
}

interface LiveOptions {
  /** Throw from the datastore insert for this form. Used to fail an on-success script after the submit insert. */
  insertError?: (form: string) => string | null;
}

async function startLive(app: App, options?: LiveOptions): Promise<Session> {
  const built = buildUi(app);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-slate-live-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(repoRoot(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of built.files) {
    const dest = join(dir, ...file.path.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.data);
  }
  writeFileSync(join(dir, 'functions/c2c-deploy.json'), `${JSON.stringify({ mode: 'live', appTimeZone: 'Asia/Kolkata' }, null, 2)}\n`);
  const store = memoryStore(options);
  const storeMod = (await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href)) as {
    setDatastore(next: MemoryStore): void;
  };
  storeMod.setDatastore(store);
  const routes = await loadRoutes(dir);
  const failures: string[] = [];
  const server = createServer((req, res) => {
    void handleRequest(req, res, routes, failures);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('live harness did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  (globalThis as { CSS?: { escape(value: string): string } }).CSS ??= {
    escape: (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`),
  };
  const assets = readdirSync(join(dir, 'slate/assets'));
  const runtimeName = assets.find((name) => /^runtime\.[0-9a-f]+\.js$/.test(name));
  const modelName = assets.find((name) => /^model\.[0-9a-f]+\.js$/.test(name));
  if (!runtimeName || !modelName) throw new Error('built runtime missing');
  const runtime = (await import(pathToFileURL(join(dir, 'slate/assets', runtimeName)).href)) as {
    boot(model: unknown, doc: Document): Promise<void>;
  };
  const modelMod = (await import(pathToFileURL(join(dir, 'slate/assets', modelName)).href)) as { model: unknown };
  const dom = new JSDOM('<!doctype html><html><body><header><strong id="app-title"></strong></header><nav id="nav"></nav><main id="main"></main></body></html>', {
    url: `${origin}/slate/index.html`,
    runScripts: 'outside-only',
  });
  const win = dom.window as unknown as Window & { Event: typeof Event; fetch: typeof fetch };
  let inflight = 0;
  win.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    inflight += 1;
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const abs = raw.startsWith('http') ? raw : `${origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
    try {
      const res = await fetch(abs, init);
      if (!res.ok) {
        const text = await res.clone().text();
        failures.push(`${res.status} ${abs} ${text.slice(0, 300)}`);
      }
      return res;
    } finally {
      inflight -= 1;
    }
  }) as typeof fetch;
  await runtime.boot(modelMod.model, win.document);
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await delay(10);
      if (inflight === 0) {
        await delay(20);
        if (inflight === 0) return;
      }
    }
    throw new Error(`network did not settle ${failures.join(' | ')}`);
  };
  return {
    store,
    origin,
    doc: win.document,
    win,
    failures,
    settle,
    async go(hash: string) {
      win.location.hash = hash;
      win.dispatchEvent(new win.Event('hashchange'));
      await settle();
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      (dom.window as unknown as { close(): void }).close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function runSteps(session: Session, steps: readonly (E2eStep | SpecStep)[], label: string): Promise<void> {
  for (const step of steps) {
    if (step.op === 'open_form') {
      assert.ok(step.form, `${label} open_form`);
      await session.go(`#/form/${encodeURIComponent(step.form)}`);
      continue;
    }
    if (step.op === 'open_report') {
      assert.ok(step.report, `${label} open_report`);
      await session.go(`#/report/${encodeURIComponent(step.report)}`);
      continue;
    }
    if (step.op === 'fill' || step.op === 'select') {
      const el = session.doc.querySelector(`form[data-form="${step.form}"] [name="${step.field}"]`) as HTMLInputElement | null;
      assert.ok(el, `${label} missing ${step.form}.${step.field}`);
      let next = typeof step.value === 'string' ? step.value : String(step.value ?? '');
      if (el.tagName === 'INPUT' && el.type === 'date') next = isoDate(next);
      if (el.maxLength > 0 && next.length > el.maxLength) next = next.slice(0, el.maxLength);
      el.value = next;
      el.dispatchEvent(new session.win.Event('input', { bubbles: true }));
      el.dispatchEvent(new session.win.Event('change', { bubbles: true }));
      continue;
    }
    if (step.op === 'check') {
      const box = session.doc.querySelector(
        `form[data-form="${step.form}"] input[type="checkbox"][name="${step.field}"]`,
      ) as HTMLInputElement | null;
      assert.ok(box, `${label} missing checkbox ${step.field}`);
      box.checked = true;
      box.dispatchEvent(new session.win.Event('change', { bubbles: true }));
      continue;
    }
    if (step.op === 'click') {
      const form = session.doc.querySelector('form[data-form]') as HTMLFormElement | null;
      assert.ok(form, `${label} click without a form`);
      form.dispatchEvent(new session.win.Event('submit', { bubbles: true, cancelable: true }));
      await session.settle();
      continue;
    }
    if (step.op === 'expect_text') {
      const text = session.doc.body?.textContent ?? '';
      assert.ok(text.includes(String(step.text)), `${label} missing ${String(step.text)} in ${text.slice(0, 400)} ${session.failures.join(' | ')}`);
      continue;
    }
    if (step.op === 'expect_url_contains') {
      const fragment = 'fragment' in step ? String(step.fragment) : '';
      assert.ok(String(session.win.location.href).includes(`/form/${fragment}`), `${label} url ${session.win.location.href}`);
      continue;
    }
    if (step.op === 'expect_row' || step.op === 'expect_no_row') {
      const report = String(step.report);
      const rows = [...session.doc.querySelectorAll(`section[data-report="${report}"] [data-rows] tbody tr`)];
      const wanted = cellStrings('cells' in step ? step.cells : undefined);
      const hits = rows.filter((row) => {
        const text = row.textContent ?? '';
        return text.includes(String(step.match)) && wanted.every((item) => text.includes(item));
      });
      const count = step.op === 'expect_row' ? 1 : 0;
      assert.equal(
        hits.length,
        count,
        `${label} ${step.op} ${String(step.match)} saw ${hits.length} (${rows.map((row) => row.textContent).join(' || ')}) ${session.failures.join(' | ')}`,
      );
      continue;
    }
    throw new Error(`${label} unsupported step ${step.op}`);
  }
}

function cellStrings(cells: Record<string, unknown> | undefined): string[] {
  if (!cells) return [];
  const out: string[] = [];
  for (const value of Object.values(cells)) {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') out.push((value as { text: string }).text);
  }
  return out;
}

async function loadRoutes(dir: string): Promise<Map<string, (req: unknown, res: ServerResponse) => Promise<void>>> {
  const routes = new Map<string, (req: unknown, res: ServerResponse) => Promise<void>>();
  const files = walkMjs(join(dir, 'functions'));
  for (const file of files) {
    if (file.endsWith('/c2c-store.mjs') || file.endsWith('/c2c-mail.mjs')) continue;
    const mod = (await import(pathToFileURL(file).href)) as {
      endpoint?: { path?: string };
      default?: (req: unknown, res: ServerResponse) => Promise<void>;
    };
    const route = mod.endpoint?.path;
    if (!route || route.includes(':') || typeof mod.default !== 'function') continue;
    routes.set(route, mod.default);
  }
  return routes;
}

function walkMjs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...walkMjs(full));
    else if (name.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routes: Map<string, (req: unknown, res: ServerResponse) => Promise<void>>,
  failures: string[],
): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const handler = routes.get(decodeURIComponent(url.pathname));
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no handler' }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  let body: unknown = {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = {};
    }
  }
  try {
    await handler({ url: url.pathname, body, user: { profile: 'Administrator', loginUser: 'admin@example.test' } }, res);
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'harness handler threw' }));
    }
  }
}

function memoryStore(options?: LiveOptions): MemoryStore {
  const tables = new Map<string, Record<string, unknown>[]>();
  let nextId = 1;
  const rowsOf = (form: string) => {
    let rows = tables.get(form);
    if (!rows) {
      rows = [];
      tables.set(form, rows);
    }
    return rows;
  };
  return {
    now: CLOCK,
    rowsOf,
    async insert(form, rows) {
      const message = options?.insertError?.(form);
      // A datastore failure in Creator's own error text; a raw adapter/JS error would be reported as "request failed".
      if (message) throw new DelugeRuntimeError(message);
      const table = rowsOf(form);
      const stored: Record<string, unknown>[] = [];
      for (const row of rows) {
        const copy = { ...row };
        copy.ROWID = copy.ROWID == null || copy.ROWID === '' ? String(nextId++) : String(copy.ROWID);
        table.push(copy);
        stored.push(copy);
      }
      return { inserted: rows.length, rows: stored };
    },
    async update(form, rows) {
      const table = rowsOf(form);
      for (const row of rows) {
        const id = String(row.ROWID);
        const found = table.find((item) => String(item.ROWID) === id);
        if (found) Object.assign(found, row, { ROWID: id });
      }
      return { updated: rows.length };
    },
    async delete(form, rowIds) {
      const ids = new Set(rowIds.map(String));
      const table = rowsOf(form);
      const kept = table.filter((row) => !ids.has(String(row.ROWID)));
      tables.set(form, kept);
      return { deleted: table.length - kept.length };
    },
    async query(form, where, limit, offset, orderBy) {
      const matched = rowsOf(form).filter((row) => matchWhere(row, where));
      matched.sort((a, b) => compareOrder(a, b, orderBy));
      return matched.slice(offset, offset + limit).map((row) => ({ ...row }));
    },
  };
}

function matchWhere(row: Record<string, unknown>, where: string): boolean {
  // An always-true read sends no WHERE clause (ZCQL has no "WHERE true").
  if (!where.trim()) return true;
  return compileWhere(where)(row);
}

type Tok =
  | { t: 'id'; v: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' };

function opIs(tok: Tok | undefined, name: string): tok is { t: 'op'; v: string } {
  return !!tok && tok.t === 'op' && tok.v === name;
}

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] ?? '';
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      out.push({ t: 'lp' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      out.push({ t: 'rp' });
      i += 1;
      continue;
    }
    if (ch === ',') {
      out.push({ t: 'comma' });
      i += 1;
      continue;
    }
    if (ch === "'") {
      let value = '';
      i += 1;
      while (i < input.length) {
        if (input[i] === "'" && input[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (input[i] === "'") {
          i += 1;
          break;
        }
        value += input[i];
        i += 1;
      }
      out.push({ t: 'str', v: value });
      continue;
    }
    if (ch === '!' && input[i + 1] === '=') {
      out.push({ t: 'op', v: '!=' });
      i += 2;
      continue;
    }
    if ((ch === '<' || ch === '>') && input[i + 1] === '=') {
      out.push({ t: 'op', v: ch + '=' });
      i += 2;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === '=') {
      out.push({ t: 'op', v: ch });
      i += 1;
      continue;
    }
    const num = /^-?\d+(?:\.\d+)?/.exec(input.slice(i));
    if (num && (ch === '-' || /[0-9]/.test(ch))) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i));
    if (!ident) throw new Error(`bad where at ${i}: ${input}`);
    i += ident[0].length;
    const word = ident[0];
    const upper = word.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT' || upper === 'IS' || upper === 'NULL' || upper === 'LIKE' || upper === 'IN') out.push({ t: 'op', v: upper });
    else if (upper === 'TRUE') out.push({ t: 'bool', v: true });
    else if (upper === 'FALSE') out.push({ t: 'bool', v: false });
    else out.push({ t: 'id', v: word });
  }
  return out;
}

function compileWhere(where: string): (row: Record<string, unknown>) => boolean {
  const toks = tokenize(where);
  let p = 0;
  const peek = () => toks[p];
  const eat = () => toks[p++];
  const parseOr = (): ((row: Record<string, unknown>) => boolean) => {
    let left = parseAnd();
    while (opIs(peek(), 'OR')) {
      eat();
      const right = parseAnd();
      const prev = left;
      left = (row) => prev(row) || right(row);
    }
    return left;
  };
  const parseAnd = (): ((row: Record<string, unknown>) => boolean) => {
    let left = parseNot();
    while (opIs(peek(), 'AND')) {
      eat();
      const right = parseNot();
      const prev = left;
      left = (row) => prev(row) && right(row);
    }
    return left;
  };
  const parseNot = (): ((row: Record<string, unknown>) => boolean) => {
    if (opIs(peek(), 'NOT')) {
      eat();
      const inner = parseNot();
      return (row) => !inner(row);
    }
    return parsePrimary();
  };
  const parsePrimary = (): ((row: Record<string, unknown>) => boolean) => {
    if (peek()?.t === 'lp') {
      eat();
      const inner = parseOr();
      if (eat()?.t !== 'rp') throw new Error(`expected ) in ${where}`);
      return inner;
    }
    if (peek()?.t === 'bool') {
      const value = (eat() as { v: boolean }).v;
      return () => value;
    }
    const fieldTok = eat();
    if (!fieldTok || fieldTok.t !== 'id') throw new Error(`expected field in ${where}`);
    const field = fieldTok.v;
    const op = eat();
    if (!op || op.t !== 'op') throw new Error(`expected operator in ${where}`);
    if (op.v === 'IS') {
      const next = eat();
      if (next?.t === 'op' && next.v === 'NOT') {
        if (!opIs(eat(), 'NULL')) throw new Error(`expected NULL in ${where}`);
        return (row) => row[field] != null;
      }
      if (!next || next.t !== 'op' || next.v !== 'NULL') throw new Error(`expected NULL in ${where}`);
      return (row) => row[field] == null;
    }
    if (op.v === 'LIKE') {
      const lit = eat();
      if (!lit || lit.t !== 'str') throw new Error(`expected pattern in ${where}`);
      const re = likeToRegExp(lit.v);
      return (row) => re.test(row[field] == null ? '' : String(row[field]));
    }
    if (op.v === 'IN') {
      if (eat()?.t !== 'lp') throw new Error(`expected ( in ${where}`);
      const items: unknown[] = [];
      if (peek()?.t !== 'rp') {
        items.push(literal(eat()));
        while (peek()?.t === 'comma') {
          eat();
          items.push(literal(eat()));
        }
      }
      if (eat()?.t !== 'rp') throw new Error(`expected ) in ${where}`);
      return (row) => items.some((item) => sameCell(row[field], item));
    }
    const lit = literal(eat());
    return (row) => compareRel(row[field], lit, op.v);
  };
  const pred = parseOr();
  if (p !== toks.length) throw new Error(`trailing where ${where}`);
  return pred;
}

function literal(tok: Tok | undefined): unknown {
  if (!tok) throw new Error('missing literal');
  if (tok.t === 'str') return tok.v;
  if (tok.t === 'num') return tok.v;
  if (tok.t === 'bool') return tok.v;
  if (tok.t === 'op' && tok.v === 'NULL') return null;
  throw new Error(`bad literal ${tok.t}`);
}

function likeToRegExp(pattern: string): RegExp {
  let src = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '\\' && i + 1 < pattern.length) {
      src += (pattern[i + 1] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
      continue;
    }
    if (ch === '%') src += '[\\s\\S]*';
    else if (ch === '_') src += '[\\s\\S]';
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${src}$`);
}

function sameCell(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  if (typeof left === 'string' && typeof right === 'string') return left === right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right;
  if (left == null || right == null) return left == null && right == null;
  return left === right;
}

function compareCells(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  const as = left == null ? '' : String(left);
  const bs = right == null ? '' : String(right);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function compareRel(left: unknown, right: unknown, op: string): boolean {
  if (op === '=' || op === '==') return sameCell(left, right);
  if (op === '!=') return !sameCell(left, right);
  const diff = compareCells(left, right);
  if (op === '<') return diff < 0;
  if (op === '>') return diff > 0;
  if (op === '<=') return diff <= 0;
  if (op === '>=') return diff >= 0;
  throw new Error(`bad compare ${op}`);
}

function compareIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right) && left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOrder(a: Record<string, unknown>, b: Record<string, unknown>, clause: string): number {
  const body = clause.trim().replace(/^ORDER BY\s+/i, '');
  const parts = body.split(',').map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const bits = part.split(/\s+/);
    const field = bits[0] ?? 'ROWID';
    const dir = (bits[1] || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
    const cmp = field === 'ROWID' ? compareIds(String(a.ROWID ?? ''), String(b.ROWID ?? '')) : compareCells(a[field], b[field]);
    if (cmp !== 0) return cmp * dir;
  }
  return compareIds(String(a.ROWID ?? ''), String(b.ROWID ?? ''));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
