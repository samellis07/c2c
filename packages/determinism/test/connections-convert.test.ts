/**
 * Connections converter: the eight synthetic connection apps
 * (fixtures/sample-app/connections) through the converter, and the
 * generated CRM handler run live against a fake CRM on 127.0.0.1.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { analyzeConnections } from '../../deluge/src/connections.js';
import { translate } from '../../deluge/src/translate.js';
import { buildUi } from '../../ui/src/index.js';

const root = repoRoot();
const CONNECTION_APPS = join(root, 'fixtures/sample-app/connections');
/** A synthetic Creator app that calls another Zoho service (committed fixture). */
const plan = JSON.parse(readFileSync(join(CONNECTION_APPS, 'apps.json'), 'utf8')) as {
  apps: { name: string; connections: string[]; tasks: string[] }[];
  connections: { link: string; scopes: string[] }[];
};
const connectionsApp = (name: string): string => readFileSync(join(CONNECTION_APPS, `${name}.ds`), 'utf8');

interface PlannedApp {
  name: string;
  connections: string[];
  tasks: string[];
}

function appIr(name: string): App {
  return deriveIr(parse(connectionsApp(name)));
}

/** The smoke base has no profile with table permissions; add Creator's predefined Administrator (as slate-live.test does). */
function withOwnerProfile(source: string): string {
  const needle = '\tshare_settings\n\t{';
  const at = source.indexOf(needle);
  if (at < 0) throw new Error('grafted app has no share_settings');
  const block = ['\t\t"Administrator"', '\t\t{', '\t\t\tname = "Administrator"', '\t\t\ttype = Users_Permissions', '\t\t\tdescription = "This profile will have all the permissions."', '\t\t}', ''].join('\n');
  return `${source.slice(0, at + needle.length)}\n${block}${source.slice(at + needle.length)}`;
}

const EXPECTED_SCOPES: Record<string, Record<string, string[]>> = {
  'c2c-conn-crm': { c2c_crm: ['ZohoCRM.modules.leads.CREATE', 'ZohoCRM.modules.leads.READ', 'ZohoCRM.modules.leads.UPDATE'] },
  'c2c-conn-books': { c2c_books: ['ZohoBooks.contacts.CREATE', 'ZohoBooks.contacts.READ'] },
  'c2c-conn-desk': { c2c_desk: ['Desk.tickets.CREATE'] },
  'c2c-conn-cliq': { c2c_cliq: ['ZohoCliq.Webhooks.CREATE'] },
  'c2c-conn-rest-getpost': { c2c_crm: ['ZohoCRM.modules.leads.CREATE', 'ZohoCRM.modules.leads.READ'] },
  'c2c-conn-rest-putdel': { c2c_crm: ['ZohoCRM.modules.leads.DELETE', 'ZohoCRM.modules.leads.UPDATE'] },
  'c2c-conn-creator-src': {},
  'c2c-conn-creator-read': { c2c_creator: ['ZohoCreator.report.READ'] },
};

const THISAPP_DIAGNOSTICS: Record<string, number> = {
  'c2c-conn-crm': 1,
  'c2c-conn-books': 2,
  'c2c-conn-desk': 1,
  'c2c-conn-cliq': 1,
  'c2c-conn-rest-getpost': 0,
  'c2c-conn-rest-putdel': 0,
  'c2c-conn-creator-src': 0,
  'c2c-conn-creator-read': 1,
};

test('the analyzer records each connection link, service, tasks, and minimal scopes for all eight apps', () => {
  const proposed = new Map((plan.connections).map((c) => [c.link, c.scopes]));
  for (const planned of plan.apps as PlannedApp[]) {
    const report = analyzeConnections(appIr(planned.name));
    assert.deepEqual(report.entries.map((e) => e.link).sort(), [...planned.connections].sort(), planned.name);
    assert.deepEqual(Object.fromEntries(report.entries.map((e) => [e.link, e.scopes])), EXPECTED_SCOPES[planned.name], planned.name);
    for (const entry of report.entries) {
      // Every derived scope is one the generator proposed for that connection.
      for (const scope of entry.scopes) assert.ok(proposed.get(entry.link!)?.includes(scope), `${planned.name} ${scope}`);
    }
    const tasks = new Set(report.entries.flatMap((e) => e.uses.map((u) => (u.task.startsWith('invokeurl') ? 'invokeurl' : `zoho.${u.task}`))));
    assert.deepEqual([...tasks].sort(), [...planned.tasks].sort(), planned.name);
    assert.deepEqual(report.unsupported, [], planned.name);
    // The service ids these apps read through thisapp.<fn>() (FILL_ functions) are dry-run stubs in the runtime.
    assert.equal(report.diagnostics.length, THISAPP_DIAGNOSTICS[planned.name], `${planned.name}: ${report.diagnostics.join(' | ')}`);
    for (const d of report.diagnostics) assert.match(d, /thisapp/, planned.name);
  }
});

test('converted apps carry the connections report, the checklist, and an unfilled deploy config', () => {
  for (const planned of plan.apps as PlannedApp[]) {
    const files = new Map(buildUi(appIr(planned.name)).files.map((f) => [f.path, String(f.data)]));
    const report = JSON.parse(files.get('migration-report.json')!) as { connections?: { entries: { link: string }[] } };
    const deploy = JSON.parse(files.get('functions/c2c-deploy.json')!) as Record<string, unknown>;
    assert.equal(deploy.mode, 'dry-run', planned.name);
    if (!planned.connections.length) {
      assert.equal(report.connections, undefined, planned.name);
      assert.equal(files.has('CONNECTIONS.md'), false, planned.name);
      assert.equal(Object.hasOwn(deploy, 'zohoDc'), false, planned.name);
      continue;
    }
    assert.deepEqual(report.connections?.entries.map((e) => e.link), planned.connections, planned.name);
    assert.equal(deploy.zohoDc, null, planned.name);
    assert.deepEqual(deploy.connections, Object.fromEntries(planned.connections.map((l) => [l, null])), planned.name);
    const checklist = files.get('CONNECTIONS.md')!;
    for (const link of planned.connections) assert.ok(checklist.includes(`| \`${link}\` |`), `${planned.name} checklist row ${link}`);
    assert.match(checklist, /getConnectionCredentials/);
    assert.ok(files.has('functions/c2c-connections.mjs'), planned.name);
    const handlers = [...files.entries()].filter(([path, src]) => path.startsWith('functions/aio/') && /shim\.(zoho\.task|http\.invokeurl)\(/.test(src));
    assert.ok(handlers.length, `${planned.name} has a handler calling the service`);
    for (const [path, src] of handlers) {
      if (src.includes('writeLive(')) assert.match(src, /zohoConnections: await zohoConnections\(req, live\)/, path);
      assert.doesNotMatch(src, /"type": (GET|POST|PUT|DELETE)\b/, `${path}: invokeurl verb emitted as a bare identifier`);
    }
  }
});

test('invokeurl type :PUT translates to the string "PUT", not an identifier', () => {
  const out = translate('r = invokeurl\n[\n\turl :u\n\ttype :PUT\n\tconnection:"c2c_crm"\n];').server;
  assert.match(out, /"type": "PUT"/);
});

function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body: string) {
      raw = body;
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }));
}

async function writeTree(app: App, deploy: Record<string, unknown>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-conn-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(root, join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of buildUi(app).files) {
    const dest = join(dir, ...file.path.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.data);
  }
  writeFileSync(join(dir, 'functions/c2c-deploy.json'), `${JSON.stringify(deploy, null, 2)}\n`);
  return dir;
}

function memoryStore() {
  const rows: Record<string, unknown>[] = [];
  let next = 1;
  return {
    rows,
    now: new Date('2026-10-06T08:30:00.000Z'),
    async insert(_form: string, input: Record<string, unknown>[]) {
      const out = input.map((row) => ({ ...row, ROWID: String(next++) }));
      rows.push(...out);
      return out;
    },
    async update(_form: string, input: Record<string, unknown>[]) {
      return input;
    },
    async delete() {
      return [];
    },
    async query() {
      return [];
    },
  };
}

test('generated CRM on success: dry run sends nothing; live without a connection name refuses; live with one calls 127.0.0.1 and stores the details map', async () => {
  const details = { Modified_Time: '2026-10-06T14:10:21+05:30', Created_Time: '2026-10-06T14:10:21+05:30', id: '900000000000000001' };
  const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ code: 'SUCCESS', details, message: 'record added', status: 'success' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  // Only the Zoho host is redirected; anything else would fail the test.
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith('https://www.zohoapis.in/'), `unexpected fetch ${url}`);
    return realFetch(origin + url.slice('https://www.zohoapis.in'.length), init);
  }) as typeof fetch;
  const app = deriveIr(parse(withOwnerProfile(connectionsApp('c2c-conn-crm'))));
  const handlerPath = 'functions/aio/conn-crm-lead/on-success.mjs';
  const record = { Lead_Last_Name: 'C2C-A1', Lead_Company: 'c2c synthetic', Lead_Email: 'c2c-a1@example.com' };
  const req = { user: { profile: 'Administrator' }, body: { record } };
  try {
    const dry = await writeTree(app, { mode: 'dry-run', appTimeZone: 'Asia/Kolkata', zohoDc: 'in', connections: { c2c_crm: 'c2c_crm' } });
    const dryRes = await invoke((await import(pathToFileURL(join(dry, handlerPath)).href)).default, req);
    assert.equal(dryRes.status, 200, JSON.stringify(dryRes.body));
    assert.equal(dryRes.body.dryRun, true);
    const task = (dryRes.body.transcript as { op: string; request?: { url: string } }[]).find((e) => e.op === 'zoho.task');
    assert.equal(task?.request?.url, 'https://www.zohoapis.in/crm/v7/Leads');
    assert.equal(seen.length, 0);

    const unset = await writeTree(app, { mode: 'live', appTimeZone: 'Asia/Kolkata', zohoDc: 'in', connections: { c2c_crm: null } });
    (await import(pathToFileURL(join(unset, 'functions/c2c-store.mjs')).href)).setDatastore(memoryStore());
    (await import(pathToFileURL(join(unset, 'functions/c2c-connections.mjs')).href)).setConnectionCredentials(async () => 'tok');
    const refused = await invoke((await import(pathToFileURL(join(unset, handlerPath)).href)).default, req);
    assert.equal(refused.status, 500);
    assert.match(String(refused.body.error), /live-refused: zoho\.crm\.createRecord: no Catalyst connection configured for "c2c_crm"/);
    assert.equal(seen.length, 0);

    const liveDir = await writeTree(app, { mode: 'live', appTimeZone: 'Asia/Kolkata', zohoDc: 'in', connections: { c2c_crm: 'c2c_crm' } });
    const store = memoryStore();
    (await import(pathToFileURL(join(liveDir, 'functions/c2c-store.mjs')).href)).setDatastore(store);
    (await import(pathToFileURL(join(liveDir, 'functions/c2c-connections.mjs')).href)).setConnectionCredentials(async (name: string) => `tok-${name}`);
    const ok = await invoke((await import(pathToFileURL(join(liveDir, handlerPath)).href)).default, req);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0]!.method, seen[0]!.url, seen[0]!.auth], ['POST', '/crm/v7/Leads', 'Zoho-oauthtoken tok-c2c_crm']);
    assert.deepEqual(JSON.parse(seen[0]!.body), { data: [{ Last_Name: 'C2C-A1', Company: 'c2c synthetic', Email: 'c2c-a1@example.com', Description: 'c2c synthetic' }] });
    // input.Crm_Response = resp.toString(): the details map as JSON text, as Creator stored it.
    assert.equal((ok.body.values as Record<string, unknown>).Crm_Response, JSON.stringify(details));
    assert.ok(!JSON.stringify(ok.body).includes('tok-c2c_crm'), 'token reached the response');
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
